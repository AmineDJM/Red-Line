import {
  HOUR,
  bearing,
  destination,
  distanceKm,
  type AiLevelBalance,
  type Branch,
  type LngLat,
  type MissionDef,
  type NationId,
  type Order,
  type ProvinceId,
  type StrikeTarget,
  type WeaponSystem,
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
import { aiCfg } from '../../ai/config.js';
import { seaLinks } from '../../ai/estimate.js';
import { airRadiusKm, isLauncher, isRadarSensor, targetClassOf } from '../../encounters/profile.js';
import { atWar, provincesOf, sortedKeys, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { canEscort } from '../mil/escort.js';
import {
  canFly,
  escortStrike,
  isFighter,
  isStriker,
  onRoute,
  ready,
  type Seen,
} from '../mil/ai.js';
import { mil } from '../mil/state.js';
import { cellsLeft, missileForShip } from '../mil/strike.js';
import { capacityOf, hasCargo } from '../mil/transport.js';
import {
  airfieldsOf,
  isAew,
  isFuelAir,
  isRecon,
  launchCells,
  portsOf,
  strikeRangeKm,
} from '../mil/util.js';
import { maxFuel, msOf } from '../mil/air.js';
import { milBal } from '../mil/state.js';
import { armyValue } from './armies.js';
import {
  aimsOf,
  airUnits,
  asGeneral,
  awacs,
  bordersOwned,
  centroid,
  cityOf,
  commanded,
  landingPrior,
  levelFor,
  needAt,
  order,
  otherAims,
  placeAirDefense,
  reinforcements,
  retreat,
  seaUnits,
  tooWeak,
  type Think,
} from './brain.js';
import { effectiveSkills, traitSum } from './generals.js';
import { opJournal } from './journal.js';
import { TAKING, closed, middle, opIntel, opOf, trackedBld, type OpIntel } from './ops.js';
import { WIDE, goalParam, isLogistics, umbrellaAims } from './opgoals.js';
import {
  adHolds,
  allyLand,
  capitalLand,
  depthLand,
  engageShip,
  escortConvoys,
  fitTransports,
  holdOp,
  huntShips,
  launchersOf,
  pacifyLand,
  raidWithdraw,
  redeployAir,
  returnHome,
  salvoFired,
  salvoReady,
  shieldOrder,
  showLand,
} from './opconduct.js';
import {
  cmd,
  cmdBal,
  cmdRoll,
  type ArmySt,
  type GenSt,
  type MissionSt,
  type OpSt,
} from './state.js';

/**
 * Généraux en opération : chacun agit selon son rôle (son commandement) et l'objectif commun, avec
 * le renseignement de l'opération (opIntel) et la machinerie tactique des IA (groupes d'assaut,
 * transports, garnisons, contre-attaques). Coordination par l'état partagé de l'opération : secteurs
 * de l'armée de terre, objectifs en cours (`op.focus`) que l'aviation couvre et appuie, défenses
 * sol-air frappées en premier (le ciel s'ouvre avant les frappes profondes), transports des généraux
 * de l'armée de terre escortés par la marine. Tous les ordres sont des ordres de jeu normaux (mêmes
 * validations que ceux du joueur), recalculés à l'identique au rejeu.
 */

const MISSION_DEF: MissionDef = {
  brain: 'conquer',
  target: 'nation',
  domains: ['land', 'air', 'sea'],
  radiusKm: 0,
  order: 0,
  continuous: false,
  blockade: false,
};

/** Profil tactique en opération : groupes et objectifs à la mesure des forces, rassemblement court. */
function levelForOp(
  t0: { state: EngineState; a: ArmySt; g: GenSt; m: MissionSt },
  op: OpSt,
): AiLevelBalance {
  const { state, a, g, m } = t0;
  const O = cmdBal(state).operations;
  const base = levelFor(state, g, m, MISSION_DEF);
  let land = 0;
  for (const id of commanded(state, a)) {
    const s = sysOf(state, state.units[id]!);
    if (s.movement === 'land' && s.speedKmh > 0 && (s.canCapture || s.damage.armor > 0)) land++;
  }
  return {
    ...base,
    groupMax: Math.min(16, Math.max(base.groupMax, Math.ceil(land * O.groupShare))),
    maxOffensivePerThink: Math.min(
      6,
      Math.max(base.maxOffensivePerThink, 1 + Math.floor(land / O.pilesPerObjective)),
    ),
    pathBudget: Math.min(48, Math.max(base.pathBudget, 8 + 2 * land)),
    rally: true,
    amphibious: true,
    counterattack: true,
    sead: base.sead || WIDE.has(op.goal),
    airEscorts: Math.max(1, base.airEscorts),
  };
}

/** Réflexion d'un général en opération. */
export function thinkOpArmy(state: EngineState, a: ArmySt): void {
  const c = cmd(state);
  const op = opOf(state, a);
  if (!op) {
    delete a.op;
    a.status = 'idle';
    return;
  }
  const g = a.general ? c.gens[a.general] : undefined;
  if (!g || (g.status !== 'active' && g.status !== 'wounded')) {
    a.status = 'passive';
    return;
  }
  if (closed(op)) {
    a.status = op.status === 'success' ? 'success' : 'failed';
    // Opération terminée : les forces tiennent les gains ou rentrent à la base (jamais inertes).
    if (!a.post || a.suspended || g.status !== 'active') return;
    const A0 = cmdBal(state).aggressiveness[op.aggr];
    const m0: MissionSt = {
      type: 'op',
      aggr: op.aggr,
      roe: op.roe,
      retreatAt: op.retreatAt ?? A0.retreatAt,
      since: op.since,
      progressAt: op.progressAt,
      okWar: op.okWar,
    };
    const g0: GenSt = { ...g, skills: effectiveSkills(state, g) };
    const t0: Think = {
      state,
      a,
      m: m0,
      def: MISSION_DEF,
      g: g0,
      n: a.owner,
      L: levelForOp({ state, a, g: g0, m: m0 }, op),
      A: A0,
      T: traitSum(state, g.traits),
    };
    asGeneral(() => {
      retreat(t0);
      if (a.post === 'home') returnHome(t0, op);
      else holdOp(t0, op);
    });
    a.now = armyValue(state, a);
    return;
  }
  if (op.suspended || op.status === 'suspended') {
    a.status = 'suspended';
    return;
  }
  if (op.status === 'awaiting') {
    a.status = 'awaiting';
    return;
  }
  const B = cmdBal(state);
  const T = traitSum(state, g.traits);
  const skills = effectiveSkills(state, g);
  const gx: GenSt = { ...g, skills };
  // Frictions : un général sans expérience perd parfois une réflexion (ordres retardés).
  const friction = B.generals.frictionMax * (1 - skills.experience / 100) * T.friction;
  if (cmdRoll(state) < friction) return;
  const A = B.aggressiveness[op.aggr];
  const m: MissionSt = {
    type: 'op',
    aggr: op.aggr,
    roe: op.roe,
    retreatAt: op.retreatAt ?? A.retreatAt,
    since: op.since,
    progressAt: op.progressAt,
    okWar: op.okWar,
    okStrike: true,
  };
  const role: Branch = op.roles[a.id] ?? 'land';
  const L = levelForOp({ state, a, g: gx, m }, op);
  const t: Think = { state, a, m, def: MISSION_DEF, g: gx, n: a.owner, L, A, T };
  const I = opIntel(state, op);
  const staging = op.phase === 'stage' && TAKING.has(op.goal) && role === 'land';
  a.status = staging ? 'preparing' : 'active';
  a.why = null;
  const aims: LngLat[] = [];
  asGeneral(() => {
    retreat(t);
    reinforcements(t);
    landPart(t, op, I, aims);
    airPart(t, op, I, aims);
    seaPart(t, op, I, role, aims);
    firesPart(t, op, I);
    adPart(t, op, I);
  });
  a.aims = dedupe(aims).slice(0, 6);
  a.now = armyValue(state, a);
}

function dedupe(pts: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of pts) if (!out.some((q) => distanceKm(p, q) < 5)) out.push(p);
  return out;
}

// ——— Armée de terre ———

/** Transports des généraux de marine de l'opération (prêtés à l'armée de terre pour les îles). */
function opTransports(state: EngineState, op: OpSt, self: ArmySt): string[] {
  const c = cmd(state);
  const out: string[] = [];
  for (const id of op.armies) {
    const b = c.armies[id];
    if (!b || b.id === self.id || op.roles[id] !== 'sea') continue;
    for (const u of b.units) {
      const x = state.units[u];
      if (x && !x.off && capacityOf(state, x) > 0) out.push(u);
    }
  }
  return out.sort();
}

function landScope(t: Think, op: OpSt): ArmyScope {
  const { state, a, L } = t;
  const O = cmdBal(state).operations;
  const tac = aiCfg(state.world).tactical;
  const units = new Set(commanded(state, a));
  if (TAKING.has(op.goal)) for (const id of opTransports(state, op, a)) units.add(id);
  return {
    units,
    L,
    mem: a.mem,
    zone: null,
    aimed: otherAims(state, a),
    // Piles mixtes (brigades) : une seule pile peut mener l'assaut.
    minGroup: 1,
    T: {
      rallyMaxHours: Math.max(1, O.stageHours),
      rallySpreadHours: Math.min(tac.rallySpreadHours, 4),
      attackReachKm: Math.max(tac.attackReachKm, 4000),
      // Assaut amphibie : les troupes viennent de tout le pays jusqu'au port d'embarquement.
      ...(op.goal === 'amphibious'
        ? { reinforceReachKm: Math.max(tac.reinforceReachKm, tac.attackReachKm, 4000) }
        : {}),
    },
  };
}

function landPart(t: Think, op: OpSt, I: OpIntel, aims: LngLat[]): void {
  const { state, a, n } = t;
  const hasLand = a.units.some((id) => {
    const u = state.units[id];
    return !!u && !u.off && sysOf(state, u).movement === 'land' && sysOf(state, u).speedKmh > 0;
  });
  if (!hasLand) return;
  // Généraux de l'air, de la marine ou de la DCA : leurs piles terrestres éventuelles ne mènent pas
  // d'offensive (sauf piles capables de prendre une ville).
  const role = op.roles[a.id] ?? 'land';
  if (
    role !== 'land' &&
    !a.units.some((id) => {
      const u = state.units[id];
      return !!u && !u.off && sysOf(state, u).canCapture;
    })
  )
    return;
  const ctx = armyContext(state, n, landScope(t, op));
  stopNeutralChases(ctx);
  defend(ctx);
  runOps(ctx);
  runTransports(ctx);
  // Assaut amphibie : un groupement à la taille des transports est détaché des brigades.
  if (op.goal === 'amphibious') fitTransports(t, opTransports(state, op, a));
  if (TAKING.has(op.goal)) advance(t, ctx, op, aims);
  else
    switch (op.goal) {
      case 'raid':
        if (op.phase === 'withdraw') raidWithdraw(t, ctx, aims);
        else advance(t, ctx, op, aims);
        break;
      case 'defense_depth':
        depthLand(t, ctx, op, aims);
        break;
      case 'defend_capital':
        capitalLand(t, ctx, op, aims);
        break;
      case 'pacify':
        pacifyLand(t, ctx, op, aims);
        break;
      case 'show_of_force':
        showLand(t, ctx, op, aims);
        break;
      case 'ally_support':
        allyLand(t, ctx, op, aims);
        break;
      default:
        if (op.goal === 'attrition') hunt(t, ctx, op);
        for (const p of holdFront(t, ctx, op, I).slice(0, 3)) aims.push(cityOf(state, p));
    }
  for (const p of aimsOf(ctx)) aims.push(cityOf(state, p));
}

/** Ville amie de rassemblement d'une province visée : voisine à soi la plus proche, sinon la plus proche. */
function stagingCity(state: EngineState, n: NationId, pid: ProvinceId): ProvinceId | null {
  const w = wi(state.world);
  const at = cityOf(state, pid);
  let best: ProvinceId | null = null;
  let bd = Infinity;
  for (const q of w.provById.get(pid)?.neighbors ?? []) {
    if (state.provinces[q]?.owner !== n) continue;
    const d = distanceKm(cityOf(state, q), at);
    if (d < bd || (d === bd && best !== null && q < best)) {
      bd = d;
      best = q;
    }
  }
  if (best) return best;
  for (const q of provincesOf(state, n)) {
    const d = distanceKm(cityOf(state, q), at);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** Piles terrestres libres capables de combattre. */
function idleGround(ctx: Ctx): number {
  let k = 0;
  for (const m of ctx.land) if (ctx.idle.has(m.u.id) && m.ground) k++;
  return k;
}

/**
 * Avance dans son secteur (conquête, occupation, décapitation) : rassemblement borné puis offensives
 * successives, les plus intéressantes et les moins défendues d'abord (capitale en priorité pour la
 * décapitation) ; les piles sans objectif suivent le front ; les provinces prises menacées sont tenues.
 */
function advance(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, a, n, L, g, T } = t;
  const O = cmdBal(state).operations;
  const w = wi(state.world);
  const open = (p: ProvinceId) => {
    const o = state.provinces[p]?.owner;
    return !!o && o !== n && atWar(state, n, o);
  };
  const sec = op.sectors[a.id];
  let pool = (sec?.pids ?? op.targets).filter(open);
  // Siège : l'anneau d'abord (isoler la ville), puis l'assaut de la ville.
  const city = op.goal === 'siege' ? op.gd?.city : undefined;
  if (city && pool.some((p) => p !== city)) pool = pool.filter((p) => p !== city);
  else if (city && !pool.includes(city) && open(city)) pool = [city];
  if (!pool.length && sec && sec.dir !== 'all') {
    pool = op.targets.filter(open);
    if (pool.length) {
      op.sectors[a.id] = { dir: 'all', pids: [...op.targets] };
      opJournal(state, op, 'sectorDone', { army: a.name }, 'good');
    }
  }
  if (!pool.length) return;
  const here = centroid(state, a) ?? cityOf(state, pool[0]!);
  const nearest = pool
    .slice()
    .sort(
      (x, y) =>
        distanceKm(cityOf(state, x), here) - distanceKm(cityOf(state, y), here) || (x < y ? -1 : 1),
    )[0]!;
  const stage = stagingCity(state, n, nearest);
  const reach = cmdBal(state).tactics.reachKm;
  if (state.time < op.stageUntil) {
    // Rassemblement borné (stageHours) près du secteur ; l'offensive part ensuite quoi qu'il arrive.
    if (stage) garrison(ctx, stage, idleGround(ctx), 0, 0, false, reach);
    return;
  }
  const links = L.amphibious ? seaLinks(state) : null;
  const off = g.skills.offense / 100;
  const cands: { pid: ProvinceId; owner: NationId; score: number; from: ProvinceId | null }[] = [];
  for (const pid of pool) {
    if (ctx.aimed.has(pid) || (ctx.failed[pid] ?? 0) > state.time) continue;
    const owner = state.provinces[pid]!.owner;
    const own = bordersOwned(state, n, pid);
    let from: ProvinceId | null = null;
    if (!own && links) {
      let bd = Infinity;
      for (const q of links.get(pid) ?? []) {
        if (state.provinces[q]?.owner !== n) continue;
        const d = distanceKm(cityOf(state, q), here);
        if (d < bd) {
          bd = d;
          from = q;
        }
      }
    }
    const def = w.provById.get(pid)!;
    const capital = w.nationById.get(owner)?.capitalProvinceId === pid;
    const worth =
      (capital ? (op.goal === 'decapitation' ? 4 : 1.5) : 1) *
      (1 + Math.log10(1 + def.income.money));
    const hold = ctx.hold.get(pid) ?? 0;
    const d = distanceKm(def.cityPoint, here);
    const score =
      (Math.pow(worth, off) / (1 + (2 * hold) / ctx.mine.avgUnit)) *
      (1 / (1 + d / (300 + 6 * g.skills.offense))) *
      (own ? 1 : from ? 0.6 : 0.4) *
      (1 + T.encircle * Math.max(0, own - 1)) *
      goalWeight(state, op, pid);
    cands.push({ pid, owner, score, from });
  }
  cands.sort((x, y) => y.score - x.score || (x.pid < y.pid ? -1 : 1));
  let launched = 0;
  let tries = 0;
  for (const c of cands) {
    if (launched >= L.maxOffensivePerThink || ctx.paths <= 0 || tries >= 6) break;
    tries++;
    const need = needOf(t, ctx, op, c);
    if (launchGroup(ctx, c.pid, need, c.from)) {
      launched++;
      op.progressAt = Math.max(op.progressAt, state.time - 0);
      opJournal(state, op, 'offensive', { army: a.name, province: { province: c.pid } });
    }
  }
  if (
    !launched &&
    cands.length &&
    !Object.keys(ctx.ops).length &&
    !Object.keys(ctx.commit).length
  ) {
    const c0 = cands[0]!;
    // Objectif désigné à l'aviation (appui, suppression) même sans assaut possible.
    aims.push(cityOf(state, c0.pid));
    if (!jointAssault(t, op, cands)) {
      a.why = 'noForces';
      tooWeak(t, ctx, needOf(t, ctx, op, c0));
      opAlert(state, op, `weak:${a.id}`, 12 * HOUR, 'tooWeak', {
        army: a.name,
        province: { province: c0.pid },
      });
    }
  }
  // Piles sans objectif : elles suivent le front (ville amie la plus proche du secteur).
  if (stage && ctx.paths > 0) {
    const at = cityOf(state, stage);
    const far = ctx.land.filter(
      (m) => ctx.idle.has(m.u.id) && m.ground && distanceKm(m.pos, at) > O.frontKm,
    ).length;
    if (far > 0) garrison(ctx, stage, idleGround(ctx), 0, 0, false, reach);
  }
  // Provinces prises menacées : tenues (la plus menacée d'abord).
  const held = op.targets
    .filter((p) => state.provinces[p]?.owner === n && (ctx.threat.get(p) ?? 0) > 0)
    .sort((x, y) => (ctx.threat.get(y) ?? 0) - (ctx.threat.get(x) ?? 0) || (x < y ? -1 : 1))
    .slice(0, 2);
  for (const p of held) garrison(ctx, p, 1, (ctx.threat.get(p) ?? 0) * L.attackRatio, 0.6);
}

/**
 * Poids d'une province dans l'avance selon l'objectif : goulot d'abord (encerclement), ordre de l'axe
 * (percée : la prochaine province de l'axe en premier).
 */
/** Force exigée (assaut amphibie : garnison vue, sinon l'estimation du renseignement). */
function needOf(
  t: Think,
  ctx: Ctx,
  op: OpSt,
  c: { pid: ProvinceId; owner: NationId; from: ProvinceId | null },
): number {
  if (c.from && op.goal === 'amphibious')
    return (
      Math.max(ctx.hold.get(c.pid) ?? 0, landingPrior(t.state, t.n, c.owner)) *
      t.L.attackRatio *
      ctx.T.amphibiousRatio
    );
  return needAt(t, ctx, c.pid, c.owner, c.from);
}

function goalWeight(state: EngineState, op: OpSt, pid: ProvinceId): number {
  if (op.goal === 'encircle' && op.gd?.neck?.includes(pid))
    return goalParam(cmdBal(state).operations.goals[op.goal] ?? null, 'neckWeight', 4);
  if (op.goal === 'breakthrough') {
    const axis = op.gd?.axis ?? [];
    const i = axis.indexOf(pid);
    if (i >= 0) return 1 + (axis.length - i);
  }
  return 1;
}

/** Alerte du journal de l'opération, au plus une fois par période. */
function opAlert(
  state: EngineState,
  op: OpSt,
  key: string,
  every: number,
  id: string,
  params: Parameters<typeof opJournal>[3],
): void {
  const at = op.alerts[key];
  if (at !== undefined && state.time - at < every) return;
  op.alerts[key] = state.time;
  opJournal(state, op, id, params, 'warn');
}

/**
 * Assaut conjoint : aucun général de l'armée de terre n'est assez fort seul ; le premier d'entre eux
 * mène un groupe formé des piles libres de tous (coordination de l'opération).
 */
function jointAssault(
  t: Think,
  op: OpSt,
  cands: { pid: ProvinceId; owner: NationId; from: ProvinceId | null }[],
): boolean {
  const { state, a, n } = t;
  const c = cmd(state);
  const land = op.armies.filter((id) => op.roles[id] === 'land' && c.armies[id]?.units.length);
  if (land.length < 2 || land[0] !== a.id) return false;
  const units = new Set<string>();
  for (const id of land) for (const u of commanded(state, c.armies[id]!)) units.add(u);
  const scope = landScope(t, op);
  const ctx = armyContext(state, n, { ...scope, units, aimed: [] });
  for (const x of cands.slice(0, 3)) {
    const need = needOf(t, ctx, op, x);
    if (launchGroup(ctx, x.pid, need, x.from)) {
      opJournal(state, op, 'jointAssault', { army: a.name, province: { province: x.pid } });
      return true;
    }
  }
  return false;
}

/** Affaiblir : chasse des forces terrestres ennemies vues près de la frontière (groupes dimensionnés). */
function hunt(t: Think, ctx: Ctx, op: OpSt): void {
  const { state, n, L } = t;
  const O = cmdBal(state).operations;
  const foes = new Set(op.nations);
  const own = provincesOf(state, n).map((p) => cityOf(state, p));
  const nav = wi(state.world).nav;
  const prey = ctx.enemies
    .filter((e) => {
      if (!e.seen || e.medium !== 'land') return false;
      const u = state.units[e.id];
      if (!u || !foes.has(u.owner)) return false;
      const pid = nav.cellProv.get(nav.cellOfPos(e.pos));
      if (pid && state.provinces[pid]?.owner === n) return true;
      return own.some((p) => distanceKm(p, e.pos) <= O.huntKm);
    })
    .sort((x, y) => y.value - x.value || (x.id < y.id ? -1 : 1));
  let groups = 0;
  for (const e of prey) {
    if (groups >= L.maxOffensivePerThink || ctx.paths <= 0) break;
    const need = e.value * L.attackRatio;
    const cands = ctx.land
      .filter((m) => ctx.idle.has(m.u.id) && m.ground)
      .map((m) => ({ m, d: distanceKm(m.pos, e.pos) }))
      .filter((x) => x.d <= O.huntKm * 3)
      .sort((x, y) => x.d - y.d || (x.m.u.id < y.m.u.id ? -1 : 1));
    const group: string[] = [];
    let force = 0;
    for (const { m } of cands) {
      if (force >= need || group.length >= L.groupMax || ctx.paths <= 0) break;
      ctx.paths--;
      if (!safeLegs(state, n, m.u, e.pos)) continue;
      group.push(m.u.id);
      force += m.value;
    }
    if (!group.length || force < need * 0.75) continue;
    if (order(state, n, { kind: 'attack', unitIds: group, targetId: e.id })) {
      for (const id of group) ctx.idle.delete(id);
      groups++;
    }
  }
}

/** Front face aux pays visés : villes frontalières tenues, contre-attaques des provinces perdues. */
function holdFront(t: Think, ctx: Ctx, op: OpSt, I: OpIntel): ProvinceId[] {
  const { state, n, L } = t;
  const w = wi(state.world);
  const foes = new Set(op.nations);
  const front = provincesOf(state, n)
    .filter((p) =>
      (w.provById.get(p)?.neighbors ?? []).some((x) => {
        const o = state.provinces[x]?.owner;
        return !!o && foes.has(o);
      }),
    )
    .sort(
      (x, y) =>
        (ctx.threat.get(y) ?? 0) - (ctx.threat.get(x) ?? 0) ||
        w.provById.get(y)!.income.money - w.provById.get(x)!.income.money ||
        (x < y ? -1 : 1),
    );
  if (L.counterattack && I.foes.length) counterattack(ctx);
  if (!front.length) return front;
  const ground = ctx.land.filter((m) => m.ground).length;
  if (!ground) return front;
  const slots = Math.min(front.length, ground);
  const per = Math.max(1, Math.floor(ground / slots));
  for (const pid of front.slice(0, slots)) {
    const threat = ctx.threat.get(pid) ?? 0;
    garrison(ctx, pid, per, threat * L.attackRatio, 0.6, false, 2500);
  }
  return front;
}

// ——— Aviation ———

type Cls = 'sead' | 'air' | 'ground' | 'ship' | 'bld';

interface Tgt {
  tg: StrikeTarget;
  pos: LngLat;
  cls: Cls;
  /** Classe de cible du moteur (dégâts de l'appareil contre elle). */
  tc: string;
  key: string;
  sam?: Seen;
}

/**
 * Cibles de l'opération par priorité : défenses sol-air et radars d'abord (ouvrir le ciel), puis
 * aviation (au sol, bases aériennes), forces terrestres, navires et logistique, selon l'objectif ;
 * les plus proches du front d'abord à priorité égale.
 */
export function targetList(state: EngineState, op: OpSt, I: OpIntel): Tgt[] {
  const g = op.goal;
  const ref = I.front ?? I.center;
  const near = (p: LngLat, km: number, pts: LngLat[]) => pts.some((q) => distanceKm(p, q) <= km);
  const focus = op.focus?.length ? op.focus : I.front ? [I.front] : [];
  const out: { t: Tgt; prio: number; d: number }[] = [];
  const push = (t: Tgt, prio: number) => out.push({ t, prio, d: ref ? distanceKm(ref, t.pos) : 0 });
  const unit = (x: Seen, cls: Cls): Tgt => ({
    tg: { type: 'unit', unitId: x.u.id },
    pos: x.pos,
    cls,
    tc: targetClassOf(state, x.u),
    key: `u:${x.u.id}`,
    sam: cls === 'sead' ? x : undefined,
  });
  const bld = (b: OpIntel['blds'][number], cls: Cls): Tgt => ({
    tg: { type: 'building', provinceId: b.pid, building: b.b },
    pos: b.at,
    cls,
    tc: 'building',
    key: `${b.pid}:${b.b}`,
  });
  const wide = WIDE.has(g);
  const rear = g === 'raid' ? new Set(op.gd?.rear ?? []) : null;
  const deep =
    g === 'strategic' ||
    g === 'strategic_bombing' ||
    g === 'interdiction' ||
    g === 'naval_strikes' ||
    g === 'raid';
  // Frappes en profondeur : seules les défenses qui couvrent une installation visée passent avant.
  const sites = deep
    ? I.blds.filter((b) => trackedBld(g, b) && (!rear || rear.has(b.pid))).map((b) => b.at)
    : [];
  // Appui rapproché : objectifs des offensives de la nation (et front).
  const cas = g === 'cas' ? [...umbrellaAims(state, op), ...focus] : [];
  const casKm = goalParam(cmdBal(state).operations.goals[g] ?? null, 'radiusKm', 120);
  const siege = g === 'siege' && op.gd?.city ? cityOf(state, op.gd.city) : null;
  for (const x of I.sams)
    if (
      wide ||
      near(x.pos, 400, focus) ||
      near(x.pos, (x.sys?.weaponRangeKm.max ?? 0) + 10, sites) ||
      (cas.length && near(x.pos, casKm + 100, cas))
    )
      push(unit(x, 'sead'), 0);
  for (const b of I.blds) {
    if (rear && !rear.has(b.pid)) {
      if (b.kind === 'ad' && near(b.at, 300, focus)) push(bld(b, 'sead'), 1);
      continue;
    }
    if (rear) {
      if (trackedBld(g, b)) push(bld(b, b.kind === 'ad' ? 'sead' : 'bld'), b.kind === 'ad' ? 1 : 2);
      continue;
    }
    if (
      b.kind === 'ad' &&
      (wide || g === 'strategic' || g === 'strategic_bombing' || near(b.at, 300, focus))
    )
      push(bld(b, 'sead'), 1);
    if (
      b.kind === 'air' &&
      (g === 'air_control' ||
        g === 'attrition' ||
        g === 'strategic' ||
        g === 'strategic_bombing' ||
        g === 'missile_campaign')
    )
      push(bld(b, 'bld'), g === 'missile_campaign' ? 2 : 3);
    if (
      b.kind === 'mil' &&
      (g === 'attrition' ||
        g === 'strategic' ||
        g === 'strategic_bombing' ||
        g === 'missile_campaign' ||
        g === 'naval_strikes')
    )
      push(bld(b, 'bld'), g === 'missile_campaign' ? 2 : 6);
    if (
      b.kind === 'naval' &&
      (g === 'blockade' ||
        g === 'strategic' ||
        g === 'attrition' ||
        g === 'naval_supremacy' ||
        g === 'port_blockade' ||
        g === 'strategic_bombing' ||
        g === 'naval_strikes')
    )
      push(bld(b, 'bld'), g === 'naval_strikes' ? 3 : 6);
    if (b.kind === 'ind' && (g === 'strategic' || g === 'strategic_bombing'))
      push(bld(b, 'bld'), 5);
    if (b.kind === 'res' && g === 'strategic_bombing') push(bld(b, 'bld'), 5);
    if (g === 'interdiction' && isLogistics(b.b)) push(bld(b, 'bld'), 2);
  }
  if (g === 'air_control' || g === 'attrition')
    for (const x of I.airGround) push(unit(x, 'air'), 2);
  if (g === 'attrition' || g === 'armed_recon')
    for (const x of I.ground) push(unit(x, 'ground'), 4);
  if (TAKING.has(g))
    for (const x of I.ground)
      if (siege && distanceKm(x.pos, siege) <= 80) push(unit(x, 'ground'), 1);
      else if (near(x.pos, 80, focus)) push(unit(x, 'ground'), 2);
      else if (ref && distanceKm(x.pos, ref) <= 300) push(unit(x, 'ground'), 4);
  if (rear)
    for (const x of I.ground)
      if ([...rear].some((p) => distanceKm(cityOf(state, p), x.pos) <= 80))
        push(unit(x, 'ground'), 3);
  if (g === 'cas')
    for (const x of I.ground) if (near(x.pos, casKm, cas)) push(unit(x, 'ground'), 1);
  if (g === 'interdiction') for (const x of I.ground) if (x.u.move) push(unit(x, 'ground'), 3);
  if (
    g === 'defend_border' ||
    g === 'defense_depth' ||
    g === 'defend_capital' ||
    g === 'pacify' ||
    g === 'ally_support' ||
    g === 'air_defense_territory' ||
    g === 'show_of_force'
  )
    for (const x of I.ground) if (ref && distanceKm(x.pos, ref) <= 300) push(unit(x, 'ground'), 2);
  if (g === 'attrition' || g === 'blockade' || g === 'armed_recon')
    for (const x of I.ships) push(unit(x, 'ship'), g === 'blockade' ? 2 : 5);
  if (g === 'naval_supremacy' || g === 'antiship' || g === 'port_blockade')
    for (const x of I.ships) push(unit(x, 'ship'), 1);
  out.sort((x, y) => x.prio - y.prio || x.d - y.d || (x.t.key < y.t.key ? -1 : 1));
  return out.map((x) => x.t);
}

/** Cibles déjà frappées par la nation (appareils en mission de frappe). */
function busyTargets(state: EngineState, n: NationId): Set<string> {
  const out = new Set<string>();
  const ms = mil(state).ms;
  for (const id of sortedKeys(ms)) {
    const x = ms[id]!;
    if (x.mis !== 'strike' || !x.tg || state.units[id]?.owner !== n) continue;
    if (x.tg.type === 'unit') out.add(`u:${x.tg.unitId}`);
    else if (x.tg.type === 'building') out.add(`${x.tg.provinceId}:${x.tg.building}`);
  }
  return out;
}

/** Points de patrouille de la chasse selon l'objectif. */
function patrolPoints(state: EngineState, op: OpSt, I: OpIntel): LngLat[] {
  const mid = I.front && I.center ? middle([I.front, I.center]) : (I.center ?? I.front);
  // Ciel pas encore ouvert (défenses connues, ou reconnaissance trop récente) : la chasse tient le front.
  const closed = op.phase === 'sead' || op.phase === 'stage' || state.time - op.since < 6 * HOUR;
  switch (op.goal) {
    case 'air_control':
    case 'sead':
    case 'attrition':
    case 'strategic':
    case 'strategic_bombing':
    case 'interdiction':
    case 'armed_recon':
    case 'raid':
    case 'missile_campaign':
      if (closed) return I.front ? [I.front] : [];
      return [I.center, mid].filter((p): p is LngLat => !!p);
    case 'air_defense_territory':
    case 'missile_shield':
    case 'defend_capital':
      return (op.gd?.sites ?? []).slice(0, 3).map((p) => cityOf(state, p));
    case 'defense_depth':
    case 'show_of_force':
    case 'pacify':
      return I.front ? [I.front] : [];
    case 'cas': {
      const pts = umbrellaAims(state, op);
      return pts.length ? dedupe(pts).slice(0, 2) : I.front ? [I.front] : [];
    }
    case 'ally_support':
      return I.center ? [I.center] : I.front ? [I.front] : [];
    case 'naval_supremacy':
    case 'antiship':
    case 'port_blockade':
    case 'naval_strikes':
    case 'blockade': {
      const w = wi(state.world);
      const pts: LngLat[] = [];
      for (const o of I.foes) for (const p of portsOf(state, o)) pts.push(w.seaSpawn.get(p)!);
      const c = middle(pts.filter((p) => !!p));
      return c ? [c] : mid ? [mid] : [];
    }
    case 'defend_border':
      return I.front ? [I.front] : [];
    default:
      return op.focus?.length ? op.focus.slice(0, 2) : mid ? [mid] : [];
  }
}

/** Chasse en patrouille sur plusieurs points (répartie), le reste en alerte ou en frappe. */
function patrolOver(
  t: Think,
  fighters: Unit[],
  pts: LngLat[],
  want: number,
  radius: number,
  fallback: LngLat | null,
): Set<string> {
  const { state, n } = t;
  const ms = mil(state).ms;
  const used = new Set<string>();
  if (!pts.length || want <= 0) return used;
  // Point hors de portée : la patrouille se tient au plus loin vers lui (mi-chemin du front, front).
  const alts = pts.map((p) => (fallback ? dedupe([p, middle([p, fallback])!, fallback]) : [p]));
  const per = pts.map(() => 0);
  for (const u of fighters) {
    const x = ms[u.id];
    if (!x || x.mis !== 'patrol' || !x.at) continue;
    const i = alts.findIndex((list) => list.some((p) => distanceKm(x.at!, p) <= radius + 50));
    if (i >= 0) {
      per[i]!++;
      used.add(u.id);
    }
  }
  const target = pts.map((_, i) => Math.ceil(want / pts.length) - (i >= want ? 1 : 0));
  let tries = 8;
  for (const u of fighters) {
    if (tries <= 0) break;
    if (used.has(u.id) || !ready(state, u)) continue;
    const i = per.findIndex((k, j) => k < target[j]!);
    if (i < 0) break;
    tries--;
    let at = alts[i]!.find((p) => canFly(state, n, u, p));
    // Toujours hors de portée : orbite à la limite du rayon d'action, dans l'axe du point visé.
    const m = msOf(state, u);
    if (!at && m?.base && state.provinces[m.base]) {
      const home = cityOf(state, m.base);
      const edge = destination(home, bearing(home, pts[i]!), airRadiusKm(state, u) * 0.85);
      if (canFly(state, n, u, edge)) at = edge;
    }
    if (!at) continue;
    if (order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: radius })) {
      per[i]!++;
      used.add(u.id);
    }
  }
  return used;
}

