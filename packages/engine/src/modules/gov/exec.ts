import {
  distanceKm,
  type BuildingType,
  type GovMissionDef,
  type GovOffice,
  type IntelOpKind,
  type IntelOpTarget,
  type LedgerKey,
  type LocParam,
  type NationId,
  type Order,
  type Resource,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { aiOrder } from '../../ai/trace.js';
import { provincesOf, sortedSet, warsOf } from '../../state/access.js';
import { partsOf } from '../../state/stack.js';
import type { EngineState } from '../../state/types.js';
import { isUnlimited } from '../../state/unlimited.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier } from '../registry.js';
import {
  investCandidates,
  productionOptions,
  repairCandidates,
  researchPick,
  type ProductionOption,
} from '../eco/ai.js';
import { budgetDay, ecoIncome, provinceIncome } from '../eco/budget.js';
import { accelerateJob, depositYield, depositsOf, levelOf } from '../eco/buildings.js';
import { shiftProduction } from '../eco/production.js';
import { cfg, effect } from '../eco/config.js';
import { accelerateResearch, hasGate, nodeOf } from '../eco/research.js';
import { eco, ecoNation } from '../eco/state.js';
import { book, eraOk } from '../eco/util.js';
import { turnable } from '../intel/agents.js';
import { focusOf, maxProtected } from '../intel/interior.js';
import { opCost } from '../intel/recon.js';
import { nat } from '../intel/state.js';
import type { HeadEffects } from './heads.js';
import { journal } from './journal.js';
import { govRoll, type MissionSt, type PendingSt } from './state.js';

/**
 * Exécutants des missions du gouvernement. Chacun réutilise la logique de l'IA économique des nations
 * (eco/ai.ts : chantiers possibles, options de production, choix de recherche, réparations) ou du
 * renseignement, paramétrée par la mission (bâtiments, zone, ressource, catégorie, nation visée), et
 * n'agit que par les ordres de jeu existants (`aiOrder`, mêmes validations que le joueur), dans la
 * limite de l'enveloppe et au-dessus du plancher de trésorerie.
 */

export interface Ctx {
  state: EngineState;
  n: NationId;
  m: MissionSt;
  def: GovMissionDef;
  office: GovOffice;
  fx: HeadEffects;
  /** Plancher de trésorerie (prudence du titulaire, mission Réserves). */
  floor: number;
  /** Disponible dans l'enveloppe. */
  available: number;
  /** Mission prioritaire de son poste (choix exclusifs : priorité du renseignement intérieur). */
  lead: boolean;
}

/** Bilan d'une réflexion : actions lancées, ou raison de l'inaction (`soft` : simple attente). */
export interface Outcome {
  acted: number;
  why?: string;
  params?: Record<string, LocParam>;
  soft?: boolean;
}

const nothing = (why: string, params?: Record<string, LocParam>, soft = false): Outcome => ({
  acted: 0,
  why,
  ...(params ? { params } : {}),
  ...(soft ? { soft } : {}),
});

/** Somme que la mission peut engager maintenant (enveloppe, plancher de trésorerie). */
export function limit(ctx: Ctx): number {
  const money = ctx.state.nations[ctx.n]!.money;
  return Math.max(0, Math.min(ctx.available, money - ctx.floor));
}

/** Raison d'un refus faute d'argent : enveloppe, réserve ou trésorerie. */
function moneyWhy(ctx: Ctx, cost: number): Outcome {
  const money = ctx.state.nations[ctx.n]!.money;
  if (cost > ctx.available)
    return nothing('envelope', { cost: Math.round(cost), left: Math.round(ctx.available) });
  if (money < cost) return nothing('funds', { cost: Math.round(cost) });
  return nothing('reserve', { cost: Math.round(cost), floor: Math.round(ctx.floor) });
}

const WHY_OF: Record<string, string> = {
  insufficient_funds: 'funds',
  insufficient_resources: 'resources',
  resource_required: 'noSite',
  research_required: 'research',
  capacity: 'capacity',
  locked: 'locked',
  not_owner: 'noTarget',
  invalid_target: 'noTarget',
  cooldown: 'capacity',
};

function refused(r: OrderResult): Outcome {
  return nothing(WHY_OF[r.error ?? ''] ?? 'refused');
}

/**
 * Ordre émis pour la mission : dépense mesurée sur la trésorerie (estimation pour une nation
 * illimitée), rabais négocié par le titulaire rendu à la trésorerie et inscrit au grand livre.
 */
function act(ctx: Ctx, order: Order, estimate: number, key: LedgerKey | null): OrderResult {
  const { state, n, m } = ctx;
  const ns = state.nations[n]!;
  const before = ns.money;
  const r = aiOrder(state, n, order);
  if (!r.ok) return r;
  const unl = isUnlimited(state, n);
  const spent = unl ? estimate : Math.max(0, before - ns.money);
  const refund = key ? spent * ctx.fx.discount : 0;
  if (refund > 0) {
    if (!unl) ns.money += refund;
    book(state, n, key!, refund);
    ecoNation(state, n).spent -= refund;
  }
  m.spent += spent - refund;
  ctx.available = Math.max(0, ctx.available - (spent - refund));
  return r;
}

/** Choix parmi les k meilleurs (titulaire peu expert : choix moins sûrs), tirage du module. */
function pick<T>(ctx: Ctx, list: T[]): T {
  const k = Math.min(list.length, ctx.fx.choice);
  return list[k <= 1 ? 0 : Math.floor(govRoll(ctx.state) * k)]!;
}

const money = (v: number) => Math.round(v);
const bkey = (b: string): LocParam => ({ key: `buildings.${b}` });

// ——— Zone ———

/** Provinces de la nation dans la zone de la mission (autour d'une province, frontière avec un pays). */
export function scopeProvinces(state: EngineState, n: NationId, m: MissionSt): string[] {
  const w = wi(state.world);
  let list = provincesOf(state, n);
  if (m.provinceId) {
    const c = w.provById.get(m.provinceId)?.cityPoint;
    const r = m.radiusKm ?? 400;
    if (c) list = list.filter((p) => distanceKm(w.provById.get(p)!.cityPoint, c) <= r);
  }
  if (m.nationId && !isNationTarget(m)) {
    const x = m.nationId;
    list = list.filter((p) =>
      w.provById.get(p)!.neighbors.some((q) => state.provinces[q]?.owner === x),
    );
  }
  return list;
}

/** La nation de la mission est une cible (renseignement) et non une frontière. */
function isNationTarget(m: MissionSt): boolean {
  return m.office === 'intel_exterior';
}

/** Menace d'une province : voisins étrangers, triplés s'ils sont en guerre avec nous. */
function threat(state: EngineState, n: NationId, pid: string, wars: Set<string>): number {
  let t = 0;
  for (const q of wi(state.world).provById.get(pid)!.neighbors) {
    const o = state.provinces[q]?.owner;
    if (!o || o === n) continue;
    t += wars.has(o) ? 3 : 1;
  }
  return t;
}

// ——— Chantiers (extraction, investissement, bases, défenses, améliorations) ———

function jobBusy(state: EngineState, pid: string, kind: string): boolean {
  const jobs = eco(state).jobs;
  for (const id of Object.keys(jobs)) {
    const j = jobs[id]!;
    if (j.pid === pid && j.kind === kind) return true;
  }
  return false;
}

function fortLevel(state: EngineState, pid: string): number {
  return eco(state).forts[pid] ?? 0;
}

/** Coût d'un chantier au niveau visé (même calcul que l'ordre `build`). */
export function buildCost(state: EngineState, kind: string, lvl: number): number {
  const c = cfg(state.world).buildings;
  return (c.buildCostUsd[kind] ?? 0) * Math.pow(c.levelCostGrowth, lvl - 1);
}

interface BuildCand {
  pid: string;
  b: string;
  /** Niveau actuel. */
  lvl: number;
  cost: number;
  score: number;
}

const RES_BUILDING: Record<string, BuildingType> = {
  oil: 'oil_field',
  metals: 'mine',
  food: 'farm',
  electronics: 'electronics_plant',
};

function buildingsFor(ctx: Ctx): string[] {
  if (ctx.def.exec === 'extract') {
    const b = RES_BUILDING[ctx.m.resource ?? ctx.def.defaultTarget ?? 'oil'];
    return b ? [b] : [];
  }
  return ctx.def.buildings;
}

function buildCandidates(ctx: Ctx): BuildCand[] {
  const { state, n, def } = ctx;
  const provs = scopeProvinces(state, n, ctx.m);
  const w = wi(state.world);
  const wars = new Set(warsOf(state, n));
  const upgradeOnly = def.exec === 'upgrade';
  const raw: { pid: string; b: string; lvl: number }[] = [];
  for (const b of buildingsFor(ctx)) {
    if (b === 'fortification') {
      const max = effect(state.world, 'fortification', 'maxLevel', 3);
      for (const pid of provs) {
        const lvl = fortLevel(state, pid);
        if (lvl < max && !(upgradeOnly && lvl === 0)) raw.push({ pid, b, lvl });
      }
      continue;
    }
    for (const x of investCandidates(state, n, [b as BuildingType], {
      provinces: provs,
      fresh: upgradeOnly ? 'none' : 'allowed',
    }))
      raw.push({ pid: x.pid, b: x.b, lvl: x.lvl });
  }
  let vmax = 1;
  const value = new Map<string, number>();
  for (const pid of provs) {
    const v = provinceIncome(state, pid);
    value.set(pid, v);
    if (v > vmax) vmax = v;
  }
  const r = def.exec === 'extract' ? (ctx.m.resource ?? def.defaultTarget ?? 'oil') : null;
  const out: BuildCand[] = [];
  for (const x of raw) {
    if (jobBusy(state, x.pid, x.b)) continue;
    const def0 = w.provById.get(x.pid)!;
    const cost = buildCost(state, x.b, x.lvl + 1);
    let weight: number;
    if (r) {
      // Extraction : gain de production du niveau suivant (rendement de la province × richesse).
      if (!depositsOf(state.world, x.pid) && !((def0.income[r as Resource] ?? 0) > 0)) continue;
      weight =
        (def0.income[r as Resource] ?? 0) *
          effect(state.world, x.b, 'yieldPerLevel', 0) *
          depositYield(state.world, x.pid, r as Resource) +
        effect(state.world, x.b, 'flatPerLevel', 0);
      if (!(weight > 0)) continue;
    } else if (upgradeOnly) {
      weight = 1 / Math.max(1, x.lvl);
    } else {
      const v = 1 + (3 * (value.get(x.pid) ?? 0)) / vmax + (def0.isCapital ? 1 : 0);
      const t = threat(state, n, x.pid, wars);
      switch (def.placement) {
        case 'border':
          if (t <= 0) continue;
          weight = t * (1 + (value.get(x.pid) ?? 0) / vmax);
          break;
        case 'spread':
          weight = (x.lvl === 0 ? 3 : 1) * v * (t > 0 ? 1.5 : 1);
          break;
        case 'any':
          weight = 1;
          break;
        default:
          weight = v;
      }
    }
    out.push({ pid: x.pid, b: x.b, lvl: x.lvl, cost, score: weight / Math.max(1, cost) });
  }
  out.sort(
    (a, b) =>
      b.score - a.score || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) || (a.b < b.b ? -1 : 1),
  );
  return out;
}

