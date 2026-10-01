import type {
  BuildingType,
  NationId,
  ResearchBranch,
  ResearchNode,
  WeaponSystem,
} from '@redline/shared';
import { nationUnits, provincesOf, sysOf, warsOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { aiOrder } from '../../ai/trace.js';
import { canAfford } from '../../economy/economy.js';
import { budgetDay } from './budget.js';
import { buildingsOf, health, levelOf, provinceProductionSpeed } from './buildings.js';
import { cfg, requiredBuildings } from './config.js';
import { importCheck, localCheck } from './production.js';
import { hasGate, nodeOf } from './research.js';
import { eco, ecoNation, orbatOf, sortedIds } from './state.js';
import { canPay, scaledRes } from './util.js';
import { aiCfg } from '../../ai/config.js';
import { aiReserve } from '../../ai/money.js';

/** Réglages de l'IA économique : data/balance, section ai.economy. */
function AI(state: EngineState) {
  return aiCfg(state.world).economy;
}

function reserve(state: EngineState, n: NationId): number {
  const bd = budgetDay(state, n);
  return bd > 0
    ? Math.max(bd * AI(state).warReserveDays, aiReserve(state, n, true))
    : state.nations[n]!.money * AI(state).warReserveShare;
}

/** Branches de recherche connues. */
const BRANCHES: ResearchBranch[] = [
  'aero',
  'cyber',
  'industry',
  'intel',
  'land',
  'missiles',
  'naval',
  'sensors',
];

/** Préférences de doctrine (ORBAT) : branches favorisées. */
const DOCTRINE: Record<string, Partial<Record<ResearchBranch, number>>> = {
  us: { aero: 0.15, naval: 0.1, sensors: 0.05 },
  ru: { missiles: 0.15, land: 0.1, sensors: 0.05 },
  cn: { missiles: 0.1, naval: 0.1, aero: 0.05 },
  eu: { aero: 0.1, sensors: 0.05, land: 0.05 },
  other: { land: 0.1, industry: 0.05 },
};

/**
 * Rang de chaque branche pour une nation : poids de ses forces (valeur des unités par milieu), de sa
 * doctrine et de la conjoncture (industrie en paix, armement en guerre).
 */
function branchRanks(state: EngineState, n: NationId, atWar: boolean): Map<ResearchBranch, number> {
  const w: Record<string, number> = {
    industry: atWar ? 0.05 : 0.5,
    cyber: 0.03,
    intel: 0.03,
    missiles: 0.1,
    sensors: 0.1,
  };
  let total = 0;
  const add = (b: ResearchBranch, v: number) => (w[b] = (w[b] ?? 0) + v);
  const parts: [ResearchBranch, number][] = [];
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    const s = sysOf(state, u);
    const v = s.cost.money * (u.count / Math.max(1, s.unitSize));
    const b: ResearchBranch | null =
      s.movement === 'air'
        ? 'aero'
        : s.movement === 'sea'
          ? 'naval'
          : s.category === 'strike_missile'
            ? 'missiles'
            : s.category === 'air_defense' || s.category === 'radar'
              ? 'sensors'
              : s.movement === 'land'
                ? 'land'
                : null;
    if (!b) continue;
    parts.push([b, v]);
    total += v;
  }
  for (const [b, v] of parts) add(b, total > 0 ? v / total : 0);
  const doc = DOCTRINE[orbatOf(state, n)?.doctrine ?? 'other'] ?? {};
  for (const b of BRANCHES) add(b, doc[b] ?? 0);
  const order = [...BRANCHES].sort((a, b) => (w[b] ?? 0) - (w[a] ?? 0) || (a < b ? -1 : 1));
  return new Map(order.map((b, i) => [b, i]));
}

/**
 * Recherche cohérente avec sa doctrine et ses forces : score = rang technologique + rang de la branche ×
 * `researchFocus` (les branches prioritaires prennent de l'avance sans délaisser les autres). Jamais
 * au-delà de la part de trésorerie prévue, ni en entamant la réserve, ni sans les ressources.
 */
function thinkResearch(state: EngineState, n: NationId, atWar: boolean): void {
  const tree = state.world.research;
  if (!tree) return;
  const en = ecoNation(state, n);
  if (en.cur || en.queue.length > 0) return;
  const money = state.nations[n]!.money;
  const ec = aiCfg(state.world).economy;
  const budget = Math.min(money * ec.researchSpendShare, money - aiReserve(state, n, atWar));
  if (!(budget > 0)) return;
  const done = new Set(en.done);
  const ranks = branchRanks(state, n, atWar);
  let best: ResearchNode | null = null;
  let bestScore = Infinity;
  for (const id of researchIds(tree)) {
    const raw = tree.get(id)!;
    if (raw.cost.money > budget || done.has(id)) continue;
    const score = raw.tier + (ranks.get(raw.branch) ?? BRANCHES.length) * ec.researchFocus;
    if (score >= bestScore) continue;
    const node = nodeOf(state, id);
    if (!node || !node.requires.every((r) => hasGate(state, n, r))) continue;
    if (canPay(state, n, { money: node.cost.money, res: scaledRes(node.cost.resources, 1) }))
      continue;
    best = node;
    bestScore = score;
  }
  if (best) aiOrder(state, n, { kind: 'research', nodeId: best.id });
}

/** Identifiants de l'arbre triés (par arbre). */
const researchIdsCache = new WeakMap<object, string[]>();