/** Peut frapper au sol (bombardier, appui, drone armé, ou chasseur multirôle). */
export function canStrike(s: WeaponSystem): boolean {
  if (isStriker(s)) return true;
  return isFighter(s) && (s.damage.building > 0 || s.damage.armor > 0 || s.damage.infantry > 0);
}

/**
 * Bases avancées : un appareil qui ne peut atteindre la cible depuis sa base est redéployé sur le
 * terrain d'aviation ami le plus proche du théâtre (quelques appareils par réflexion).
 */
function forwardBase(t: Think, I: OpIntel, air: Unit[], goal: LngLat | null): void {
  const { state, n } = t;
  if (!goal) return;
  const fields = airfieldsOf(state, n)
    .map((p) => ({ p, d: distanceKm(cityOf(state, p), goal) }))
    .sort((x, y) => x.d - y.d || (x.p < y.p ? -1 : 1));
  if (!fields.length) return;
  let left = 6;
  for (const u of air) {
    if (left <= 0) break;
    const s = sysOf(state, u);
    if (!isFuelAir(s) || !ready(state, u)) continue;
    const m = msOf(state, u);
    if (!m || m.emb || m.bk === 'c') continue;
    if (canFly(state, n, u, goal)) continue;
    // Convoyage : terrain le plus proche du théâtre parmi ceux qu'il atteint d'une traite.
    const here = unitPosAt(state, u, state.time);
    const ferry = Math.max(0, maxFuel(state, u) - milBal(state).air.reserveH) * s.speedKmh * 0.95;
    const best = fields.find((f) => distanceKm(cityOf(state, f.p), here) <= ferry);
    if (!best || best.p === m.base) continue;
    const cur = m.base && state.provinces[m.base] ? m.base : null;
    if (cur && distanceKm(cityOf(state, cur), goal) <= best.d + 1) continue;
    left--;
    order(state, n, { kind: 'rebase', unitIds: [u.id], provinceId: best.p });
  }
}