function execBuild(ctx: Ctx, slots: number): Outcome {
  const { state, n, m } = ctx;
  const left = m.goal - m.done - m.pending.length;
  if (left <= 0) return nothing('inProgress', undefined, true);
  const cands = buildCandidates(ctx);
  if (!cands.length) {
    if (ctx.def.exec === 'extract')
      return nothing('noDeposit', {
        resource: { key: `game.resources.${m.resource ?? ctx.def.defaultTarget ?? 'oil'}` },
      });
    return nothing('noSite');
  }
  let acted = 0;
  let last: Outcome | null = null;
  let tries = 0;
  while (acted < Math.min(slots, left) && tries < 4) {
    tries++;
    const lim = limit(ctx);
    const affordable = cands.filter((c) => c.cost <= lim);
    if (!affordable.length) {
      last = moneyWhy(ctx, Math.min(...cands.map((c) => c.cost)));
      break;
    }
    const c = pick(ctx, affordable);
    cands.splice(cands.indexOf(c), 1);
    const r = act(
      ctx,
      { kind: 'build', provinceId: c.pid, building: c.b as BuildingType },
      c.cost,
      'buildings',
    );
    if (!r.ok) {
      last = refused(r);
      continue;
    }
    const jobs = eco(state).jobs;
    const jid = Object.keys(jobs).find(
      (k) => jobs[k]!.n === n && jobs[k]!.pid === c.pid && jobs[k]!.kind === c.b,
    );
    if (jid) {
      speedUp(ctx, 'job', jid);
      m.pending.push({ k: 'job', id: jid, pid: c.pid, b: c.b, lvl: c.lvl + 1 });
    }
    m.last = journal(
      state,
      n,
      ctx.office,
      'built',
      { building: bkey(c.b), level: c.lvl + 1, place: { province: c.pid }, cost: money(c.cost) },
      'info',
      m.id,
    );
    acted++;
  }
  return acted ? { acted } : (last ?? nothing('noSite'));
}

