import type { Category, NationId, ResearchBranch, WeaponSystem } from '@redline/shared';
import { provincesOf, warsOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { applyOrderImpl } from '../../orders/orders.js';
import { budgetDay } from './budget.js';
import { buildingsOf, health, levelOf, provinceProductionSpeed } from './buildings.js';
import { cfg, requiredBuildings } from './config.js';
import { importCheck, localCheck } from './production.js';
import { hasGate, nodeOf } from './research.js';
import { eco, ecoNation, sortedIds } from './state.js';

/**
 * Réglages de comportement de l'IA économique (heuristiques de décision, pas de l'équilibrage) :
 * part de la trésorerie qu'elle accepte d'engager, priorités de branches, catégories achetées en guerre.
 */
const AI = {
  /** Une recherche n'est lancée que si elle coûte moins que cette part de la trésorerie. */
  researchSpendShare: 0.25,
  /** Priorité des branches (paix / guerre). */
  peaceBranches: [
    'industry',
    'aero',
    'land',
    'sensors',
    'naval',
    'missiles',
    'cyber',
    'intel',
  ] as ResearchBranch[],
  warBranches: [
    'aero',
    'missiles',
    'land',
    'sensors',
    'industry',
    'naval',
    'cyber',
    'intel',
  ] as ResearchBranch[],
  /** En guerre : catégories achetées ou produites, par ordre de préférence. */
  warCategories: ['air_defense', 'fighter', 'tank', 'artillery', 'drone'] as Category[],
  /** Réserve conservée : jours de budget (ou part de la trésorerie sans ORBAT). */
  reserveDays: 10,
  reserveShare: 0.5,
  /** Productions simultanées maximales en guerre. */
  maxQueueWar: 3,
  /** Taille d'une série. */
  batch: 4,
  /** Une réparation n'est lancée que si l'argent couvre ce multiple de son coût. */
  repairFactor: 3,
};

function reserve(state: EngineState, n: NationId): number {
  const bd = budgetDay(state, n);
  return bd > 0 ? bd * AI.reserveDays : state.nations[n]!.money * AI.reserveShare;
}

/** Recherche : la génération suivante (plus petit rang disponible) dans la branche prioritaire. */
function thinkResearch(state: EngineState, n: NationId, atWar: boolean): void {
  const tree = state.world.research;
  if (!tree) return;
  const en = ecoNation(state, n);
  if (en.cur || en.queue.length > 0) return;
  const money = state.nations[n]!.money;
  const order = atWar ? AI.warBranches : AI.peaceBranches;
  let best: { id: string; score: number } | null = null;
  for (const id of tree.keys()) {
    const node = nodeOf(state, id);
    if (!node || en.done.includes(id)) continue;
    if (!node.requires.every((r) => hasGate(state, n, r))) continue;
    if (node.cost.money > money * AI.researchSpendShare) continue;
    const bi = order.indexOf(node.branch);
    const score = node.tier * 100 + (bi < 0 ? 99 : bi);
    if (!best || score < best.score || (score === best.score && id < best.id)) best = { id, score };
  }
  if (best) applyOrderImpl(state, n, { kind: 'research', nodeId: best.id });
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
      if (state.nations[n]!.money < cost * AI.repairFactor) continue;
      applyOrderImpl(state, n, { kind: 'repair', provinceId: pid, building: b });
    }
  }
}

/** En guerre : production locale ou importation de défenses selon le budget. */
function thinkWarProduction(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  if (ns.production.length >= AI.maxQueueWar) return;
  const spare = ns.money - reserve(state, n);
  if (spare <= 0) return;
  const w = wi(state.world);
  const provs = provincesOf(state, n);
  for (const cat of AI.warCategories) {
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
      const count = Math.min(AI.batch, Math.floor(spare / Math.max(1, unit)));
      if (count < 1) continue;
      if (
        applyOrderImpl(state, n, { kind: 'produce', provinceId: o.pid, systemId: o.sys.id, count })
          .ok
      )
        return;
    }
  }
}

export function ecoAiThink(state: EngineState, n: NationId): void {
  if (!eco(state).live) return;
  const ns = state.nations[n];
  if (!ns?.alive) return;
  const atWar = warsOf(state, n).length > 0;
  thinkResearch(state, n, atWar);
  thinkRepairs(state, n);
  if (atWar && ns.active) thinkWarProduction(state, n);
}