function airPart(t: Think, op: OpSt, I: OpIntel, aims: LngLat[]): void {
  const { state, a, n, g, L, A, T } = t;
  const air = airUnits(state, a);
  if (!air.length) return;
  const O = cmdBal(state).operations;
  if (op.goal === 'air_redeploy') return redeployAir(t, op, aims);
  if (I.front) awacs(t, I.front);
  const list = targetList(state, op, I);
  // Cible prioritaire (ou cœur du pays visé) : les appareils qui ne l'atteignent pas se redéploient.
  forwardBase(t, I, air, list[0]?.pos ?? I.center ?? I.front);
  const fighters = air.filter((u) => isFighter(sysOf(state, u)));
  // Chasse : part en patrouille (toute la part pour le contrôle aérien), le reste frappe.
  // Pas de patrouille sous une défense sol-air connue : la chasse tient le front tant que le ciel
  // n'est pas ouvert (suppression d'abord), puis s'avance au-dessus du pays visé.
  const covered = (p: LngLat) =>
    I.sams.some((x) => distanceKm(x.pos, p) <= (x.sys?.weaponRangeKm.max ?? 0) + 30);
  const pts = dedupe(patrolPoints(state, op, I).map((p) => (covered(p) && I.front ? I.front : p)));
  const patrolGoal = op.goal === 'air_control' || op.goal === 'air_defense_territory';
  const share = patrolGoal
    ? Math.max(
        A.airShare,
        goalParam(cmdBal(state).operations.goals[op.goal] ?? null, 'patrolShare', 0.75),
      )
    : I.airUp.length
      ? A.airShare
      : Math.min(A.airShare, 0.34);
  const want = Math.ceil(fighters.length * share);
  const radius = patrolGoal ? 150 : 90;
  const patrolling = patrolOver(t, fighters, pts, want, radius, I.front);
  for (const p of pts) aims.push(p);
  // Frappes par priorité (ciel d'abord), escortées.
  const pool = air.filter(
    (u) => !patrolling.has(u.id) && canStrike(sysOf(state, u)) && ready(state, u),
  );
  const S = O.sorties;
  let sorties = Math.min(
    Math.max(1, Math.ceil(pool.length * S.share)),
    Math.round(S.base + g.skills.air / Math.max(1, S.perSkill) + T.sorties),
  );
  const busy = busyTargets(state, n);
  const counts: Record<Cls, number> = { sead: 0, air: 0, ground: 0, ship: 0, bld: 0 };
  let tries = 10;
  for (const tg of list) {
    if (sorties <= 0 || tries <= 0 || !pool.length) break;
    if (busy.has(tg.key)) continue;
    tries--;
    const i = pool.findIndex((u) => {
      const s = sysOf(state, u);
      return (s.damage as Record<string, number>)[tg.tc]! > 0 && canFly(state, n, u, tg.pos);
    });
    if (i < 0) continue;
    const u = pool[i]!;
    // Une défense sol-air vue sur la route passe avant (suppression).
    let aim = tg;
    if (tg.cls !== 'sead' && L.sead) {
      const here = unitPosAt(state, u, state.time);
      const sam = I.sams.find(
        (x) =>
          !busy.has(`u:${x.u.id}`) &&
          (sysOf(state, u).damage as Record<string, number>)[targetClassOf(state, x.u)]! > 0 &&
          (distanceKm(x.pos, tg.pos) <= (x.sys?.weaponRangeKm.max ?? 0) + 10 ||
            onRoute(x, here, tg.pos)) &&
          canFly(state, n, u, x.pos),
      );
      if (sam)
        aim = {
          tg: { type: 'unit', unitId: sam.u.id },
          pos: sam.pos,
          cls: 'sead',
          tc: targetClassOf(state, sam.u),
          key: `u:${sam.u.id}`,
        };
    }
    pool.splice(i, 1);
    if (order(state, n, { kind: 'strike', unitIds: [u.id], target: aim.tg })) {
      sorties--;
      busy.add(aim.key);
      counts[aim.cls]++;
      op.strikes++;
      if (op.goal === 'interdiction' && aim.tg.type === 'unit' && state.units[aim.tg.unitId]?.move)
        (op.cnt ??= {}).moving = (op.cnt.moving ?? 0) + 1;
      escortStrike(state, n, air, aim.pos, L.airEscorts, u);
      if (aims.length < 6) aims.push(aim.pos);
    }
  }
  const total = counts.sead + counts.air + counts.ground + counts.ship + counts.bld;
  if (total > 0)
    opJournal(state, op, 'strikes', {
      army: a.name,
      count: total,
      sead: counts.sead,
      air: counts.air,
      ground: counts.ground + counts.ship,
      bld: counts.bld,
    });
  else if (!list.length) {
    recon(t, op, I, air);
    if (!patrolling.size) a.why = 'noTargets';
  }
}

