import type { ResolutionType } from '@redline/shared';
import type { World } from '../../api.js';

/**
 * Réglages du module diplo : valeurs par défaut documentées, surchargées par `balance.diplomacy` et
 * `balance.stability` (champs optionnels de BalanceSchema). Tous les chiffres d'équilibrage sont ici
 * ou dans data/balance, jamais ailleurs dans le module.
 */
export interface DiploConfig {
  // ——— Conseil de sécurité ———
  councilEveryDays: number;
  voteWindowRealHours: number;
  majority: 'simple' | 'two_thirds';
  veto: boolean;
  rotatingSeats: number;
  proposalsPerNation: number;
  resolutionDays: Record<ResolutionType, number>;
  sanctionsIncomeFactor: number;
  sanctionsStabilityPerDay: number;
  condemnationStability: number;
  condemnationReputation: number;
  peacekeepersPerProvince: number;
  // ——— Relations ———
  reputationStart: number;
  aggressionReputation: number;
  peaceGraceHours: number;
  ceasefireDays: number;
  ceasefireViolationStability: number;
  ceasefireViolationReputation: number;
  // ——— Alliances ———
  leaderInactiveDays: number;
  mutualDefenseDelayHours: number;
  allianceVoteHours: number;
  leaveAllianceStability: number;
  leaveAllianceReputation: number;
  // ——— Guerres par procuration ———
  courtRefShare: number;
  courtJoinLeaning: number;
  leaningDecayPerDay: number;
  fundRebelsRefShare: number;
  fundRebelsUnrestPerRef: number;
  claimantFundingDiscount: number;
  mercenaryCostFactor: number;
  mercenaryDays: number;
  irregularSystemId: string | null;
  newsKeep: number;
  // ——— Stabilité ———
  stabilityStart: number;
  coupThreshold: number;
  revoltThreshold: number;
  lowThreshold: number;
  lowMinFactor: number;
  recoveryPerDay: number;
  lossPerUnit: number;
  lossCapPerDay: number;
  provinceLost: number;
  capitalLost: number;
  provinceGained: number;
  warWearinessPerDay: number;
  nuclearVictim: number;
  nuclearUser: number;
  nuclearWorld: number;
  refugeePerDay: number;
  refugeeCapPerDay: number;
  coupChancePerDay: number;
  coupResetTo: number;
  coupPlayerToAi: boolean;
  revoltChancePerDay: number;
  armedUprisingChance: number;
  rebelUnits: number;
  rebelDays: number;
  disputedCaptureTension: number;
  disputedTensionDriftPerDay: number;
  unrestDecayPerDay: number;
  mobilizationStabilityPerDay: number;
}

export const DEFAULTS: DiploConfig = {
  councilEveryDays: 30,
  voteWindowRealHours: 12,
  majority: 'simple',
  veto: true,
  rotatingSeats: 3,
  proposalsPerNation: 2,
  resolutionDays: {
    arms_embargo: 30,
    economic_sanctions: 30,
    ceasefire: 10,
    no_fly_zone: 15,
    peacekeeping: 20,
    condemnation: 0,
  },
  sanctionsIncomeFactor: 0.6,
  sanctionsStabilityPerDay: 0.5,
  condemnationStability: 5,
  condemnationReputation: 10,
  peacekeepersPerProvince: 2,
  reputationStart: 50,
  aggressionReputation: 3,
  peaceGraceHours: 48,
  ceasefireDays: 7,
  ceasefireViolationStability: 25,
  ceasefireViolationReputation: 25,
  leaderInactiveDays: 3,
  mutualDefenseDelayHours: 6,
  allianceVoteHours: 24,
  leaveAllianceStability: 10,
  leaveAllianceReputation: 10,
  courtRefShare: 0.1,
  courtJoinLeaning: 0.8,
  leaningDecayPerDay: 0.02,
  fundRebelsRefShare: 0.05,
  fundRebelsUnrestPerRef: 30,
  claimantFundingDiscount: 0.5,
  mercenaryCostFactor: 1.5,
  mercenaryDays: 30,
  irregularSystemId: null,
  newsKeep: 200,
  stabilityStart: 70,
  coupThreshold: 15,
  revoltThreshold: 30,
  lowThreshold: 40,
  lowMinFactor: 0.5,
  recoveryPerDay: 0.5,
  lossPerUnit: 0.5,
  lossCapPerDay: 8,
  provinceLost: 3,
  capitalLost: 15,
  provinceGained: 1,
  warWearinessPerDay: 0.2,
  nuclearVictim: 20,
  nuclearUser: 10,
  nuclearWorld: 2,
  refugeePerDay: 0.5,
  refugeeCapPerDay: 3,
  coupChancePerDay: 0.3,
  coupResetTo: 40,
  coupPlayerToAi: false,
  revoltChancePerDay: 0.15,
  armedUprisingChance: 0.35,
  rebelUnits: 2,
  rebelDays: 20,
  disputedCaptureTension: 25,
  disputedTensionDriftPerDay: 1,
  unrestDecayPerDay: 2,
  mobilizationStabilityPerDay: 1,
};

const cache = new WeakMap<World, DiploConfig>();

function pick<T extends object>(src: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!src) return out;
  for (const [k, v] of Object.entries(src))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Réglages de la partie (monde + surcharges d'équilibrage), calculés une fois par monde. */
export function worldConfig(world: World): DiploConfig {
  let c = cache.get(world);
  if (c) return c;
  const b = world.balance;
  const d = pick(b.diplomacy);
  const s = pick(b.stability);
  c = {
    ...DEFAULTS,
    ...(d as Partial<DiploConfig>),
    resolutionDays: { ...DEFAULTS.resolutionDays, ...(d.resolutionDays ?? {}) },
    irregularSystemId: d.irregularSystemId ?? null,
    stabilityStart: s.start ?? DEFAULTS.stabilityStart,
    coupThreshold: s.coupThreshold ?? DEFAULTS.coupThreshold,
    revoltThreshold: s.revoltThreshold ?? DEFAULTS.revoltThreshold,
    ...(s as Partial<DiploConfig>),
    mobilizationStabilityPerDay: Math.abs(
      b.mobilization?.stabilityPerDay ?? -DEFAULTS.mobilizationStabilityPerDay,
    ),
  } as DiploConfig;
  delete (c as unknown as Record<string, unknown>).start;
  cache.set(world, c);
  return c;
}
