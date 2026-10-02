import {
  HOUR,
  distanceKm,
  type AiLevelBalance,
  type BuildingType,
  type CommandBalance,
  type GeneralTraitDef,
  type LngLat,
  type MissionDef,
  type NationId,
  type Order,
  type ProvinceId,
  type StrikeTarget,
} from '@redline/shared';
import {
  armyContext,
  counterattack,
  defend,
  garrison,
  launchGroup,
  needFor,
  runOps,
  runTransports,
  safeLegs,
  stopNeutralChases,
  type ArmyScope,
  type Ctx,
} from '../../ai/ai.js';
import { aiLevelCfg } from '../../ai/config.js';
import { contactValue, estimateForce, ownForce, seaLinks, unitValue } from '../../ai/estimate.js';
import { aiOrder } from '../../ai/trace.js';
import { isLauncher } from '../../encounters/profile.js';
import { atWar, provincesOf, sortedKeys, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../../state/world.js';
import { board } from '../kit.js';
import { knowledge, revealed } from '../intel/provinces.js';
import {
  canFly,
  cover,
  escortStrike,
  isFighter,
  isSam,
  isStriker,
  onRoute,
  ready,
  visibleEnemies,
  type Seen,
} from '../mil/ai.js';
import { mil } from '../mil/state.js';
import { buildingsOf, isAew, launchCells, portsOf } from '../mil/util.js';
import { cellsLeft, missileForShip } from '../mil/strike.js';
import { strikeRangeKm } from '../mil/util.js';
import { capacityOf } from '../mil/transport.js';
import { addUnits, armyValue, targetParam } from './armies.js';
import { fullName, gainXp, traitSum } from './generals.js';
import { journal, notifyOwner } from './journal.js';
import {
  cmd,
  cmdBal,
  cmdRoll,
  nextCmdId,
  type ArmySt,
  type GenSt,
  type MissionSt,
} from './state.js';

/**
 * Le général est l'IA : à chaque réflexion (cadence des IA), il commande les piles de son armée selon
 * la mission, avec la machinerie tactique des IA du moteur (groupes dimensionnés, rassemblement,
 * départs échelonnés, débarquement par navire de transport et escorte, défense des villes,
 * contre-attaques) et l'aviation des IA (couverture, frappes, suppression des défenses, escortes).
 * Ses compétences et ses traits règlent le profil (`AiLevelBalance`) : rapport de force exigé, taille
 * des groupes, objectifs par réflexion, rassemblement, escortes, sorties aériennes, budget de calcul ;
 * l'expérience réduit les frictions (réflexions perdues). Tous les ordres sont des ordres de jeu
 * normaux, recalculés à l'identique au rejeu (PRNG du module).
 */

let driving = false;

/** Vrai pendant que le général donne ses ordres (ils ne passent pas les piles en ordre manuel). */
export function generalDriving(): boolean {
  return driving;
}

function order(state: EngineState, n: NationId, o: Order): boolean {
  return aiOrder(state, n, o).ok;
}

type Aggr = CommandBalance['aggressiveness']['balanced'];

interface Think {
  state: EngineState;
  a: ArmySt;
  m: MissionSt;
  def: MissionDef;
  g: GenSt;
  n: NationId;
  L: AiLevelBalance;
  A: Aggr;
  T: GeneralTraitDef;
}

/** Profil tactique du général (niveau d'IA synthétisé d'après ses compétences et ses traits). */
export function levelFor(
  state: EngineState,
  g: GenSt,
  m: MissionSt,
  def: MissionDef,
): AiLevelBalance {
  const base = aiLevelCfg(state, 'normal');
  const A = cmdBal(state).aggressiveness[m.aggr];
  const T = traitSum(state, g.traits);
  const s = g.skills;
  const audacity = (50 - s.audacity) / 100; // prudent > 0, audacieux < 0
  return {
    ...base,
    attackRatio: Math.max(0.8, A.attackRatio + T.attackRatio + audacity * 0.6),
    groupMax: 3 + Math.floor(s.offense / 35) + (s.logistics >= 60 ? 1 : 0),
    maxOffensivePerThink: Math.max(
      1,
      1 + Math.floor(s.offense / 45) + Math.round(A.objectives + T.objectives),
    ),
    maxCounterPerThink: 1 + Math.floor(s.defense / 50),
    counterattack: m.aggr !== 'cautious' || s.defense >= 50,
    defendCities: true,
    rally: s.logistics >= 40 || T.rally,
    amphibious: def.brain === 'landing' || s.naval >= 30,
    escortShips: Math.min(4, Math.floor(s.naval / 30) + T.escorts),
    airEscorts: Math.min(3, Math.floor(s.air / 35) + T.escorts),
    sead: s.air >= 45,
    pathBudget: 6 + Math.round(s.logistics / 12),
    capitalGarrison: 0,
  };
}

/** Pile disponible pour le général : ni ordre manuel en cours, ni au repos. */
function commanded(state: EngineState, a: ArmySt): string[] {
  return a.units.filter((id) => {
    const u = state.units[id];
    return !!u && u.owner === a.owner && !a.manual[id] && !a.rest?.[id];
  });
}

/** Provinces déjà visées par les autres armées de la nation. */
function otherAims(state: EngineState, a: ArmySt): ProvinceId[] {
  const c = cmd(state);
  const out = new Set<ProvinceId>();
  for (const id of Object.keys(c.armies).sort()) {
    const b = c.armies[id]!;
    if (b.id === a.id || b.owner !== a.owner) continue;
    for (const pid of Object.keys(b.mem.ops ?? {})) out.add(pid);
    for (const k of Object.keys(b.mem.commit ?? {})) out.add(b.mem.commit![k]![0]);
  }
  return [...out].sort();
}

function scopeOf(
  t: Think,
  zone: { at: LngLat; r: number } | null,
  extra?: Partial<AiLevelBalance>,
): ArmyScope {
  return {
    units: new Set(commanded(t.state, t.a)),
    L: extra ? { ...t.L, ...extra } : t.L,
    mem: t.a.mem,
    zone,
    aimed: otherAims(t.state, t.a),
  };
}

function cityOf(state: EngineState, pid: ProvinceId): LngLat {
  return wi(state.world).provById.get(pid)!.cityPoint;
}

/** Piles aériennes commandées (aéronefs à carburant). */
function airUnits(state: EngineState, a: ArmySt): Unit[] {
  return commanded(state, a)
    .map((id) => state.units[id]!)
    .filter((u) => sysOf(state, u).movement === 'air' && !u.role);
}

function seaUnits(state: EngineState, a: ArmySt): Unit[] {
  return commanded(state, a)
    .map((id) => state.units[id]!)
    .filter((u) => !u.off && sysOf(state, u).movement === 'sea');
}

/** Barycentre des piles de l'armée (null si vide). */
export function centroid(state: EngineState, a: ArmySt): LngLat | null {
  let x = 0;
  let y = 0;
  let k = 0;
  let ref: number | null = null;
  for (const id of a.units) {
    const u = state.units[id];
    if (!u || u.off) continue;
    const p = unitPosAt(state, u, state.time);
    let lng = p[0];
    if (ref === null) ref = lng;
    else if (lng - ref > 180) lng -= 360;
    else if (ref - lng > 180) lng += 360;
    x += lng;
    y += p[1];
    k++;
  }
  if (!k) return null;
  let cx = x / k;
  if (cx > 180) cx -= 360;
  if (cx < -180) cx += 360;
  return [cx, y / k];
}

// ——— Guerre et autorisations ———

/**
 * La guerre contre `o` est-elle ouverte ? Règles d'engagement libres ou autorisation déjà donnée : le
 * général la déclare ; sinon il demande l'autorisation au joueur (mission en attente).
 */
function ensureWar(t: Think, o: NationId): boolean {
  const { state, a, m, n } = t;
  if (atWar(state, n, o)) return true;
  if (m.roe === 'free' || m.okWar?.includes(o)) {
    if (order(state, n, { kind: 'declareWar', nationId: o }) && atWar(state, n, o)) {
      journal(state, a, 'declaredWar', { nation: { nation: o } }, 'warn');
      return true;
    }
    journal(state, a, 'warBlocked', { nation: { nation: o } }, 'bad');
    a.suspended = true;
    a.status = 'suspended';
    return false;
  }
  ask(t, 'declare_war', o);
  return false;
}

function ask(t: Think, kind: 'declare_war' | 'strategic_strike', o: NationId): void {
  const { state, a, g } = t;
  a.request = { id: nextCmdId(state, 'r'), kind, nationId: o, at: state.time };
  a.status = 'awaiting';
  const params = { army: a.name, general: fullName(g), nation: { nation: o } };
  notifyOwner(state, a.owner, kind === 'declare_war' ? 'askWar' : 'askStrike', params, 'warn');
  journal(
    state,
    a,
    kind === 'declare_war' ? 'askWar' : 'askStrike',
    { nation: { nation: o } },
    'warn',
  );
}

// ——— Repli et renforts ———

/** Piles trop éprouvées : repli vers la ville amie la plus proche ; retour quand elles sont remises. */
function retreat(t: Think): void {
  const { state, a, m, n, T } = t;
  a.rest ??= {};
  const threshold = Math.max(0, Math.min(0.9, m.retreatAt + T.retreatAt));
  for (const id of sortedKeys(a.rest)) {
    const u = state.units[id];
    if (
      !u ||
      u.owner !== n ||
      u.hp / Math.max(1, u.maxHp) >= Math.min(0.95, threshold + cmdBal(state).tactics.restMargin)
    )
      delete a.rest[id];
  }
  if (threshold <= 0) return;
  const w = wi(state.world);
  for (const id of commanded(state, a)) {
    const u = state.units[id]!;
    const s = sysOf(state, u);
    if (u.off || s.movement !== 'land' || s.speedKmh <= 0) continue;
    if (u.hp / Math.max(1, u.maxHp) >= threshold) continue;
    const here = unitPosAt(state, u, state.time);
    let best: ProvinceId | null = null;
    let bd = Infinity;
    for (const pid of provincesOf(state, n)) {
      const d = distanceKm(w.provById.get(pid)!.cityPoint, here);
      if (d < bd) {
        bd = d;
        best = pid;
      }
    }
    a.rest[id] = 1;
    if (!best) continue;
    const to = cityOf(state, best);
    if (bd > CAPTURE_RADIUS_KM && safeLegs(state, n, u, to))
      order(state, n, { kind: 'move', unitIds: [id], to });
    journal(
      state,
      a,
      'retreat',
      { system: { system: s.id }, province: { province: best } },
      'warn',
    );
  }
}

/** Effectifs sous le seuil : piles libres proches proposées (ou intégrées d'office). */
function reinforcements(t: Think, shortfall = 0): void {
  const { state, a, g, n } = t;
  const R = cmdBal(state).reinforce;
  if (a.reinforce === 'off' || a.request || state.time < a.askAfter || a.start <= 0) return;
  if (shortfall <= 0 && a.now >= R.triggerShare * a.start) return;
  a.askAfter = state.time + R.cooldownHours * HOUR;
  const c = cmd(state);
  const at = centroid(state, a);
  if (!at) return;
  const domains = new Set<string>(shortfall > 0 ? ['land'] : t.def.domains);
  if (shortfall <= 0)
    for (const id of a.units) {
      const u = state.units[id];
      if (u) domains.add(sysOf(state, u).movement);
    }
  const w = wi(state.world);
  const capId = w.nationById.get(n)?.capitalProvinceId;
  const cap = capId ? w.provById.get(capId)?.cityPoint : null;
  const cands: { id: string; d: number; v: number }[] = [];
  for (const id of sortedKeys(state.units)) {
    const u = state.units[id]!;
    if (u.owner !== n || u.role || u.off || c.unitArmy[id] || u.move || u.target) continue;
    const s = sysOf(state, u);
    if (!domains.has(s.movement) || s.speedKmh <= 0) continue;
    const p = unitPosAt(state, u, state.time);
    // La garnison de la capitale reste chez elle.
    if (cap && distanceKm(p, cap) <= CAPTURE_RADIUS_KM * 2) continue;
    const d = distanceKm(p, at);
    if (d > R.reachKm) continue;
    cands.push({ id, d, v: unitValue(state, u) });
  }
  cands.sort((x, y) => x.d - y.d || (x.id < y.id ? -1 : 1));
  const want = shortfall > 0 ? shortfall : a.start - a.now;
  const pick: string[] = [];
  let got = 0;
  for (const x of cands) {
    if (pick.length >= R.maxPiles || got >= want) break;
    pick.push(x.id);
    got += x.v;
  }
  if (!pick.length) {
    journal(state, a, 'noReinforcements', {}, 'warn');
    return;
  }
  if (a.reinforce === 'auto') {
    addUnits(state, a, pick);
    a.start += got;
    journal(state, a, 'reinforced', { count: pick.length }, 'good');
    return;
  }
  a.request = { id: nextCmdId(state, 'r'), kind: 'reinforce', unitIds: pick, at: state.time };
  notifyOwner(
    state,
    n,
    'askReinforce',
    { army: a.name, general: fullName(g), count: pick.length },
    'info',
  );
  journal(state, a, 'askReinforce', { count: pick.length }, 'info');
}

/**
 * Aucune offensive possible faute de forces : le général le dit (journal espacé de 12 h) et demande
 * des renforts terrestres à la mesure du manque.
 */
function tooWeak(t: Think, ctx: Ctx, need: number): void {
  const { state, a } = t;
  if (need <= 0) return;
  let have = 0;
  for (const m of ctx.land)
    if (ctx.idle.has(m.u.id) && (m.ground || m.s.canCapture)) have += m.value;
  if (have >= need) return;
  if (
    a.weakAt === undefined ||
    state.time - a.weakAt >= cmdBal(state).tactics.weakNoticeHours * HOUR
  ) {
    a.weakAt = state.time;
    journal(state, a, 'tooWeak', { pct: Math.round((100 * have) / need) }, 'warn');
  }
  reinforcements(t, need - have);
}

// ——— Aviation ———

/**
 * Appui aérien d'une offensive ou d'une zone : couverture de chasse au-dessus de l'objectif principal
 * (si l'aviation ennemie se montre, ou d'office en mode audacieux), frappes sur les défenses
 * antiaériennes identifiées (suppression) puis sur les forces terrestres qui tiennent les objectifs.
 */
function airSupport(t: Think, objectives: LngLat[], forceCover: boolean): void {
  const { state, a, g, n, L, A, T } = t;
  if (!objectives.length) return;
  const air = airUnits(state, a);
  if (!air.length) return;
  const main = objectives[0]!;
  const seen = visibleEnemies(state, n);
  const fighters = air.filter((u) => isFighter(sysOf(state, u)));
  const K = cmdBal(state).tactics;
  const hostileAir = seen.airAt.some((p) => distanceKm(p, main) <= K.airThreatKm);
  const want =
    hostileAir || forceCover || A.objectives > 0
      ? Math.ceil(fighters.length * A.airShare)
      : Math.min(fighters.length, L.airEscorts);
  if (want > 0) cover(state, n, air, main, want);
  if (!seen.threats.length) return;
  let sorties = 1 + Math.floor(g.skills.air / 34) + T.sorties;
  const near = (p: LngLat, km: number) => objectives.some((o) => distanceKm(o, p) <= km);
  const sams = L.sead ? seen.threats.filter((x) => isSam(x.sys) && near(x.pos, K.seadKm)) : [];
  const ground = seen.threats.filter(
    (x) => x.sys?.movement === 'land' && !isSam(x.sys) && near(x.pos, K.supportKm),
  );
  if (!sams.length && !ground.length) return;
  for (const u of air) {
    if (sorties <= 0) break;
    const s = sysOf(state, u);
    if (!isStriker(s) || !ready(state, u)) continue;
    const here = unitPosAt(state, u, state.time);
    const pick = (list: Seen[]) =>
      list
        .filter((x) => s.damage[x.sys!.targetClass] > 0)
        .sort(
          (p, q) => distanceKm(p.pos, here) - distanceKm(q.pos, here) || (p.u.id < q.u.id ? -1 : 1),
        )[0];
    const tg = pick(sams) ?? pick(ground);
    if (!tg || !canFly(state, n, u, tg.pos)) continue;
    if (
      order(state, n, {
        kind: 'strike',
        unitIds: [u.id],
        target: { type: 'unit', unitId: tg.u.id },
      })
    ) {
      sorties--;
      escortStrike(state, n, air, tg.pos, L.airEscorts, u);
    }
  }
}

/** Avion radar en orbite au-dessus de la zone (un seul). */
function awacs(t: Think, at: LngLat): void {
  const { state, a, n } = t;
  const ms = mil(state).ms;
  const air = airUnits(state, a).filter((u) => isAew(sysOf(state, u)));
  if (!air.length || air.some((u) => ms[u.id]?.mis === 'awacs' || ms[u.id]?.up)) return;
  for (const u of air) {
    if (!ready(state, u) || !canFly(state, n, u, at)) continue;
    if (order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: 100 })) return;
  }
}

