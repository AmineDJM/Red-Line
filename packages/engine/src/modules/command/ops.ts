import {
  BRANCHES,
  DAY,
  HOUR,
  branchOfSystem,
  distanceKm,
  generalRating,
  type Branch,
  type BuildingType,
  type CampaignView,
  type LngLat,
  type NationId,
  type OpCommanderInput,
  type OpGoalDef,
  type OpMetric,
  type OpPhaseInput,
  type OpSector,
  type LocParam,
  type Order,
  type ProvinceId,
  type WaitView,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import {
  elementValue,
  estimateForce,
  ownForce,
  publicForce,
  unitValue,
} from '../../ai/estimate.js';
import { health as bldHealth } from '../eco/buildings.js';
import { atWar, provincesOf, sortedKeys, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../../state/world.js';
import { scheduleMod } from '../kit.js';
import { transferProvince } from '../../combat/capture.js';
import { knowledge, revealed } from '../intel/provinces.js';
import { isSam, visibleEnemies, type Seen } from '../mil/ai.js';
import { mil } from '../mil/state.js';
import { buildingsOf, portsOf } from '../mil/util.js';
import { addUnits, armyValue, removeUnits } from './armies.js';
import { asGeneral, centroid, order } from './brain.js';
import {
  assign,
  branchOf,
  candidate as candidateOf,
  checkHire,
  doHire,
  gainXp,
  salaryOf,
} from './generals.js';
import { journal as journalArmy, notifyOwner, opJournal } from './journal.js';
import {
  cmd,
  cmdBal,
  cmdOpt,
  nextCmdId,
  type ArmySt,
  type GenSt,
  type OpPhaseSt,
  type OpSt,
} from './state.js';
import { ensureTick } from './schedule.js';
import {
  CUSTOM,
  TAKING,
  WIDE,
  alliesOf,
  borderWith,
  capitalOf as goalCapital,
  holdingGoal,
  isLogistics,
  measureGoal,
  setupGoal,
  trackShips,
} from './opgoals.js';

/**
 * Opérations (ordre d'opération) : un ou plusieurs pays cibles (ou une région), un objectif (affaiblir
 * les forces, contrôle aérien total, conquête totale, décapitation, frappes stratégiques, neutraliser
 * la défense antiaérienne, blocus naval, tenir une frontière, occuper une région), un ou plusieurs
 * généraux — chacun avec son armée et un rôle tiré de son commandement (terre, air, mer, défense
 * sol-air) — une échéance facultative, des règles d'engagement et une agressivité.
 *
 * Le planificateur commun (déterministe, à chaque réflexion des IA) déclare la guerre aux cibles selon
 * les règles d'engagement, tient le renseignement de l'opération (cibles connues), découpe le théâtre
 * en secteurs pour les généraux de l'armée de terre, mesure la progression chiffrée de chaque objectif,
 * fixe la phase (rassemblement borné, suppression des défenses, offensive, maintien), émet les alertes
 * (pertes lourdes, opération enlisée, objectif atteint) et conclut. Chaque général agit ensuite selon
 * son rôle (opbrain.ts) : l'aviation ouvre le ciel, l'armée de terre avance, la marine bloque, la
 * défense sol-air couvre les troupes. Tout est sérialisé dans state.mods.cmd.ops.
 */

const fail = (error: OrderResult['error'], message: string): OrderResult => ({
  ok: false,
  error,
  message,
});

export { TAKING };

/** Opération close (réussie ou échouée). */
export function closed(op: OpSt): boolean {
  return op.status === 'success' || op.status === 'failed';
}

export function opsOf(state: EngineState): Record<string, OpSt> {
  return (cmd(state).ops ??= {});
}

export function opOf(state: EngineState, a: ArmySt): OpSt | null {
  return a.op ? (cmdOpt(state)?.ops?.[a.op] ?? null) : null;
}

export function goalDef(state: EngineState, goal: string): OpGoalDef | null {
  return cmdBal(state).operations.goals[goal] ?? null;
}

/** Arme d'une pile (null : satellites, armes nucléaires). */
export function unitBranch(state: EngineState, u: Unit): Branch | null {
  return branchOfSystem(sysOf(state, u));
}

function capitalOf(state: EngineState, o: NationId): ProvinceId | null {
  return wi(state.world).nationById.get(o)?.capitalProvinceId ?? null;
}

function cityAt(state: EngineState, pid: ProvinceId): LngLat {
  return wi(state.world).provById.get(pid)!.cityPoint;
}

/** Barycentre de points (longitudes dépliées autour du premier). */
export function middle(pts: LngLat[]): LngLat | null {
  if (!pts.length) return null;
  const ref = pts[0]![0];
  let x = 0;
  let y = 0;
  for (const p of pts) {
    let l = p[0];
    if (l - ref > 180) l -= 360;
    else if (ref - l > 180) l += 360;
    x += l;
    y += p[1];
  }
  let cx = x / pts.length;
  if (cx > 180) cx -= 360;
  if (cx < -180) cx += 360;
  return [cx, y / pts.length];
}

// ——— Renseignement de l'opération ———

export type BldKind = 'ad' | 'air' | 'mil' | 'naval' | 'ind' | 'log' | 'res';

const BLD_KIND: Partial<Record<BuildingType, BldKind>> = {
  air_defense_site: 'ad',
  radar_station: 'ad',
  air_base: 'air',
  military_base: 'mil',
  arms_factory: 'mil',
  naval_base: 'naval',
  refinery: 'ind',
  power_plant: 'ind',
  electronics_plant: 'ind',
  research_center: 'ind',
  forward_base: 'log',
  port: 'log',
  recruiting_office: 'log',
  oil_field: 'res',
  mine: 'res',
  local_industry: 'res',
};

/** Installations suivies par la mesure d'un objectif (frappes : bâtiments à détruire). */
export function trackedBld(goal: string, b: { kind: BldKind; b: BuildingType }): boolean {
  switch (goal) {
    case 'strategic':
      return b.kind === 'air' || b.kind === 'mil' || b.kind === 'naval' || b.kind === 'ind';
    case 'strategic_bombing':
      return b.kind !== 'ad' && b.kind !== 'log';
    case 'interdiction':
      return isLogistics(b.b);
    case 'naval_strikes':
      return b.kind === 'ad' || b.kind === 'air' || b.kind === 'mil' || b.kind === 'naval';
    case 'missile_campaign':
      return b.kind === 'ad' || b.kind === 'air' || b.kind === 'mil';
    case 'raid':
      return b.kind !== 'res';
    default:
      return b.kind === 'ad';
  }
}

export interface OpIntel {
  /** Pays cibles en guerre avec la nation (les seuls qu'on frappe). */
  foes: NationId[];
  sams: Seen[];
  airUp: Seen[];
  airGround: Seen[];
  ground: Seen[];
  ships: Seen[];
  /** Installations révélées par le renseignement, en état. */
  blds: { pid: ProvinceId; b: BuildingType; at: LngLat; kind: BldKind }[];
  /** Barycentre des villes des cibles, ville amie la plus proche (front). */
  center: LngLat | null;
  front: LngLat | null;
}

const intelCache = new WeakMap<EngineState, { t: number; m: Map<string, OpIntel> }>();

/** Cibles des pays visés : provinces encore à eux (ou provinces désignées encore à prendre). */
export function foeProvinces(state: EngineState, op: OpSt): ProvinceId[] {
  const kind = goalDef(state, op.goal)?.target ?? 'nation';
  if (CUSTOM.has(op.goal)) {
    const allies = new Set(op.gd?.allies ?? []);
    return op.targets.filter((p) => {
      const o = state.provinces[p]?.owner;
      return !!o && o !== op.owner && !allies.has(o);
    });
  }
  if (op.provinces?.length)
    return op.provinces.filter((p) => {
      const o = state.provinces[p]?.owner;
      return !!o && o !== op.owner;
    });
  // Défense de son territoire, soutien d'un allié : aucune province ennemie visée.
  if (kind === 'self' || kind === 'ally') return [];
  const out: ProvinceId[] = [];
  for (const o of op.nations) out.push(...provincesOf(state, o));
  return out.sort();
}

/**
 * Nations visées : pays cibles, propriétaires des provinces désignées ou à prendre ; pour une
 * opération sur son territoire sans pays désigné, les nations en guerre avec soi ; pour un allié,
 * ses ennemis.
 */
export function opNations(state: EngineState, op: OpSt): NationId[] {
  const kind = goalDef(state, op.goal)?.target ?? 'nation';
  const out = new Set<NationId>();
  const allies = new Set<NationId>(kind === 'ally' ? op.nations : []);
  if (kind === 'ally') {
    for (const a of op.nations) for (const e of [...(state.rt.enemies.get(a) ?? [])]) out.add(e);
  } else for (const o of op.nations) out.add(o);
  for (const p of op.provinces ?? []) {
    const o = state.provinces[p]?.owner;
    if (o && o !== op.owner) out.add(o);
  }
  if (CUSTOM.has(op.goal))
    for (const p of op.targets) {
      const o = state.provinces[p]?.owner;
      if (o && o !== op.owner) out.add(o);
    }
  if (kind === 'self' && !op.nations.length)
    for (const e of [...(state.rt.enemies.get(op.owner) ?? [])]) out.add(e);
  out.delete(op.owner);
  for (const a of allies) out.delete(a);
  return [...out].filter((o) => state.nations[o]?.alive).sort();
}

/** Théâtre d'une opération défensive : ses provinces au contact des ennemis, sinon sa capitale. */
function theater(state: EngineState, op: OpSt, foes: NationId[]): ProvinceId[] {
  const kind = goalDef(state, op.goal)?.target ?? 'nation';
  const set = new Set(foes);
  if (kind === 'ally') {
    const out: ProvinceId[] = [];
    for (const a of op.nations) out.push(...borderWith(state, a, set));
    if (out.length) return out.sort();
    return op.nations.map((a) => goalCapital(state, a)).filter((p): p is ProvinceId => !!p);
  }
  if (op.gd?.sites?.length)
    return op.gd.sites.filter((p) => state.provinces[p]?.owner === op.owner);
  if (op.gd?.lines?.[0]?.length) return op.gd.lines[0];
  const front = borderWith(state, op.owner, set);
  if (front.length) return front;
  const cap = goalCapital(state, op.owner);
  return cap && state.provinces[cap]?.owner === op.owner ? [cap] : [];
}

/** Ce que la nation sait des pays visés (contacts identifiés, installations révélées), une fois par instant. */
export function opIntel(state: EngineState, op: OpSt): OpIntel {
  let c = intelCache.get(state);
  if (!c || c.t !== state.time) {
    c = { t: state.time, m: new Map() };
    intelCache.set(state, c);
  }
  const hit = c.m.get(op.id);
  if (hit) return hit;
  const n = op.owner;
  const foes = opNations(state, op).filter((o) => atWar(state, n, o));
  const set = new Set(foes);
  const I: OpIntel = {
    foes,
    sams: [],
    airUp: [],
    airGround: [],
    ground: [],
    ships: [],
    blds: [],
    center: null,
    front: null,
  };
  const ms = mil(state).ms;
  for (const x of visibleEnemies(state, n).threats) {
    if (!set.has(x.u.owner) || !x.sys) continue;
    const s = x.sys;
    if (isSam(s) || (s.category === 'radar' && s.movement !== 'air')) I.sams.push(x);
    else if (s.movement === 'air') (ms[x.u.id]?.up ? I.airUp : I.airGround).push(x);
    else if (s.movement === 'sea') I.ships.push(x);
    else if (s.movement === 'land') I.ground.push(x);
  }
  const pts: LngLat[] = [];
  for (const pid of foeProvinces(state, op)) {
    const owner = state.provinces[pid]!.owner;
    pts.push(cityAt(state, pid));
    if (!set.has(owner)) continue;
    const k = knowledge(state, n, pid);
    if (!k || (k.m <= 0 && k.e <= 0)) continue;
    for (const b of revealed(pid, buildingsOf(state, pid), k)) {
      const kind = BLD_KIND[b];
      if (!kind || bldHealth(state, pid, b) <= 0) continue;
      I.blds.push({ pid, b, at: cityAt(state, pid), kind });
    }
  }
  // Opération défensive ou de soutien : le théâtre est son front (ou celui de l'allié).
  if (!pts.length) for (const p of theater(state, op, foes)) pts.push(cityAt(state, p));
  I.center = middle(pts);
  if (I.center) {
    let bd = Infinity;
    for (const pid of provincesOf(state, n)) {
      const d = distanceKm(cityAt(state, pid), I.center);
      if (d < bd) {
        bd = d;
        I.front = cityAt(state, pid);
      }
    }
  }
  c.m.set(op.id, I);
  return I;
}

// ——— Forces : piles d'un commandement prises d'office ———

/**
 * Armée qui rend ses piles disponibles : formée d'office pour une opération désormais close (elle
 * tient les gains ou rentre en attendant un nouvel ordre).
 */
export function spareArmy(state: EngineState, aid: string | undefined): boolean {
  const c = cmdOpt(state);
  const a = aid ? c?.armies[aid] : undefined;
  if (!a || !a.opAuto) return false;
  const op = a.op ? c?.ops?.[a.op] : undefined;
  return !op || closed(op);
}

/** Piles libres (hors armée, ou d'une armée d'opération close) d'une arme, utilisables par un général. */
export function freeBranchPiles(
  state: EngineState,
  n: NationId,
  b: Branch,
  keep: ReadonlySet<string> = new Set(),
): Unit[] {
  const c = cmdOpt(state);
  const out: Unit[] = [];
  for (const id of sortedKeys(state.units)) {
    const u = state.units[id]!;
    if (u.owner !== n || u.role || u.off) continue;
    const aid = c?.unitArmy[id];
    if (aid && (keep.has(aid) || !spareArmy(state, aid))) continue;
    const s = sysOf(state, u);
    if (s.speedKmh <= 0 || branchOfSystem(s) !== b) continue;
    out.push(u);
  }
  return out;
}

/**
 * Forces d'office : part des piles libres de l'arme, les plus proches des cibles d'abord (la garnison
 * de la capitale reste chez elle, sauf engagement total).
 */
function autoForces(
  state: EngineState,
  n: NationId,
  b: Branch,
  share: number,
  aim: LngLat | null,
  taken: Set<string>,
  keepArmies: ReadonlySet<string> = new Set(),
): Unit[] {
  const O = cmdBal(state).operations;
  const cap = capitalOf(state, n);
  const capAt = cap && state.provinces[cap]?.owner === n ? cityAt(state, cap) : null;
  let free = freeBranchPiles(state, n, b, keepArmies).filter((u) => !taken.has(u.id));
  // Une pile de l'armée de terre garde la capitale (la plus proche), sauf engagement total.
  if (share < 1 && b === 'land' && capAt && free.length > 1) {
    const keep = free
      .map((u) => ({ u, d: distanceKm(unitPosAt(state, u, state.time), capAt) }))
      .filter((x) => x.d <= CAPTURE_RADIUS_KM * 2)
      .sort((p, q) => p.d - q.d || (p.u.id < q.u.id ? -1 : 1))[0];
    if (keep) free = free.filter((u) => u.id !== keep.u.id);
  }
  const cands = free
    .map((u) => ({ u, d: aim ? distanceKm(unitPosAt(state, u, state.time), aim) : 0 }))
    .filter((x) => !aim || x.d <= O.autoReachKm)
    .sort((p, q) => p.d - q.d || (p.u.id < q.u.id ? -1 : 1));
  const k = Math.min(cmdBal(state).maxPiles, Math.max(1, Math.ceil(cands.length * share)));
  return cands.slice(0, cands.length ? k : 0).map((x) => x.u);
}

// ——— Secteurs de l'armée de terre ———

/** Coordonnées locales (km) d'un point autour d'une origine. */
function local(o: LngLat, p: LngLat): [number, number] {
  let dl = p[0] - o[0];
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  return [dl * 111.32 * Math.cos((o[1] * Math.PI) / 180), (p[1] - o[1]) * 110.57];
}

function dirOf(v: [number, number], spread: number): OpSector {
  const [x, y] = v;
  if (Math.hypot(x, y) < Math.max(40, spread * 0.15)) return 'center';
  if (Math.abs(y) >= Math.abs(x)) return y > 0 ? 'north' : 'south';
  return x > 0 ? 'east' : 'west';
}

/**
 * Découpe les provinces à prendre en secteurs contigus, un par général de l'armée de terre : axe de
 * l'offensive (de ses forces vers la cible), provinces ordonnées le long de la perpendiculaire,
 * secteurs attribués aux généraux dans le même ordre (chacun garde son flanc).
 */
export function computeSectors(state: EngineState, op: OpSt): void {
  const c = cmd(state);
  const land = op.armies.filter((id) => op.roles[id] === 'land' && c.armies[id]);
  op.sectors = {};
  const targets = op.targets.length ? op.targets : [];
  if (!land.length) return;
  const max = cmdBal(state).operations.sectors;
  const pts = targets.map((p) => cityAt(state, p));
  const center = middle(pts);
  const ats = land.map((id) => centroid(state, c.armies[id]!));
  const from = middle(ats.filter((x): x is LngLat => !!x));
  // Percée : concentration de tous les généraux sur l'axe (pas de secteurs).
  const concentrate = op.goal === 'breakthrough';
  if (
    !TAKING.has(op.goal) ||
    concentrate ||
    land.length < 2 ||
    targets.length < 2 ||
    !center ||
    !from
  ) {
    for (const id of land) op.sectors[id] = { dir: 'all', pids: [...targets] };
    return;
  }
  const k = Math.min(land.length, max, targets.length);
  // Axe : forces → cible ; perpendiculaire (vers la gauche de l'axe).
  const ax = local(from, center);
  const len = Math.hypot(ax[0], ax[1]) || 1;
  const perp: [number, number] = [-ax[1] / len, ax[0] / len];
  const proj = (p: LngLat) => {
    const v = local(center, p);
    return v[0] * perp[0] + v[1] * perp[1];
  };
  const ordered = targets
    .map((p) => ({ p, x: proj(cityAt(state, p)) }))
    .sort((a, b) => a.x - b.x || (a.p < b.p ? -1 : 1));
  const chunks: ProvinceId[][] = [];
  for (let i = 0; i < k; i++) {
    const a = Math.floor((i * ordered.length) / k);
    const b = Math.floor(((i + 1) * ordered.length) / k);
    chunks.push(ordered.slice(a, b).map((x) => x.p));
  }
  const armies = land
    .map((id, i) => ({ id, x: ats[i] ? proj(ats[i]!) : 0 }))
    .sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1));
  let spread = 0;
  for (const p of pts) spread = Math.max(spread, Math.hypot(...local(center, p)));
  armies.forEach((a, i) => {
    const pids = chunks[Math.min(i, k - 1)]!;
    const mid = middle(pids.map((p) => cityAt(state, p)));
    op.sectors[a.id] = {
      dir: i >= k ? 'all' : mid ? dirOf(local(center, mid), spread) : 'all',
      pids: i >= k ? [...targets] : [...pids].sort(),
    };
  });
}