/**
 * Reconnaissance faute de cible connue : un appareil en patrouille au-dessus de la cible (capteurs),
 * et une reconnaissance militaire du renseignement sur chaque pays visé.
 */
function recon(t: Think, op: OpSt, I: OpIntel, air: Unit[]): void {
  const { state, n } = t;
  const O = cmdBal(state).operations;
  if (!I.center || (op.reconAt !== null && state.time - op.reconAt < O.reconHours * HOUR)) return;
  op.reconAt = state.time;
  const pick = air
    .filter((u) => ready(state, u))
    .sort((x, y) => {
      const rx = isRecon(sysOf(state, x)) || sysOf(state, x).category === 'drone' ? 0 : 1;
      const ry = isRecon(sysOf(state, y)) || sysOf(state, y).category === 'drone' ? 0 : 1;
      return rx - ry || (x.id < y.id ? -1 : 1);
    })
    .find((u) => !isAew(sysOf(state, u)) && canFly(state, n, u, I.center!));
  if (pick) order(state, n, { kind: 'patrol', unitIds: [pick.id], at: I.center, radiusKm: 150 });
  for (const o of I.foes)
    order(state, n, { kind: 'intelOp', op: 'recon_military', target: { nationId: o } });
  opJournal(state, op, 'recon', { nation: { nation: I.foes[0] ?? op.nations[0]! } });
}