/** Chasseurs en patrouille au-dessus de la zone (une part, le reste en alerte au sol). */
function airPatrol(t: Think, at: LngLat, r: number, share: number): void {
  const { state, a, n, T } = t;
  const ms = mil(state).ms;
  const fighters = airUnits(state, a).filter((u) => isFighter(sysOf(state, u)));
  if (!fighters.length) return;
  const want = Math.min(fighters.length, Math.ceil(fighters.length * share) + T.sorties);
  const radius = Math.max(30, Math.min(400, r));
  let on = 0;
  for (const u of fighters) {
    const x = ms[u.id];
    if (x && (x.mis === 'patrol' || x.mis === 'escort') && x.at && distanceKm(x.at, at) <= r + 50)
      on++;
  }
  let tries = 6;
  for (const u of fighters) {
    if (on >= want || tries <= 0) break;
    const x = ms[u.id];
    if (x?.mis === 'patrol' || !ready(state, u)) continue;
    tries--;
    if (!canFly(state, n, u, at)) continue;
    if (order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: radius })) on++;
  }
}

/** Frappes sur les défenses antiaériennes identifiées d'une zone (suppression). */
function seadIn(t: Think, at: LngLat, r: number): void {
  const { state, a, g, n, L, T } = t;
  if (!L.sead) return;
  const seen = visibleEnemies(state, n);
  const sams = seen.threats.filter((x) => isSam(x.sys) && distanceKm(x.pos, at) <= r);
  if (!sams.length) return;
  const air = airUnits(state, a);
  let sorties = 1 + Math.floor(g.skills.air / 40) + T.sorties;
  for (const u of air) {
    if (sorties <= 0) break;
    const s = sysOf(state, u);
    if (!isStriker(s) || !ready(state, u)) continue;
    const tg = sams.find((x) => s.damage[x.sys!.targetClass] > 0 && canFly(state, n, u, x.pos));
    if (!tg) continue;
    if (
      order(state, n, {
        kind: 'strike',
        unitIds: [u.id],
        target: { type: 'unit', unitId: tg.u.id },
      })
    ) {
      sorties--;
      escortStrike(state, n, air, tg.pos, L.airEscorts, u);
    }
  }
}

