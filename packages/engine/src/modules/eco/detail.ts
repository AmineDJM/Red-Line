import {
  RESOURCES,
  type EconomyDetailView,
  type LedgerKey,
  type NationId,
  type ProvinceEconomyView,
  type Resource,
  type ResourceFlowView,
} from '@redline/shared';
import { provincesOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { breakdown, provinceIncome } from './budget.js';
import { moraleOf, provinceResources } from './buildings.js';
import { ecoNation, orbatOf } from './state.js';

/** Postes du grand livre qui relèvent du commerce extérieur (balance commerciale). */
const TRADE_KEYS: LedgerKey[] = [
  'marketSales',
  'marketPurchases',
  'imports',
  'blackMarket',
  'licences',
  'transfersIn',
  'transfersOut',
];

const round = (x: number, d = 2): number => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

/** Tableau de bord économique d'une nation (onglet Économie). */
export function economyDetail(state: EngineState, n: NationId): EconomyDetailView {
  const ns = state.nations[n]!;
  const en = ecoNation(state, n);
  const b = breakdown(state, n);
  const w = wi(state.world);
  const net = b.total - b.upkeepTotal;

  const resources = {} as Record<Resource, ResourceFlowView>;
  for (const r of RESOURCES) {
    const flow = b.production[r] - b.consumption[r];
    resources[r] = {
      stock: ns.res[r],
      production: round(b.production[r]),
      consumption: round(b.consumption[r]),
      net: round(flow),
      shortage: !!en.short[r],
      daysLeft: flow < 0 ? round(Math.max(0, ns.res[r]) / -flow, 1) : null,
    };
  }

  const provinces: ProvinceEconomyView[] = [];
  let population = 0;
  let moraleSum = 0;
  let moraleW = 0;
  for (const pid of provincesOf(state, n)) {
    const def = w.provById.get(pid)!;
    const pop = def.population ?? 0;
    const morale = moraleOf(state, pid);
    population += pop;
    moraleSum += morale * Math.max(1, pop);
    moraleW += Math.max(1, pop);
    const y = provinceResources(state, pid);
    const res: Partial<Record<Resource, number>> = {};
    for (const r of RESOURCES) if (y[r] !== 0) res[r] = round(y[r]);
    provinces.push({
      id: pid,
      population: pop,
      morale: round(morale, 1),
      income: round(provinceIncome(state, pid)),
      resources: res,
    });
  }

  let tradeBalance = 0;
  for (const k of TRADE_KEYS) tradeBalance += en.lastDay[k] ?? 0;
  const o = orbatOf(state, n);
  return {
    budgetUsdPerYear: o ? o.defenseBudgetUsd : null,
    income: {
      national: round(b.national),
      provincial: round(b.provincial),
      trade: round(b.trade),
      mobilization: round(b.mobilization),
      modifiers: round(b.modifiers),
      total: round(b.total),
    },
    upkeep: Object.fromEntries(
      Object.keys(b.upkeep)
        .sort()
        .map((k) => [k, round(b.upkeep[k]!)]),
    ),
    upkeepTotal: round(b.upkeepTotal),
    lastDay: { ...en.lastDay } as Partial<Record<LedgerKey, number>>,
    today: { ...en.today } as Partial<Record<LedgerKey, number>>,
    tradeBalance: round(tradeBalance),
    resources,
    forecast: {
      netPerDay: round(net),
      money7d: round(ns.money + 7 * net),
      money30d: round(ns.money + 30 * net),
    },
    population,
    morale: moraleW > 0 ? round(moraleSum / moraleW, 1) : 0,
    provinces,
  };
}