// ——— Feux : missiles sol-sol et de croisière ———

function firesPart(t: Think, op: OpSt, I: OpIntel): void {
  const { state, a, n } = t;
  const O = cmdBal(state).operations;
  const def = cmdBal(state).operations.goals[op.goal] ?? null;
  // Campagne de missiles : salves coordonnées (les lanceurs attendent d'être assez nombreux).
  const campaign = op.goal === 'missile_campaign';
  if (campaign && !salvoReady(t, op, launchersOf(t))) return;
  let salvos =
    campaign || op.goal === 'naval_strikes' ? goalParam(def, 'salvos', O.salvos) : O.salvos;
  if (salvos <= 0) return;
  const start = salvos;
  const used = new Map<string, number>();
  let list: Tgt[] | null = null;
  const reload = mil(state).reload;
  for (const id of commanded(state, a)) {
    if (salvos <= 0) break;
    const u = state.units[id]!;
    if (u.off) continue;
    const s = sysOf(state, u);
    const ship = s.movement === 'sea' && launchCells(s) > 0 && cellsLeft(state, u) > 0;
    if (!isLauncher(s) && !ship) continue;
    if ((reload[u.id] ?? 0) > state.time) continue;
    const msys = isLauncher(s) ? s : missileForShip(state, s, false);
    if (!msys || msys.missile?.warhead === 'nuclear') continue;
    list ??= targetList(state, op, I);
    const here = unitPosAt(state, u, state.time);
    const kind = msys.missile?.kind ?? 'cruise';
    const tg = list.find((x) => {
      // Salves réparties : une cible par lanceur (deux pour une défense sol-air : saturation).
      if (campaign && (used.get(x.key) ?? 0) >= (x.cls === 'sead' ? 2 : 1)) return false;
      // Navire : sa position connue vieillit (il a pu s'éloigner), marge de portée.
      if (distanceKm(x.pos, here) > strikeRangeKm(msys) * (x.cls === 'ship' ? 0.8 : 1))
        return false;
      if (x.tg.type === 'unit') {
        const v = state.units[x.tg.unitId];
        if (!v) return false;
        const vs = sysOf(state, v);
        if (vs.movement === 'air') return false;
        if (kind === 'antiship' && vs.movement !== 'sea') return false;
        if (kind === 'antiradiation' && !isRadarSensor(vs)) return false;
      } else if (kind === 'antiship' || kind === 'antiradiation') return false;
      return (msys.damage as Record<string, number>)[x.tc]! > 0;
    });
    if (!tg) continue;
    const o: Order = isLauncher(s)
      ? { kind: 'strike', unitIds: [u.id], target: tg.tg, count: Math.min(u.count, 4) }
      : { kind: 'strike', unitIds: [u.id], target: tg.tg };
    if (order(state, n, o)) {
      salvos--;
      op.strikes++;
      used.set(tg.key, (used.get(tg.key) ?? 0) + 1);
    }
  }
  if (campaign) salvoFired(t, op, start - salvos);
}

