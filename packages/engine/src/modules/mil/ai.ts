import {
  distanceKm,
  type BuildingType,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
  type StrikeTarget,
  type WeaponSystem,
} from '@redline/shared';
import { isLauncher, isRadarSensor } from '../../encounters/profile.js';
import { interpolator } from '../../geo/sphere.js';
import { planAir } from '../../nav/plan.js';
import { crossingHits } from '../../movement/movement.js';
import { hasPassage } from '../../state/war.js';
import { aiOrder } from '../../ai/trace.js';
import { aiCfg, aiLevelCfg } from '../../ai/config.js';
import { atWar, sortedKeys, sortedSet, sysOf, warsOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { airFeasible, msOf } from './air.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { isRegular } from '../diplo/state.js';
import { knowledge, revealed } from '../intel/provinces.js';
import { operations } from '../../ai/strategy.js';
import { mil } from './state.js';
import { cellsLeft, missileForShip } from './strike.js';
import {
  buildingsOf,
  cityOf,
  isAew,
  isFuelAir,
  isRecon,
  isTanker,
  launchCells,
  portsOf,
  posOf,
  strikeRangeKm,
} from './util.js';

/**
 * IA de combat (crochet aiThink, nations tenues par l'IA et en guerre seulement). Elle ne triche pas :
 * elle ne vise que ce que sa nation voit (contacts observés, au niveau d'identification atteint) et
 * les bâtiments publics de la carte. Réglages par niveau : data/balance, section ai.levels.
 *  - Défense aérienne : quand un aéronef ou un missile ennemi est vu à moins de `capAlertKm` de la
 *    capitale, patrouilles de chasse au-dessus d'elle (`caps`) et un avion radar en orbite s'il y en
 *    a ; les défenses sol-air interceptent automatiquement.
 *  - Salves de missiles (`salvosPerThink`) sur les menaces identifiées (défense aérienne et radars
 *    d'abord, puis navires et concentrations), sinon sur les bases ennemies à portée.
 *  - Supériorité aérienne : chasseurs en patrouille au-dessus des objectifs de ses offensives et des
 *    zones de débarquement (`airEscorts`) quand l'aviation ennemie se montre (ou pour un débarquement).
 *  - Frappes aériennes (`airStrikesPerThink`), par priorité : défenses antiaériennes identifiées qui
 *    couvrent ses objectifs (suppression, `sead`), forces terrestres ennemies vues chez soi et, en appui
 *    (`supportStrikes`), celles qui défendent ses objectifs.
 *  - Frappes profondes (`deepStrikesPerThink`) sur les installations ennemies révélées par son
 *    renseignement (sites antiaériens et radars, bases aériennes, bases et usines d'armement), jamais
 *    sous une défense antiaérienne connue non neutralisée (elle est frappée d'abord), avec une escorte
 *    de chasseurs (patrouille sur l'objectif, arrivée avant les bombardiers).
 *  - Chaque ordre est vérifié avant d'être donné (rayon d'action, portée) : pas d'ordres refusés.
 *  - Jamais de nucléaire (décision réservée aux joueurs humains).
 */

interface Seen {
  u: Unit;
  /** Système identifié (niveau 2 ou mieux), sinon null. */
  sys: WeaponSystem | null;
  pos: LngLat;
}

function order(state: EngineState, n: NationId, o: Order): boolean {
  return aiOrder(state, n, o).ok;
}

/**
 * Vol possible vers ce point et retour (rayon d'action, carburant) sans survoler une nation avec qui
 * on n'est pas en guerre (le survol d'une province étrangère vaut entrée : il ouvrirait un front).
 */
function canFly(state: EngineState, n: NationId, u: Unit, to: LngLat): boolean {
  if (airFeasible(state, u, to)) return false;
  const from = posOf(state, u);
  const plan = planAir(sysOf(state, u), from, to, state.time);
  if ('error' in plan) return false;
  return !crossingHits(state, from, plan.legs, (p) => {
    const owner = state.provinces[p]?.owner;
    return !!owner && owner !== n && !atWar(state, n, owner) && !hasPassage(state, n, owner);
  });
}

/** Appareil au sol, prêt à décoller. */
function ready(state: EngineState, u: Unit): boolean {
  const m = msOf(state, u);
  return !!m && !m.up && m.ready <= state.time;
}

export function combatAi(state: EngineState, n: NationId): void {
  if (!state.rt.enemies.get(n)?.size) return;
  navalAi(state, n);
  // Réactive : rien à faire tant qu'aucun ennemi n'est observé (coût quasi nul pour les guerres
  // dormantes), sauf frappes profondes et couverture des débarquements, une réflexion sur quatre.
  const { threats, air, airAt } = visibleEnemies(state, n);
  const ns = state.nations[n]!;
  const L = aiLevelCfg(state, ns.aiLevel);
  if (threats.length === 0 && !air) {
    if (L.deepStrikesPerThink <= 0 && L.airEscorts <= 0) return;
    const tick = Math.round(state.time / (state.world.balance.time.aiThinkMinutes * 60_000));
    if ((tick + state.nationIds.indexOf(n)) % QUIET_EVERY !== 0) return;
    const units = sortedSet(state.rt.byNation.get(n))
      .map((id) => state.units[id]!)
      .filter((u) => !u.role);
    const landings = landingZones(state, n);
    if (L.airEscorts > 0 && landings.length > 0) cover(state, n, units, landings[0]!, L.airEscorts);
    if (L.deepStrikesPerThink > 0) deepStrikes(state, n, units, threats, L.deepStrikesPerThink);
    return;
  }
  const units = sortedSet(state.rt.byNation.get(n))
    .map((id) => state.units[id]!)
    .filter((u) => !u.role);
  const w = wi(state.world);
  const capId = w.nationById.get(n)?.capitalProvinceId;
  const capital =
    capId && state.provinces[capId]?.owner === n ? w.provById.get(capId)!.cityPoint : null;

  // 1. Menace aérienne (avions, drones, missiles) : chasse et avion radar au-dessus de la capitale.
  const T = aiCfg(state.world).tactical;
  if (capital && airAt.some((p) => distanceKm(p, capital) <= T.capAlertKm)) {
    const ms = mil(state).ms;
    const radius = T.capRadiusKm;
    const onCap = units.filter(
      (u) => ms[u.id]?.mis === 'patrol' && sysOf(state, u).movement === 'air',
    ).length;
    let want = L.caps - onCap;
    let tries = 6;
    for (const u of units) {
      if (want <= 0 || tries <= 0) break;
      const s = sysOf(state, u);
      if (!isFuelAir(s) || !ready(state, u)) continue;
      if (isTanker(s) || isAew(s) || isRecon(s) || s.damage.aircraft <= 0) continue;
      tries--;
      if (!canFly(state, n, u, capital)) continue;
      if (order(state, n, { kind: 'patrol', unitIds: [u.id], at: capital, radiusKm: radius }))
        want--;
    }
    const aew = units.find((u) => {
      const m = msOf(state, u);
      return isAew(sysOf(state, u)) && m?.mis === 'awacs';
    });
    if (!aew) {
      for (const u of units) {
        if (!isAew(sysOf(state, u)) || !ready(state, u) || !canFly(state, n, u, capital)) continue;
        if (order(state, n, { kind: 'patrol', unitIds: [u.id], at: capital, radiusKm: 100 })) break;
      }
    }
  }

  // 2. Salves de missiles.
  let salvos = L.salvosPerThink;
  let tries = 6;
  for (const u of units) {
    if (salvos <= 0 || tries <= 0) break;
    const s = sysOf(state, u);
    const isShip = s.movement === 'sea' && launchCells(s) > 0 && cellsLeft(state, u) > 0;
    if (!isLauncher(s) && !isShip) continue;
    if (s.missile?.warhead === 'nuclear' || s.category === 'space') continue;
    // Navire : missile de croisière tiré de ses cellules (portée de ce missile).
    const msys = isLauncher(s) ? s : missileForShip(state, s, false);
    if (!msys || msys.missile?.warhead === 'nuclear') continue;
    tries--;
    const antiShip = isLauncher(s) ? null : missileForShip(state, s, true);
    const target = pickMissileTarget(state, n, u, msys, antiShip, threats);
    if (!target) continue;
    const count = isLauncher(s) ? Math.min(u.count, L.salvoSize) : undefined;
    const o: Order = count
      ? { kind: 'strike', unitIds: [u.id], target, count }
      : { kind: 'strike', unitIds: [u.id], target };
    if (order(state, n, o)) salvos--;
  }

  // 3. Supériorité aérienne au-dessus des objectifs (et des zones de débarquement).
  const T2 = aiCfg(state.world).tactical;
  const objectives =
    L.supportStrikes || L.airEscorts > 0 ? offensiveObjectives(state, n, units) : [];
  const landings = landingZones(state, n);
  if (L.airEscorts > 0) {
    const zones = air ? [...landings, ...objectives] : landings;
    if (zones.length > 0) cover(state, n, units, zones[0]!, L.airEscorts);
  }

  // 4. Frappes aériennes : défenses antiaériennes qui couvrent ses objectifs, forces terrestres
  //    ennemies chez soi, appui de ses offensives.
  let strikes = L.airStrikesPerThink;
  const supportKm = T2.cityRadiusKm * 3;
  const near = (p: LngLat) =>
    nearOwn(state, n, p) ||
    (L.supportStrikes && objectives.some((o) => distanceKm(o, p) <= supportKm)) ||
    landings.some((o) => distanceKm(o, p) <= SAM_COVER_KM);
  // Défenses antiaériennes identifiées sur la route de ses offensives (autour des objectifs), sur
  // son sol ou près des zones de débarquement : neutralisées en premier.
  const sams = L.sead
    ? threats.filter(
        (x) =>
          isSam(x.sys) &&
          (near(x.pos) || objectives.some((o) => distanceKm(o, x.pos) <= 2 * SAM_COVER_KM)),
      )
    : [];
  const ground = threats.filter((x) => x.sys?.movement === 'land' && !isSam(x.sys) && near(x.pos));
  if (strikes > 0 && (sams.length > 0 || ground.length > 0)) {
    let attempts = 6;
    for (const u of units) {
      if (strikes <= 0 || attempts <= 0) break;
      const s = sysOf(state, u);
      if (!isStriker(s) || !ready(state, u)) continue;
      const here = posOf(state, u);
      const pick = (list: Seen[]): Seen | undefined =>
        list
          .filter((x) => s.damage[x.sys!.targetClass] > 0)
          .sort(
            (a, b) =>
              distanceKm(a.pos, here) - distanceKm(b.pos, here) || (a.u.id < b.u.id ? -1 : 1),
          )[0];
      let t = pick(sams) ?? pick(ground);
      if (!t) continue;
      // Une défense identifiée sur la route de la frappe passe avant (suppression).
      if (L.sead && !isSam(t.sys)) {
        const onWay = threats.find(
          (x) => isSam(x.sys) && s.damage[x.sys!.targetClass] > 0 && onRoute(x, here, t!.pos),
        );
        if (onWay) t = onWay;
      }
      attempts--;
      if (!canFly(state, n, u, t.pos)) continue;
      if (
        order(state, n, {
          kind: 'strike',
          unitIds: [u.id],
          target: { type: 'unit', unitId: t.u.id },
        })
      ) {
        strikes--;
        if (isSam(t.sys) || !nearOwn(state, n, t.pos))
          escortStrike(state, n, units, t.pos, L.airEscorts);
      }
    }
  }

  // 5. Frappes profondes sur les installations ennemies révélées.
  if (L.deepStrikesPerThink > 0) deepStrikes(state, n, units, threats, L.deepStrikesPerThink);
}

/** Guerre sans contact : une réflexion aérienne sur QUIET_EVERY. */
const QUIET_EVERY = 4;

/** Appareil d'attaque au sol (bombardier, appui, drone armé ; ni ravitailleur ni avion radar). */
function isStriker(s: WeaponSystem): boolean {
  if (!isFuelAir(s) || isTanker(s) || isAew(s)) return false;
  return s.category === 'bomber' || s.category === 'air_support' || s.category === 'drone';
}

/** Chasseur disponible pour l'escorte ou la patrouille (ni ravitailleur, ni radar, ni reconnaissance). */
function isFighter(s: WeaponSystem): boolean {
  if (!isFuelAir(s) || isTanker(s) || isAew(s) || isRecon(s)) return false;
  return s.category === 'fighter' && s.damage.aircraft > 0;
}

/** Défense antiaérienne (sol-air) d'après sa fiche identifiée. */
function isSam(s: WeaponSystem | null): boolean {
  return !!s && s.category === 'air_defense' && s.damage.aircraft > 0 && s.movement !== 'air';
}

/** Rayon de couverture prudent d'une défense antiaérienne autour d'un point (km). */
const SAM_COVER_KM = 150;

function covers(x: Seen, p: LngLat): boolean {
  return distanceKm(x.pos, p) <= (x.sys?.weaponRangeKm.max ?? 0) + 10;
}

/** Zones de débarquement de ses opérations amphibies en cours (mer devant la province visée). */
function landingZones(state: EngineState, n: NationId): LngLat[] {
  const ops = operations(state, n);
  const w = wi(state.world);
  const out: LngLat[] = [];
  for (const pid of sortedKeys(ops)) {
    if (!ops[pid]!.sea) continue;
    const at = w.seaSpawn.get(pid) ?? cityOf(state, pid);
    if (at) out.push(at);
  }
  return out;
}

/** Chasseurs déjà en patrouille près d'un point. */
function patrolling(state: EngineState, units: Unit[], at: LngLat, km: number): number {
  const ms = mil(state).ms;
  let c = 0;
  for (const u of units) {
    const m = ms[u.id];
    if (!m || (m.mis !== 'patrol' && m.mis !== 'strike') || !m.at) continue;
    if (!isFighter(sysOf(state, u))) continue;
    if (distanceKm(m.at, at) <= km) c++;
  }
  return c;
}

/** Patrouille de chasse au-dessus d'un point (couverture d'un objectif ou d'un débarquement). */
function cover(state: EngineState, n: NationId, units: Unit[], at: LngLat, want: number): void {
  let need = want - patrolling(state, units, at, COVER_KM);
  let tries = 4;
  for (const u of units) {
    if (need <= 0 || tries <= 0) break;
    const s = sysOf(state, u);
    if (!isFighter(s) || !ready(state, u)) continue;
    tries--;
    if (!canFly(state, n, u, at)) continue;
    if (order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: COVER_KM })) need--;
  }
}