// ——— Ordres ———

interface Resolved {
  gen: GenSt | null;
  hire: { idx: number; branch: Branch } | null;
  army: ArmySt | null;
  units: Unit[] | null;
  role: Branch | null;
  share: number | null;
}

/** Valide les généraux d'un ordre (sans rien modifier). */
function resolveCommanders(
  state: EngineState,
  n: NationId,
  list: OpCommanderInput[],
): { ok: true; out: Resolved[] } | { ok: false; res: OrderResult } {
  const c = cmd(state);
  const B = cmdBal(state);
  const no = (msg: string, e: OrderResult['error'] = 'invalid_target') => ({
    ok: false as const,
    res: fail(e, msg),
  });
  const out: Resolved[] = [];
  const gens = new Set<string>();
  const armies = new Set<string>();
  const units = new Set<string>();
  let bonus = 0;
  for (const x of list) {
    let gen: GenSt | null = null;
    let hire: Resolved['hire'] = null;
    if (x.generalId) {
      gen = c.gens[x.generalId] ?? null;
      if (!gen || gen.owner !== n || gen.status === 'dead' || gen.status === 'resigned')
        return no('Général inconnu.');
      if (gens.has(gen.id)) return no('Un général ne commande qu’une fois dans l’opération.');
      gens.add(gen.id);
    } else if (x.candidateId) {
      const h = checkHire(state, n, x.candidateId);
      if (!h.ok) return h;
      if (gens.has(x.candidateId)) return no('Candidat en double.');
      gens.add(x.candidateId);
      hire = { idx: h.idx, branch: h.branch };
      bonus += hireBonus(state, n, h.idx, h.branch);
    } else if (!x.armyId) return no('Choisissez un général.');
    let army: ArmySt | null = null;
    if (x.armyId) {
      army = c.armies[x.armyId] ?? null;
      if (!army || army.owner !== n) return no('Armée inconnue.');
      if (armies.has(army.id)) return no('Armée en double.');
      armies.add(army.id);
      if (!gen && !hire) {
        gen = army.general ? (c.gens[army.general] ?? null) : null;
        if (!gen) return no('Cette armée n’a pas de général.');
      }
    }
    let us: Unit[] | null = null;
    if (x.unitIds?.length) {
      us = [];
      for (const id of [...new Set(x.unitIds)].sort()) {
        const u = state.units[id];
        if (!u) return no(`Unité inconnue : ${id}`, 'unknown_unit');
        if (u.owner !== n) return no(`Cette unité ne vous appartient pas : ${id}`, 'not_owner');
        if (u.role) return no(`Unité indisponible : ${id}`, 'not_allowed');
        if (units.has(id)) return no('Pile attribuée deux fois.');
        units.add(id);
        us.push(u);
      }
      if (us.length > B.maxPiles) return no('Trop de piles pour une armée.', 'capacity');
    }
    out.push({ gen, hire, army, units: us, role: x.role ?? null, share: x.share ?? null });
  }
  // Primes d'engagement cumulées.
  if (bonus > 0 && state.nations[n]!.money < bonus)
    return no('Trésorerie insuffisante pour les primes d’engagement.', 'insufficient_funds');
  return { ok: true, out };
}

