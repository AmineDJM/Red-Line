import type {
  Department,
  InfoCredibility,
  IntelOpKind,
  IntelSource,
  SourceReliability,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';

/**
 * Réglages du renseignement. Les chiffres viennent de `balance.intel` (data/balance, validé par zod) ;
 * les valeurs ci-dessous sont les valeurs par défaut documentées du moteur (identiques à celles du schéma),
 * appliquées quand la section est absente.
 */
export interface IntelConfig {
  dailyReportHour: number;
  reportsPerDay: number;
  defaultBudgetShare: number;
  defaultBudgetUsdPerDay: number;
  budgetRefUsdPerDay: number;
  staleAfterH: number;
  reportUncertaintyKmh: number;
  maxReports: number;
  viewReports: number;
  scanEveryMin: number;
  flashMinUnits: number;
  flashBorderKm: number;
  flashCooldownH: number;
  listenHours: number;
  listenRadiusKm: number;
  listenMaxRadiusKm: number;
  listenEveryMin: number;
  interceptHours: number;
  jamHours: number;
  cyberHours: number;
  decoyHours: number;
  decoyCount: number;
  decoyMaxKm: number;
  agentDetectPerDay: number;
  caughtGraceH: number;
  sabotageDamage: [number, number];
  disinformationAmount: number;
  exposureTension: number;
  ops: Record<IntelOpKind, OpCost>;
}

export interface OpCost {
  money: number;
  durationH: number;
  baseSuccess: number;
  exposure: number;
}

export const DEFAULTS: Omit<IntelConfig, 'ops'> = {
  dailyReportHour: 7,
  reportsPerDay: 1,
  defaultBudgetShare: 0.02,
  defaultBudgetUsdPerDay: 200_000,
  budgetRefUsdPerDay: 1_000_000,
  staleAfterH: 24,
  reportUncertaintyKmh: 10,
  maxReports: 80,
  viewReports: 40,
  scanEveryMin: 60,
  flashMinUnits: 6,
  flashBorderKm: 150,
  flashCooldownH: 12,
  listenHours: 12,
  listenRadiusKm: 150,
  listenMaxRadiusKm: 600,
  listenEveryMin: 30,
  interceptHours: 12,
  jamHours: 6,
  cyberHours: 12,
  decoyHours: 48,
  decoyCount: 3,
  decoyMaxKm: 400,
  agentDetectPerDay: 0.05,
  caughtGraceH: 24,
  sabotageDamage: [0.3, 0.6],
  disinformationAmount: 5,
  exposureTension: 2,
};

/** Coûts par défaut des opérations (dollars US, heures de jeu), surchargés par balance.intel.ops. */
export const DEFAULT_OPS: Record<IntelOpKind, OpCost> = {
  infiltrate_spy: { money: 3_000_000, durationH: 24, baseSuccess: 0.6, exposure: 0.5 },
  recruit_source: { money: 1_000_000, durationH: 12, baseSuccess: 0.7, exposure: 0.3 },
  turn_agent: { money: 1_500_000, durationH: 12, baseSuccess: 0.55, exposure: 0.2 },
  exfiltrate: { money: 2_000_000, durationH: 12, baseSuccess: 0.7, exposure: 0.4 },
  steal_research: { money: 8_000_000, durationH: 48, baseSuccess: 0.4, exposure: 0.5 },
  sabotage_factory: { money: 6_000_000, durationH: 36, baseSuccess: 0.45, exposure: 0.6 },
  fund_rebels: { money: 10_000_000, durationH: 24, baseSuccess: 0.6, exposure: 0.4 },
  listen_area: { money: 1_000_000, durationH: 2, baseSuccess: 0.85, exposure: 0.05 },
  intercept_army: { money: 1_500_000, durationH: 3, baseSuccess: 0.65, exposure: 0.1 },
  jam_area: { money: 2_000_000, durationH: 1, baseSuccess: 0.8, exposure: 0.2 },
  cyber_radar: { money: 4_000_000, durationH: 8, baseSuccess: 0.5, exposure: 0.35 },
  cyber_production: { money: 4_000_000, durationH: 8, baseSuccess: 0.5, exposure: 0.35 },
  cyber_orders: { money: 4_000_000, durationH: 6, baseSuccess: 0.45, exposure: 0.35 },
  disinformation: { money: 3_000_000, durationH: 12, baseSuccess: 0.6, exposure: 0.3 },
  leak_plans: { money: 2_000_000, durationH: 12, baseSuccess: 0.55, exposure: 0.3 },
  plant_fake_report: { money: 1_000_000, durationH: 6, baseSuccess: 0.6, exposure: 0.3 },
  deploy_decoys: { money: 3_000_000, durationH: 6, baseSuccess: 0.8, exposure: 0.1 },
  fake_radio_traffic: { money: 1_000_000, durationH: 3, baseSuccess: 0.7, exposure: 0.2 },
  counterintel_sweep: { money: 2_000_000, durationH: 12, baseSuccess: 0.75, exposure: 0 },
};

/** Département et source de chaque opération (structure du jeu, pas de l'équilibrage). */
export const OP_META: Record<IntelOpKind, { dept: Department; source: IntelSource }> = {
  infiltrate_spy: { dept: 'exterior', source: 'humint' },
  recruit_source: { dept: 'exterior', source: 'humint' },
  turn_agent: { dept: 'interior', source: 'humint' },
  exfiltrate: { dept: 'exterior', source: 'humint' },
  steal_research: { dept: 'exterior', source: 'humint' },
  sabotage_factory: { dept: 'exterior', source: 'humint' },
  fund_rebels: { dept: 'exterior', source: 'humint' },
  listen_area: { dept: 'military', source: 'sigint' },
  intercept_army: { dept: 'military', source: 'sigint' },
  jam_area: { dept: 'military', source: 'sigint' },
  cyber_radar: { dept: 'military', source: 'sigint' },
  cyber_production: { dept: 'military', source: 'sigint' },
  cyber_orders: { dept: 'military', source: 'sigint' },
  disinformation: { dept: 'exterior', source: 'humint' },
  leak_plans: { dept: 'exterior', source: 'humint' },
  plant_fake_report: { dept: 'exterior', source: 'humint' },
  deploy_decoys: { dept: 'military', source: 'sigint' },
  fake_radio_traffic: { dept: 'military', source: 'sigint' },
  counterintel_sweep: { dept: 'interior', source: 'humint' },
};

const cache = new WeakMap<object, IntelConfig>();

export function cfg(state: EngineState): IntelConfig {
  const bal = state.world.balance;
  let c = cache.get(bal);
  if (!c) {
    const src = (bal.intel ?? {}) as Partial<IntelConfig> & {
      ops?: Record<string, Partial<OpCost>>;
    };
    const ops = { ...DEFAULT_OPS };
    for (const k of Object.keys(ops) as IntelOpKind[]) {
      const o = src.ops?.[k];
      if (o) ops[k] = { ...ops[k], ...o };
    }
    const merged = { ...DEFAULTS } as Record<string, unknown>;
    for (const k of Object.keys(DEFAULTS)) {
      const v = (src as Record<string, unknown>)[k];
      if (v !== undefined) merged[k] = v;
    }
    c = { ...(merged as Omit<IntelConfig, 'ops'>), ops };
    cache.set(bal, c);
  }
  return c;
}

/** Cotation : qualité 0..1 → fiabilité A..F. */
export function reliabilityOf(s: number): SourceReliability {
  if (s >= 0.85) return 'A';
  if (s >= 0.7) return 'B';
  if (s >= 0.5) return 'C';
  if (s >= 0.3) return 'D';
  if (s >= 0.15) return 'E';
  return 'F';
}

/** Cotation : qualité 0..1 → crédibilité 1..6. */
export function credibilityOf(s: number): InfoCredibility {
  if (s >= 0.85) return 1;
  if (s >= 0.7) return 2;
  if (s >= 0.5) return 3;
  if (s >= 0.3) return 4;
  if (s >= 0.15) return 5;
  return 6;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