const COVER_KM = 80;

/**
 * Escorte d'une frappe hors de son territoire : des chasseurs patrouillent sur l'objectif (plus
 * rapides, ils arrivent avant les bombardiers et engagent les intercepteurs ennemis).
 */
function escortStrike(
  state: EngineState,
  n: NationId,
  units: Unit[],
  at: LngLat,
  want: number,
): void {
  if (want <= 0) return;
  cover(state, n, units, at, want);
}

/** Installations visées par les frappes profondes, par priorité décroissante. */
const DEEP_PRIORITY: Partial<Record<BuildingType, number>> = {
  air_defense_site: 5,
  radar_station: 4,
  air_base: 3,
  military_base: 2,
  arms_factory: 2,
  naval_base: 1,
};

/**
 * Frappes profondes : installations ennemies révélées par son renseignement, à moins de
 * `deepStrikeKm` de son territoire, par priorité (défenses, radars, bases aériennes, logistique).
 * Une installation couverte par une défense antiaérienne identifiée n'est frappée qu'une fois celle-ci
 * neutralisée (la défense est frappée d'abord) ; chaque frappe part avec son escorte.
 */
function deepStrikes(
  state: EngineState,
  n: NationId,
  units: Unit[],
  threats: Seen[],
  max: number,
): void {
  const strikers = units.filter((u) => {
    const s = sysOf(state, u);
    return isStriker(s) && s.damage.building > 0 && ready(state, u);
  });
  if (strikers.length === 0) return;
  const ns = state.nations[n]!;
  const L = aiLevelCfg(state, ns.aiLevel);
  const reach = aiCfg(state.world).tactical.deepStrikeKm;
  const w = wi(state.world);
  const own = sortedSet(state.rt.provsOf.get(n)).map((p) => w.provById.get(p)!.cityPoint);
  const sams = L.sead ? threats.filter((x) => isSam(x.sys)) : [];
  const busy = new Set<string>();
  for (const id of sortedKeys(mil(state).ms)) {
    const m = mil(state).ms[id]!;
    const tg = m.tg;
    if (m.mis === 'strike' && tg && tg.type === 'building')
      busy.add(`${tg.provinceId}:${tg.building}`);
  }
  const cands: { pid: ProvinceId; b: BuildingType; at: LngLat; score: number }[] = [];
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    for (const pid of sortedSet(state.rt.provsOf.get(e))) {
      const at = cityOf(state, pid);
      const k = knowledge(state, n, pid);
      if (!at || !k || k.m <= 0) continue;
      let d = Infinity;
      for (const p of own) d = Math.min(d, distanceKm(p, at));
      if (d > reach) continue;
      for (const b of revealed(pid, buildingsOf(state, pid), k)) {
        const pr = DEEP_PRIORITY[b];
        if (!pr || busy.has(`${pid}:${b}`)) continue;
        cands.push({ pid, b, at, score: pr - d / reach });
      }
    }
  }
  cands.sort(
    (a, b) => b.score - a.score || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : a.b < b.b ? -1 : 1),
  );
  let left = max;
  let tries = 6;
  for (const c of cands) {
    if (left <= 0 || tries <= 0 || strikers.length === 0) break;
    tries--;
    // Appareil capable de frapper l'installation et à distance de vol.
    const i = strikers.findIndex(
      (u) => sysOf(state, u).damage.building > 0 && canFly(state, n, u, c.at),
    );
    if (i < 0) continue;
    const u = strikers[i]!;
    // Suppression d'abord : une défense identifiée qui couvre l'objectif ou la route est la cible.
    const here = posOf(state, u);
    const sam = sams.find((x) => covers(x, c.at) || onRoute(x, here, c.at));
    if (sam && (sysOf(state, u).damage[sam.sys!.targetClass] <= 0 || !canFly(state, n, u, sam.pos)))
      continue;
    const target: StrikeTarget = sam
      ? { type: 'unit', unitId: sam.u.id }
      : { type: 'building', provinceId: c.pid, building: c.b };
    const aim = sam ? sam.pos : c.at;
    strikers.splice(i, 1);
    if (order(state, n, { kind: 'strike', unitIds: [u.id], target })) {
      left--;
      escortStrike(state, n, units, aim, L.airEscorts);
      if (sam) sams.splice(sams.indexOf(sam), 1);
    }
  }
}

