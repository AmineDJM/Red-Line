import {
  CATEGORIES,
  DAY,
  HOUR,
  MINUTE,
  RESEARCH_BRANCHES,
  RESOURCES,
  loc,
  type GovBudget,
  type GovMissionDef,
  type GovOffice,
  type LocParam,
  type NationId,
  type Order,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { scheduleMod } from '../kit.js';
import { ecoIncome } from '../eco/budget.js';
import { maxProtected } from '../intel/interior.js';
import {
  dayUnit,
  execute,
  inventoryLots,
  protectedCount,
  resolvePending,
  type Ctx,
} from './exec.js';
import { effectsOf, officeDef } from './heads.js';
import { journal, notifyOwner } from './journal.js';
import {
  gov,
  govBal,
  govNation,
  govOpt,
  nextGovId,
  type GovNation,
  type MissionSt,
} from './state.js';

/**
 * Missions confiées aux ministères et directions : création, modification (priorité, enveloppe,
 * objectif), suspension, retrait, et exécution à la cadence de l'IA (`time.aiThinkMinutes`). Chaque
 * nation réfléchit missions par ordre de priorité ; une mission n'agit que si son poste a un titulaire,
 * dans son enveloppe et au-dessus du plancher de trésorerie (prudence du titulaire, mission Réserves).
 */

const fail = (error: OrderResult['error'], message: string): OrderResult => ({
  ok: false,
  error,
  message,
});

export function missionDef(state: EngineState, type: string): GovMissionDef | undefined {
  return govBal(state).missions[type];
}

/** Disponible maintenant dans l'enveloppe d'une mission. */
export function availableOf(m: MissionSt): number {
  const b = m.budget;
  if (b.mode === 'amount') return Math.max(0, b.amount - m.spent);
  const cap = b.cap ?? Infinity;
  return Math.max(0, Math.min(m.credit, cap) - m.spent);
}

/** Revenus journaliers (base des enveloppes en part des revenus). */
function revenueDay(state: EngineState, n: NationId): number {
  return Math.max(0, ecoIncome(state, n)?.money ?? 0);
}

function active(m: MissionSt): boolean {
  return !m.suspended && m.status !== 'done';
}

// ——— Cadence ———

function thinkPeriod(state: EngineState): number {
  return state.world.balance.time.aiThinkMinutes * MINUTE;
}

/** Tick commun de réflexion (programmé tant qu'une mission est en cours). */
export function ensureTick(state: EngineState): void {
  const g = gov(state);
  if (g.ticking) return;
  g.ticking = true;
  const p = thinkPeriod(state);
  scheduleMod(state, { t: (Math.floor(state.time / p) + 1) * p, m: 'gov', e: 'tick' });
}

/** Réflexion immédiate d'une nation (nouvelle mission, titulaire nommé), puis cadence commune. */
export function scheduleNation(state: EngineState, n: NationId): void {
  const gn = govNation(state, n);
  gn.v++;
  scheduleMod(state, { t: state.time, m: 'gov', e: 'think', d: { n, v: gn.v } });
  ensureTick(state);
}

export function anyLive(state: EngineState): boolean {
  const g = govOpt(state);
  if (!g) return false;
  for (const n of Object.keys(g.nations)) {
    const ms = g.nations[n]!.missions;
    for (const id of Object.keys(ms)) if (active(ms[id]!)) return true;
  }
  return false;
}

// ——— Réflexion ———

/** Plancher de trésorerie des missions Réserves de la nation (hors la mission `except`). */
function reserveFloor(state: EngineState, n: NationId, gn: GovNation, except?: string): number {
  let f = 0;
  for (const id of Object.keys(gn.missions).sort()) {
    const m = gn.missions[id]!;
    if (id === except || !active(m) || missionDef(state, m.type)?.exec !== 'reserve') continue;
    f = Math.max(f, m.goal * dayUnit(state, n));
  }
  return f;
}

/** Plancher de trésorerie d'un poste : prudence du titulaire, missions Réserves. */
export function floorFor(state: EngineState, n: NationId, office: GovOffice, except?: string) {
  const gn = govNation(state, n);
  const h = gn.heads[office];
  const own = h ? effectsOf(state, office, h).reserveDays * dayUnit(state, n) : 0;
  return Math.max(own, reserveFloor(state, n, gn, except));
}

function sortedMissions(gn: GovNation): MissionSt[] {
  return Object.keys(gn.missions)
    .map((id) => gn.missions[id]!)
    .sort((a, b) => b.priority - a.priority || a.since - b.since || (a.id < b.id ? -1 : 1));
}

function setWhy(
  state: EngineState,
  n: NationId,
  m: MissionSt,
  why: string | undefined,
  params: Record<string, LocParam> | undefined,
  blocked: boolean,
): void {
  const text = why ? loc(`engine.gov.why.${why}`, params) : undefined;
  const changed = JSON.stringify(text ?? null) !== JSON.stringify(m.why ?? null);
  if (text) m.why = text;
  else delete m.why;
  // Un blocage nouveau est expliqué au journal (une fois, pas à chaque réflexion).
  if (changed && blocked && text)
    journal(
      state,
      n,
      m.office,
      'blocked',
      { why: { key: text.key, params: text.params ?? {} } },
      'warn',
      m.id,
    );
}

/** Fin d'une mission (objectif atteint) : historique, journal, notification. */
function finish(state: EngineState, n: NationId, gn: GovNation, m: MissionSt): void {
  m.status = 'done';
  m.ended = state.time;
  delete m.why;
  journal(
    state,
    n,
    m.office,
    'missionDone',
    { mission: { key: `engine.gov.m.${m.type}` } },
    'good',
    m.id,
  );
  notifyOwner(state, n, 'missionDone', { mission: { key: `engine.gov.m.${m.type}` } }, 'info');
  archive(state, gn, m);
}

function archive(state: EngineState, gn: GovNation, m: MissionSt): void {
  delete gn.missions[m.id];
  m.pending = [];
  gn.history.push(m);
  const max = govBal(state).historyMax;
  if (gn.history.length > max) gn.history.splice(0, gn.history.length - max);
}

/** Objectif atteint (missions à objectif ; la prochaine génération finit à son ouverture). */
function goalReached(def: GovMissionDef, m: MissionSt): boolean {
  if (def.continuous || (def.exec === 'research' && def.target === 'category')) return false;
  return m.goal > 0 && m.done >= m.goal;
}

/** Missions de la nation, par ordre de priorité. */
export function thinkNation(state: EngineState, n: NationId): void {
  const ns = state.nations[n];
  const gn = govOpt(state)?.nations[n];
  if (!gn || !ns?.alive) return;
  const B = govBal(state);
  const leads = new Set<GovOffice>();
  for (const m of sortedMissions(gn)) {
    const def = missionDef(state, m.type);
    if (!def) continue;
    const pend0 = m.pending.length;
    const done0 = m.done;
    resolvePending(state, n, m, def);
    if (m.pending.length !== pend0 || m.done !== done0) delete m.retryAt;
    if (m.suspended) {
      m.status = 'suspended';
      continue;
    }
    const lead = !leads.has(m.office);
    leads.add(m.office);
    if (goalReached(def, m)) {
      finish(state, n, gn, m);
      continue;
    }
    const head = gn.heads[m.office];
    if (!head) {
      m.status = 'blocked';
      setWhy(state, n, m, 'noHead', undefined, true);
      continue;
    }
    const fx = effectsOf(state, m.office, head);
    const free = Math.max(0, fx.slots - m.pending.length);
    if (free <= 0 && def.exec !== 'reserve') {
      m.status = 'active';
      setWhy(state, n, m, undefined, undefined, false);
      continue;
    }
    // Mission bloquée récemment : rien n'a changé d'ici son prochain examen.
    if (m.retryAt !== undefined && state.time < m.retryAt) continue;
    delete m.retryAt;
    const ctx: Ctx = {
      state,
      n,
      m,
      def,
      office: m.office,
      fx,
      floor: def.exec === 'reserve' ? 0 : floorFor(state, n, m.office, m.id),
      available: availableOf(m),
      lead,
    };
    const out = execute(ctx, free, B.batch);
    if (
      def.exec === 'research' &&
      def.target === 'category' &&
      out.why === 'unlocked' &&
      !m.pending.length
    ) {
      // Prochaine génération ouverte : mission accomplie.
      if (m.goal <= 0) m.goal = m.done;
      finish(state, n, gn, m);
      continue;
    }
    if (out.acted > 0 || m.pending.length > 0) {
      m.status = 'active';
      setWhy(state, n, m, out.acted > 0 ? undefined : out.why, out.params, false);
    } else if (out.soft) {
      m.status = 'waiting';
      setWhy(state, n, m, out.why, out.params, false);
    } else {
      m.status = 'blocked';
      setWhy(state, n, m, out.why ?? 'refused', out.params, true);
    }
    if (out.acted === 0) {
      const at = retryAt(state, m, out.why);
      if (at !== null) m.retryAt = at;
    }
    if (goalReached(def, m)) finish(state, n, gn, m);
  }
}

/** Prochain examen d'une mission restée sans action (null : à la prochaine réflexion). */
function retryAt(state: EngineState, m: MissionSt, why: string | undefined): number | null {
  switch (why) {
    case 'envelope':
      // Part des revenus : nouveau crédit au tick journalier ; montant fixe : jusqu'à modification.
      return m.budget.mode === 'share'
        ? (Math.floor(state.time / DAY) + 1) * DAY + 1
        : state.time + 30 * DAY;
    case 'saving':
    case 'reserveHeld':
      return null;
    case 'funds':
    case 'reserve':
    case 'resources':
    case 'capacity':
    case 'locked':
    case 'inProgress':
    case 'stocked':
    case 'nothingDamaged':
    case 'allProtected':
      return state.time + 2 * HOUR;
    default:
      return state.time + 6 * HOUR;
  }
}

export function handleTick(state: EngineState): void {
  const g = gov(state);
  g.ticking = false;
  for (const n of Object.keys(g.nations).sort()) thinkNation(state, n);
  if (anyLive(state)) ensureTick(state);
}

/** Enveloppes en part des revenus : crédit du jour. */
export function accrueDaily(state: EngineState): void {
  const g = govOpt(state);
  if (!g) return;
  for (const n of Object.keys(g.nations).sort()) {
    if (!state.nations[n]?.alive) continue;
    const ms = g.nations[n]!.missions;
    let rev: number | null = null;
    for (const id of Object.keys(ms).sort()) {
      const m = ms[id]!;
      if (m.budget.mode !== 'share' || !active(m)) continue;
      rev ??= revenueDay(state, n);
      m.credit += (m.budget.pct / 100) * rev;
    }
  }
}

// ——— Progression (vue) ———

/** Avancement 0..1 et compte « fait » affiché d'une mission. */
export function progressOf(
  state: EngineState,
  n: NationId,
  m: MissionSt,
): { done: number; goal: number; progress: number } {
  const def = missionDef(state, m.type);
  if (m.status === 'done') return { done: m.done, goal: m.goal, progress: 1 };
  const ratio = (d: number, g: number) => (g > 0 ? Math.max(0, Math.min(1, d / g)) : 0);
  switch (def?.exec) {
    case 'stock': {
      const have = inventoryLots(state, n, m.category ?? def.defaultTarget ?? '');
      return { done: have, goal: m.goal, progress: ratio(have, m.goal) };
    }
    case 'reserve': {
      const unit = dayUnit(state, n);
      const days = unit > 0 ? Math.floor(state.nations[n]!.money / unit) : 0;
      return { done: days, goal: m.goal, progress: ratio(days, m.goal) };
    }
    case 'protect': {
      const max = maxProtected(state, n);
      const k = protectedCount(state, n);
      return { done: k, goal: max, progress: ratio(k, max) };
    }
    default:
      return { done: m.done, goal: m.goal, progress: ratio(m.done, m.goal) };
  }
}

// ——— Ordres ———

function checkTarget(
  state: EngineState,
  n: NationId,
  def: GovMissionDef,
  o: Extract<Order, { kind: 'govMission' }>['mission'],
): string | null {
  const w = wi(state.world);
  if (def.target === 'resource' && o.resource && !RESOURCES.includes(o.resource))
    return 'Ressource inconnue.';
  if (def.target === 'branch' && o.branch && !RESEARCH_BRANCHES.includes(o.branch))
    return 'Domaine inconnu.';
  if (def.target === 'category' && o.category && !CATEGORIES.includes(o.category))
    return 'Catégorie inconnue.';
  if (def.target === 'nation') {
    if (!o.nationId || !state.nations[o.nationId]?.alive || o.nationId === n)
      return 'Nation visée invalide.';
  } else if (o.nationId) {
    if (!def.zone) return 'Zone non prévue pour cette mission.';
    if (!state.nations[o.nationId] || o.nationId === n) return 'Frontière invalide.';
  }
  if (o.provinceId) {
    if (!def.zone) return 'Zone non prévue pour cette mission.';
    if (!w.provById.get(o.provinceId)) return 'Province inconnue.';
  }
  return null;
}

export function orderMission(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govMission' }>,
): OrderResult {
  const B = govBal(state);
  if (!B.enabled) return fail('not_allowed', 'Gouvernement désactivé.');
  if (!state.nations[n]?.alive) return fail('not_allowed', 'Nation vaincue.');
  const inp = o.mission;
  const def = missionDef(state, inp.type);
  if (!def || !officeDef(state, def.office)) return fail('invalid_target', 'Mission inconnue.');
  const bad = checkTarget(state, n, def, inp);
  if (bad) return fail('invalid_target', bad);
  const gn = govNation(state, n);
  const count = Object.keys(gn.missions).filter(
    (id) => gn.missions[id]!.office === def.office,
  ).length;
  if (count >= B.maxMissions) return fail('capacity', 'Trop de missions pour ce poste.');
  const goal = Math.min(def.goalMax, inp.goal ?? def.goal);
  const m: MissionSt = {
    id: nextGovId(state, 'm'),
    office: def.office,
    type: inp.type,
    priority: inp.priority ?? 2,
    budget: inp.budget as GovBudget,
    spent: 0,
    credit: 0,
    goal,
    done: 0,
    pending: [],
    status: 'active',
    suspended: false,
    since: state.time,
  };
  if (def.target === 'resource') m.resource = inp.resource ?? def.defaultTarget ?? 'oil';
  if (def.target === 'branch') m.branch = inp.branch ?? def.defaultTarget ?? 'aero';
  if (def.target === 'category') m.category = inp.category ?? def.defaultTarget ?? 'air_defense';
  if (inp.nationId) m.nationId = inp.nationId;
  if (inp.provinceId) {
    m.provinceId = inp.provinceId;
    m.radiusKm = inp.radiusKm ?? 400;
  }
  // Part des revenus : le premier jour est crédité tout de suite.
  if (m.budget.mode === 'share') m.credit = (m.budget.pct / 100) * revenueDay(state, n);
  gn.missions[m.id] = m;
  journal(
    state,
    n,
    m.office,
    'missionNew',
    { mission: { key: `engine.gov.m.${m.type}` } },
    'info',
    m.id,
  );
  scheduleNation(state, n);
  return { ok: true };
}

function ownMission(state: EngineState, n: NationId, id: string): MissionSt | null {
  return govOpt(state)?.nations[n]?.missions[id] ?? null;
}

export function orderMissionEdit(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govMissionEdit' }>,
): OrderResult {
  const m = ownMission(state, n, o.missionId);
  if (!m) return fail('invalid_target', 'Mission introuvable.');
  const def = missionDef(state, m.type);
  delete m.retryAt;
  if (o.priority !== undefined) m.priority = o.priority;
  if (o.goal !== undefined) m.goal = Math.min(def?.goalMax ?? 1000, o.goal);
  if (o.budget) {
    const was = m.budget;
    m.budget = o.budget as GovBudget;
    if (m.budget.mode === 'share' && was.mode !== 'share')
      m.credit = m.spent + (m.budget.pct / 100) * revenueDay(state, n);
  }
  journal(
    state,
    n,
    m.office,
    'missionEdit',
    { mission: { key: `engine.gov.m.${m.type}` } },
    'info',
    m.id,
  );
  scheduleNation(state, n);
  return { ok: true };
}

export function orderMissionSuspend(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govMissionSuspend' }>,
): OrderResult {
  const m = ownMission(state, n, o.missionId);
  if (!m) return fail('invalid_target', 'Mission introuvable.');
  if (m.suspended === o.on) return fail('not_allowed', o.on ? 'Déjà suspendue.' : 'Déjà en cours.');
  m.suspended = o.on;
  m.status = o.on ? 'suspended' : 'active';
  delete m.retryAt;
  delete m.why;
  journal(
    state,
    n,
    m.office,
    o.on ? 'missionSuspended' : 'missionResumed',
    { mission: { key: `engine.gov.m.${m.type}` } },
    o.on ? 'warn' : 'info',
    m.id,
  );
  if (!o.on) scheduleNation(state, n);
  return { ok: true };
}

export function orderMissionCancel(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govMissionCancel' }>,
): OrderResult {
  const gn = govOpt(state)?.nations[n];
  const m = gn?.missions[o.missionId];
  if (!gn || !m) return fail('invalid_target', 'Mission introuvable.');
  m.cancelled = true;
  m.ended = state.time;
  m.status = 'done';
  delete m.why;
  journal(
    state,
    n,
    m.office,
    'missionCancelled',
    { mission: { key: `engine.gov.m.${m.type}` } },
    'warn',
    m.id,
  );
  archive(state, gn, m);
  return { ok: true };
}
