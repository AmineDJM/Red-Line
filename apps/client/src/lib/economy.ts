/**
 * Économie (tableau de bord) : lecture de `PlayerView.economy.detail` (EconomyDetailView, publié par
 * le module eco du moteur). Sans module eco (bac à sable phase 1), repli minimal sur la vue.
 */
import {
  RESOURCES,
  type BuildingType,
  type EconomyDetailView,
  type GameTime,
  type LedgerKey,
  type PlayerView,
  type ProvinceId,
  type Resource,
  type ResourceFlowView,
} from '@redline/shared';

export type IncomeKey = 'national' | 'provincial' | 'trade' | 'mobilization' | 'modifiers';

export interface EconomySummary {
  detail: EconomyDetailView | null;
  /** Postes de revenus (dollars par jour ; les postes négatifs sont des pertes : sanctions…). */
  income: { key: IncomeKey; amount: number }[];
  /** Entretien par catégorie d'unités (dollars par jour, positifs). */
  upkeep: { key: string; amount: number }[];
  /** Budgets des services de renseignement (dollars par jour). */
  intel: number;
  totalIncome: number;
  totalExpenses: number;
  /** Solde par jour, renseignement compris. */
  balance: number;
}

/** Budget journalier total des services de renseignement. */
export function intelBudget(view: PlayerView | null): number {
  return (view?.intel?.departments ?? []).reduce((s, x) => s + x.budgetPerDay, 0);
}

/**
 * Solde journalier réel : `incomePerDay.money` (revenus − entretien, calculé par le moteur) moins les
 * budgets du renseignement, prélevés chaque jour à part.
 */
export function netPerDay(view: PlayerView | null): number {
  return (view?.economy.incomePerDay.money ?? 0) - intelBudget(view);
}

export function economySummary(view: PlayerView | null): EconomySummary {
  const detail = view?.economy.detail ?? null;
  const intel = intelBudget(view);
  if (!detail) {
    const net = view?.economy.incomePerDay.money ?? 0;
    return {
      detail: null,
      income: net > 0 ? [{ key: 'national', amount: net }] : [],
      upkeep: net < 0 ? [{ key: 'total', amount: -net }] : [],
      intel,
      totalIncome: Math.max(0, net),
      totalExpenses: Math.max(0, -net) + intel,
      balance: net - intel,
    };
  }
  const keys: IncomeKey[] = ['national', 'provincial', 'trade', 'mobilization', 'modifiers'];
  const income = keys
    .map((key) => ({ key, amount: detail.income[key] }))
    .filter((x) => Math.abs(x.amount) >= 1);
  const upkeep = Object.entries(detail.upkeep)
    .map(([key, amount]) => ({ key, amount }))
    .filter((x) => x.amount >= 1)
    .sort((a, b) => b.amount - a.amount);
  return {
    detail,
    income,
    upkeep,
    intel,
    totalIncome: detail.income.total,
    totalExpenses: detail.upkeepTotal + intel,
    balance: detail.income.total - detail.upkeepTotal - intel,
  };
}

/** Flux de ressources (module eco, sinon stock et revenu de la vue). */
export function resourceFlows(view: PlayerView | null): Record<Resource, ResourceFlowView> {
  const d = view?.economy.detail?.resources;
  const out = {} as Record<Resource, ResourceFlowView>;
  for (const r of RESOURCES) {
    const inc = view?.economy.incomePerDay[r] ?? 0;
    out[r] = d?.[r] ?? {
      stock: view?.economy.resources[r] ?? 0,
      production: Math.max(0, inc),
      consumption: Math.max(0, -inc),
      net: inc,
      shortage: false,
      daysLeft: null,
    };
  }
  return out;
}

/** Postes du grand livre, dans l'ordre d'affichage (recettes puis dépenses). */
export const LEDGER_ORDER: LedgerKey[] = [
  'budgetNational',
  'budgetProvincial',
  'trade',
  'mobilization',
  'modifiers',
  'marketSales',
  'transfersIn',
  'upkeep',
  'production',
  'imports',
  'research',
  'buildings',
  'licences',
  'blackMarket',
  'marketPurchases',
  'transfersOut',
  'other',
];

/** Lignes du grand livre non nulles (dollars signés), dans l'ordre d'affichage. */
export function ledgerRows(
  ledger: Partial<Record<LedgerKey, number>> | undefined,
): { key: LedgerKey; amount: number }[] {
  if (!ledger) return [];
  return LEDGER_ORDER.filter((k) => Math.abs(ledger[k] ?? 0) >= 1).map((key) => ({
    key,
    amount: ledger[key]!,
  }));
}

export interface ConstructionItem {
  id: string;
  provinceId: ProvinceId;
  building: BuildingType | 'fortification';
  /** Niveau visé (0 pour une réparation). */
  level: number;
  completesAt: GameTime;
  kind: 'build' | 'upgrade' | 'repair';
}

/** Chantiers en cours (constructions, améliorations, réparations, fortifications) du joueur. */
export function constructionSites(view: PlayerView | null, now: GameTime): ConstructionItem[] {
  const out: ConstructionItem[] = [];
  if (!view) return out;
  for (const p of Object.values(view.provinces)) {
    if (p.owner !== view.me) continue;
    for (const b of p.buildingState ?? []) {
      const lvl = b.level ?? 1;
      if (b.buildUntil && b.buildUntil > now)
        out.push({
          id: `${p.id}:${b.type}:b`,
          provinceId: p.id,
          building: b.type,
          level: 1,
          completesAt: b.buildUntil,
          kind: 'build',
        });
      else if (b.upgradeUntil && b.upgradeUntil > now)
        out.push({
          id: `${p.id}:${b.type}:u`,
          provinceId: p.id,
          building: b.type,
          level: lvl + 1,
          completesAt: b.upgradeUntil,
          kind: 'upgrade',
        });
      if (b.repairUntil && b.repairUntil > now)
        out.push({
          id: `${p.id}:${b.type}:r`,
          provinceId: p.id,
          building: b.type,
          level: 0,
          completesAt: b.repairUntil,
          kind: 'repair',
        });
    }
    const f = p.fortification;
    if (f?.completesAt && f.completesAt > now)
      out.push({
        id: `${p.id}:fortification`,
        provinceId: p.id,
        building: 'fortification',
        level: f.level + 1,
        completesAt: f.completesAt,
        kind: f.level > 0 ? 'upgrade' : 'build',
      });
  }
  return out.sort((a, b) => a.completesAt - b.completesAt);
}