function researchIds(tree: ReadonlyMap<string, ResearchNode>): string[] {
  let ids = researchIdsCache.get(tree);
  if (!ids) researchIdsCache.set(tree, (ids = [...tree.keys()].sort()));
  return ids;
}

/** Réparations des bâtiments endommagés, si la trésorerie le permet. */
function thinkRepairs(state: EngineState, n: NationId): void {
  const es = eco(state);
  const c = cfg(state.world);
  for (const pid of sortedIds(es.bld)) {
    if (state.provinces[pid]?.owner !== n) continue;
    for (const b of buildingsOf(state, pid)) {
      const h = health(state, pid, b);
      if (h >= 1 || es.bld[pid]?.[b]?.rep != null) continue;
      const cost =
        (c.buildings.buildCostUsd[b] ?? 0) *
        Math.pow(c.buildings.levelCostGrowth, levelOf(state, pid, b) - 1) *
        (1 - h) *
        c.industry.repairCostFactor;
      if (state.nations[n]!.money < cost * AI(state).repairFactor) continue;
      aiOrder(state, n, { kind: 'repair', provinceId: pid, building: b });
    }
  }
}

/** Investissement : améliore le bâtiment de ressources le moins avancé (un chantier à la fois). */
function thinkInvest(state: EngineState, n: NationId): void {
  const bd = budgetDay(state, n);
  if (bd <= 0 || state.nations[n]!.money < bd * AI(state).investDays) return;
  const es = eco(state);
  for (const id of sortedIds(es.jobs)) if (es.jobs[id]!.n === n) return;
  const max = cfg(state.world).buildings.maxLevel;
  let best: { pid: string; b: BuildingType; lvl: number } | null = null;
  for (const pid of provincesOf(state, n)) {
    for (const b of AI(state).investIn) {
      const lvl = levelOf(state, pid, b);
      if (lvl <= 0 || lvl >= max || health(state, pid, b) < 1) continue;
      if (!best || lvl < best.lvl) best = { pid, b, lvl };
    }
  }
  if (!best) return;
  const c = cfg(state.world).buildings;
  const cost = (c.buildCostUsd[best.b] ?? 0) * Math.pow(c.levelCostGrowth, best.lvl);
  if (state.nations[n]!.money - cost < aiReserve(state, n, false)) return;
  aiOrder(state, n, { kind: 'build', provinceId: best.pid, building: best.b });
}

/** En guerre : production locale ou importation de défenses selon le budget. */
function thinkWarProduction(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  if (ns.production.length >= AI(state).warMaxQueue) return;
  const spare = ns.money - reserve(state, n);
  if (spare <= 0) return;
  const w = wi(state.world);
  const provs = provincesOf(state, n);
  for (const cat of AI(state).warCategories) {
    const options: { sys: WeaponSystem; pid: string; local: boolean }[] = [];
    for (const id of w.systemIds) {
      const sys = state.world.catalog.get(id)!;
      if (sys.category !== cat || !sys.enabled || sys.movement === 'sea') continue;
      const need = requiredBuildings(sys);
      const pid = provs.find((p) => provinceProductionSpeed(state, p, need) > 0);
      if (pid && !localCheck(state, n, sys, pid)) options.push({ sys, pid, local: true });
      else if (provs[0] && !importCheck(state, n, sys))
        options.push({ sys, pid: pid ?? provs[0], local: false });
    }
    options.sort(
      (a, b) =>
        Number(b.local) - Number(a.local) ||
        b.sys.generation - a.sys.generation ||
        a.sys.cost.money - b.sys.cost.money ||
        (a.sys.id < b.sys.id ? -1 : 1),
    );
    for (const o of options) {
      const unit = o.sys.cost.money * (o.local ? 1 : cfg(state.world).industry.importPriceFactor);
      const count = Math.min(AI(state).warBatch, Math.floor(spare / Math.max(1, unit)));
      if (count < 1) continue;
      if (aiOrder(state, n, { kind: 'produce', provinceId: o.pid, systemId: o.sys.id, count }).ok)
        return;
    }
  }
}

/**
 * Coût d'une unité produite par l'IA tactique dans une province : fabrication locale (recherche ou
 * licence, bâtiment requis, ressources) ou, à défaut, importation au prix majoré ; null si impossible.
 * Hors économie réelle : prix du catalogue.
 */
export function aiUnitPrice(
  state: EngineState,
  n: NationId,
  sys: WeaponSystem,
  pid: string,
): number | null {
  if (!eco(state).live) return canAfford(state, n, sys) ? sys.cost.money : null;
  const local = localCheck(state, n, sys, pid);
  if (!local) {
    const licensed = ecoNation(state, n).licences[sys.id] !== undefined;
    const discount = licensed ? 1 - cfg(state.world).licences.productionDiscount : 1;
    const paid = { money: sys.cost.money * discount, res: scaledRes(sys.cost.resources, 1) };
    return canPay(state, n, paid) ? null : paid.money;
  }
  if (local !== 'research_required' && local !== 'not_allowed') return null;
  if (importCheck(state, n, sys)) return null;
  return sys.cost.money * cfg(state.world).industry.importPriceFactor;
}

export function ecoAiThink(state: EngineState, n: NationId): void {
  if (!eco(state).live) return;
  const ns = state.nations[n];
  if (!ns?.alive) return;
  const atWar = warsOf(state, n).length > 0;
  thinkResearch(state, n, atWar);
  thinkRepairs(state, n);
  if (atWar && ns.active) thinkWarProduction(state, n);
  else if (!atWar) thinkInvest(state, n);
}