function hireBonus(state: EngineState, n: NationId, idx: number, b: Branch): number {
  // Même calcul que doHire (prime d'engagement).
  const B = cmdBal(state);
  return Math.round(salaryOfCandidate(state, n, idx, b) * B.generals.signingBonusDays);
}

function salaryOfCandidate(state: EngineState, n: NationId, idx: number, b: Branch): number {
  const g = candidateOf(state, n, idx, b);
  return salaryOf(state, n, g.skills, g.traits);
}

/** Nouvelle armée (forces d'un général dans une opération). */
function newArmy(state: EngineState, n: NationId, name: string): ArmySt {
  const id = nextCmdId(state, 'a');
  const a: ArmySt = {
    id,
    owner: n,
    name: name.slice(0, 40) || id,
    createdAt: state.time,
    units: [],
    general: null,
    mission: null,
    status: 'idle',
    suspended: false,
    reinforce: 'ask',
    manual: {},
    request: null,
    askAfter: 0,
    journal: [],
    start: 0,
    now: 0,
    est: null,
    obj: null,
    aims: [],
    captures: 0,
    losses: 0,
    mem: {},
    v: 0,
  };
  cmd(state).armies[id] = a;
  return a;
}

/** Retire une armée de son opération (elle redevient libre, sans mission). */
export function leaveOp(state: EngineState, a: ArmySt, dissolveAuto: boolean): void {
  const c = cmd(state);
  const op = a.op ? c.ops?.[a.op] : undefined;
  if (op) {
    op.armies = op.armies.filter((x) => x !== a.id);
    delete op.roles[a.id];
    delete op.sectors[a.id];
    op.v++;
  }
  delete a.op;
  a.mem = {};
  a.request = null;
  a.aims = [];
  a.status = 'idle';
  a.post = null;
  a.v++;
  if (dissolveAuto && a.opAuto) {
    removeUnits(state, a, [...a.units]);
    const g = a.general ? c.gens[a.general] : null;
    if (g) g.army = null;
    delete c.armies[a.id];
  }
}

/** Engage les généraux (recrutés au besoin) et leurs forces dans l'opération. */
function enlist(state: EngineState, op: OpSt, rs: Resolved[]): void {
  const c = cmd(state);
  const n = op.owner;
  const O = cmdBal(state).operations;
  const aim = opIntelCenter(state, op);
  const taken = new Set<string>();
  // Armées reprises telles quelles (désignées, ou celle du général) : leurs piles ne sont pas « libres ».
  const keepArmies = new Set<string>();
  // Généraux de même arme aux forces d'office : piles partagées par contiguïté géographique.
  const autoBy = new Map<Branch, number[]>();
  rs.forEach((r, i) => {
    const b = r.role ?? (r.gen ? branchOf(r.gen) : (r.hire?.branch ?? 'land'));
    if (r.army) keepArmies.add(r.army.id);
    else if (!r.units && r.gen?.army && c.armies[r.gen.army]?.units.length)
      keepArmies.add(r.gen.army);
    if (!r.army && !r.units && !(r.gen?.army && c.armies[r.gen.army]?.units.length))
      autoBy.set(b, [...(autoBy.get(b) ?? []), i]);
  });
  const autoUnits = new Map<number, Unit[]>();
  for (const b of BRANCHES) {
    const idx = autoBy.get(b);
    if (!idx) continue;
    const share = Math.max(...idx.map((i) => rs[i]!.share ?? O.forceShare[op.aggr]));
    const pool = autoForces(state, n, b, share, aim, taken, keepArmies);
    for (const u of pool) taken.add(u.id);
    // Découpage le long de la perpendiculaire à l'axe (même règle que les secteurs).
    const center = aim;
    const sorted = pool
      .map((u) => {
        const p = unitPosAt(state, u, state.time);
        const v: [number, number] = center ? local(center, p) : [0, 0];
        return { u, x: v[0] - v[1] };
      })
      .sort((p, q) => p.x - q.x || (p.u.id < q.u.id ? -1 : 1));
    idx.forEach((i, k) => {
      const a0 = Math.floor((k * sorted.length) / idx.length);
      const a1 = Math.floor(((k + 1) * sorted.length) / idx.length);
      autoUnits.set(
        i,
        sorted.slice(a0, a1).map((x) => x.u),
      );
    });
  }
  rs.forEach((r, i) => {
    let g = r.gen;
    if (!g && r.hire) g = doHire(state, n, r.hire.idx, null, r.hire.branch);
    let a = r.army;
    if (!a && g?.army && !r.units && !autoUnits.has(i)) a = c.armies[g.army] ?? null;
    if (!a) {
      a = newArmy(state, n, `${op.name} · ${g ? g.last : ''}`.trim());
      a.opAuto = true;
      const units = r.units ?? autoUnits.get(i) ?? [];
      addUnits(
        state,
        a,
        units.map((u) => u.id),
      );
      journalArmy(state, a, 'created', { count: a.units.length });
    } else if (r.units) {
      addUnits(
        state,
        a,
        r.units.map((u) => u.id),
      );
    }
    if (g && a.general !== g.id) assign(state, g, a);
    // Une armée change d'opération : le général est réaffecté (l'opération close n'en dit rien).
    if (a.op && a.op !== op.id) {
      const prev = c.ops?.[a.op];
      if (prev && !closed(prev)) opJournal(state, prev, 'reassigned', { army: a.name }, 'warn');
      leaveOp(state, a, false);
    }
    a.op = op.id;
    a.mission = null;
    a.mem = {};
    a.request = null;
    a.suspended = false;
    // Nouvelle intention du joueur : le général reprend toutes ses piles (ordres directs levés).
    a.manual = {};
    a.post = null;
    const home = centroid(state, a);
    if (home) a.home = home;
    a.start = armyValue(state, a);
    a.now = a.start;
    a.status = a.general ? 'preparing' : 'passive';
    a.v++;
    if (!op.armies.includes(a.id)) op.armies.push(a.id);
    op.roles[a.id] = r.role ?? (g ? branchOf(g) : dominantBranch(state, a));
    journalArmy(state, a, 'joinedOp', {
      op: op.name,
      role: { key: `engine.cmd.role.${op.roles[a.id]}` },
    });
  });
  pruneSpare(state);
}

/** Armées d'office d'opérations closes vidées de leurs piles (reprises par une autre) : dissoutes. */
export function pruneSpare(state: EngineState): void {
  const c = cmd(state);
  for (const id of Object.keys(c.armies).sort()) {
    const a = c.armies[id]!;
    if (!a.units.length && spareArmy(state, id)) leaveOp(state, a, true);
  }
}

