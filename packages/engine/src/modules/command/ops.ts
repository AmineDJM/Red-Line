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
  type OpSector,
  type LocParam,
  type Order,
  type ProvinceId,
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
import { cmd, cmdBal, cmdOpt, nextCmdId, type ArmySt, type GenSt, type OpSt } from './state.js';
import { ensureTick } from './schedule.js';

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

/** Objectifs qui prennent des provinces. */
export const TAKING = new Set(['conquest', 'occupy', 'decapitation']);

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

export type BldKind = 'ad' | 'air' | 'mil' | 'naval' | 'ind';

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
};

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
  if (op.provinces?.length)
    return op.provinces.filter((p) => {
      const o = state.provinces[p]?.owner;
      return !!o && o !== op.owner;
    });
  const out: ProvinceId[] = [];
  for (const o of op.nations) out.push(...provincesOf(state, o));
  return out.sort();
}

/** Nations visées : pays cibles, propriétaires des provinces désignées. */
export function opNations(state: EngineState, op: OpSt): NationId[] {
  const out = new Set(op.nations);
  for (const p of op.provinces ?? []) {
    const o = state.provinces[p]?.owner;
    if (o && o !== op.owner) out.add(o);
  }
  return [...out].filter((o) => state.nations[o]?.alive).sort();
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

/** Piles libres (hors armée) d'une arme, utilisables par un général. */
export function freeBranchPiles(state: EngineState, n: NationId, b: Branch): Unit[] {
  const c = cmdOpt(state);
  const out: Unit[] = [];
  for (const id of sortedKeys(state.units)) {
    const u = state.units[id]!;
    if (u.owner !== n || u.role || u.off || c?.unitArmy[id]) continue;
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
): Unit[] {
  const O = cmdBal(state).operations;
  const cap = capitalOf(state, n);
  const capAt = cap && state.provinces[cap]?.owner === n ? cityAt(state, cap) : null;
  let free = freeBranchPiles(state, n, b).filter((u) => !taken.has(u.id));
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
  if (!TAKING.has(op.goal) || land.length < 2 || targets.length < 2 || !center || !from) {
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
  // Généraux de même arme aux forces d'office : piles partagées par contiguïté géographique.
  const autoBy = new Map<Branch, number[]>();
  rs.forEach((r, i) => {
    const b = r.role ?? (r.gen ? branchOf(r.gen) : (r.hire?.branch ?? 'land'));
    if (!r.army && !r.units && !(r.gen?.army && c.armies[r.gen.army]?.units.length))
      autoBy.set(b, [...(autoBy.get(b) ?? []), i]);
  });
  const autoUnits = new Map<number, Unit[]>();
  for (const b of BRANCHES) {
    const idx = autoBy.get(b);
    if (!idx) continue;
    const share = Math.max(...idx.map((i) => rs[i]!.share ?? O.forceShare[op.aggr]));
    const pool = autoForces(state, n, b, share, aim, taken);
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
    // Une armée change d'opération : le général est réaffecté.
    if (a.op && a.op !== op.id) {
      const prev = c.ops?.[a.op];
      if (prev) opJournal(state, prev, 'reassigned', { army: a.name }, 'warn');
      leaveOp(state, a, false);
    }
    a.op = op.id;
    a.mission = null;
    a.mem = {};
    a.request = null;
    a.suspended = false;
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
function setGoal(state: EngineState, op: OpSt): void {
  const n = op.owner;
  const w = wi(state.world);
  const foes = opNations(state, op);
  op.targets = [];
  if (op.goal === 'conquest') op.targets = foeProvinces(state, op);
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
  op.stageUntil = state.time + cmdBal(state).operations.stageHours * HOUR;
  op.phase = 'stage';
  op.status = 'planning';
  op.focus = [];
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
  }
  for (const p of provinces ?? []) {
    if (!state.provinces[p]) return fail('invalid_target', 'Province inconnue.');
  }
  if (def.target === 'provinces' && !provinces?.length)
    return fail('invalid_target', 'Désignez les provinces à occuper.');
  if (def.target === 'nation' && !nations.length)
    return fail('invalid_target', 'Désignez au moins un pays cible.');
  return null;
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
  const mine = Object.values(cmdOpt(state)?.ops ?? {}).filter((x) => x.owner === n).length;
  if (mine >= O.maxOps) return fail('capacity', 'Nombre maximal d’opérations atteint.');
  if (o.commanders.length > O.maxCommanders)
    return fail('capacity', 'Trop de généraux pour une opération.');
  const nations = [...new Set(o.nations)].sort();
  const provinces = o.provinces?.length
    ? [...new Set(o.provinces)].filter((p) => state.provinces[p]?.owner !== n).sort()
    : undefined;
  const bad = validTargets(state, n, def, nations, provinces);
  if (bad) return bad;
  const armiesNow = Object.values(cmd(state).armies).filter((a) => a.owner === n).length;
  const fresh = o.commanders.filter((x) => !x.armyId).length;
  if (armiesNow + fresh > B.maxArmies) return fail('capacity', 'Nombre maximal d’armées atteint.');
  const r = resolveCommanders(state, n, o.commanders);
  if (!r.ok) return r.res;
  const id = nextCmdId(state, 'o');
  const op: OpSt = {
    id,
    owner: n,
    name: (o.name ?? '').trim().slice(0, 40) || `Op ${id.slice(1)}`,
    goal: o.goal,
    nations,
    ...(provinces?.length ? { provinces } : {}),
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
  opsOf(state)[id] = op;
  setGoal(state, op);
  enlist(state, op, r.out);
  computeSectors(state, op);
  op.start = opValue(state, op);
  op.now = op.start;
  op.day = [state.time, op.start];
  opJournal(state, op, 'created', {
    goal: { key: `engine.cmd.goal.${op.goal}` },
    count: op.armies.length,
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
    ? [...new Set(o.provinces)].filter((p) => state.provinces[p]?.owner !== n).sort()
    : op.provinces;
  const bad = validTargets(state, n, def, nations, provinces);
  if (bad) return bad;
  if (o.name !== undefined) op.name = o.name.trim().slice(0, 40) || op.name;
  if (o.aggr) op.aggr = o.aggr;
  if (o.roe) op.roe = o.roe;
  if (o.deadlineHours !== undefined)
    op.deadline = o.deadlineHours === null ? null : state.time + o.deadlineHours * HOUR;
  const retarget =
    goal !== op.goal ||
    JSON.stringify(nations) !== JSON.stringify(op.nations) ||
    JSON.stringify(provinces ?? []) !== JSON.stringify(op.provinces ?? []);
  if (retarget) {
    op.goal = goal;
    op.nations = nations;
    if (provinces?.length) op.provinces = provinces;
    else delete op.provinces;
    setGoal(state, op);
    const c = cmd(state);
    for (const id of op.armies) {
      const a = c.armies[id];
      if (!a) continue;
      a.mem = {};
      a.status = a.general ? 'preparing' : 'passive';
      a.v++;
    }
    computeSectors(state, op);
    op.start = opValue(state, op);
    op.now = op.start;
    opJournal(state, op, 'goalChanged', { goal: { key: `engine.cmd.goal.${goal}` } }, 'warn');
  }
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
  if (op.goal === 'defend_border') return true;
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
  track(
    op.seen.bld,
    I.blds
      .filter((x) => (op.goal === 'strategic' ? x.kind !== 'ad' : x.kind === 'ad'))
      .map((x) => `${x.pid}:${x.b}`),
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
  return false;
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

function closeOp(state: EngineState, op: OpSt, ok: boolean, reason?: string): void {
  const c = cmd(state);
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
  for (const id of op.armies) {
    const a = c.armies[id];
    if (!a) continue;
    a.status = ok ? 'success' : 'failed';
    a.v++;
    const g = a.general ? c.gens[a.general] : null;
    if (ok && g) {
      g.victories++;
      gainXp(state, g, cmdBal(state).generals.xpSuccess, xpBrain(op.roles[id]));
    }
  }
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

/** Réflexion du planificateur (avant celles des généraux). */
export function planOp(state: EngineState, op: OpSt): void {
  const c = cmd(state);
  op.armies = op.armies.filter((id) => c.armies[id]?.op === op.id);
  if (op.status === 'success' || op.status === 'failed') return;
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
  const I = opIntel(state, op);
  measure(state, op, I);
  const def = goalDef(state, op.goal);
  const O = cmdBal(state).operations;
  const B = cmdBal(state);
  // Fin : objectif atteint (missions ponctuelles), échéance, pertes, enlisement.
  if (def && !def.continuous) {
    const total = op.prog[0]?.total ?? 0;
    if (total > 0 && op.pct >= def.success - 1e-9) return closeOp(state, op, true);
    if (
      TAKING.has(op.goal) &&
      op.targets.length &&
      !foeProvinces(state, op).some((p) => op.targets.includes(p))
    )
      return closeOp(state, op, true);
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
  // Durée : rythme observé depuis le lancement, sinon estimation par objectif.
  const el = Math.max(HOUR, state.time - op.since);
  let eta: number | null = null;
  const def = goalDef(state, op.goal);
  const goal = def?.success ?? 1;
  if (op.pct > 0.02 && op.pct < goal) eta = ((goal - op.pct) * el) / op.pct / HOUR;
  else if (op.pct < goal) {
    const left = TAKING.has(op.goal)
      ? op.targets.filter((p) => state.provinces[p]?.owner !== op.owner).length
      : 0;
    eta = TAKING.has(op.goal) ? 12 + left * 10 : op.goal === 'attrition' ? 72 : 24;
  }
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
  };
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
    if (op.owner !== att.owner || op.status === 'success' || op.status === 'failed') continue;
    if (!op.nations.includes(tgt.owner) && !(op.provinces?.length && tgt.owner in op.base.killed))
      continue;
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
