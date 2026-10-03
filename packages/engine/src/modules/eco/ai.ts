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
import {
  RESOURCE_BUILDINGS,
  buildRestriction,
  buildingsOf,
  depositYield,
  depositsOf,
  health,
  levelOf,
  provinceProductionSpeed,
} from './buildings.js';
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
  const share = money * ec.researchSpendShare;
  if (!(share > 0) || share < cheapest(tree)) return;
  // Réserve (grand livre) lue seulement quand une recherche est envisageable.
  const budget = Math.min(share, money - aiReserve(state, n, atWar));
  if (!(budget > 0)) return;
  const ranks = branchRanks(state, n, atWar);
  const best = researchPick(
    state,
    n,
    budget,
    (raw) => raw.tier + (ranks.get(raw.branch) ?? BRANCHES.length) * ec.researchFocus,
  );
  if (best) aiOrder(state, n, { kind: 'research', nodeId: best.id });
}

/**
 * Meilleur nœud de recherche selon un score (le plus bas l'emporte ; null = exclu) : acquis exclus,
 * prérequis acquis, coût dans le budget, ressources disponibles. Partagé par l'IA économique et la
 * direction de la recherche du gouvernement (modules/gov), qui en change le score.
 */
export function researchPick(
  state: EngineState,
  n: NationId,
  budget: number,
  score: (raw: ResearchNode) => number | null,
): ResearchNode | null {
  const tree = state.world.research;
  if (!tree) return null;
  const done = new Set(ecoNation(state, n).done);
  let best: ResearchNode | null = null;
  let bestScore = Infinity;
  for (const id of researchIds(tree)) {
    const raw = tree.get(id)!;
    if (raw.cost.money > budget || done.has(id)) continue;
    const sc = score(raw);
    if (sc === null || sc >= bestScore) continue;
    const node = nodeOf(state, id);
    if (!node || !node.requires.every((r) => hasGate(state, n, r))) continue;
    if (canPay(state, n, { money: node.cost.money, res: scaledRes(node.cost.resources, 1) }))
      continue;
    best = node;
    bestScore = sc;
  }
  return best;
}

/** Coût du nœud de recherche le moins cher (par arbre). */
const cheapestCache = new WeakMap<object, number>();

function cheapest(tree: ReadonlyMap<string, ResearchNode>): number {
  let c = cheapestCache.get(tree);
  if (c === undefined) {
    c = Infinity;
    for (const node of tree.values()) c = Math.min(c, node.cost.money);
    cheapestCache.set(tree, c);
  }
  return c;
}

/** Identifiants de l'arbre triés (par arbre). */
const researchIdsCache = new WeakMap<object, string[]>();

function researchIds(tree: ReadonlyMap<string, ResearchNode>): string[] {
  let ids = researchIdsCache.get(tree);
  if (!ids) researchIdsCache.set(tree, (ids = [...tree.keys()].sort()));
  return ids;
}

/** Coût de réparation d'un bâtiment endommagé (même calcul que l'ordre `repair`). */
export function repairCost(state: EngineState, pid: string, b: string): number {
  const c = cfg(state.world);
  return (
    (c.buildings.buildCostUsd[b] ?? 0) *
    Math.pow(c.buildings.levelCostGrowth, levelOf(state, pid, b) - 1) *
    (1 - health(state, pid, b)) *
    c.industry.repairCostFactor
  );
}

/**
 * Bâtiments endommagés d'une nation sans réparation en cours (ordre stable). Partagé par l'IA
 * économique et le gouvernement (mission Reconstruction).
 */
export function repairCandidates(
  state: EngineState,
  n: NationId,
): { pid: string; b: BuildingType; cost: number }[] {
  const es = eco(state);
  const out: { pid: string; b: BuildingType; cost: number }[] = [];
  for (const pid of sortedIds(es.bld)) {
    if (state.provinces[pid]?.owner !== n) continue;
    for (const b of buildingsOf(state, pid)) {
      const h = health(state, pid, b);
      if (h >= 1 || es.bld[pid]?.[b]?.rep != null) continue;
      out.push({ pid, b, cost: repairCost(state, pid, b) });
    }
  }
  return out;
}

/** Réparations des bâtiments endommagés, si la trésorerie le permet. */
function thinkRepairs(state: EngineState, n: NationId): void {
  for (const { pid, b, cost } of repairCandidates(state, n)) {
    if (state.nations[n]!.money < cost * AI(state).repairFactor) continue;
    aiOrder(state, n, { kind: 'repair', provinceId: pid, building: b });
  }
}

/**
 * Investissement (un chantier à la fois) : améliore le bâtiment de ressources le moins avancé ou, sur
 * une carte à ressources, ouvre un bâtiment d'extraction là où la province possède la ressource. À
 * niveau égal, la plus riche d'abord (rendement selon la richesse, principale avant secondaire) ;
 * jamais de bâtiment interdit (ressource absente, pas de côte, pas de pôle électronique) ; dans une
 * province « argent seulement », l'industrie locale (quartier d'affaires).
 */