/** Arme dominante (valeur) des piles d'une armée. */
export function dominantBranch(state: EngineState, a: ArmySt): Branch {
  const v: Record<Branch, number> = { land: 0, air: 0, sea: 0, ad: 0 };
  for (const id of a.units) {
    const u = state.units[id];
    if (!u) continue;
    const b = unitBranch(state, u);
    if (b) v[b] += unitValue(state, u);
  }
  let best: Branch = 'land';
  for (const b of BRANCHES) if (v[b] > v[best]) best = b;
  return best;
}

function opIntelCenter(state: EngineState, op: OpSt): LngLat | null {
  return middle(foeProvinces(state, op).map((p) => cityAt(state, p)));
}

/** Provinces à prendre, front à tenir, références des mesures (au lancement ou au changement d'objectif). */
function setGoal(state: EngineState, op: OpSt, stageHours?: number): void {
  const n = op.owner;
  const w = wi(state.world);
  op.targets = [];
  // Objectifs ajoutés : cibles et données propres (lignes, anneau, axe, sites…).
  setupGoal(state, op, goalDef(state, op.goal));
  const foes = opNations(state, op);
  if (CUSTOM.has(op.goal)) {
    // Cibles déjà calculées.
  } else if (op.goal === 'conquest') op.targets = foeProvinces(state, op);
  else if (op.goal === 'occupy') op.targets = foeProvinces(state, op);
  else if (op.goal === 'decapitation')
    op.targets = foes
      .map((o) => capitalOf(state, o))
      .filter((p): p is ProvinceId => !!p && state.provinces[p]?.owner !== n)
      .sort();
  const killed: Record<NationId, number> = {};
  let enemy = 0;
  const mine = ownForce(state, n);
  op.kills = 0;
  for (const o of foes) {
    killed[o] = 0;
    const pub = publicForce(state, n, o);
    enemy += pub ? pub.mean : estimateForce(state, n, o, mine, 1);
  }
  let ports = 0;
  for (const o of foes) ports += portsOf(state, o).length;
  const foeSet = new Set(foes);
  const front = provincesOf(state, n)
    .filter((p) =>
      (w.provById.get(p)?.neighbors ?? []).some((x) => {
        const o = state.provinces[x]?.owner;
        return !!o && foeSet.has(o);
      }),
    )
    .sort();
  op.base = { enemy: Math.round(enemy), killed, ports, front };
  op.seen = { sams: [], air: [], bld: [] };
  op.airAt = null;
  op.best = 0;
  op.pct = 0;
  op.prog = [];
  op.doneAt = null;
  op.progressAt = state.time;
  op.stageUntil = state.time + (stageHours ?? cmdBal(state).operations.stageHours) * HOUR;
  op.phase = 'stage';
  op.status = 'planning';
  op.focus = [];
  op.ships = [];
  op.phaseAt = state.time;
}

/** Objectif sans guerre (redéploiement…) : ses propres provinces peuvent être désignées. */
function keepOwn(state: EngineState, goal: string): boolean {
  return goalDef(state, goal)?.war === false;
}

function validTargets(
  state: EngineState,
  n: NationId,
  def: OpGoalDef,
  nations: string[],
  provinces: string[] | undefined,
): OrderResult | null {
  for (const o of nations) {
    if (o === n) return fail('invalid_target', 'Vous ne pouvez pas vous viser vous-même.');
    if (!state.nations[o]?.alive) return fail('invalid_target', 'Nation invalide.');
    if (def.target === 'ally' && atWar(state, n, o))
      return fail('invalid_target', 'Vous êtes en guerre contre ce pays.');
  }
  for (const p of provinces ?? []) {
    if (!state.provinces[p]) return fail('invalid_target', 'Province inconnue.');
  }
  if (def.target === 'provinces' && !provinces?.length)
    return fail('invalid_target', 'Désignez les provinces à occuper.');
  if (def.target === 'nation' && !nations.length)
    return fail('invalid_target', 'Désignez au moins un pays cible.');
  if (def.target === 'ally' && !nations.length)
    return fail('invalid_target', 'Désignez le pays allié à soutenir.');
  if (def.target === 'place' && !nations.length && !provinces?.length)
    return fail('invalid_target', 'Désignez un pays ou des provinces.');
  return null;
}

/** Message d'un objectif sans cible (rien à prendre au lancement de la phase). */
const NO_TARGET: Record<string, string> = {
  counteroffensive: 'Aucune de vos provinces n’est occupée.',
  liberation: 'Aucune province de ce pays n’est occupée.',
  encircle: 'Aucune poche ennemie au contact.',
  breakthrough: 'Aucun axe de percée vers la cible.',
  siege: 'Aucune ville à assiéger.',
  amphibious: 'Aucune côte à atteindre.',
  raid: 'Aucune installation à l’arrière de la cible.',
};

/**
 * Phases d'un ordre : objectif composé des données (guerre éclair…) développé, puis phases demandées
 * (cibles de la phase précédente si absentes).
 */
function buildChain(
  state: EngineState,
  n: NationId,
  goal: string,
  nations: NationId[],
  provinces: ProvinceId[] | undefined,
  extra: OpPhaseInput[] | undefined,
  firstHours?: number,
): { ok: true; chain: OpPhaseSt[] } | { ok: false; res: OrderResult } {
  const O = cmdBal(state).operations;
  const chain: OpPhaseSt[] = [];
  const push = (g: string, ns: NationId[], ps: ProvinceId[] | undefined, hours?: number) => {
    const d = goalDef(state, g);
    if (!d) return fail('invalid_target', 'Objectif inconnu.');
    if (d.chain?.length) {
      for (let i = 0; i < d.chain.length; i++) {
        const sub = goalDef(state, d.chain[i]!);
        if (!sub || sub.chain?.length) return fail('invalid_target', 'Objectif inconnu.');
        const h = d.chain.length - 1 === i && hours ? hours : d.chainHours?.[i] || undefined;
        chain.push({
          goal: d.chain[i]!,
          nations: [...ns],
          ...(ps?.length ? { provinces: [...ps] } : {}),
          ...(h ? { hours: h } : {}),
        });
      }
      return null;
    }
    const bad = validTargets(state, n, d, ns, ps);
    if (bad) return bad;
    chain.push({
      goal: g,
      nations: [...ns],
      ...(ps?.length ? { provinces: [...ps] } : {}),
      ...(hours ? { hours } : {}),
    });
    return null;
  };
  const first = goalDef(state, goal);
  if (!first) return { ok: false, res: fail('invalid_target', 'Objectif inconnu.') };
  const bad0 = validTargets(state, n, first, nations, provinces);
  if (bad0) return { ok: false, res: bad0 };
  const e0 = push(goal, nations, provinces, firstHours);
  if (e0) return { ok: false, res: e0 };
  let pn = nations;
  let pp = provinces;
  for (const ph of extra ?? []) {
    const ns = ph.nations ? [...new Set(ph.nations)].sort() : pn;
    const ps = ph.provinces
      ? [...new Set(ph.provinces)]
          .filter((p) => keepOwn(state, ph.goal) || state.provinces[p]?.owner !== n)
          .sort()
      : ph.nations
        ? undefined
        : pp;
    const e = push(ph.goal, ns, ps, ph.hours);
    if (e) return { ok: false, res: e };
    pn = ns;
    pp = ps;
  }
  if (chain.length > O.maxPhases)
    return { ok: false, res: fail('capacity', 'Trop de phases pour une opération.') };
  return { ok: true, chain };
}

/** Applique la phase `i` de l'enchaînement à l'opération (objectif, cibles). */
function applyPhase(op: OpSt, i: number): void {
  const ph = op.chain![i]!;
  op.step = i;
  op.goal = ph.goal;
  op.nations = [...ph.nations];
  if (ph.provinces?.length) op.provinces = [...ph.provinces];
  else delete op.provinces;
}

