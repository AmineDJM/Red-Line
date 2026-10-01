import { z } from 'zod';
import type { GameTime, ProvinceId } from './ids.js';

/**
 * Gestion intérieure : politiques choisies par le joueur (ordre `domesticPolicy`), indicateurs (stabilité,
 * moral, soutien à la guerre, risque de troubles) et événements intérieurs (grèves, manifestations,
 * sabotages). Les chiffres sont dans data/balance (section `domestic`).
 */
export const DOMESTIC_POLICIES = [
  'propaganda',
  'conscription',
  'war_economy',
  'austerity',
  'stimulus',
  'martial_law',
] as const;
export type DomesticPolicy = (typeof DOMESTIC_POLICIES)[number];

/** Effets chiffrés d'une politique (multiplicateurs : 1 = neutre ; additifs : 0 = neutre). */
export const DomesticPolicyEffectsSchema = z.object({
  /** Revenus en dollars (×). */
  income: z.number().positive().default(1),
  /** Vitesse de production (×). */
  production: z.number().positive().default(1),
  /** Vitesse de production de l'infanterie (×), en plus de `production`. */
  infantry: z.number().positive().default(1),
  /** Vitesse de recherche (×). */
  research: z.number().positive().default(1),
  /** Entretien des forces (×). */
  upkeep: z.number().positive().default(1),
  /** Stabilité par jour (+/−). */
  stabilityPerDay: z.number().default(0),
  /** Moral visé des provinces (+/− points). */
  morale: z.number().default(0),
  /** Soutien à la guerre visé (+/− points). */
  warSupport: z.number().default(0),
  /** Risque de troubles (révoltes, manifestations, sabotages) (×). */
  unrest: z.number().min(0).default(1),
  /** Risque de grèves (×). */
  strikes: z.number().min(0).default(1),
  /** Politiques incompatibles (activer celle-ci désactive les autres). */
  excludes: z.array(z.enum(DOMESTIC_POLICIES)).default([]),
});
export type DomesticPolicyEffects = z.infer<typeof DomesticPolicyEffectsSchema>;

export type DomesticEventKind = 'strike' | 'protest' | 'sabotage' | 'riot';

export interface DomesticPolicyView {
  id: DomesticPolicy;
  active: boolean;
  /** Date d'activation (politique active). */
  since: GameTime | null;
  /** Date à partir de laquelle la politique peut de nouveau changer. */
  changeableAt: GameTime;
  effects: DomesticPolicyEffects;
}

export interface DomesticEventView {
  id: string;
  time: GameTime;
  kind: DomesticEventKind;
  provinceId: ProvinceId | null;
  title: string;
  text: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface ProvinceRiskView {
  id: ProvinceId;
  /** Risque de troubles 0..100. */
  risk: number;
  /** Agitation locale (financements étrangers, révoltes) 0..100. */
  unrest: number;
  /** Province conquise (population hostile). */
  occupied: boolean;
  /** Site protégé par le renseignement intérieur. */
  protected?: boolean;
}

/** Section `domestic` de la vue (onglet Intérieur de la fenêtre Économie). */
export interface DomesticView {
  policies: DomesticPolicyView[];
  stability: number;
  /** Moral moyen des provinces (0..100), pondéré par la population. */
  morale: number;
  /** Soutien de la population à la guerre (0..100). */
  warSupport: number;
  warSupportTarget: number;
  /** Multiplicateur de la lassitude de guerre dû au soutien (1 = neutre). */
  wearinessFactor: number;
  /** Risque national de troubles 0..100. */
  unrestRisk: number;
  /** Multiplicateur du risque de troubles (politiques × renseignement intérieur). */
  unrestFactor: number;
  /** Grève en cours : production ralentie jusqu'à cette date. */
  strikeUntil: GameTime | null;
  /** Provinces les plus exposées (risque décroissant, bornées). */
  provinces: ProvinceRiskView[];
  /** Événements intérieurs récents (plus récents d'abord). */
  events: DomesticEventView[];
  /** Effets cumulés des politiques actives. */
  totals: {
    income: number;
    production: number;
    research: number;
    upkeep: number;
    stabilityPerDay: number;
    morale: number;
  };
}

// ——— Renseignement intérieur ———

/** Priorité du renseignement intérieur (ordre `interiorFocus`). */
export const INTERIOR_FOCUS = ['balanced', 'counterintel', 'protection', 'surveillance'] as const;
export type InteriorFocus = (typeof INTERIOR_FOCUS)[number];

export type ThreatGrade = 'low' | 'moderate' | 'high' | 'critical';

export interface ProvinceThreatView {
  provinceId: ProvinceId;
  /** Niveau de menace 0..100 (incidents récents, agitation, sites sensibles, frontière ennemie). */
  level: number;
  grade: ThreatGrade;
  /** Facteurs principaux (libellés courts). */
  factors: string[];
  protected: boolean;
}

/** Section `interior` de IntelView (onglet Intérieur de la fenêtre Renseignement). */
export interface InteriorIntelView {
  focus: InteriorFocus;
  protected: ProvinceId[];
  maxProtected: number;
  /** Effets mesurables (selon niveau, budget et priorité). */
  metrics: {
    /** Qualité du département 0..1. */
    quality: number;
    /** Chance quotidienne de démasquer un agent étranger actif (0..1). */
    agentDetectPerDay: number;
    /** Chance de détecter la préparation d'une opération étrangère (0..1). */
    opDetect: number;
    /** Réduction du succès des opérations adverses sur un site protégé (0..1). */
    protection: number;
    /** Réduction du risque de troubles (0..1). */
    unrestReduction: number;
  };
  /** Menace nationale 0..100 et provinces les plus menacées. */
  threatLevel: number;
  threats: ProvinceThreatView[];
  stats: { foiled: number; alerts: number; caught: number; doubles: number };
}