// ——— Vitesse (gestion du titulaire) ———

function speedUp(ctx: Ctx, kind: 'job' | 'prod' | 'res', id: string): void {
  const f = ctx.fx.speed;
  if (!f) return;
  const { state, n } = ctx;
  if (kind === 'job') {
    const j = eco(state).jobs[id];
    if (j) accelerateJob(state, id, (j.completesAt - state.time) * f);
  } else if (kind === 'prod') {
    const it = state.nations[n]!.production.find((x) => x.id === id);
    if (it) shiftProduction(state, n, id, (it.completesAt - state.time) * f);
  } else {
    const cur = ecoNation(state, n).cur;
    if (cur && cur.id === id) accelerateResearch(state, n, id, (cur.completesAt - state.time) * f);
  }
}

// ——— Réparations ———

function execRepair(ctx: Ctx, slots: number): Outcome {
  const { state, n, m } = ctx;
  const left = m.goal - m.done - m.pending.length;
  if (left <= 0) return nothing('inProgress', undefined, true);
  const scope = new Set(scopeProvinces(state, n, m));
  const cands = repairCandidates(state, n)
    .filter((c) => scope.has(c.pid))
    .sort((a, b) => b.cost - a.cost || (a.pid < b.pid ? -1 : 1));
  if (!cands.length) return nothing('nothingDamaged', undefined, true);
  let acted = 0;
  let last: Outcome | null = null;
  for (const c of cands) {
    if (acted >= Math.min(slots, left)) break;
    if (c.cost > limit(ctx)) {
      last = moneyWhy(ctx, c.cost);
      continue;
    }
    const r = act(ctx, { kind: 'repair', provinceId: c.pid, building: c.b }, c.cost, 'buildings');
    if (!r.ok) {
      last = refused(r);
      continue;
    }
    m.pending.push({ k: 'rep', id: `${c.pid}:${c.b}`, pid: c.pid, b: c.b });
    m.last = journal(
      state,
      n,
      ctx.office,
      'repaired',
      { building: bkey(c.b), place: { province: c.pid }, cost: money(c.cost) },
      'info',
      m.id,
    );
    acted++;
  }
  return acted ? { acted } : (last ?? nothing('nothingDamaged', undefined, true));
}

