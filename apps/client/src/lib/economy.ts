/**
 * Économie détaillée (tableau de bord). Le module eco publie ces détails en champs optionnels de
 * `PlayerView.economy` ; tant qu'ils sont absents, le tableau de bord recalcule ce qu'il peut à
 * partir de la vue (revenus, entretien des unités, budgets du renseignement).
 *
 * Forme attendue (proposition au module eco, tous les champs facultatifs) :
 *   economy.details = EconomyDetails
 */
import {
  RESOURCES,
  type BuildingType,
  type GameTime,
  type NationId,
  type PlayerView,
  type ProvinceId,
  type Resource,
  type WeaponSystem,
} from '@redline/shared';
import { totalUpkeep } from './game.js';

export type IncomeKey = 'budget' | 'provinces' | 'trade' | 'licences' | 'alliance' | 'other';
export type ExpenseKey =
  | 'upkeep'
  | 'production'
  | 'research'
  | 'intel'
  | 'construction'
  | 'mobilization'
  | 'imports'
  | 'other';

export interface ResourceFlow {
  stock: number;
  /** Production journalière. */
  production: number;
  /** Consommation journalière (entretien, production). */
  consumption: number;
  shortage?: boolean;
  /** Historique des stocks (un point par jour, le plus récent en dernier). */
  history?: number[];
}

export interface ConstructionItem {
  id: string;
  provinceId: ProvinceId;
  building: BuildingType;
  /** Niveau visé. */
  level: number;
  startedAt: GameTime;
  completesAt: GameTime;
  kind: 'build' | 'upgrade' | 'repair';
}

export interface EconomyDetails {
  /** Budget de défense annuel (dollars). */
  annualBudget?: number;
  income?: Partial<Record<IncomeKey, number>>;
  expenses?: Partial<Record<ExpenseKey, number>>;
  resources?: Partial<Record<Resource, ResourceFlow>>;
  /** Trésorerie par jour (dollars, le plus récent en dernier). */
  history?: number[];
  construction?: ConstructionItem[];
}

export interface EconomySummary {
  details: EconomyDetails;
  income: { key: IncomeKey; amount: number }[];
  expenses: { key: ExpenseKey; amount: number }[];
  totalIncome: number;
  totalExpenses: number;
  balance: number;
  /** Chiffres recalculés côté client (module eco absent). */
  estimated: boolean;
}

export function economyDetails(view: PlayerView | null): EconomyDetails | null {
  const d = (view?.economy as { details?: EconomyDetails } | undefined)?.details;
  return d ?? null;
}

/** Résumé des flux (revenus, dépenses, balance), avec repli calculé. */
export function economySummary(
  view: PlayerView | null,
  me: NationId | null,
  catalog: Record<string, WeaponSystem>,
): EconomySummary {
  const d = economyDetails(view);
  const estimated = !d?.income || !d?.expenses;
  const income = d?.income ?? { budget: view?.economy.incomePerDay.money ?? 0 };
  const intel = (view?.intel?.departments ?? []).reduce((s, x) => s + x.budgetPerDay, 0);
  const expenses = d?.expenses ?? {
    upkeep: totalUpkeep(view, me, catalog),
    ...(intel ? { intel } : {}),
  };
  const inc = Object.entries(income)
    .filter(([, v]) => v)
    .map(([key, amount]) => ({ key: key as IncomeKey, amount: amount! }))
    .sort((a, b) => b.amount - a.amount);
  const exp = Object.entries(expenses)
    .filter(([, v]) => v)
    .map(([key, amount]) => ({ key: key as ExpenseKey, amount: amount! }))
    .sort((a, b) => b.amount - a.amount);
  const totalIncome = inc.reduce((s, x) => s + x.amount, 0);
  const totalExpenses = exp.reduce((s, x) => s + x.amount, 0);
  return {
    details: d ?? {},
    income: inc,
    expenses: exp,
    totalIncome,
    totalExpenses,
    balance: totalIncome - totalExpenses,
    estimated,
  };
}

/** Flux de ressources (détails du module eco, sinon stock et revenu de la vue). */
export function resourceFlows(view: PlayerView | null): Record<Resource, ResourceFlow> {
  const d = economyDetails(view)?.resources ?? {};
  const out = {} as Record<Resource, ResourceFlow>;
  for (const r of RESOURCES) {
    out[r] = d[r] ?? {
      stock: view?.economy.resources[r] ?? 0,
      production: view?.economy.incomePerDay[r] ?? 0,
      consumption: 0,
    };
  }
  return out;
}