/** La défense antiaérienne couvre-t-elle un point de la route (grand cercle échantillonné) ? */
function onRoute(x: Seen, from: LngLat, to: LngLat): boolean {
  const r = (x.sys?.weaponRangeKm.max ?? 0) + 10;
  const d = distanceKm(from, to);
  const steps = Math.max(1, Math.ceil(d / ROUTE_STEP_KM));
  const along = interpolator(from, to);
  for (let k = 0; k <= steps; k++) if (distanceKm(x.pos, along(k / steps)) <= r) return true;
  return false;
}

const ROUTE_STEP_KM = 25;

/**
 * Marine : blocus des ports ennemis par les navires de surface libres (au plus `blockades` blocus
 * tenus à la fois ; une réflexion navale toutes les `NAVAL_EVERY` réflexions, décalée par nation). Le
 * blocus coupe une part du commerce de l'ennemi ; les navires engagent ce qui force le blocus.
 */
const NAVAL_EVERY = 12;

function navalAi(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  let want = aiLevelCfg(state, ns.aiLevel).blockades;
  if (want <= 0) return;
  const tick = Math.round(state.time / (state.world.balance.time.aiThinkMinutes * 60_000));
  if ((tick + state.nationIds.indexOf(n)) % NAVAL_EVERY !== 0) return;
  const m = mil(state);
  const busy = new Set<string>();
  const blocked = new Set<string>();
  for (const id of sortedKeys(m.blk)) {
    const b = m.blk[id]!;
    if (b.by !== n) continue;
    for (const u of b.units) busy.add(u);
    if ('provinceId' in b.target) blocked.add(b.target.provinceId);
    want--;
  }
  if (want <= 0) return;
  const ships = sortedSet(state.rt.byNation.get(n))
    .map((id) => state.units[id]!)
    .filter((u) => {
      if (u.role || u.off || u.move || u.target || busy.has(u.id)) return false;
      // Navire en mission (escorte d'un débarquement) : pas de blocus.
      const mis = m.ms[u.id]?.mis;
      if (mis && mis !== 'none') return false;
      const s = sysOf(state, u);
      return s.category === 'surface_ship' && s.damage.ship > 0;
    });
  if (ships.length === 0) return;
  const w = wi(state.world);
  const ports: { pid: string; at: LngLat }[] = [];
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    for (const pid of portsOf(state, e)) {
      if (blocked.has(pid)) continue;
      ports.push({ pid, at: w.seaSpawn.get(pid)! });
    }
  }
  let tries = 3;
  while (want > 0 && tries > 0 && ships.length > 0 && ports.length > 0) {
    // Couple port / navire le plus proche (départage par identifiants).
    let best: { si: number; pi: number; d: number } | null = null;
    for (let si = 0; si < ships.length; si++) {
      const here = posOf(state, ships[si]!);
      for (let pi = 0; pi < ports.length; pi++) {
        const d = distanceKm(here, ports[pi]!.at);
        if (d <= NAVAL_REACH_KM && (!best || d < best.d)) best = { si, pi, d };
      }
    }
    if (!best) return;
    tries--;
    const ship = ships.splice(best.si, 1)[0]!;
    const port = ports.splice(best.pi, 1)[0]!;
    if ('error' in planUnitMove(state, ship, port.at)) continue;
    if (order(state, n, { kind: 'blockade', unitIds: [ship.id], target: { provinceId: port.pid } }))
      want--;
  }
}