// ——— Recherche ———

function inProgress(state: EngineState, n: NationId, id: string): boolean {
  const en = ecoNation(state, n);
  return en.cur?.id === id || en.queue.some((q) => q.id === id);
}

/**
 * Prochaine génération d'une catégorie : portes de recherche manquantes des matériels de la plus
 * petite génération au-dessus de la meilleure génération déjà productible (licence ou recherche).
 */
export function nextGeneration(
  state: EngineState,
  n: NationId,
  cat: string,
): { gen: number; gates: string[]; systems: string[] } | null {
  const w = wi(state.world);
  const year = eco(state).year;
  const en = ecoNation(state, n);
  let best = 0;
  const locked: WeaponSystem[] = [];
  for (const id of w.systemIds) {
    const sys = state.world.catalog.get(id)!;
    if (sys.category !== cat || !sys.enabled || !eraOk(sys, year)) continue;
    const ok = en.licences[id] !== undefined || sys.requires.every((r) => hasGate(state, n, r));
    if (ok) best = Math.max(best, sys.generation);
    else locked.push(sys);
  }
  const higher = locked.filter((s) => s.generation > best);
  if (!higher.length) return null;
  const gen = Math.min(...higher.map((s) => s.generation));
  const gates = new Set<string>();
  const systems: string[] = [];
  for (const s of higher) {
    if (s.generation !== gen) continue;
    systems.push(s.id);
    for (const r of s.requires) if (!hasGate(state, n, r)) gates.add(r);
  }
  return { gen, gates: [...gates].sort(), systems: systems.sort() };
}