export function orderCampaignCreate(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignCreate' }>,
): OrderResult {
  const B = cmdBal(state);
  if (!B.enabled) return fail('not_allowed', 'Centre de commandement désactivé.');
  const O = B.operations;
  const def = goalDef(state, o.goal);
  if (!def) return fail('invalid_target', 'Objectif inconnu.');
  // Seules les opérations en cours comptent (les opérations closes restent consultables).
  const mine = Object.values(cmdOpt(state)?.ops ?? {}).filter(
    (x) => x.owner === n && !closed(x),
  ).length;
  if (mine >= O.maxOps) return fail('capacity', 'Nombre maximal d’opérations atteint.');
  if (o.commanders.length > O.maxCommanders)
    return fail('capacity', 'Trop de généraux pour une opération.');
  const nations = [...new Set(o.nations)].sort();
  const provinces = o.provinces?.length
    ? [...new Set(o.provinces)]
        .filter((p) => keepOwn(state, o.goal) || state.provinces[p]?.owner !== n)
        .sort()
    : undefined;
  const ch = buildChain(state, n, o.goal, nations, provinces, o.phases, o.phaseHours);
  if (!ch.ok) return ch.res;
  const armiesNow = Object.values(cmd(state).armies).filter((a) => a.owner === n).length;
  const fresh = o.commanders.filter((x) => !x.armyId).length;
  if (armiesNow + fresh > B.maxArmies) return fail('capacity', 'Nombre maximal d’armées atteint.');
  const r = resolveCommanders(state, n, o.commanders);
  if (!r.ok) return r.res;
  const op: OpSt = {
    id: '',
    owner: n,
    name: '',
    goal: ch.chain[0]!.goal,
    nations: ch.chain[0]!.nations,
    ...(ch.chain[0]!.provinces?.length ? { provinces: ch.chain[0]!.provinces } : {}),
    aggr: o.aggr ?? 'balanced',
    roe: o.roe ?? 'standard',
    ...(o.retreatAt !== undefined ? { retreatAt: o.retreatAt } : {}),
    deadline: o.deadlineHours ? state.time + o.deadlineHours * HOUR : null,
    since: state.time,
    status: 'planning',
    suspended: false,
    armies: [],
    roles: {},
    sectors: {},
    targets: [],
    base: { enemy: 0, killed: {}, ports: 0, front: [] },
    seen: { sams: [], air: [], bld: [] },
    airAt: null,
    strikes: 0,
    captures: 0,
    losses: 0,
    phase: 'stage',
    stageUntil: state.time,
    progressAt: state.time,
    best: 0,
    doneAt: null,
    request: null,
    okWar: [],
    journal: [],
    prog: [],
    pct: 0,
    start: 0,
    now: 0,
    day: [state.time, 0],
    alerts: {},
    reconAt: null,
    est: null,
    v: 0,
  };
  if (ch.chain.length > 1 || def.chain?.length) {
    op.chain = ch.chain;
    op.step = 0;
    op.results = [];
  }
  if (def.chain?.length) op.preset = o.goal;
  if (o.after) op.after = o.after;
  setGoal(state, op);
  // Rien à prendre (contre-offensive sans province perdue…) : refus, rien n'est modifié.
  if (TAKING.has(op.goal) || op.goal === 'raid')
    if (!op.targets.length)
      return fail('invalid_target', NO_TARGET[op.goal] ?? 'Aucune cible pour cet objectif.');
  const id = nextCmdId(state, 'o');
  op.id = id;
  op.name = (o.name ?? '').trim().slice(0, 40) || `Op ${id.slice(1)}`;
  opsOf(state)[id] = op;
  enlist(state, op, r.out);
  computeSectors(state, op);
  op.start = opValue(state, op);
  op.now = op.start;
  op.day = [state.time, op.start];
  opJournal(state, op, 'created', {
    goal: { key: `engine.cmd.goal.${op.preset ?? op.goal}` },
    count: op.armies.length,
  });
  if (op.chain && op.chain.length > 1)
    opJournal(state, op, 'phaseStart', {
      n: 1,
      total: op.chain.length,
      goal: { key: `engine.cmd.goal.${op.goal}` },
    });
  scheduleOp(state, op);
  return { ok: true };
}

export function scheduleOp(state: EngineState, op: OpSt): void {
  scheduleMod(state, { t: state.time, m: 'cmd', e: 'op', d: { o: op.id, v: op.v } });
  ensureTick(state);
}

function myOp(state: EngineState, n: NationId, id: string): OpSt | null {
  const op = cmdOpt(state)?.ops?.[id];
  return op && op.owner === n ? op : null;
}

/** Armées de l'opération remises en préparation (nouvel objectif, nouvelle phase, réouverture). */
function rearm(state: EngineState, op: OpSt): void {
  const c = cmd(state);
  for (const id of op.armies) {
    const a = c.armies[id];
    if (!a) continue;
    a.mem = {};
    a.post = null;
    a.status = a.general ? 'preparing' : 'passive';
    a.v++;
  }
  op.post = null;
  delete op.postUntil;
}

/**
 * Phase suivante de l'enchaînement : nouvel objectif et nouvelles cibles, mêmes généraux et mêmes
 * forces (rassemblement court). Les phases sans cible sont sautées. Faux : plus de phase.
 */
export function advancePhase(
  state: EngineState,
  op: OpSt,
  result: 'success' | 'timeout' | 'skipped',
): boolean {
  const chain = op.chain;
  const i = op.step ?? 0;
  if (!chain || i + 1 >= chain.length) return false;
  const O = cmdBal(state).operations;
  const results = (op.results ??= []);
  results[i] = result;
  opJournal(
    state,
    op,
    result === 'success' ? 'phaseDone' : result === 'timeout' ? 'phaseTimeout' : 'phaseSkipped',
    { n: i + 1, goal: { key: `engine.cmd.goal.${op.goal}` } },
    result === 'success' ? 'good' : 'warn',
  );
  let k = i + 1;
  for (; k < chain.length; k++) {
    applyPhase(op, k);
    setGoal(state, op, O.phaseStageHours);
    if ((TAKING.has(op.goal) || op.goal === 'raid') && !op.targets.length) {
      results[k] = 'skipped';
      opJournal(
        state,
        op,
        'phaseSkipped',
        { n: k + 1, goal: { key: `engine.cmd.goal.${op.goal}` } },
        'warn',
      );
      continue;
    }
    break;
  }
  if (k >= chain.length) return false;
  rearm(state, op);
  computeSectors(state, op);
  op.now = opValue(state, op);
  op.day = [state.time, op.now];
  op.v++;
  opJournal(state, op, 'phaseStart', {
    n: k + 1,
    total: chain.length,
    goal: { key: `engine.cmd.goal.${op.goal}` },
  });
  notifyOwner(
    state,
    op.owner,
    'opPhase',
    { op: op.name, n: k + 1, total: chain.length, goal: { key: `engine.cmd.goal.${op.goal}` } },
    'info',
  );
  scheduleOp(state, op);
  return true;
}

export function orderCampaignEdit(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignEdit' }>,
): OrderResult {
  const op = myOp(state, n, o.opId);
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  const goal = o.goal ?? op.goal;
  const def = goalDef(state, goal);
  if (!def) return fail('invalid_target', 'Objectif inconnu.');
  const nations = o.nations ? [...new Set(o.nations)].sort() : op.nations;
  const provinces = o.provinces
    ? [...new Set(o.provinces)]
        .filter((p) => keepOwn(state, goal) || state.provinces[p]?.owner !== n)
        .sort()
    : op.provinces;
  const retarget =
    goal !== op.goal ||
    JSON.stringify(nations) !== JSON.stringify(op.nations) ||
    JSON.stringify(provinces ?? []) !== JSON.stringify(op.provinces ?? []);
  // Nouvel objectif (ou composé) : l'enchaînement repart de lui, suivi des phases demandées ;
  // nouvelles phases seules : elles remplacent celles qui restent après la phase en cours.
  let chain: OpPhaseSt[] | null = null;
  if (retarget || o.phases) {
    const ch = buildChain(state, n, retarget ? goal : op.goal, nations, provinces, o.phases ?? []);
    if (!ch.ok) return ch.res;
    chain = ch.chain;
  }
  if (closed(op) && (retarget || o.phases)) {
    const live = Object.values(cmdOpt(state)?.ops ?? {}).filter(
      (x) => x.owner === n && !closed(x),
    ).length;
    if (live >= cmdBal(state).operations.maxOps)
      return fail('capacity', 'Nombre maximal d’opérations atteint.');
  }
  if (o.name !== undefined) op.name = o.name.trim().slice(0, 40) || op.name;
  if (o.aggr) op.aggr = o.aggr;
  if (o.roe) op.roe = o.roe;
  if (o.after) op.after = o.after;
  if (o.deadlineHours !== undefined)
    op.deadline = o.deadlineHours === null ? null : state.time + o.deadlineHours * HOUR;
  if (chain) {
    const keep = retarget ? [] : (op.chain ?? []).slice(0, op.step ?? 0);
    const full = [...keep, ...chain];
    if (full.length > 1 || (retarget ? !!def.chain?.length : !!op.preset)) {
      op.chain = full;
      op.step = keep.length;
      op.results = (op.results ?? []).slice(0, keep.length);
    } else {
      delete op.chain;
      delete op.step;
      delete op.results;
    }
    if (retarget) {
      if (def.chain?.length) op.preset = goal;
      else delete op.preset;
      if (op.chain) applyPhase(op, op.step!);
      else {
        op.goal = goal;
        op.nations = nations;
        if (provinces?.length) op.provinces = provinces;
        else delete op.provinces;
      }
    }
  }
  if (retarget) {
    setGoal(state, op);
    rearm(state, op);
    computeSectors(state, op);
    op.start = opValue(state, op);
    op.now = op.start;
    opJournal(
      state,
      op,
      'goalChanged',
      { goal: { key: `engine.cmd.goal.${op.preset ?? op.goal}` } },
      'warn',
    );
  }
  if (o.stageNow && !closed(op) && state.time < op.stageUntil) {
    op.stageUntil = state.time;
    opJournal(state, op, 'stageNow', {}, 'warn');
  }
  if (o.nextPhase && !closed(op) && !advancePhase(state, op, 'skipped'))
    return fail('not_allowed', 'Aucune phase suivante.');
  op.v++;
  if (!op.suspended) scheduleOp(state, op);
  return { ok: true };
}

export function orderCampaignForces(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignForces' }>,
): OrderResult {
  const op = myOp(state, n, o.opId);
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  const c = cmd(state);
  const B = cmdBal(state);
  const remove = (o.remove ?? []).filter((id) => op.armies.includes(id));
  const add = o.add ?? [];
  if (op.armies.length - remove.length + add.length > B.operations.maxCommanders)
    return fail('capacity', 'Trop de généraux pour une opération.');
  for (const x of o.roles ?? [])
    if (!op.armies.includes(x.armyId)) return fail('invalid_target', 'Armée hors de l’opération.');
  const r = add.length ? resolveCommanders(state, n, add) : null;
  if (r && !r.ok) return r.res;
  for (const id of remove) {
    const a = c.armies[id];
    if (!a) continue;
    opJournal(state, op, 'released', { army: a.name });
    leaveOp(state, a, true);
  }
  if (r?.ok) {
    enlist(state, op, r.out);
    op.start += 0;
    opJournal(state, op, 'reinforced', { count: r.out.length }, 'good');
  }
  for (const x of o.roles ?? []) {
    op.roles[x.armyId] = x.role;
    const a = c.armies[x.armyId];
    if (a) {
      a.mem = {};
      a.v++;
      opJournal(state, op, 'role', {
        army: a.name,
        role: { key: `engine.cmd.role.${x.role}` },
      });
    }
  }
  computeSectors(state, op);
  op.start = Math.max(op.start, 0);
  if (r?.ok) op.start = opValue(state, op) + Math.max(0, op.start - op.now);
  op.now = opValue(state, op);
  op.v++;
  if (!op.suspended) scheduleOp(state, op);
  return { ok: true };
}

