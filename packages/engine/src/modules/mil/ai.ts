import {
  distanceKm,
  type LngLat,
  type NationId,
  type Order,
  type StrikeTarget,
  type WeaponSystem,
} from '@redline/shared';
import { isLauncher, isRadarSensor } from '../../encounters/profile.js';
import { aiOrder } from '../../ai/trace.js';
import { aiCfg, aiLevelCfg } from '../../ai/config.js';
import { sortedKeys, sortedSet, sysOf, warsOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { airFeasible, msOf } from './air.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { isRegular } from '../diplo/state.js';
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
 *  - Frappes aériennes (`airStrikesPerThink`) sur les forces terrestres ennemies vues chez soi et, en
 *    appui (`supportStrikes`), sur celles qui défendent les objectifs de ses offensives.
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

/** Appareil au sol, prêt à décoller. */
function ready(state: EngineState, u: Unit): boolean {
  const m = msOf(state, u);
  return !!m && !m.up && m.ready <= state.time;
}

export function combatAi(state: EngineState, n: NationId): void {
  if (!state.rt.enemies.get(n)?.size) return;
  navalAi(state, n);
  // Réactive : rien à faire tant qu'aucun ennemi n'est observé (coût nul pour les guerres dormantes).
  const { threats, air, airAt } = visibleEnemies(state, n);
  if (threats.length === 0 && !air) return;
  const ns = state.nations[n]!;
  const L = aiLevelCfg(state, ns.aiLevel);
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
      if (airFeasible(state, u, capital)) continue;
      if (order(state, n, { kind: 'patrol', unitIds: [u.id], at: capital, radiusKm: radius }))
        want--;
    }
    const aew = units.find((u) => {
      const m = msOf(state, u);
      return isAew(sysOf(state, u)) && m?.mis === 'awacs';
    });
    if (!aew) {
      for (const u of units) {
        if (!isAew(sysOf(state, u)) || !ready(state, u) || airFeasible(state, u, capital)) continue;
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

  // 3. Frappes aériennes : forces terrestres ennemies chez soi, et appui de ses offensives.
  let strikes = L.airStrikesPerThink;
  if (strikes <= 0) return;
  const objectives = L.supportStrikes ? offensiveObjectives(state, n, units) : [];
  const supportKm = aiCfg(state.world).tactical.cityRadiusKm * 3;
  const ground = threats.filter(
    (x) =>
      x.sys?.movement === 'land' &&
      (nearOwn(state, n, x.pos) || objectives.some((o) => distanceKm(o, x.pos) <= supportKm)),
  );
  if (ground.length === 0) return;
  let attempts = 6;
  for (const u of units) {
    if (strikes <= 0 || attempts <= 0) break;
    const s = sysOf(state, u);
    if (!isFuelAir(s) || !ready(state, u)) continue;
    if (s.category !== 'bomber' && s.category !== 'air_support' && s.category !== 'drone') continue;
    const here = posOf(state, u);
    const t = ground
      .filter((x) => s.damage[x.sys!.targetClass] > 0)
      .sort(
        (a, b) => distanceKm(a.pos, here) - distanceKm(b.pos, here) || (a.u.id < b.u.id ? -1 : 1),
      )[0];
    if (!t) continue;
    attempts--;
    if (airFeasible(state, u, t.pos)) continue;
    if (
      order(state, n, {
        kind: 'strike',
        unitIds: [u.id],
        target: { type: 'unit', unitId: t.u.id },
      })
    )
      strikes--;
  }
}

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
  // Sinon : base ennemie à portée (bâtiments publics de la carte).
  const enemies = warsOf(state, n);
  let bestB: StrikeTarget | null = null;
  let bestD = Infinity;
  for (const e of enemies) {
    for (const pid of sortedSet(state.rt.provsOf.get(e))) {
      const blds = buildingsOf(state, pid);
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