/** Nœuds encore à rechercher pour ouvrir des portes (prérequis compris). */
export function researchClosure(state: EngineState, n: NationId, gates: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...gates];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || hasGate(state, n, id)) continue;
    const node = nodeOf(state, id);
    if (!node) continue;
    out.add(id);
    for (const r of node.requires) stack.push(r);
  }
  return out;
}

/** Coût du nœud ouvert (prérequis acquis) le moins cher parmi ceux voulus, sans regarder la caisse. */
function cheapestOpen(
  state: EngineState,
  n: NationId,
  want: (id: string, branch: string) => boolean,
): { money: number } | null {
  const tree = state.world.research!;
  const done = new Set(ecoNation(state, n).done);
  let best: { money: number } | null = null;
  for (const id of [...tree.keys()].sort()) {
    const raw = tree.get(id)!;
    if (done.has(id) || !want(id, raw.branch) || inProgress(state, n, id)) continue;
    const node = nodeOf(state, id);
    if (!node || !node.requires.every((r) => hasGate(state, n, r))) continue;
    if (!best || node.cost.money < best.money) best = { money: node.cost.money };
  }
  return best;
}

function execResearch(ctx: Ctx, slots: number): Outcome {
  const { state, n, m, def } = ctx;
  if (!state.world.research) return nothing('noResearch');
  let want: (id: string, branch: string) => boolean;
  if (def.target === 'category') {
    const cat = m.category ?? def.defaultTarget ?? 'fighter';
    const next = nextGeneration(state, n, cat);
    const closure = next ? researchClosure(state, n, next.gates) : new Set<string>();
    if (!closure.size) return { acted: 0, why: 'unlocked' };
    // Objectif fixé au premier examen : nœuds à acquérir pour la génération suivante.
    if (m.goal <= 0) m.goal = closure.size + m.done;
    want = (id) => closure.has(id);
  } else {
    const br = m.branch ?? def.defaultTarget ?? 'aero';
    if (m.done + m.pending.length >= m.goal) return nothing('inProgress', undefined, true);
    want = (_id, branch) => branch === br;
  }
  let acted = 0;
  let last: Outcome | null = null;
  for (let i = 0; i < slots; i++) {
    if (def.target !== 'category' && m.done + m.pending.length >= m.goal) break;
    const lim = limit(ctx);
    const node = researchPick(state, n, lim, (raw) =>
      want(raw.id, raw.branch) && !inProgress(state, n, raw.id) ? raw.tier : null,
    );
    if (!node) {
      // Sans rien d'abordable : est-ce l'argent (ou les ressources) ou l'absence de recherche ?
      const cost = cheapestOpen(state, n, want);
      if (cost === null) last = nothing('noResearch');
      else if (cost.money > lim) last = moneyWhy(ctx, cost.money);
      else last = nothing('resources');
      break;
    }
    const r = act(ctx, { kind: 'research', nodeId: node.id }, node.cost.money, 'research');
    if (!r.ok) {
      last = refused(r);
      break;
    }
    speedUp(ctx, 'res', node.id);
    m.pending.push({ k: 'res', id: node.id });
    m.last = journal(
      state,
      n,
      ctx.office,
      'research',
      { node: node.id, cost: money(node.cost.money) },
      'info',
      m.id,
    );
    acted++;
  }
  return acted ? { acted } : (last ?? nothing('noResearch'));
}

// ——— Production ———

/** Lots d'une catégorie en service (piles mixtes comprises) et en commande pour la nation. */
export function inventoryLots(state: EngineState, n: NationId, cat: string): number {
  let lots = 0;
  for (const uid of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[uid];
    if (!u) continue;
    for (const p of partsOf(state, u))
      if (p.sys.category === cat) lots += p.c / Math.max(1, p.sys.unitSize);
  }
  return Math.floor(lots + 1e-9);
}

/** Matériels en service dans les forces de la nation (piles mixtes comprises). */
function fieldedSystems(state: EngineState, n: NationId): Set<string> {
  const out = new Set<string>();
  for (const uid of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[uid];
    if (u) for (const p of partsOf(state, u)) out.add(p.sys.id);
  }
  return out;
}