export function orderCampaignSuspend(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignSuspend' }>,
): OrderResult {
  const op = myOp(state, n, o.opId);
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  if (op.suspended === o.on) return { ok: true };
  op.suspended = o.on;
  op.v++;
  const c = cmd(state);
  if (o.on) {
    op.status = 'suspended';
    for (const id of op.armies) if (c.armies[id]) c.armies[id]!.status = 'suspended';
    opJournal(state, op, 'suspended', {}, 'warn');
  } else {
    op.status = 'active';
    op.progressAt = state.time;
    opJournal(state, op, 'resumed');
    scheduleOp(state, op);
  }
  return { ok: true };
}

export function orderCampaignCancel(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignCancel' }>,
): OrderResult {
  const op = myOp(state, n, o.opId);
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  const c = cmd(state);
  for (const id of [...op.armies]) {
    const a = c.armies[id];
    if (a) {
      journalArmy(state, a, 'opClosed', { op: op.name });
      leaveOp(state, a, true);
    }
  }
  delete c.ops![op.id];
  return { ok: true };
}

export function orderCampaignAnswer(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'campaignAnswer' }>,
): OrderResult {
  const op = myOp(state, n, o.opId);
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  const rq = op.request;
  if (!rq || rq.id !== o.requestId) return fail('invalid_target', 'Demande expirée.');
  op.request = null;
  op.v++;
  if (o.accept) {
    op.okWar = [...new Set([...op.okWar, rq.nationId])].sort();
    op.status = 'active';
    opJournal(state, op, 'warAuthorized', { nation: { nation: rq.nationId } }, 'warn');
    scheduleOp(state, op);
  } else {
    op.suspended = true;
    op.status = 'suspended';
    opJournal(state, op, 'warRefused', { nation: { nation: rq.nationId } });
  }
  return { ok: true };
}

// ——— Planificateur ———

export function opValue(state: EngineState, op: OpSt): number {
  const c = cmd(state);
  let v = 0;
  for (const id of op.armies) {
    const a = c.armies[id];
    if (a) v += armyValue(state, a);
  }
  return v;
}

/** Guerre contre les pays visés : déclarée (règles libres ou standard), sinon autorisation demandée. */
function ensureWars(state: EngineState, op: OpSt): boolean {
  // Opérations défensives, démonstration de force, redéploiement : jamais de guerre ouverte.
  if (goalDef(state, op.goal)?.war === false) return true;
  const n = op.owner;
  for (const o of opNations(state, op)) {
    if (atWar(state, n, o)) continue;
    if (op.roe !== 'strict' || op.okWar.includes(o)) {
      let ok = false;
      asGeneral(() => {
        ok = order(state, n, { kind: 'declareWar', nationId: o }) && atWar(state, n, o);
      });
      if (ok) {
        opJournal(state, op, 'declaredWar', { nation: { nation: o } }, 'warn');
        continue;
      }
      opJournal(state, op, 'warBlocked', { nation: { nation: o } }, 'bad');
      op.suspended = true;
      op.status = 'suspended';
      return false;
    }
    if (!op.request) {
      op.request = { id: nextCmdId(state, 'r'), kind: 'declare_war', nationId: o, at: state.time };
      notifyOwner(state, n, 'opAskWar', { op: op.name, nation: { nation: o } }, 'warn');
      opJournal(state, op, 'askWar', { nation: { nation: o } }, 'warn');
    }
    op.status = 'awaiting';
    return false;
  }
  return true;
}

/** Contacts identifiés suivis (défense sol-air, aéronefs) : liste bornée, ordre d'apparition. */
function track(list: string[], ids: string[]): void {
  for (const id of ids) if (!list.includes(id) && list.length < 600) list.push(id);
}

/** Mesures chiffrées de l'opération. */
function measure(state: EngineState, op: OpSt, I: OpIntel): void {
  const n = op.owner;
  track(
    op.seen.sams,
    I.sams.map((x) => x.u.id),
  );
  track(
    op.seen.air,
    [...I.airUp, ...I.airGround].map((x) => x.u.id),
  );
  const rear = op.goal === 'raid' ? new Set(op.gd?.rear ?? []) : null;
  track(
    op.seen.bld,
    I.blds
      .filter((x) => trackedBld(op.goal, x) && (!rear || rear.has(x.pid)))
      .map((x) => `${x.pid}:${x.b}`),
  );
  trackShips(
    op,
    I.ships.map((x) => x.u.id),
  );
  if (I.airUp.length) op.airAt = state.time;
  const gone = (id: string) => {
    const u = state.units[id];
    return !u || u.off || u.owner === n;
  };
  const bldDown = (k: string) => {
    const [pid, b] = k.split(':') as [ProvinceId, BuildingType];
    return bldHealth(state, pid, b) <= 0 || state.provinces[pid]?.owner === n;
  };
  const prog: OpSt['prog'] = [];
  const add = (key: OpMetric, done: number, total: number) =>
    prog.push({ key, done: Math.round(done), total: Math.round(total) });
  const killed = op.kills ?? 0;
  const samsDone =
    op.seen.sams.filter(gone).length +
    (op.goal === 'strategic' ? 0 : op.seen.bld.filter(bldDown).length);
  const samsTotal = op.seen.sams.length + (op.goal === 'strategic' ? 0 : op.seen.bld.length);
  const airDone = op.seen.air.filter(gone).length;
  const takenT = op.targets.filter((p) => state.provinces[p]?.owner === n).length;
  // Capitales des pays visés, y compris des pays déjà vaincus (la mesure reste « 1/1 » après la chute).
  const caps = [...new Set([...op.nations, ...opNations(state, op)])]
    .sort()
    .map((o) => capitalOf(state, o))
    .filter((p): p is ProvinceId => !!p);
  let main = 0;
  switch (op.goal) {
    case 'attrition':
      add('forces', killed, op.base.enemy);
      add('sams', samsDone, samsTotal);
      add('aircraft', airDone, op.seen.air.length);
      main = op.base.enemy > 0 ? killed / op.base.enemy : 0;
      break;
    case 'air_control':
    case 'sead':
      add('sams', samsDone, samsTotal);
      if (op.goal === 'air_control') add('aircraft', airDone, op.seen.air.length);
      main =
        op.goal === 'sead'
          ? samsTotal
            ? samsDone / samsTotal
            : 0
          : samsTotal + op.seen.air.length
            ? (samsDone + airDone) / (samsTotal + op.seen.air.length)
            : 0;
      break;
    case 'conquest':
    case 'occupy':
    case 'decapitation': {
      add('provinces', takenT, op.targets.length);
      if (op.goal !== 'occupy') {
        const capT = op.targets.filter((p) => caps.includes(p) || op.goal === 'decapitation');
        add('capital', capT.filter((p) => state.provinces[p]?.owner === n).length, capT.length);
      }
      add('forces', killed, op.base.enemy);
      main = op.targets.length ? takenT / op.targets.length : 0;
      break;
    }
    case 'strategic': {
      const done = op.seen.bld.filter(bldDown).length;
      add('buildings', done, op.seen.bld.length);
      add('forces', killed, op.base.enemy);
      main = op.seen.bld.length ? done / op.seen.bld.length : 0;
      break;
    }
    case 'blockade': {
      const blocked = blockedPorts(state, op);
      add('ports', blocked, op.base.ports);
      main = op.base.ports ? blocked / op.base.ports : 0;
      break;
    }
    case 'defend_border': {
      const held = op.base.front.filter((p) => state.provinces[p]?.owner === n).length;
      add('front', held, op.base.front.length);
      add('forces', killed, op.base.enemy);
      main = op.base.front.length ? held / op.base.front.length : 1;
      break;
    }
    default:
      main = measureGoal(state, op, I, add) ?? 0;
  }
  op.prog = prog;
  op.pct = Math.max(0, Math.min(1, main));
  if (op.pct > op.best + 1e-6) {
    op.best = op.pct;
    op.progressAt = state.time;
  }
}

/** Ports des pays visés tenus en blocus par la nation. */
export function blockedPorts(state: EngineState, op: OpSt): number {
  const blk = mil(state).blk;
  const ports = new Set<string>();
  for (const o of opNations(state, op)) for (const p of portsOf(state, o)) ports.add(p);
  let k = 0;
  const done = new Set<string>();
  for (const id of sortedKeys(blk)) {
    const b = blk[id]!;
    if (b.by !== op.owner || !('provinceId' in b.target)) continue;
    const p = b.target.provinceId;
    if (ports.has(p) && !done.has(p)) {
      done.add(p);
      k++;
    }
  }
  return k;
}