// ——— Défense antiaérienne au sol ———

/** Défenses sol-air de l'armée réparties sur les villes à couvrir (une par ville, par importance). */
function placeAirDefense(t: Think, holds: ProvinceId[]): void {
  const { state, a, n } = t;
  const gc = state.world.balance.combat.groundContactKm;
  const ads = commanded(state, a)
    .map((id) => state.units[id]!)
    .filter((u) => {
      const s = sysOf(state, u);
      return !u.off && s.category === 'air_defense' && s.movement === 'land' && s.speedKmh > 0;
    });
  if (!ads.length || !holds.length) return;
  const dest = (u: Unit): LngLat => {
    const legs = u.move?.legs;
    return legs?.length ? legs[legs.length - 1]!.to : unitPosAt(state, u, state.time);
  };
  const free = new Set(ads.map((u) => u.id));
  const covered = new Set<ProvinceId>();
  for (const pid of holds) {
    const c = cityOf(state, pid);
    const there = ads.find((u) => free.has(u.id) && distanceKm(dest(u), c) <= gc);
    if (there) {
      free.delete(there.id);
      covered.add(pid);
    }
  }
  for (const pid of holds) {
    if (covered.has(pid) || !free.size) continue;
    const c = cityOf(state, pid);
    const u = ads
      .filter((x) => free.has(x.id) && !x.move)
      .sort(
        (p, q) =>
          distanceKm(unitPosAt(state, p, state.time), c) -
            distanceKm(unitPosAt(state, q, state.time), c) || (p.id < q.id ? -1 : 1),
      )[0];
    if (!u) break;
    free.delete(u.id);
    if (safeLegs(state, n, u, c)) order(state, n, { kind: 'move', unitIds: [u.id], to: c });
  }
}