/** Distance maximale d'un navire au port qu'il va bloquer (km). */
const NAVAL_REACH_KM = 2500;

/** Ennemis observés (hors missiles) et présence d'une menace aérienne (aéronef ou missile vu). */
function visibleEnemies(
  state: EngineState,
  n: NationId,
): { threats: Seen[]; air: boolean; airAt: LngLat[] } {
  const threats: Seen[] = [];
  const airAt: LngLat[] = [];
  let air = false;
  const known = state.know[n];
  if (!known) return { threats, air, airAt };
  const enemies = state.rt.enemies.get(n);
  const cat = state.world.catalog;
  for (const id of sortedKeys(known)) {
    const c = known[id]!;
    const u = state.units[id];
    if (!c.seen || !u || u.off || !enemies?.has(u.owner)) continue;
    const pos = posOf(state, u);
    if (u.role === 'missile') {
      air = true;
      airAt.push(pos);
      continue;
    }
    const sys = c.lvl >= 2 && c.sys ? (cat.get(c.sys) ?? null) : null;
    if (sysOf(state, u).movement === 'air') {
      air = true;
      airAt.push(pos);
    }
    threats.push({ u, sys, pos });
  }
  return { threats, air, airAt };
}

/** Villes ennemies visées par ses unités terrestres en route (objectifs de ses offensives). */
function offensiveObjectives(state: EngineState, n: NationId, units: Unit[]): LngLat[] {
  const out: LngLat[] = [];
  for (const u of units) {
    const legs = u.move?.legs;
    if (!legs || sysOf(state, u).movement !== 'land') continue;
    const dest = legs[legs.length - 1]!.to;
    const owner = ownerAt(state, dest);
    if (owner && owner !== n && state.rt.enemies.get(n)?.has(owner)) out.push(dest);
  }
  return out;
}