/** Objectif de durée atteint ? (ciel tenu, ports bloqués, front tenu). */
function holdingNow(state: EngineState, op: OpSt, I: OpIntel): boolean {
  const def = goalDef(state, op.goal);
  switch (op.goal) {
    case 'air_control': {
      // Aucune défense sol-air connue en état, aucun aéronef ennemi vu en vol depuis 6 h.
      const quiet = op.airAt === null || state.time - op.airAt >= 6 * HOUR;
      // Défenses connues : contacts encore suivis (vus ou perdus de vue récemment), sites révélés.
      const known = state.know[op.owner] ?? {};
      const memory = cmdBal(state).tactics.contactMemoryHours * HOUR;
      const samsLeft =
        op.seen.sams.filter((id) => {
          const u = state.units[id];
          const k = known[id];
          return (
            !!u &&
            !u.off &&
            u.owner !== op.owner &&
            !!k &&
            (k.seen || state.time - k.lastSeen <= memory)
          );
        }).length + I.blds.filter((b) => b.kind === 'ad').length;
      return quiet && samsLeft === 0 && state.time >= op.stageUntil;
    }
    case 'blockade':
      return op.base.ports > 0 && op.pct >= (def?.success ?? 1) - 1e-9;
    case 'defend_border':
      return op.pct >= (def?.success ?? 1) - 1e-9;
  }
  return holdingGoal(state, op, def) ?? false;
}

function alert(
  state: EngineState,
  op: OpSt,
  key: string,
  every: number,
  note: string | null,
  params: Record<string, LocParam>,
  tone: 'warn' | 'bad' | 'good',
): void {
  const at = op.alerts[key];
  if (at !== undefined && state.time - at < every) return;
  op.alerts[key] = state.time;
  opJournal(state, op, key, params, tone);
  if (note)
    notifyOwner(
      state,
      op.owner,
      note,
      { op: op.name, ...params },
      tone === 'good' ? 'info' : 'warn',
    );
}

/**
 * Fin de l'opération. Les forces ne restent jamais inertes : selon « quand c'est fini », elles
 * tiennent les gains (exploitation : garnisons, couverture aérienne, DCA, contre-attaques), rentrent
 * à la base puis sont rendues au joueur, ou passent tout de suite en réserve (piles rendues). Les
 * généraux sont libres pour une nouvelle opération, qui reprend leurs armées et leurs piles.
 */
function closeOp(state: EngineState, op: OpSt, ok: boolean, reason?: string): void {
  const c = cmd(state);
  const after = op.after ?? 'hold';
  if (op.chain) (op.results ??= [])[op.step ?? 0] = ok ? 'success' : 'timeout';
  op.status = ok ? 'success' : 'failed';
  op.phase = 'done';
  op.v++;
  if (ok) {
    opJournal(state, op, 'success', {}, 'good');
    notifyOwner(state, op.owner, 'opSuccess', { op: op.name }, 'info');
  } else {
    opJournal(state, op, 'failed', { reason: { key: `engine.cmd.reason.${reason}` } }, 'bad');
    notifyOwner(state, op.owner, 'opFailed', { op: op.name }, 'warn');
  }
  for (const id of [...op.armies]) {
    const a = c.armies[id];
    if (!a) continue;
    a.status = ok ? 'success' : 'failed';
    a.request = null;
    a.v++;
    const g = a.general ? c.gens[a.general] : null;
    if (ok && g) {
      g.victories++;
      gainXp(state, g, cmdBal(state).generals.xpSuccess, xpBrain(op.roles[id]));
    }
    if (after === 'reserve') {
      journalArmy(state, a, 'opClosed', { op: op.name });
      leaveOp(state, a, true);
      continue;
    }
    a.post = after;
    if (after === 'home' || !ok) a.mem = {};
  }
  op.post = after === 'reserve' ? null : after;
  if (after === 'home') op.postUntil = state.time + cmdBal(state).operations.returnHours * HOUR;
  opJournal(state, op, `after_${after}`, {}, 'info');
  ensureTick(state);
}

function xpBrain(role: Branch | undefined): string {
  return role === 'air'
    ? 'air_superiority'
    : role === 'sea'
      ? 'sea_control'
      : role === 'ad'
        ? 'air_defense'
        : 'conquer';
}

/** Phase réussie : phase suivante s'il y en a une, sinon fin de l'opération. */
function phaseSucceeded(state: EngineState, op: OpSt): void {
  if (!advancePhase(state, op, 'success')) closeOp(state, op, true);
}

/** Libération : les provinces reprises sont rendues à leur propriétaire d'origine (allié). */
function handBack(state: EngineState, op: OpSt): void {
  if (op.goal !== 'liberation') return;
  const allies = new Set(op.gd?.allies ?? []);
  for (const p of op.targets) {
    if (state.provinces[p]?.owner !== op.owner) continue;
    const o = wi(state.world).provById.get(p)?.nationId;
    if (!o || !allies.has(o) || !state.nations[o]?.alive || atWar(state, op.owner, o)) continue;
    transferProvince(state, p, o);
    opJournal(state, op, 'liberated', { province: { province: p }, nation: { nation: o } }, 'good');
  }
}

/** Réflexion du planificateur (avant celles des généraux). */
export function planOp(state: EngineState, op: OpSt): void {
  const c = cmd(state);
  op.armies = op.armies.filter((id) => c.armies[id]?.op === op.id);
  if (closed(op)) {
    if (op.post && !op.armies.length) op.post = null;
    return;
  }
  op.now = opValue(state, op);
  if (op.suspended) {
    op.status = 'suspended';
    return;
  }
  if (op.request) {
    op.status = 'awaiting';
    return;
  }
  if (!ensureWars(state, op)) return;
  handBack(state, op);
  const I = opIntel(state, op);
  measure(state, op, I);
  const def = goalDef(state, op.goal);
  const O = cmdBal(state).operations;
  const B = cmdBal(state);
  // Fin : objectif atteint (missions ponctuelles), échéance, pertes, enlisement.
  if (def && !def.continuous) {
    const total = op.prog[0]?.total ?? 0;
    if (total > 0 && op.pct >= def.success - 1e-9) return phaseSucceeded(state, op);
    if (
      TAKING.has(op.goal) &&
      op.targets.length &&
      !foeProvinces(state, op).some((p) => op.targets.includes(p))
    )
      return phaseSucceeded(state, op);
  }
  // Échéance de la phase : phase suivante (ou fin, pour la dernière).
  const ph = op.chain?.[op.step ?? 0];
  if (ph?.hours && op.phaseAt !== undefined && state.time - op.phaseAt >= ph.hours * HOUR) {
    const done = op.status === 'holding' || op.pct >= (def?.success ?? 1) - 1e-9;
    if (advancePhase(state, op, done ? 'success' : 'timeout')) return;
    return closeOp(state, op, done, 'deadline');
  }
  if (op.deadline !== null && state.time >= op.deadline) {
    if (def?.continuous && op.status === 'holding') return closeOp(state, op, true);
    return closeOp(state, op, false, 'deadline');
  }
  if (op.start > 0 && op.now < B.failShare * op.start) return closeOp(state, op, false, 'losses');
  if (!def?.continuous && state.time - op.progressAt > O.failStuckHours * HOUR)
    return closeOp(state, op, false, 'stuck');
  // Phase.
  const samsKnown = I.sams.length + I.blds.filter((b) => b.kind === 'ad').length;
  if (state.time < op.stageUntil && TAKING.has(op.goal)) op.phase = 'stage';
  else if (op.goal === 'raid' && op.gd?.withdrawAt != null && state.time >= op.gd.withdrawAt)
    op.phase = 'withdraw';
  else if (def?.continuous && holdingNow(state, op, I)) op.phase = 'hold';
  else if (
    (op.goal === 'sead' || op.goal === 'air_control' || op.goal === 'attrition') &&
    samsKnown > 0
  )
    op.phase = 'sead';
  else if (op.goal === 'air_control') op.phase = 'air';
  else op.phase = 'offensive';
  // Statut et alertes.
  const was = op.status;
  if (op.phase === 'hold') {
    op.status = 'holding';
    if (was !== 'holding') {
      op.doneAt = state.time;
      alert(state, op, 'achieved', 0, 'opAchieved', {}, 'good');
      // Objectif de durée atteint au milieu d'un enchaînement : phase suivante.
      if (op.chain && (op.step ?? 0) + 1 < op.chain.length) return phaseSucceeded(state, op);
    }
  } else op.status = op.phase === 'stage' ? 'planning' : 'active';
  if (state.time - op.day[0] >= DAY) op.day = [state.time, op.now];
  else if (op.day[1] > 0 && op.now < op.day[1] * (1 - O.heavyLossShare))
    alert(
      state,
      op,
      'heavyLosses',
      12 * HOUR,
      'opHeavyLosses',
      {
        pct: Math.round(100 * (1 - op.now / op.day[1])),
      },
      'bad',
    );
  if (!def?.continuous && state.time - op.progressAt > O.stuckHours * HOUR)
    alert(
      state,
      op,
      'stuck',
      O.stuckHours * HOUR,
      'opStuck',
      { hours: Math.round(O.stuckHours) },
      'warn',
    );
  op.est = estimateOp(state, op);
}

/** Durée indicative d'un objectif sans rythme observé (heures). */
const ETA: Record<string, number> = {
  attrition: 72,
  strategic: 48,
  interdiction: 48,
  armed_recon: 24,
  naval_supremacy: 72,
  naval_strikes: 36,
  missile_campaign: 24,
  air_redeploy: 12,
  raid: 36,
};