// ——— Missions ———

const STRATEGIC: Partial<Record<BuildingType, number>> = {
  air_defense_site: 5,
  radar_station: 4,
  air_base: 3,
  military_base: 2.5,
  arms_factory: 2.5,
  refinery: 2,
  power_plant: 2,
  naval_base: 1.5,
  electronics_plant: 1,
  research_center: 1,
};

function bordersOwned(state: EngineState, n: NationId, pid: ProvinceId): number {
  const def = wi(state.world).provById.get(pid);
  let k = 0;
  for (const x of def?.neighbors ?? []) if (state.provinces[x]?.owner === n) k++;
  return k;
}

/** Conquérir : provinces de la cible, les plus intéressantes et les moins défendues d'abord. */
function brainConquer(t: Think): void {
  const { state, a, m, n, L, g, T } = t;
  const remaining = (m.targets ?? []).filter((p) => state.provinces[p]?.owner !== n);
  const owners = [...new Set(remaining.map((p) => state.provinces[p]!.owner))].sort();
  for (const o of owners) if (!ensureWar(t, o)) return;
  const enemy = remaining.filter((p) => atWar(state, n, state.provinces[p]!.owner));
  if (!enemy.length) return;
  const ctx = armyContext(state, n, scopeOf(t, null));
  stopNeutralChases(ctx);
  defend(ctx);
  runOps(ctx);
  runTransports(ctx);
  const at = centroid(state, a) ?? cityOf(state, enemy[0]!);
  const links = L.amphibious ? seaLinks(state) : null;
  const w = wi(state.world);
  const off = g.skills.offense / 100;
  const cands: { pid: ProvinceId; owner: NationId; score: number; from: ProvinceId | null }[] = [];
  for (const pid of enemy) {
    if (ctx.aimed.has(pid) || (ctx.failed[pid] ?? 0) > state.time) continue;
    const owner = state.provinces[pid]!.owner;
    const own = bordersOwned(state, n, pid);
    let from: ProvinceId | null = null;
    if (!own && links) {
      let bd = Infinity;
      for (const q of links.get(pid) ?? []) {
        if (state.provinces[q]?.owner !== n) continue;
        const d = distanceKm(cityOf(state, q), at);
        if (d < bd) {
          bd = d;
          from = q;
        }
      }
    }
    const def = w.provById.get(pid)!;
    const capital = w.nationById.get(owner)?.capitalProvinceId === pid;
    const worth = (capital ? 1.5 : 1) * (1 + Math.log10(1 + def.income.money));
    const hold = ctx.hold.get(pid) ?? 0;
    const d = distanceKm(def.cityPoint, at);
    // Un général offensif pèse la valeur de l'objectif ; un général médiocre prend le plus proche.
    const score =
      (Math.pow(worth, off) / (1 + (2 * hold) / ctx.mine.avgUnit)) *
      (1 / (1 + d / (300 + 6 * g.skills.offense))) *
      (own ? 1 : from ? 0.6 : 0.4) *
      (1 + T.encircle * Math.max(0, own - 1));
    cands.push({ pid, owner, score, from });
  }
  cands.sort((x, y) => y.score - x.score || (x.pid < y.pid ? -1 : 1));
  let launched = 0;
  let tries = 0;
  for (const c of cands) {
    if (launched >= L.maxOffensivePerThink || ctx.paths <= 0 || tries >= 4) break;
    tries++;
    const need = needFor(ctx, c.pid, c.owner) * (c.from ? ctx.T.amphibiousRatio : 1);
    if (launchGroup(ctx, c.pid, need, c.from)) {
      launched++;
      m.progressAt = state.time;
      journal(state, a, 'offensive', { province: { province: c.pid } });
    }
  }
  if (
    !launched &&
    cands.length &&
    !Object.keys(ctx.ops).length &&
    !Object.keys(ctx.commit).length
  ) {
    const c0 = cands[0]!;
    tooWeak(t, ctx, needFor(ctx, c0.pid, c0.owner) * (c0.from ? ctx.T.amphibiousRatio : 1));
  }
  const aims = aimsOf(ctx);
  a.aims = aims.map((p) => cityOf(state, p));
  airSupport(t, a.aims.length ? a.aims : [cityOf(state, enemy[0]!)], false);
  if (ctx.ops && Object.keys(ctx.ops).length && !launched) a.status = 'preparing';
}

function aimsOf(ctx: Ctx): ProvinceId[] {
  const out = new Set<ProvinceId>(Object.keys(ctx.ops));
  for (const k of Object.keys(ctx.commit)) out.add(ctx.commit[k]![0]);
  for (const k of Object.keys(ctx.mem?.tr ?? {})) out.add(ctx.mem!.tr![k]!.pid);
  return [...out].sort().slice(0, 6);
}

/** Débarquement : rassemblement au port, navire de transport, escorte, traversée et prise. */
function brainLanding(t: Think): void {
  const { state, a, m, n, L } = t;
  const pid = m.targets?.[0];
  if (!pid || state.provinces[pid]?.owner === n) return;
  const owner = state.provinces[pid]!.owner;
  if (!ensureWar(t, owner)) return;
  const ctx = armyContext(state, n, scopeOf(t, null, { amphibious: true, rally: true }));
  stopNeutralChases(ctx);
  runOps(ctx);
  runTransports(ctx);
  const landing = wi(state.world).seaSpawn.get(pid) ?? cityOf(state, pid);
  const busy = !!ctx.ops[pid] || Object.values(ctx.mem?.tr ?? {}).some((x) => x.pid === pid);
  if (!busy && !ctx.aimed.has(pid) && (ctx.failed[pid] ?? 0) <= state.time) {
    const at = centroid(state, a) ?? landing;
    let from: ProvinceId | null = null;
    let bd = Infinity;
    const consider = (q: ProvinceId) => {
      if (state.provinces[q]?.owner !== n || !wi(state.world).seaSpawn.get(q)) return;
      const d = distanceKm(cityOf(state, q), at) + distanceKm(cityOf(state, q), landing);
      if (d < bd) {
        bd = d;
        from = q;
      }
    };
    for (const q of seaLinks(state).get(pid) ?? []) consider(q);
    if (!from) for (const q of portsOf(state, n)) consider(q);
    if (from) {
      const prior = landingPrior(state, n, owner);
      const need = Math.max(needFor(ctx, pid, owner), prior) * ctx.T.amphibiousRatio;
      if (launchGroup(ctx, pid, need, from)) {
        m.progressAt = state.time;
        journal(state, a, 'landing', { province: { province: pid } });
      } else tooWeak(t, ctx, need);
    }
  }
  a.aims = [landing, cityOf(state, pid)];
  const active = !!ctx.ops[pid] || Object.values(ctx.mem?.tr ?? {}).some((x) => x.pid === pid);
  if (active) {
    const fighters = airUnits(state, a).filter((u) => isFighter(sysOf(state, u)));
    if (fighters.length) cover(state, n, fighters, landing, Math.max(1, L.airEscorts));
  }
  airSupport(t, [cityOf(state, pid)], false);
}