function lotPrice(state: EngineState, n: NationId, o: ProductionOption): number {
  if (!o.local) return o.sys.cost.money * cfg(state.world).industry.importPriceFactor;
  const licensed = ecoNation(state, n).licences[o.sys.id] !== undefined;
  const discount = licensed ? 1 - cfg(state.world).licences.productionDiscount : 1;
  return o.sys.cost.money * modifier(state, n, 'production.cost') * discount;
}

function pendingLots(m: MissionSt): number {
  let s = 0;
  for (const p of m.pending) if (p.k === 'prod') s += p.n ?? 0;
  return s;
}

function execProduce(ctx: Ctx, slots: number, batch: number): Outcome {
  const { state, n, m, def } = ctx;
  const cat = m.category ?? def.defaultTarget ?? 'air_defense';
  const have = def.exec === 'stock' ? inventoryLots(state, n, cat) : m.done;
  let left = m.goal - have - pendingLots(m);
  if (left <= 0) return nothing(def.exec === 'stock' ? 'stocked' : 'inProgress', undefined, true);
  // Options de l'IA économique (local d'abord, génération, coût), puis le matériel déjà en service
  // dans les forces de la nation en tête à égalité de source : on commande ce qu'on sait employer.
  const fielded = fieldedSystems(state, n);
  const opts = productionOptions(state, n, cat, { sea: true })
    .map((o, i) => ({ o, i }))
    .sort(
      (a, b) =>
        Number(b.o.local) - Number(a.o.local) ||
        Number(fielded.has(b.o.sys.id)) - Number(fielded.has(a.o.sys.id)) ||
        a.i - b.i,
    )
    .map((x) => x.o);
  if (!opts.length) return nothing('noSystem', { category: { key: `categories.${cat}` } });
  let acted = 0;
  let last: Outcome | null = null;
  const tried = new Set<string>();
  for (let i = 0; i < slots + 2 && acted < slots && left > 0; i++) {
    const pool = opts.filter((o) => !tried.has(o.sys.id));
    if (!pool.length) break;
    // Fabrication locale de préférence : le choix se fait parmi les meilleures options locales.
    const local = pool.filter((o) => o.local);
    const o = pick(ctx, local.length ? local : pool);
    tried.add(o.sys.id);
    const unit = lotPrice(state, n, o);
    const count = Math.min(batch, left, Math.floor(limit(ctx) / Math.max(1, unit)));
    if (count < 1) {
      last = moneyWhy(ctx, unit);
      continue;
    }
    const ns = state.nations[n]!;
    const before = new Set(ns.production.map((x) => x.id));
    const r = act(
      ctx,
      { kind: 'produce', provinceId: o.pid, systemId: o.sys.id, count },
      unit * count,
      o.local ? 'production' : 'imports',
    );
    if (!r.ok) {
      last = refused(r);
      continue;
    }
    const item = ns.production.find((x) => !before.has(x.id));
    if (item) {
      speedUp(ctx, 'prod', item.id);
      m.pending.push({ k: 'prod', id: item.id, pid: o.pid, n: count });
    }
    m.last = journal(
      state,
      n,
      ctx.office,
      o.local ? 'produced' : 'imported',
      {
        count,
        system: { system: o.sys.id },
        place: { province: o.pid },
        cost: money(unit * count),
      },
      'info',
      m.id,
    );
    left -= count;
    acted++;
  }
  return acted
    ? { acted }
    : (last ?? nothing('noSystem', { category: { key: `categories.${cat}` } }));
}

// ——— Renseignement ———

function launchOp(ctx: Ctx, kind: IntelOpKind, target: IntelOpTarget): Outcome | null {
  const { state, n, m } = ctx;
  const c = opCost(state, kind, target) as { money: number } | undefined;
  if (!c) return nothing('refused');
  const cost = c.money;
  if (cost > limit(ctx)) return moneyWhy(ctx, cost);
  const r = act(ctx, { kind: 'intelOp', op: kind, target }, cost, null);
  if (!r.ok) return refused(r);
  const ops = nat(state, n).ops;
  const op = ops[ops.length - 1];
  if (op) m.pending.push({ k: 'op', id: op.id });
  m.last = journal(
    state,
    n,
    ctx.office,
    target.nationId ? 'intelOpAt' : 'intelOp',
    {
      op: { key: `engine.intelOp.${kind}` },
      ...(target.nationId ? { nation: { nation: target.nationId } } : {}),
      cost: money(cost),
    },
    'info',
    m.id,
  );
  return null;
}