// ——— Marine ———

/** Trajet maritime impossible (mer fermée, eaux d'un neutre) : pas de nouvel essai avant 6 h. */
function seaPath(t: Think, u: Unit, to: LngLat, key: string): boolean {
  const { state, a, n } = t;
  const memo = (a.mem.capFail ??= {});
  const k = `s:${u.id}:${key}`;
  if ((memo[k] ?? 0) > state.time) return false;
  if (safeLegs(state, n, u, to)) return true;
  memo[k] = state.time + 6 * HOUR;
  return false;
}

function seaPart(t: Think, op: OpSt, I: OpIntel, role: Branch, aims: LngLat[]): void {
  const { state, a, n } = t;
  const ms = mil(state).ms;
  const c = cmd(state);
  const landing =
    TAKING.has(op.goal) && op.armies.some((id) => op.roles[id] === 'land' && id !== a.id);
  const ships = seaUnits(state, a).filter(
    (u) => capacityOf(state, u) <= 0 || !(landing && role === 'sea'),
  );
  if (!ships.length) return;
  const free = ships.filter((u) => {
    if (u.move || u.target || hasCargo(state, u.id) || capacityOf(state, u) > 0) return false;
    const x = ms[u.id]?.mis;
    return !x || x === 'none';
  });
  // Escorte des transports chargés des généraux de l'armée de terre.
  if (landing) {
    for (const id of op.armies) {
      const b = c.armies[id];
      if (!b || op.roles[id] !== 'sea') continue;
      for (const sid of b.units) {
        const tr = state.units[sid];
        if (!tr || !hasCargo(state, sid)) continue;
        const escorted = ships.some((u) => ms[u.id]?.mis === 'escort' && u.target === sid);
        if (escorted) continue;
        const e = free.find((u) => canEscort(state, u) && u.id !== sid);
        if (e && order(state, n, { kind: 'escort', unitIds: [e.id], targetId: sid }))
          free.splice(free.indexOf(e), 1);
      }
    }
  }
  // Escorte des convois : ses transports chargés d'abord, puis ses routes maritimes.
  if (op.goal === 'convoy_escort') return escortConvoys(t, free, aims);
  // Supériorité navale, guerre anti-navires : chasse d'abord.
  if (op.goal === 'naval_supremacy' || op.goal === 'antiship') huntShips(t, op, I, free);
  // Blocus des ports des pays visés (renforcé : plusieurs navires par port).
  const share =
    op.goal === 'blockade' || op.goal === 'port_blockade'
      ? 1
      : TAKING.has(op.goal) || op.goal === 'attrition'
        ? 0.5
        : op.goal === 'naval_supremacy' || op.goal === 'antiship'
          ? 0.2
          : 0.3;
  const perPort =
    op.goal === 'port_blockade'
      ? Math.max(
          1,
          Math.round(goalParam(cmdBal(state).operations.goals[op.goal] ?? null, 'shipsPerPort', 2)),
        )
      : 1;
  let left = Math.ceil(free.length * share);
  const blk = mil(state).blk;
  const blocked = new Set<string>();
  const portShips = new Map<string, number>();
  for (const id of sortedKeys(blk)) {
    const b = blk[id]!;
    if (b.by !== n || !('provinceId' in b.target)) continue;
    const p = b.target.provinceId;
    portShips.set(p, (portShips.get(p) ?? 0) + b.units.length);
    if ((portShips.get(p) ?? 0) >= perPort) blocked.add(p);
  }
  const w = wi(state.world);
  for (const o of I.foes) {
    for (const pid of portsOf(state, o)) {
      const sp = w.seaSpawn.get(pid);
      if (!sp) continue;
      if (blocked.has(pid)) {
        if (aims.length < 6) aims.push(sp);
        continue;
      }
      if (left <= 0 || !free.length) break;
      // Le navire libre le plus proche qui peut rejoindre le port (un navire enfermé n'y va pas).
      const ship = free
        .slice()
        .sort(
          (p, q) =>
            distanceKm(unitPosAt(state, p, state.time), sp) -
              distanceKm(unitPosAt(state, q, state.time), sp) || (p.id < q.id ? -1 : 1),
        )
        .slice(0, 3)
        .find((u) => seaPath(t, u, sp, pid));
      if (!ship) continue;
      if (order(state, n, { kind: 'blockade', unitIds: [ship.id], target: { provinceId: pid } })) {
        free.splice(free.indexOf(ship), 1);
        portShips.set(pid, (portShips.get(pid) ?? 0) + 1);
        if ((portShips.get(pid) ?? 0) >= perPort) blocked.add(pid);
        left--;
        opJournal(state, op, 'blockade', { army: a.name, province: { province: pid } });
        if (aims.length < 6) aims.push(sp);
      }
    }
  }
  // Navires ennemis vus : attaqués.
  for (const e of I.ships) {
    const hunter = free.find(
      (u) =>
        (sysOf(state, u).damage as Record<string, number>)[targetClassOf(state, e.u)]! > 0 &&
        distanceKm(unitPosAt(state, u, state.time), e.pos) <= 800,
    );
    if (!hunter) continue;
    if (engageShip(t, hunter, e)) free.splice(free.indexOf(hunter), 1);
  }
  // Le reste patrouille au large des côtes visées.
  const pts: LngLat[] = [];
  for (const o of I.foes) for (const p of portsOf(state, o)) pts.push(w.seaSpawn.get(p)!);
  const coast = middle(pts.filter((p) => !!p));
  if (!coast) return;
  let tries = 4;
  for (const u of free) {
    if (tries-- <= 0) break;
    if (distanceKm(unitPosAt(state, u, state.time), coast) <= 150) continue;
    if (!seaPath(t, u, coast, 'coast')) continue;
    order(state, n, { kind: 'patrol', unitIds: [u.id], at: coast, radiusKm: 150 });
  }
}