/** Part supposée des forces publiques de l'ennemi dans une province côtière qu'on ne voit pas. */
function landingPrior(state: EngineState, n: NationId, owner: NationId): number {
  const provs = Math.max(1, state.nations[owner]?.provinceCount ?? 1);
  return (
    (estimateForce(state, n, owner, ownForce(state, n), 1) / provs) *
    cmdBal(state).tactics.blindShare
  );
}

/** Villes à tenir encore à soi, la plus importante d'abord (capitale, menace, revenu). */
function holdsOrdered(t: Think, ctx: Ctx, holds: ProvinceId[]): ProvinceId[] {
  const { state, n } = t;
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  return holds
    .filter((p) => state.provinces[p]?.owner === n)
    .sort(
      (x, y) =>
        Number(y === cap) - Number(x === cap) ||
        (ctx.threat.get(y) ?? 0) - (ctx.threat.get(x) ?? 0) ||
        w.provById.get(y)!.income.money - w.provById.get(x)!.income.money ||
        (x < y ? -1 : 1),
    );
}

/** Défendre une zone, Défense antiaérienne, Réserve. */
function brainZone(t: Think, kind: 'defend' | 'air_defense' | 'reserve'): void {
  const { state, a, m, n, L, A, g } = t;
  const at = m.at!;
  const r = m.radiusKm ?? 150;
  const zone = { at, r: kind === 'reserve' ? r : r * A.pursuit };
  const ctx = armyContext(state, n, scopeOf(t, zone));
  stopNeutralChases(ctx);
  if (kind !== 'air_defense') defend(ctx);
  runOps(ctx);
  const holds = holdsOrdered(t, ctx, m.holds ?? []);
  if (kind !== 'air_defense' && L.counterattack) {
    const lost = (m.holds ?? []).filter((p) => {
      const P = state.provinces[p];
      return !!P && P.owner !== n && atWar(state, n, P.owner);
    });
    let k = 0;
    for (const pid of lost) {
      if (k >= L.maxCounterPerThink || ctx.paths <= 0) break;
      if (launchGroup(ctx, pid, needFor(ctx, pid, state.provinces[pid]!.owner))) {
        k++;
        journal(state, a, 'counter', { province: { province: pid } });
      }
    }
  }
  // Les piles de l'armée viennent de loin s'il le faut (elles lui appartiennent toutes).
  const reach = Math.max(r * 2 + 600, cmdBal(state).tactics.reachKm);
  if (kind === 'reserve') {
    // Position d'attente : la ville amie la plus proche du point choisi.
    let hub: ProvinceId | null = null;
    let bd = Infinity;
    for (const pid of provincesOf(state, n)) {
      const d = distanceKm(cityOf(state, pid), at);
      if (d < bd) {
        bd = d;
        hub = pid;
      }
    }
    if (hub) garrison(ctx, hub, ctx.land.length, 0, 0, false, reach);
    a.aims = hub ? [cityOf(state, hub)] : [];
  } else if (kind === 'defend' && holds.length) {
    const per = Math.max(1, Math.floor(ctx.land.length / holds.length));
    const extra = Math.floor(g.skills.defense / 40);
    holds.forEach((pid, i) => {
      const threat = ctx.threat.get(pid) ?? 0;
      garrison(ctx, pid, per + (i === 0 ? extra : 0), threat * L.attackRatio, 0.6, false, reach);
    });
    a.aims = holds.slice(0, 4).map((p) => cityOf(state, p));
  } else {
    a.aims = holds.slice(0, 4).map((p) => cityOf(state, p));
  }
  if (kind !== 'reserve') placeAirDefense(t, holds);
  // Aviation : patrouille dès qu'une menace aérienne approche (ou d'office en mode audacieux).
  const seen = visibleEnemies(state, n);
  const T2 = cmdBal(state).tactics.airThreatKm;
  const threat = seen.airAt.some((p) => distanceKm(p, at) <= r + T2);
  if (threat || m.aggr === 'bold') {
    airPatrol(t, at, r, kind === 'air_defense' ? 1 : A.airShare);
    awacs(t, at);
  }
  if (kind === 'defend') {
    const ground = seen.threats.filter(
      (x) => x.sys?.movement === 'land' && distanceKm(x.pos, at) <= r,
    );
    if (ground.length) airSupport(t, [ground[0]!.pos], false);
  }
}

/** Tenir la ligne de front : piles réparties sur les villes frontalières, contre-attaques. */
function brainFront(t: Think): void {
  const { state, a, m, n, L } = t;
  const w = wi(state.world);
  const enemyOf = (o: NationId) => (m.nationId ? o === m.nationId : atWar(state, n, o));
  const front = provincesOf(state, n)
    .filter((p) =>
      (w.provById.get(p)?.neighbors ?? []).some((x) => {
        const o = state.provinces[x]?.owner;
        return !!o && o !== n && enemyOf(o);
      }),
    )
    .sort();
  if (!front.length) {
    a.aims = [];
    return;
  }
  const ctx = armyContext(state, n, scopeOf(t, null));
  stopNeutralChases(ctx);
  defend(ctx);
  runOps(ctx);
  if (L.counterattack) {
    const before = Object.keys(ctx.ops).length;
    counterattack(ctx);
    if (Object.keys(ctx.ops).length > before) journal(state, a, 'counterFront');
  }
  const ordered = front.sort(
    (x, y) =>
      (ctx.threat.get(y) ?? 0) - (ctx.threat.get(x) ?? 0) ||
      w.provById.get(y)!.income.money - w.provById.get(x)!.income.money ||
      (x < y ? -1 : 1),
  );
  const slots = Math.min(ordered.length, Math.max(1, ctx.land.length));
  const per = Math.max(1, Math.floor(ctx.land.length / slots));
  for (const pid of ordered.slice(0, slots)) {
    const threat = ctx.threat.get(pid) ?? 0;
    garrison(ctx, pid, per, threat * L.attackRatio, 0.6, false, 2500);
  }
  a.aims = ordered.slice(0, 6).map((p) => cityOf(state, p));
  placeAirDefense(t, ordered);
}