function execIntel(ctx: Ctx, slots: number): Outcome {
  const { state, m, def } = ctx;
  const x = m.nationId;
  if (!x || !state.nations[x]?.alive || x === ctx.n) return nothing('noTarget');
  const ops = def.ops as IntelOpKind[];
  if (!ops.length) return nothing('refused');
  let acted = 0;
  let last: Outcome | null = null;
  for (let i = 0; i < ops.length && acted < slots; i++) {
    if (m.done + m.pending.length >= m.goal) break;
    const kind = ops[(m.k ?? 0) % ops.length]!;
    const bad = launchOp(ctx, kind, { nationId: x });
    m.k = (m.k ?? 0) + 1;
    if (bad) {
      last = bad;
      if (bad.why === 'envelope' || bad.why === 'funds' || bad.why === 'reserve') break;
      continue;
    }
    acted++;
  }
  if (!acted && m.done + m.pending.length >= m.goal) return nothing('inProgress', undefined, true);
  return acted ? { acted } : (last ?? nothing('refused'));
}

/** Priorité du renseignement intérieur fixée par la mission prioritaire du poste. */
function ensureFocus(ctx: Ctx, focus: 'counterintel' | 'protection'): void {
  const { state, n, m } = ctx;
  if (!ctx.lead || focusOf(state, n) === focus) return;
  if (aiOrder(state, n, { kind: 'interiorFocus', focus }).ok)
    m.last = journal(
      state,
      n,
      ctx.office,
      'focus',
      { focus: { key: `engine.gov.focus.${focus}` } },
      'info',
      m.id,
    );
}

function execCounterintel(ctx: Ctx, slots: number): Outcome {
  const { state, n, m } = ctx;
  ensureFocus(ctx, 'counterintel');
  if (m.done + m.pending.length >= m.goal) return nothing('inProgress', undefined, true);
  let acted = 0;
  let last: Outcome | null = null;
  for (let i = 0; i < slots; i++) {
    if (m.done + m.pending.length >= m.goal) break;
    // Réseau adverse démasqué : démantèlement ; sinon balayage de contre-espionnage.
    const caught = turnable(state, n);
    const bad =
      caught.length >= 2
        ? launchOp(ctx, 'dismantle_network', { nationId: caught[0]!.owner })
        : launchOp(ctx, 'counterintel_sweep', {});
    if (bad) {
      last = bad;
      break;
    }
    acted++;
  }
  return acted ? { acted } : (last ?? nothing('refused'));
}

/** Valeur des installations d'une province (bâtiments sensibles × niveau × coût). */
function siteValue(state: EngineState, pid: string): number {
  const c = cfg(state.world).buildings;
  let v = 0;
  for (const b of [
    'arms_factory',
    'electronics_plant',
    'refinery',
    'power_plant',
    'research_center',
    'secret_lab',
    'oil_field',
    'missile_silo',
  ])
    v += levelOf(state, pid, b) * (c.buildCostUsd[b] ?? 0);
  return v;
}

/** Sites protégés par la nation (renseignement intérieur). */
export function protectedCount(state: EngineState, n: NationId): number {
  const ps = board(state).protectedSites ?? {};
  let k = 0;
  for (const pid of Object.keys(ps)) if (ps[pid] === n) k++;
  return k;
}