// ——— Défense sol-air ———

/**
 * Défenses sol-air et radars de l'armée : avec les troupes (villes amies les plus proches des
 * objectifs en cours, provinces prises) pour une offensive, sinon sur le front et la capitale.
 */
function adPart(t: Think, op: OpSt, I: OpIntel): void {
  const { state, a, n } = t;
  const has = a.units.some((id) => {
    const u = state.units[id];
    if (!u || u.off) return false;
    const s = sysOf(state, u);
    return (
      s.movement === 'land' &&
      (s.category === 'air_defense' || s.category === 'radar') &&
      s.speedKmh > 0
    );
  });
  if (!has) return;
  const custom = adHolds(t, op);
  if (custom) {
    if (op.goal === 'missile_shield') return placeAirDefense(t, custom, shieldOrder);
    return placeAirDefense(t, custom);
  }
  const holds: ProvinceId[] = [];
  const add = (p: ProvinceId | null) => {
    if (p && !holds.includes(p) && state.provinces[p]?.owner === n) holds.push(p);
  };
  const nearestOwn = (at: LngLat): ProvinceId | null => {
    let best: ProvinceId | null = null;
    let bd = Infinity;
    for (const q of provincesOf(state, n)) {
      const d = distanceKm(cityOf(state, q), at);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  };
  if (TAKING.has(op.goal)) {
    for (const p of op.focus ?? []) add(nearestOwn(p));
    for (const p of op.targets) if (state.provinces[p]?.owner === n) add(p);
  }
  if (I.front) add(nearestOwn(I.front));
  const w = wi(state.world);
  const foes = new Set(op.nations);
  const front = provincesOf(state, n)
    .filter((p) =>
      (w.provById.get(p)?.neighbors ?? []).some((x) => foes.has(state.provinces[x]?.owner ?? '')),
    )
    .sort((x, y) =>
      I.center
        ? distanceKm(cityOf(state, x), I.center) - distanceKm(cityOf(state, y), I.center) ||
          (x < y ? -1 : 1)
        : x < y
          ? -1
          : 1,
    );
  for (const p of front) add(p);
  add(w.nationById.get(n)?.capitalProvinceId ?? null);
  placeAirDefense(t, holds);
}