function thinkInvest(state: EngineState, n: NationId): void {
  const bd = budgetDay(state, n);
  if (bd <= 0 || state.nations[n]!.money < bd * AI(state).investDays) return;
  const es = eco(state);
  for (const id of sortedIds(es.jobs)) if (es.jobs[id]!.n === n) return;
  let best: InvestCandidate | null = null;
  for (const x of investCandidates(state, n, AI(state).investIn))
    if (!best || x.lvl < best.lvl || (x.lvl === best.lvl && x.y > best.y)) best = x;
  if (!best) return;
  const c = cfg(state.world).buildings;
  const cost = (c.buildCostUsd[best.b] ?? 0) * Math.pow(c.levelCostGrowth, best.lvl);
  if (state.nations[n]!.money - cost < aiReserve(state, n, false)) return;
  aiOrder(state, n, { kind: 'build', provinceId: best.pid, building: best.b });
}

export interface InvestCandidate {
  pid: string;
  b: BuildingType;
  /** Niveau actuel (0 : bâtiment neuf). */
  lvl: number;
  /** Rendement de la ressource produite (1 hors ressources). */
  y: number;
}

/**
 * Chantiers d'investissement possibles d'une nation (province × bâtiment, ordre stable) : amélioration
 * d'un bâtiment intact sous le niveau maximal ou construction neuve selon `fresh` — règle de l'IA
 * (`ai`, défaut : sur une carte à ressources, extraction seulement sur gisement, industrie locale dans
 * les provinces « argent seulement »), tout bâtiment que `buildRestriction` permet (`allowed`), ou
 * aucun (`none`). Partagé par l'IA économique et le gouvernement (modules/gov).
 */
export function investCandidates(
  state: EngineState,
  n: NationId,
  buildings: readonly BuildingType[],
  opts: { provinces?: readonly string[]; fresh?: 'ai' | 'allowed' | 'none' } = {},
): InvestCandidate[] {
  const max = cfg(state.world).buildings.maxLevel;
  const fresh = opts.fresh ?? 'ai';
  const out: InvestCandidate[] = [];
  for (const pid of opts.provinces ?? provincesOf(state, n)) {
    const ds = depositsOf(state.world, pid);
    for (const b of buildings) {
      const lvl = levelOf(state, pid, b);
      if (lvl >= max) continue;
      const r = RESOURCE_BUILDINGS[b];
      if (lvl <= 0) {
        if (fresh === 'none') continue;
        if (fresh === 'ai') {
          // Bâtiment neuf : seulement sur une carte à ressources, là où la province s'y prête.
          if (!ds || buildRestriction(state.world, pid, b)) continue;
          if (r ? !ds.some((d) => d.type === r) : !(b === 'local_industry' && ds.length === 0))
            continue;
        } else if (buildRestriction(state.world, pid, b)) continue;
      } else if (health(state, pid, b) < 1) continue;
      const y = r ? depositYield(state.world, pid, r) : 1;
      out.push({ pid, b, lvl, y });
    }
  }
  return out;
}

/** En guerre : production locale ou importation de défenses selon le budget. */
function thinkWarProduction(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  if (ns.production.length >= AI(state).warMaxQueue) return;
  const spare = ns.money - reserve(state, n);
  if (spare <= 0) return;
  for (const cat of AI(state).warCategories) {
    for (const o of productionOptions(state, n, cat)) {
      const unit = o.sys.cost.money * (o.local ? 1 : cfg(state.world).industry.importPriceFactor);
      const count = Math.min(AI(state).warBatch, Math.floor(spare / Math.max(1, unit)));
      if (count < 1) continue;
      if (aiOrder(state, n, { kind: 'produce', provinceId: o.pid, systemId: o.sys.id, count }).ok)
        return;
    }
  }
}

export interface ProductionOption {
  sys: WeaponSystem;
  pid: string;
  local: boolean;
}

/**
 * Façons de se procurer un matériel d'une catégorie : fabrication locale (recherche ou licence,
 * bâtiment requis) dans la première province équipée, sinon importation ; triées : local d'abord,
 * génération la plus récente, coût le plus bas. Navires exclus, sauf `sea` (province avec accès à la
 * mer). Partagé par l'IA économique et la direction de la production du gouvernement.
 */
export function productionOptions(
  state: EngineState,
  n: NationId,
  cat: string,
  opts: { sea?: boolean } = {},
): ProductionOption[] {
  const w = wi(state.world);
  const provs = provincesOf(state, n);
  const options: ProductionOption[] = [];
  for (const id of w.systemIds) {
    const sys = state.world.catalog.get(id)!;
    if (sys.category !== cat || !sys.enabled) continue;
    const sea = sys.movement === 'sea';
    if (sea && !opts.sea) continue;
    const need = requiredBuildings(sys);
    const pid = provs.find(
      (p) => provinceProductionSpeed(state, p, need) > 0 && (!sea || !!w.seaSpawn.get(p)),
    );
    const fallback = sea ? provs.find((p) => !!w.seaSpawn.get(p)) : provs[0];
    if (pid && !localCheck(state, n, sys, pid)) options.push({ sys, pid, local: true });
    else if (fallback && !importCheck(state, n, sys))
      options.push({ sys, pid: pid ?? fallback, local: false });
  }
  options.sort(
    (a, b) =>
      Number(b.local) - Number(a.local) ||
      b.sys.generation - a.sys.generation ||
      a.sys.cost.money - b.sys.cost.money ||
      (a.sys.id < b.sys.id ? -1 : 1),
  );
  return options;
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