function execProtect(ctx: Ctx, slots: number): Outcome {
  const { state, n, m } = ctx;
  ensureFocus(ctx, 'protection');
  const ps = board(state).protectedSites ?? {};
  const max = maxProtected(state, n);
  let acted = 0;
  const cands = scopeProvinces(state, n, m)
    .filter((p) => ps[p] !== n)
    .map((p) => ({ p, v: siteValue(state, p) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v || (a.p < b.p ? -1 : 1));
  for (const c of cands) {
    if (protectedCount(state, n) >= max || acted >= slots) break;
    if (!aiOrder(state, n, { kind: 'protectSite', provinceId: c.p, on: true }).ok) continue;
    m.last = journal(state, n, ctx.office, 'protected', { place: { province: c.p } }, 'info', m.id);
    acted++;
  }
  if (acted) return { acted };
  // Sites au maximum : durcissement des installations, une opération à la fois.
  if (m.pending.length) return nothing('inProgress', undefined, true);
  const bad = launchOp(ctx, 'harden_sites', {});
  if (!bad) return { acted: 1 };
  return bad.why === 'capacity' ? nothing('allProtected', undefined, true) : bad;
}

// ——— Réserve ———

function execReserve(ctx: Ctx): Outcome {
  const { state, n, m } = ctx;
  const target = m.goal * dayUnit(state, n);
  const money0 = state.nations[n]!.money;
  if (money0 >= target) return nothing('reserveHeld', undefined, true);
  return nothing('saving', { pct: Math.floor((100 * money0) / Math.max(1, target)) }, true);
}

/** Unité de « jour de budget » : budget de défense par jour (ORBAT), sinon revenus par jour. */
export function dayUnit(state: EngineState, n: NationId): number {
  const bd = budgetDay(state, n);
  if (bd > 0) return bd;
  return Math.max(0, ecoIncome(state, n)?.money ?? 0);
}

// ——— Aiguillage ———

export function execute(ctx: Ctx, slots: number, batch: number): Outcome {
  switch (ctx.def.exec) {
    case 'extract':
    case 'invest':
    case 'build':
    case 'upgrade':
      return execBuild(ctx, slots);
    case 'repair':
      return execRepair(ctx, slots);
    case 'research':
      return execResearch(ctx, slots);
    case 'produce':
    case 'stock':
      return execProduce(ctx, slots, batch);
    case 'intel':
      return execIntel(ctx, slots);
    case 'counterintel':
      return execCounterintel(ctx, slots);
    case 'protect':
      return execProtect(ctx, slots);
    case 'reserve':
      return execReserve(ctx);
  }
}

// ——— Suivi des actions en cours ———

/**
 * Aboutissement des actions lancées : chantier terminé (niveau atteint), commande livrée, recherche
 * acquise, opération achevée, réparation finie. Une action perdue (province prise, annulation par le
 * joueur) est retirée sans compter.
 */
export function resolvePending(
  state: EngineState,
  n: NationId,
  m: MissionSt,
  def: GovMissionDef,
): void {
  if (!m.pending.length) return;
  const keep: PendingSt[] = [];
  const es = eco(state);
  const ns = state.nations[n]!;
  for (const p of m.pending) {
    switch (p.k) {
      case 'job': {
        if (es.jobs[p.id]) {
          keep.push(p);
          break;
        }
        const lvl =
          p.b === 'fortification' ? fortLevel(state, p.pid!) : levelOf(state, p.pid!, p.b!);
        if (state.provinces[p.pid!]?.owner === n && lvl >= (p.lvl ?? 1)) {
          m.done++;
          journal(
            state,
            n,
            m.office,
            'jobDone',
            { building: bkey(p.b!), level: p.lvl ?? 1, place: { province: p.pid! } },
            'good',
            m.id,
          );
        }
        break;
      }
      case 'prod': {
        if (ns.production.some((x) => x.id === p.id)) keep.push(p);
        else if (def.exec === 'produce') m.done += p.n ?? 0;
        break;
      }
      case 'res': {
        const en = ecoNation(state, n);
        if (en.done.includes(p.id)) {
          m.done++;
          journal(state, n, m.office, 'researched', { node: p.id }, 'good', m.id);
        } else if (inProgress(state, n, p.id)) keep.push(p);
        break;
      }
      case 'op': {
        const op = nat(state, n).ops.find((o) => o.id === p.id);
        if (op && op.status === 'running') keep.push(p);
        else {
          m.done++;
          if (op)
            journal(
              state,
              n,
              m.office,
              op.status === 'success' ? 'opSuccess' : 'opFailed',
              { op: { key: `engine.intelOp.${op.kind}` } },
              op.status === 'success' ? 'good' : 'warn',
              m.id,
            );
        }
        break;
      }
      case 'rep': {
        if (es.bld[p.pid!]?.[p.b!]?.rep != null) keep.push(p);
        else if (state.provinces[p.pid!]?.owner === n) m.done++;
        break;
      }
    }
  }
  m.pending = keep;
}