/** Supériorité aérienne / contrôle aérien total : patrouilles de chasse, avion radar, suppression. */
function brainAir(t: Think): void {
  const { m, A } = t;
  const at = m.at!;
  const r = m.radiusKm ?? 250;
  airPatrol(t, at, r, A.airShare);
  awacs(t, at);
  if (m.aggr !== 'cautious') seadIn(t, at, r);
  t.a.aims = [at];
}

/** Contrôle maritime et blocus : patrouille sur zone, navires ennemis attaqués, ports bloqués. */
function brainSea(t: Think): void {
  const { state, a, m, n, def } = t;
  const at = m.at!;
  const r = m.radiusKm ?? 300;
  const ctx = armyContext(state, n, scopeOf(t, { at, r }));
  stopNeutralChases(ctx);
  defend(ctx);
  const msx = mil(state).ms;
  const blk = mil(state).blk;
  const ships = seaUnits(state, a).filter((u) => !u.move && !u.target && capacityOf(state, u) <= 0);
  const idle = ships.filter((u) => {
    const x = msx[u.id]?.mis;
    return !x || x === 'none';
  });
  if (def.blockade) {
    const blocked = new Set<string>();
    for (const id of sortedKeys(blk)) {
      const b = blk[id]!;
      if (b.by === n && 'provinceId' in b.target) blocked.add(b.target.provinceId);
    }
    const w = wi(state.world);
    let left = Math.floor(ships.length / 2);
    for (const e of [...(state.rt.enemies.get(n) ?? [])].sort()) {
      for (const pid of portsOf(state, e)) {
        if (left <= 0 || !idle.length) break;
        const sp = w.seaSpawn.get(pid);
        if (!sp || blocked.has(pid) || distanceKm(sp, at) > r) continue;
        const ship = idle
          .slice()
          .sort(
            (p, q) =>
              distanceKm(unitPosAt(state, p, state.time), sp) -
                distanceKm(unitPosAt(state, q, state.time), sp) || (p.id < q.id ? -1 : 1),
          )[0]!;
        if (!safeLegs(state, n, ship, sp)) continue;
        if (
          order(state, n, { kind: 'blockade', unitIds: [ship.id], target: { provinceId: pid } })
        ) {
          idle.splice(idle.indexOf(ship), 1);
          blocked.add(pid);
          left--;
          journal(state, a, 'blockade', { province: { province: pid } });
        }
      }
    }
  }
  const radius = Math.max(20, Math.min(200, r));
  for (const u of idle) {
    if (distanceKm(unitPosAt(state, u, state.time), at) <= radius) continue;
    if (!safeLegs(state, n, u, at)) continue;
    order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: radius });
  }
  a.aims = [at];
  airPatrol(t, at, r, 0.5);
}

/** Frappes en profondeur sur les installations de la cible révélées par le renseignement. */
function brainDeep(t: Think): void {
  const { state, a, m, n, g, L, T } = t;
  const o = m.nationId;
  if (!o || !state.nations[o]?.alive) return;
  if (!ensureWar(t, o)) return;
  if (m.roe !== 'free' && !m.okStrike) {
    ask(t, 'strategic_strike', o);
    return;
  }
  const cands = strategicTargets(state, n, o);
  if (!cands.length) {
    if (!m.doneAt || state.time - m.doneAt >= cmdBal(state).tactics.noIntelNoticeHours * HOUR) {
      m.doneAt = state.time;
      journal(state, a, 'noIntel', { nation: { nation: o } }, 'warn');
    }
    a.aims = [];
    return;
  }
  const busy = new Set<string>();
  const ms = mil(state).ms;
  for (const id of sortedKeys(ms)) {
    const tg = ms[id]!.tg;
    if (ms[id]!.mis === 'strike' && tg?.type === 'building')
      busy.add(`${tg.provinceId}:${tg.building}`);
  }
  const air = airUnits(state, a);
  const strikers = air.filter((u) => {
    const s = sysOf(state, u);
    return isStriker(s) && s.damage.building > 0 && ready(state, u);
  });
  const seen = visibleEnemies(state, n);
  const sams = L.sead ? seen.threats.filter((x) => isSam(x.sys)) : [];
  let sorties = 1 + Math.floor(g.skills.air / 30) + T.sorties;
  let struck = false;
  let tries = 8;
  for (const c of cands) {
    if (sorties <= 0 || tries <= 0 || !strikers.length) break;
    if (busy.has(`${c.pid}:${c.b}`)) continue;
    tries--;
    const i = strikers.findIndex((u) => canFly(state, n, u, c.at));
    if (i < 0) continue;
    const u = strikers[i]!;
    const here = unitPosAt(state, u, state.time);
    const sam = sams.find(
      (x) =>
        distanceKm(x.pos, c.at) <= (x.sys?.weaponRangeKm.max ?? 0) + 10 || onRoute(x, here, c.at),
    );
    if (sam && (sysOf(state, u).damage[sam.sys!.targetClass] <= 0 || !canFly(state, n, u, sam.pos)))
      continue;
    const target: StrikeTarget = sam
      ? { type: 'unit', unitId: sam.u.id }
      : { type: 'building', provinceId: c.pid, building: c.b };
    strikers.splice(i, 1);
    if (order(state, n, { kind: 'strike', unitIds: [u.id], target })) {
      sorties--;
      struck = true;
      busy.add(`${c.pid}:${c.b}`);
      escortStrike(state, n, air, sam ? sam.pos : c.at, L.airEscorts, u);
      if (sam) sams.splice(sams.indexOf(sam), 1);
      else
        journal(state, a, 'strike', {
          province: { province: c.pid },
          building: { key: `engine.cmd.building.${c.b}` },
        });
    }
  }
  // Lanceurs de missiles et navires de l'armée : salves sur la première installation à portée.
  for (const id of commanded(state, a)) {
    const u = state.units[id]!;
    if (u.off) continue;
    const s = sysOf(state, u);
    const ship = s.movement === 'sea' && launchCells(s) > 0 && cellsLeft(state, u) > 0;
    if (!isLauncher(s) && !ship) continue;
    const msys = isLauncher(s) ? s : missileForShip(state, s, false);
    if (!msys || msys.missile?.warhead === 'nuclear' || msys.damage.building <= 0) continue;
    if ((mil(state).reload[u.id] ?? 0) > state.time) continue;
    const here = unitPosAt(state, u, state.time);
    const c = cands.find((x) => distanceKm(x.at, here) <= strikeRangeKm(msys));
    if (!c) continue;
    const ord: Order = isLauncher(s)
      ? {
          kind: 'strike',
          unitIds: [u.id],
          target: { type: 'building', provinceId: c.pid, building: c.b },
          count: Math.min(u.count, 4),
        }
      : {
          kind: 'strike',
          unitIds: [u.id],
          target: { type: 'building', provinceId: c.pid, building: c.b },
        };
    if (order(state, n, ord)) struck = true;
  }
  a.aims = cands.slice(0, 4).map((c) => c.at);
  if (struck) m.progressAt = state.time;
}