/** Rapport de force, durée et chances de l'opération (vue du joueur : estimations publiques). */
function estimateOp(
  state: EngineState,
  op: OpSt,
): { ratio: number; etaHours: number | null; chance: number } {
  const c = cmd(state);
  const enemy = Math.max(1, op.base.enemy - (op.kills ?? 0));
  const ratio = Math.min(99, op.now / enemy);
  let skill = 30;
  let exp = 20;
  for (const id of op.armies) {
    const g = c.armies[id]?.general ? c.gens[c.armies[id]!.general!] : null;
    if (!g) continue;
    skill = Math.max(skill, generalRating(g.skills));
    exp = Math.max(exp, g.skills.experience);
  }
  const need = cmdBal(state).aggressiveness[op.aggr].attackRatio;
  const x = Math.min(ratio, 10) * (0.85 + (0.3 * skill) / 100) * (0.9 + (0.2 * exp) / 100);
  const chance = Math.max(0.03, Math.min(0.97, (x * x) / (x * x + need * need * 0.64)));
  // Durée : rythme observé depuis le début de la phase, sinon estimation par objectif.
  const el = Math.max(HOUR, state.time - (op.phaseAt ?? op.since));
  let eta: number | null = null;
  const def = goalDef(state, op.goal);
  const goal = def?.success ?? 1;
  if (op.pct > 0.02 && op.pct < goal) eta = ((goal - op.pct) * el) / op.pct / HOUR;
  else if (op.pct < goal) {
    const left = TAKING.has(op.goal)
      ? op.targets.filter((p) => state.provinces[p]?.owner !== op.owner).length
      : 0;
    eta = TAKING.has(op.goal) ? 12 + left * 10 : (ETA[op.goal] ?? 24);
  }
  // Phases à venir : durée indicative ajoutée.
  if (eta !== null && op.chain)
    for (const ph of op.chain.slice((op.step ?? 0) + 1))
      eta += ph.hours ?? (TAKING.has(ph.goal) ? 36 : (ETA[ph.goal] ?? 24));
  return {
    ratio: Math.round(ratio * 100) / 100,
    etaHours: eta === null ? null : Math.round(eta * 10) / 10,
    chance: Math.round(chance * 100) / 100,
  };
}

/** Fin de réflexion : objectifs en cours des généraux de l'armée de terre (appui aérien, flèches). */
export function afterThink(state: EngineState, op: OpSt): void {
  const c = cmd(state);
  const out: LngLat[] = [];
  for (const id of op.armies) {
    const a = c.armies[id];
    if (!a || op.roles[id] !== 'land') continue;
    for (const p of a.aims) if (out.length < 8) out.push([p[0], p[1]]);
  }
  op.focus = out;
}

// ——— Vue ———

export function campaignView(state: EngineState, op: OpSt): CampaignView {
  const c = cmd(state);
  const def = goalDef(state, op.preset ?? op.goal);
  const step = op.step ?? 0;
  const ph = op.chain?.[step];
  return {
    id: op.id,
    name: op.name,
    goal: op.goal,
    nations: [...op.nations],
    ...(op.provinces ? { provinces: [...op.provinces] } : {}),
    status: op.status,
    phase: op.phase,
    aggr: op.aggr,
    roe: op.roe,
    deadline: op.deadline,
    since: op.since,
    commanders: op.armies
      .filter((id) => c.armies[id])
      .map((id) => {
        const a = c.armies[id]!;
        const sec = op.sectors[id];
        const left = sec
          ? sec.pids.filter((p) => state.provinces[p]?.owner !== op.owner).length
          : 0;
        const wait = waitOf(state, a, op);
        return {
          armyId: id,
          generalId: a.general,
          role: op.roles[id] ?? 'land',
          sector: sec ? sec.dir : null,
          sectorLeft: left,
          sectorTotal: sec?.pids.length ?? 0,
          aims: a.aims.slice(0, 4).map((p) => [p[0], p[1]] as LngLat),
          piles: a.units.length,
          value: Math.round(armyValue(state, a)),
          status: a.status,
          ...(wait ? { wait } : {}),
          ...(a.post ? { posture: a.post } : {}),
        };
      }),
    progress: op.prog.map((x) => ({ ...x })),
    pct: Math.round(op.pct * 1000) / 1000,
    journal: op.journal.map((e) => ({ ...e })),
    request: op.request
      ? { id: op.request.id, kind: 'declare_war', nationId: op.request.nationId }
      : null,
    estimate: op.est ? { ...op.est } : null,
    stats: {
      strikes: op.strikes,
      captures: op.captures,
      losses: op.losses,
      kills: Math.round(op.kills ?? 0),
    },
    value: { start: Math.round(op.start), now: Math.round(op.now) },
    category: def?.category ?? 'land',
    ...(op.preset ? { preset: op.preset } : {}),
    ...(op.chain
      ? {
          phases: op.chain.map((p, i) => ({
            goal: p.goal,
            nations: [...p.nations],
            ...(p.provinces ? { provinces: [...p.provinces] } : {}),
            ...(p.hours ? { hours: p.hours } : {}),
            state:
              i < step || (i === step && closed(op))
                ? ('done' as const)
                : i === step
                  ? ('current' as const)
                  : ('next' as const),
            ...(op.results?.[i] ? { result: op.results[i] } : {}),
          })),
          step,
        }
      : {}),
    ...(op.phaseAt !== undefined ? { phaseSince: op.phaseAt } : {}),
    ...(ph?.hours && op.phaseAt !== undefined ? { phaseUntil: op.phaseAt + ph.hours * HOUR } : {}),
    after: op.after ?? 'hold',
    ...(op.phase === 'stage' && !closed(op) ? { stageUntil: op.stageUntil } : {}),
  };
}

/**
 * Ce qu'attend un général : autorisation, renforts, fin d'un ordre direct, rassemblement, carburant,
 * repos des piles éprouvées, forces ou cibles manquantes (affiché avec un bouton d'action).
 */
export function waitOf(state: EngineState, a: ArmySt, op: OpSt | null): WaitView | null {
  const c = cmd(state);
  const g = a.general ? c.gens[a.general] : null;
  if (!g) return { reason: 'noGeneral' };
  if (op?.request) return { reason: 'war', nationId: op.request.nationId };
  if (a.request?.kind === 'declare_war')
    return { reason: 'war', ...(a.request.nationId ? { nationId: a.request.nationId } : {}) };
  if (a.request?.kind === 'strategic_strike')
    return { reason: 'strike', ...(a.request.nationId ? { nationId: a.request.nationId } : {}) };
  if (a.request?.kind === 'reinforce')
    return { reason: 'reinforce', count: a.request.unitIds?.length ?? 0 };
  if (a.suspended || op?.suspended) return { reason: 'suspended' };
  if (g.status === 'wounded' && !op) return { reason: 'wounded' };
  const live = a.units.filter((id) => !!state.units[id] && !state.units[id]!.off);
  if (!live.length) return { reason: 'noForces' };
  const manual = live.filter((id) => a.manual[id]).length;
  if (manual && manual === live.length) return { reason: 'manual', count: manual };
  const rest = live.filter((id) => a.rest?.[id]).length;
  if (rest && rest === live.length) return { reason: 'resting', count: rest };
  if (op && !closed(op) && op.phase === 'stage' && state.time < op.stageUntil)
    return { reason: 'staging', until: op.stageUntil };
  // Aviation au sol (ravitaillement, réarmement) : toute l'armée attend.
  const ms = mil(state).ms;
  const air = live.filter((id) => sysOf(state, state.units[id]!).movement === 'air');
  if (air.length && air.length === live.length) {
    const waiting = air.filter((id) => {
      const m = ms[id];
      return !!m && !m.up && m.ready > state.time;
    }).length;
    if (waiting === air.length) return { reason: 'fuel', count: waiting };
  }
  if (a.why) return { reason: a.why };
  if (manual) return { reason: 'manual', count: manual };
  return null;
}

/**
 * Dégâts infligés par la nation aux forces des pays visés : valeur détruite (prix des matériels ×
 * part des points de vie perdus), mesure de l'attrition.
 */
export function opDamage(state: EngineState, att: Unit, tgt: Unit, dmg: number): void {
  const ops = cmdOpt(state)?.ops;
  if (!ops || tgt.role || att.owner === tgt.owner) return;
  let base = 0;
  for (const id of Object.keys(ops).sort()) {
    const op = ops[id]!;
    if (op.owner !== att.owner || closed(op)) continue;
    if (!op.nations.includes(tgt.owner) && !(tgt.owner in op.base.killed)) continue;
    if (!base) {
      if (tgt.mix) for (const p of tgt.mix) base += elementValue(state, p.sys) * p.c;
      else base = elementValue(state, tgt.sys) * tgt.count;
    }
    const lost = (base * Math.min(dmg, tgt.hp + dmg)) / Math.max(1, tgt.maxHp);
    op.kills = (op.kills ?? 0) + lost;
  }
}

/** Province prise ou perdue : compteurs et journal de l'opération. */
export function opCaptured(
  state: EngineState,
  pid: ProvinceId,
  from: NationId,
  to: NationId,
): void {
  const ops = cmdOpt(state)?.ops;
  if (!ops) return;
  for (const id of sortedKeys(ops)) {
    const op = ops[id]!;
    if (op.status === 'success' || op.status === 'failed') continue;
    if (to === op.owner && op.targets.includes(pid)) {
      op.captures++;
      op.progressAt = state.time;
      opJournal(state, op, 'captured', { province: { province: pid } }, 'good');
    } else if (from === op.owner && (op.base.front.includes(pid) || op.targets.includes(pid)))
      opJournal(state, op, 'lostProvince', { province: { province: pid } }, 'bad');
  }
}

/** Pile d'une armée en opération détruite. */
export function opUnitLost(state: EngineState, a: ArmySt, u: Unit): void {
  const op = opOf(state, a);
  if (op) op.losses += u.count;
}