function ownerAt(state: EngineState, p: LngLat): NationId | null {
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellOfPos(p));
  return pid ? (state.provinces[pid]?.owner ?? null) : null;
}

function nearOwn(state: EngineState, n: NationId, p: LngLat): boolean {
  return ownerAt(state, p) === n;
}

function pickMissileTarget(
  state: EngineState,
  n: NationId,
  launcher: Unit,
  msys: WeaponSystem,
  /** Navire : missile tiré contre un navire (le moteur choisit l'antinavire), sinon null. */
  antiShip: WeaponSystem | null,
  threats: Seen[],
): StrikeTarget | null {
  const here = posOf(state, launcher);
  const range = strikeRangeKm(msys);
  const kind = msys.missile?.kind ?? 'cruise';
  let best: Seen | null = null;
  let bestScore = 0;
  for (const t of threats) {
    // Cible identifiée seulement : on ne gaspille pas une salve sur un écho inconnu.
    const ts = t.sys;
    if (!ts) continue;
    const d = distanceKm(t.pos, here);
    const vsShip = antiShip && (ts.targetClass === 'ship' || ts.targetClass === 'submarine');
    if (d > (vsShip ? strikeRangeKm(antiShip) : range)) continue;
    if (kind === 'antiship' && ts.movement !== 'sea') continue;
    if (kind === 'antiradiation' && !isRadarSensor(ts)) continue;
    if (ts.movement === 'air') continue; // trop mobiles pour un missile sol-sol
    const dmg = msys.damage[ts.targetClass] > 0 ? msys.damage[ts.targetClass] : 0;
    if (dmg <= 0) continue;
    const priority = isRadarSensor(ts) ? 3 : ts.movement === 'sea' ? 2 : 1;
    const score = priority * dmg * t.u.count;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  if (best) return { type: 'unit', unitId: best.u.id };
  if (kind === 'antiship' || kind === 'antiradiation' || msys.damage.building <= 0) return null;
  // Sinon : base ennemie à portée, révélée par son renseignement.
  const enemies = warsOf(state, n);
  let bestB: StrikeTarget | null = null;
  let bestD = Infinity;
  for (const e of enemies) {
    for (const pid of sortedSet(state.rt.provsOf.get(e))) {
      const k = knowledge(state, n, pid);
      if (k && k.m <= 0) continue;
      const blds = k ? revealed(pid, buildingsOf(state, pid), k) : buildingsOf(state, pid);
      const b = (['air_base', 'military_base', 'arms_factory'] as const).find((x) =>
        blds.includes(x),
      );
      if (!b) continue;
      const d = distanceKm(cityOf(state, pid)!, here);
      if (d <= range && d < bestD) {
        bestD = d;
        bestB = { type: 'building', provinceId: pid, building: b };
      }
    }
  }
  return bestB;
}