/** Installations de la cible révélées (et encore en état), par priorité stratégique. */
export function strategicTargets(
  state: EngineState,
  n: NationId,
  o: NationId,
): { pid: ProvinceId; b: BuildingType; at: LngLat; score: number }[] {
  const out: { pid: ProvinceId; b: BuildingType; at: LngLat; score: number }[] = [];
  const health = board(state).buildingHealth ?? {};
  for (const pid of provincesOf(state, o).sort()) {
    const k = knowledge(state, n, pid);
    if (!k || (k.m <= 0 && k.e <= 0)) continue;
    const at = cityOf(state, pid);
    for (const b of revealed(pid, buildingsOf(state, pid), k)) {
      const pr = STRATEGIC[b];
      if (!pr) continue;
      if ((health[pid]?.[b] ?? 1) <= 0) continue;
      out.push({ pid, b, at, score: pr });
    }
  }
  out.sort(
    (x, y) => y.score - x.score || (x.pid < y.pid ? -1 : x.pid > y.pid ? 1 : x.b < y.b ? -1 : 1),
  );
  return out;
}

const BRAINS: Record<string, (t: Think) => void> = {
  conquer: brainConquer,
  landing: brainLanding,
  defend: (t) => brainZone(t, 'defend'),
  air_defense: (t) => brainZone(t, 'air_defense'),
  reserve: (t) => brainZone(t, 'reserve'),
  hold_front: brainFront,
  air_superiority: brainAir,
  sea_control: brainSea,
  deep_strike: brainDeep,
};

/** Une pile a-t-elle fini l'ordre manuel du joueur (immobile, sans cible, aéronef posé) ? */
function manualDone(state: EngineState, u: Unit): boolean {
  if (u.move || u.target) return false;
  const M = mil(state);
  const ms = M.ms[u.id];
  if (ms && ms.mis !== 'none') return false;
  if (ms?.up) return false;
  if (M.trl?.[u.id] || M.tru?.[u.id]) return false;
  for (const id of Object.keys(M.blk)) if (M.blk[id]!.units.includes(u.id)) return false;
  return true;
}

/** Réflexion d'une armée (cadence des IA). */
export function thinkArmy(state: EngineState, a: ArmySt): void {
  const c = cmd(state);
  const n = a.owner;
  const ns = state.nations[n];
  if (!ns?.alive || state.winner) return;
  a.units = a.units.filter((id) => {
    const ok = state.units[id]?.owner === n;
    if (!ok && c.unitArmy[id] === a.id) delete c.unitArmy[id];
    return ok;
  });
  for (const id of sortedKeys(a.manual)) {
    const u = state.units[id];
    if (!u || c.unitArmy[id] !== a.id || manualDone(state, u)) delete a.manual[id];
  }
  a.now = armyValue(state, a);
  const m = a.mission;
  if (!m) {
    a.status = 'idle';
    return;
  }
  const B = cmdBal(state);
  const def = B.missions[m.type];
  if (!def) return;
  if (a.status === 'success' || a.status === 'failed') return;
  const g = a.general ? c.gens[a.general] : undefined;
  if (evaluate(state, a, def, g ?? null)) return;
  if (!g || g.status !== 'active') {
    a.status = 'passive';
    return;
  }
  if (a.suspended) {
    a.status = 'suspended';
    return;
  }
  if (a.request && a.request.kind !== 'reinforce') {
    a.status = 'awaiting';
    return;
  }
  if (a.status !== 'preparing' || state.time > m.since) a.status = 'active';
  const T = traitSum(state, g.traits);
  const t: Think = {
    state,
    a,
    m,
    def,
    g,
    n,
    L: levelFor(state, g, m, def),
    A: B.aggressiveness[m.aggr],
    T,
  };
  // Frictions : un général sans expérience perd parfois une réflexion (ordres retardés).
  const friction = B.generals.frictionMax * (1 - g.skills.experience / 100) * T.friction;
  if (cmdRoll(state) < friction) return;
  driving = true;
  try {
    retreat(t);
    reinforcements(t);
    BRAINS[def.brain]?.(t);
  } finally {
    driving = false;
  }
  a.now = armyValue(state, a);
  a.est = estimateMission(state, a, def, g, t.L);
}

// ——— Évaluation de la mission ———

function succeed(state: EngineState, a: ArmySt, g: GenSt | null, def: MissionDef): void {
  a.status = 'success';
  a.v++;
  journal(state, a, 'success', {}, 'good');
  notifyOwner(state, a.owner, 'missionSuccess', { army: a.name }, 'info');
  if (g) {
    g.victories++;
    gainXp(state, g, cmdBal(state).generals.xpSuccess, def.brain);
  }
}

function failMission(state: EngineState, a: ArmySt, reason: string): void {
  a.status = 'failed';
  a.v++;
  journal(state, a, 'failed', { reason: { key: `engine.cmd.reason.${reason}` } }, 'bad');
  notifyOwner(state, a.owner, 'missionFailed', { army: a.name }, 'warn');
}

/** Ennemis vus (aériens, navals) dans une zone. */
function enemiesIn(
  state: EngineState,
  n: NationId,
  at: LngLat,
  r: number,
  medium: string,
): boolean {
  const known = state.know[n];
  if (!known) return false;
  for (const id of sortedKeys(known)) {
    const k = known[id]!;
    const u = state.units[id];
    if (!k.seen || !u || u.off || u.role || !atWar(state, n, u.owner)) continue;
    if (sysOf(state, u).movement !== medium) continue;
    if (distanceKm(unitPosAt(state, u, state.time), at) <= r) return true;
  }
  return false;
}

/** Objectif mesurable et fin de mission (réussite, échec). Renvoie vrai si la mission est close. */
function evaluate(state: EngineState, a: ArmySt, def: MissionDef, g: GenSt | null): boolean {
  const m = a.mission!;
  const n = a.owner;
  const B = cmdBal(state);
  switch (def.brain) {
    case 'conquer':
    case 'landing': {
      const total = m.targets?.length ?? 0;
      const done = (m.targets ?? []).filter((p) => state.provinces[p]?.owner === n).length;
      a.obj = { done, total };
      if (total > 0 && done === total) {
        succeed(state, a, g, def);
        return true;
      }
      break;
    }
    case 'defend':
    case 'air_defense':
    case 'reserve':
    case 'hold_front': {
      const holds = m.holds ?? [];
      const done = holds.filter((p) => state.provinces[p]?.owner === n).length;
      a.obj = holds.length ? { done, total: holds.length } : null;
      if (holds.length && done === 0 && state.time - m.since > B.tactics.zoneLostHours * HOUR) {
        failMission(state, a, 'zoneLost');
        return true;
      }
      break;
    }
    case 'air_superiority': {
      const clear = !enemiesIn(state, n, m.at!, m.radiusKm ?? 250, 'air');
      a.obj = { done: clear ? 1 : 0, total: 1 };
      break;
    }
    case 'sea_control': {
      const clear = !enemiesIn(state, n, m.at!, m.radiusKm ?? 300, 'sea');
      a.obj = { done: clear ? 1 : 0, total: 1 };
      break;
    }
    case 'deep_strike': {
      if (m.nationId && atWar(state, n, m.nationId)) {
        const left = strategicTargets(state, n, m.nationId).length;
        const total = Math.max(left, a.obj?.total ?? 0);
        a.obj = { done: total - left, total };
        if (total > 0 && left === 0) {
          succeed(state, a, g, def);
          return true;
        }
      }
      break;
    }
  }
  if (a.start > 0 && a.now < B.failShare * a.start) {
    failMission(state, a, 'losses');
    return true;
  }
  const offensive =
    def.brain === 'conquer' || def.brain === 'landing' || def.brain === 'deep_strike';
  if (
    offensive &&
    g &&
    !a.suspended &&
    !a.request &&
    state.time - m.progressAt > B.stuckHours * HOUR
  ) {
    const weak = a.weakAt !== undefined && state.time - a.weakAt <= B.stuckHours * HOUR;
    failMission(state, a, weak ? 'tooWeak' : 'stuck');
    return true;
  }
  return false;
}

// ——— Estimation ———

const RELEVANT: Record<string, 'offense' | 'defense' | 'air' | 'naval'> = {
  conquer: 'offense',
  landing: 'naval',
  defend: 'defense',
  hold_front: 'defense',
  reserve: 'defense',
  air_superiority: 'air',
  air_defense: 'air',
  deep_strike: 'air',
  sea_control: 'naval',
};

/** Force ennemie connue (contacts vus ou récents) dans un rayon, en dollars. */
function knownNear(state: EngineState, n: NationId, at: LngLat, r: number, air?: boolean): number {
  const known = state.know[n];
  if (!known) return 0;
  const mine = ownForce(state, n);
  const memory = cmdBal(state).tactics.contactMemoryHours * HOUR;
  let v = 0;
  for (const id of sortedKeys(known)) {
    const k = known[id]!;
    const u = state.units[id];
    if (!u || u.role || !atWar(state, n, k.owner)) continue;
    if (!k.seen && state.time - k.lastSeen > memory) continue;
    if (air !== undefined && (sysOf(state, u).movement === 'air') !== air) continue;
    const p = k.seen ? unitPosAt(state, u, state.time) : k.pos;
    if (distanceKm(p, at) <= r) v += contactValue(state, k, mine);
  }
  return v;
}

/** Rapport de force, durée estimée et chances (vu par le général : contacts et estimations publiques). */
export function estimateMission(
  state: EngineState,
  a: ArmySt,
  def: MissionDef,
  g: GenSt | null,
  L: AiLevelBalance | null,
): { ratio: number; etaHours: number | null; chance: number } {
  const m = a.mission!;
  const n = a.owner;
  let enemy = 0;
  let mine = a.now;
  const at = centroid(state, a);
  let goal: LngLat | null = m.at ?? null;
  const remaining = (m.targets ?? []).filter((p) => state.provinces[p]?.owner !== n);
  switch (def.brain) {
    case 'conquer':
    case 'landing': {
      const prior = new Map<NationId, number>();
      for (const pid of remaining) {
        const o = state.provinces[pid]!.owner;
        if (!prior.has(o)) prior.set(o, landingPrior(state, n, o));
        enemy += Math.max(knownNear(state, n, cityOf(state, pid), 30), prior.get(o)!);
      }
      if (remaining.length && at) {
        goal = remaining
          .map((p) => cityOf(state, p))
          .sort((x, y) => distanceKm(x, at) - distanceKm(y, at))[0]!;
      }
      break;
    }
    case 'air_superiority':
      mine = airUnits(state, a).reduce((s, u) => s + unitValue(state, u), 0);
      enemy = knownNear(state, n, m.at!, (m.radiusKm ?? 250) + 300, true);
      break;
    case 'deep_strike':
      mine = airUnits(state, a).reduce((s, u) => s + unitValue(state, u), 0);
      enemy = m.nationId
        ? visibleEnemies(state, n)
            .threats.filter((x) => isSam(x.sys) && x.u.owner === m.nationId)
            .reduce((s, x) => s + unitValue(state, x.u), 0)
        : 0;
      goal = m.nationId
        ? cityOf(state, wi(state.world).nationById.get(m.nationId)!.capitalProvinceId)
        : null;
      break;
    default:
      if (m.at) enemy = knownNear(state, n, m.at, (m.radiusKm ?? 150) + 300);
      break;
  }
  const ratio = enemy > 0 ? Math.min(99, mine / enemy) : mine > 0 ? 99 : 0;
  const skill = g ? g.skills[RELEVANT[def.brain] ?? 'offense'] : 30;
  const exp = g ? g.skills.experience : 20;
  const x = Math.min(ratio, 10) * (0.85 + (0.3 * skill) / 100) * (0.9 + (0.2 * exp) / 100);
  const need = L?.attackRatio ?? 1.5;
  const chance = Math.max(0.03, Math.min(0.97, (x * x) / (x * x + need * need * 0.64)));
  let etaHours: number | null = null;
  if (goal && at) {
    let speed = Infinity;
    for (const id of a.units) {
      const u = state.units[id];
      if (!u || u.off) continue;
      const s = sysOf(state, u);
      if (
        s.speedKmh > 0 &&
        (def.brain === 'air_superiority' || def.brain === 'deep_strike' || s.movement !== 'air')
      )
        speed = Math.min(speed, s.speedKmh);
    }
    const d = distanceKm(at, goal);
    const r = def.target === 'zone' ? (m.radiusKm ?? 0) : 0;
    if (Number.isFinite(speed) && d > r) {
      etaHours = (Math.max(0, d - r) * 1.3) / speed;
      if (def.brain === 'conquer' || def.brain === 'landing') {
        const per = Math.max(1, L?.maxOffensivePerThink ?? 1);
        etaHours +=
          (state.world.balance.time.captureMinutes / 60) * Math.ceil(remaining.length / per);
        etaHours += (Math.max(0, remaining.length - 1) * 6) / per;
      }
    } else if (def.brain === 'conquer' || def.brain === 'landing') {
      etaHours = (state.world.balance.time.captureMinutes / 60) * Math.max(1, remaining.length);
    }
    if (etaHours !== null) etaHours = Math.round(etaHours * 10) / 10;
  }
  return { ratio: Math.round(ratio * 100) / 100, etaHours, chance: Math.round(chance * 100) / 100 };
}
