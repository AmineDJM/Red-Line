import { z } from 'zod';
import type { GameTime, LngLat, NationId, ProvinceId } from './ids.js';
import type { LocText } from './i18n.js';
import { CATEGORIES, RESOURCES } from './catalog.js';
import { RESEARCH_BRANCHES } from './economy.js';

/**
 * Gouvernement : ministères (Défense, Économie), leurs directions (armement, renseignement,
 * infrastructures) et leurs titulaires, personnages fictifs nommés et payés par le joueur, à qui il
 * confie des missions exécutées automatiquement avec les ressources disponibles, dans une enveloppe de
 * budget. Les missions émettent les ordres de jeu existants (construire, rechercher, produire,
 * opérations de renseignement…), validés comme ceux du joueur. Moteur : packages/engine/src/modules/gov.
 * Section `government` de data/balance (optionnelle, chaque valeur a un défaut).
 */

export const GOV_MINISTRIES = ['defense', 'economy'] as const;
export type GovMinistry = (typeof GOV_MINISTRIES)[number];

/**
 * Postes : le ministre de la Défense (infrastructures et logistique), les directions de l'armement
 * (recherche, production), du renseignement (intérieur, extérieur et militaire), le ministre de
 * l'Économie. Le cadre est générique : un poste des données (`government.offices`) suffit à en
 * brancher un autre.
 */
export const GOV_OFFICES = [
  'defense',
  'research',
  'production',
  'intel_interior',
  'intel_exterior',
  'economy',
] as const;
export type GovOffice = (typeof GOV_OFFICES)[number];

/** Sections de la vue d'un ministère. */
export const GOV_GROUPS = ['infra', 'armament', 'intel', 'economy'] as const;
export type GovGroup = (typeof GOV_GROUPS)[number];

/** Compétences d'un titulaire (0 à 100). `finance` : prudence budgétaire. */
export const GOV_SKILLS = [
  'management',
  'industry',
  'logistics',
  'finance',
  'science',
  'intelligence',
] as const;
export type GovSkill = (typeof GOV_SKILLS)[number];

/** Exécutants de mission (code du moteur) ; une mission des données en choisit un. */
export const GOV_EXECS = [
  'extract', // bâtiments d'extraction de la ressource visée, là où sont les gisements
  'invest', // bâtiments listés, provinces les plus rentables
  'build', // bâtiments listés (bases, défenses…), placement selon la mission
  'upgrade', // amélioration des bâtiments listés déjà présents
  'repair', // réparation des bâtiments endommagés
  'reserve', // réserve de trésorerie (aucune dépense ; plancher pour les autres missions)
  'research', // nœuds de recherche (domaine ou prochaine génération d'une catégorie)
  'produce', // production d'une quantité de matériel d'une catégorie
  'stock', // stock d'une catégorie maintenu à un niveau
  'intel', // opérations de renseignement extérieur sur une nation
  'counterintel', // contre-espionnage (balayages, démantèlement, retournement)
  'protect', // protection des sites sensibles (renseignement intérieur)
] as const;
export type GovExec = (typeof GOV_EXECS)[number];

/** Cible d'une mission : ressource, domaine de recherche, catégorie de matériel, nation, aucune. */
export const GOV_TARGETS = ['none', 'resource', 'branch', 'category', 'nation'] as const;
export type GovTarget = (typeof GOV_TARGETS)[number];

/** Placement des chantiers : rentabilité, frontière, couverture (nouveaux sites d'abord), partout. */
export const GOV_PLACEMENTS = ['value', 'border', 'spread', 'any'] as const;
export type GovPlacement = (typeof GOV_PLACEMENTS)[number];

/** Unité de l'objectif d'une mission (affichage). */
export const GOV_UNITS = ['projects', 'nodes', 'lots', 'ops', 'days', 'sites', 'repairs'] as const;
export type GovUnit = (typeof GOV_UNITS)[number];

const num = (d: number) => z.number().default(d);
const pos = (d: number) => z.number().min(0).default(d);

const OfficeDefSchema = z.object({
  ministry: z.enum(GOV_MINISTRIES),
  /** Ministre (tête du ministère) ou directeur. */
  head: z.enum(['minister', 'director']),
  group: z.enum(GOV_GROUPS),
  order: num(0),
  /** Compétences utiles : [gestion, expertise, prudence] (effets ci-dessous). */
  skills: z.array(z.enum(GOV_SKILLS)).min(3).max(3),
  /** Coût par jour (cabinet ou direction : traitement, équipe, frais), dollars US, prix américains. */
  salaryUsdPerDay: pos(30_000),
});
export type GovOfficeDef = z.infer<typeof OfficeDefSchema>;

const MissionDefSchema = z.object({
  office: z.enum(GOV_OFFICES),
  exec: z.enum(GOV_EXECS),
  target: z.enum(GOV_TARGETS).default('none'),
  /** Zone facultative (autour d'une province, ou frontière avec une nation). */
  zone: z.boolean().default(false),
  /** Bâtiments (exécutants build, invest, upgrade) ; `fortification` compris. */
  buildings: z.array(z.string()).default([]),
  placement: z.enum(GOV_PLACEMENTS).default('value'),
  /** Opérations de renseignement, dans l'ordre de rotation (exécutant intel). */
  ops: z.array(z.string()).default([]),
  /** Objectif par défaut, bornes, unité. */
  goal: pos(5),
  goalMax: pos(50),
  unit: z.enum(GOV_UNITS).default('projects'),
  /** Mission de durée : jamais « terminée », elle se poursuit (stock, réserve, protection). */
  continuous: z.boolean().default(false),
  /** Cible par défaut (ressource, domaine, catégorie). */
  defaultTarget: z.string().optional(),
  order: num(0),
});
export type GovMissionDef = z.infer<typeof MissionDefSchema>;

const DEFAULT_OFFICES: Record<string, z.input<typeof OfficeDefSchema>> = {
  defense: {
    ministry: 'defense',
    head: 'minister',
    group: 'infra',
    order: 0,
    skills: ['management', 'logistics', 'finance'],
    salaryUsdPerDay: 60_000,
  },
  research: {
    ministry: 'defense',
    head: 'director',
    group: 'armament',
    order: 1,
    skills: ['management', 'science', 'finance'],
    salaryUsdPerDay: 25_000,
  },
  production: {
    ministry: 'defense',
    head: 'director',
    group: 'armament',
    order: 2,
    skills: ['management', 'industry', 'finance'],
    salaryUsdPerDay: 25_000,
  },
  intel_interior: {
    ministry: 'defense',
    head: 'director',
    group: 'intel',
    order: 3,
    skills: ['management', 'intelligence', 'finance'],
    salaryUsdPerDay: 20_000,
  },
  intel_exterior: {
    ministry: 'defense',
    head: 'director',
    group: 'intel',
    order: 4,
    skills: ['management', 'intelligence', 'finance'],
    salaryUsdPerDay: 20_000,
  },
  economy: {
    ministry: 'economy',
    head: 'minister',
    group: 'economy',
    order: 5,
    skills: ['management', 'industry', 'finance'],
    salaryUsdPerDay: 60_000,
  },
};

const DEFAULT_MISSIONS: Record<string, z.input<typeof MissionDefSchema>> = {
  // ——— Défense : infrastructures et logistique ———
  air_bases: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['air_base'],
    placement: 'spread',
    goal: 3,
    order: 1,
  },
  military_bases: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['military_base'],
    placement: 'spread',
    goal: 3,
    order: 2,
  },
  upgrade_bases: {
    office: 'defense',
    exec: 'upgrade',
    zone: true,
    buildings: ['air_base', 'military_base', 'naval_base'],
    goal: 4,
    order: 3,
  },
  logistics: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['forward_base', 'military_base', 'hospital'],
    placement: 'border',
    goal: 4,
    order: 4,
  },
  fortify: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['fortification', 'bunker'],
    placement: 'border',
    goal: 6,
    order: 5,
  },
  air_defense: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['air_defense_site', 'radar_station'],
    placement: 'value',
    goal: 4,
    order: 6,
  },
  coastal: {
    office: 'defense',
    exec: 'build',
    zone: true,
    buildings: ['coastal_battery', 'naval_base'],
    placement: 'value',
    goal: 3,
    order: 7,
  },
  // ——— Défense : direction de la recherche d'armement ———
  research_next: {
    office: 'research',
    exec: 'research',
    target: 'category',
    defaultTarget: 'fighter',
    unit: 'nodes',
    goal: 0,
    order: 10,
  },
  research_branch: {
    office: 'research',
    exec: 'research',
    target: 'branch',
    defaultTarget: 'aero',
    unit: 'nodes',
    goal: 3,
    goalMax: 20,
    order: 11,
  },
  research_labs: {
    office: 'research',
    exec: 'invest',
    buildings: ['research_center', 'secret_lab'],
    goal: 2,
    order: 12,
  },
  // ——— Défense : direction de la production d'armement ———
  produce: {
    office: 'production',
    exec: 'produce',
    target: 'category',
    defaultTarget: 'air_defense',
    unit: 'lots',
    goal: 10,
    goalMax: 200,
    order: 20,
  },
  stockpile: {
    office: 'production',
    exec: 'stock',
    target: 'category',
    defaultTarget: 'strike_missile',
    unit: 'lots',
    goal: 12,
    goalMax: 200,
    continuous: true,
    order: 21,
  },
  arms_industry: {
    office: 'production',
    exec: 'invest',
    buildings: ['arms_factory', 'electronics_plant'],
    goal: 3,
    order: 22,
  },
  // ——— Défense : renseignement intérieur ———
  counterintel: {
    office: 'intel_interior',
    exec: 'counterintel',
    unit: 'ops',
    goal: 4,
    goalMax: 30,
    order: 30,
  },
  protect_sites: {
    office: 'intel_interior',
    exec: 'protect',
    unit: 'sites',
    goal: 0,
    continuous: true,
    order: 31,
  },
  // ——— Défense : renseignement extérieur et militaire ———
  watch: {
    office: 'intel_exterior',
    exec: 'intel',
    target: 'nation',
    ops: ['recon_military', 'intercept_comms', 'infiltrate_spy'],
    unit: 'ops',
    goal: 4,
    goalMax: 30,
    order: 40,
  },
  map_defenses: {
    office: 'intel_exterior',
    exec: 'intel',
    target: 'nation',
    ops: ['recon_military', 'geolocate_emitters'],
    unit: 'ops',
    goal: 3,
    goalMax: 30,
    order: 41,
  },
  economic_intel: {
    office: 'intel_exterior',
    exec: 'intel',
    target: 'nation',
    ops: ['recon_economic', 'infiltrate_spy'],
    unit: 'ops',
    goal: 2,
    goalMax: 30,
    order: 42,
  },
  // ——— Économie ———
  resource: {
    office: 'economy',
    exec: 'extract',
    target: 'resource',
    defaultTarget: 'oil',
    goal: 5,
    order: 50,
  },
  industry: {
    office: 'economy',
    exec: 'invest',
    buildings: ['local_industry', 'power_plant'],
    goal: 4,
    order: 51,
  },
  revenue: {
    office: 'economy',
    exec: 'invest',
    buildings: ['local_industry'],
    goal: 4,
    order: 52,
  },
  war_economy: {
    office: 'economy',
    exec: 'invest',
    buildings: ['arms_factory', 'power_plant', 'refinery'],
    goal: 4,
    order: 53,
  },
  reserves: {
    office: 'economy',
    exec: 'reserve',
    unit: 'days',
    goal: 30,
    goalMax: 365,
    continuous: true,
    order: 54,
  },
  repair: {
    office: 'economy',
    exec: 'repair',
    unit: 'repairs',
    goal: 5,
    order: 55,
  },
};

/** Effets d'un trait (additifs, sauf les multiplicateurs). */
const TraitSchema = z.object({
  weight: pos(1),
  /** Gain de vitesse des chantiers, productions et recherches (fraction). */
  speed: num(0),
  /** Rabais négocié sur les dépenses (fraction). */
  discount: num(0),
  /** Réserve de trésorerie gardée : multiplicateur. */
  reserve: pos(1),
  /** Actions simultanées en plus par mission. */
  slots: num(0),
  /** Coût du poste : multiplicateur. */
  salary: pos(1),
  /** Qualité des choix : −1 = toujours le meilleur choix, +1 = plus dispersé. */
  choice: num(0),
});
export type GovTraitDef = z.infer<typeof TraitSchema>;

const DEFAULT_TRAITS: Record<string, z.input<typeof TraitSchema>> = {
  efficient: { weight: 1, speed: 0.04 },
  frugal: { weight: 1, discount: 0.02, salary: 0.9 },
  ambitious: { weight: 0.8, slots: 1, reserve: 0.7, salary: 1.1 },
  cautious: { weight: 1, reserve: 1.5 },
  technocrat: { weight: 0.8, choice: -1, salary: 1.15 },
  reformer: { weight: 0.8, speed: 0.02, discount: 0.01 },
  bureaucrat: { weight: 1, speed: -0.03, salary: 0.85 },
};

export const GovernmentBalanceSchema = z.object({
  enabled: z.boolean().default(true),
  /** Missions actives par poste (suspendues comprises, terminées exclues). */
  maxMissions: z.number().int().min(1).default(6),
  /** Entrées du journal conservées par poste. */
  journalMax: z.number().int().min(5).default(40),
  /** Missions terminées ou annulées conservées pour l'historique (par nation). */
  historyMax: z.number().int().min(0).default(10),
  offices: z.record(z.string(), OfficeDefSchema).default(DEFAULT_OFFICES),
  missions: z.record(z.string(), MissionDefSchema).default(DEFAULT_MISSIONS),
  heads: z
    .object({
      /** Candidats proposés à la fois par poste. */
      poolSize: z.number().int().min(1).max(12).default(4),
      /** Un candidat non nommé est remplacé au bout de ce délai (jours ; 0 = jamais). */
      poolRefreshDays: pos(10),
      skillMean: num(55),
      skillSpread: pos(14),
      traitChance: z.number().min(0).max(1).default(0.6),
      /** Coût du poste selon la note : × (base + span × note / 100). */
      salaryBase: pos(0.6),
      salarySpan: pos(0.8),
      useCostIndex: z.boolean().default(true),
      /** Prime de nomination et indemnité de départ (jours de coût). */
      signingDays: pos(2),
      severanceDays: pos(5),
      /** Jours impayés avant démission. */
      resignAfterUnpaidDays: pos(3),
      traits: z.record(z.string(), TraitSchema).default(DEFAULT_TRAITS),
    })
    .default({}),
  /** Effets modestes des compétences. */
  effects: z
    .object({
      /** Gestion : gain de vitesse maximal (compétence 100), à partir de `speedFrom`. */
      speedMax: pos(0.1),
      speedFrom: pos(40),
      /** Gestion : une action simultanée de plus par mission au-delà de ce seuil. */
      slotsBase: z.number().int().min(1).default(1),
      slotsAt: pos(70),
      /** Expertise : rabais maximal négocié (compétence 100), à partir de `discountFrom`. */
      discountMax: pos(0.06),
      discountFrom: pos(40),
      /** Expertise : choix parmi les k meilleurs, k = 1 + ⌊(100 − compétence) / choiceStep⌋. */
      choiceStep: z.number().positive().default(30),
      /** Prudence : réserve gardée = reserveDays × (0,5 + prudence / 100) jours de budget. */
      reserveDays: pos(10),
    })
    .default({}),
  budget: z
    .object({
      /** Part des revenus par défaut (%) et enveloppe par défaut (jours de budget de défense). */
      defaultPct: pos(10),
      defaultDays: pos(20),
    })
    .default({}),
  /** Production : lots commandés au plus par ordre. */
  batch: z.number().int().min(1).max(20).default(4),
});
export type GovernmentBalance = z.infer<typeof GovernmentBalanceSchema>;

// ——— Ordres ———

const id = z.string().max(64);
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** Enveloppe : montant total, ou part des revenus journaliers (avec un plafond facultatif). */
export const GovBudgetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('amount'), amount: z.number().min(0).max(1e15) }),
  z.object({
    mode: z.literal('share'),
    pct: z.number().min(0.5).max(100),
    cap: z.number().min(0).max(1e15).optional(),
  }),
]);
export type GovBudget = z.infer<typeof GovBudgetSchema>;

export const GOV_PRIORITIES = [1, 2, 3] as const;

export const GovMissionInputSchema = z.object({
  /** Identifiant de mission des données (balance.government.missions). */
  type: z.string().min(1).max(32),
  priority: z.number().int().min(1).max(3).optional(),
  budget: GovBudgetSchema,
  goal: z.number().int().min(0).max(1000).optional(),
  /** Cible : ressource, domaine de recherche, catégorie de matériel (selon la mission). */
  resource: z.enum(RESOURCES).optional(),
  branch: z.enum(RESEARCH_BRANCHES).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** Nation visée (renseignement) ou frontière avec cette nation (zone). */
  nationId: id.optional(),
  /** Zone autour d'une province. */
  provinceId: id.optional(),
  radiusKm: z.number().min(50).max(3000).optional(),
});
export type GovMissionInput = z.input<typeof GovMissionInputSchema>;

/** Ordres du gouvernement (ajoutés à OrderSchema). */
export const GOVERNMENT_ORDERS = [
  /** Nomme un candidat du vivier à un poste (le titulaire éventuel part avec son indemnité). */
  z.object({ kind: z.literal('govAppoint'), office: z.enum(GOV_OFFICES), candidateId: id }),
  /** Renvoie le titulaire (indemnité) : le poste est vacant, ses missions attendent. */
  z.object({ kind: z.literal('govDismiss'), office: z.enum(GOV_OFFICES) }),
  z.object({ kind: z.literal('govMission'), mission: GovMissionInputSchema }),
  z.object({
    kind: z.literal('govMissionEdit'),
    missionId: id,
    priority: z.number().int().min(1).max(3).optional(),
    budget: GovBudgetSchema.optional(),
    goal: z.number().int().min(0).max(1000).optional(),
  }),
  z.object({ kind: z.literal('govMissionSuspend'), missionId: id, on: z.boolean() }),
  /** Arrête et retire la mission (les chantiers et commandes déjà lancés continuent). */
  z.object({ kind: z.literal('govMissionCancel'), missionId: id }),
] as const;

// ——— Vue (PlayerView.government, propre nation seulement) ———

export interface GovHeadView {
  id: string;
  first: string;
  last: string;
  culture: string;
  skills: Record<GovSkill, number>;
  traits: string[];
  /** Note du poste (moyenne des trois compétences utiles). */
  rating: number;
  salaryPerDay: number;
  /** Candidat : prime de nomination ; titulaire : indemnité de départ. */
  hireCost: number;
  severance: number;
  since?: GameTime;
  unpaidDays?: number;
  /** Effets calculés pour le poste (vitesse, rabais, actions simultanées, réserve en jours). */
  effects: { speed: number; discount: number; slots: number; reserveDays: number; choice: number };
}

export interface GovJournalEntry {
  t: GameTime;
  text: LocText;
  tone?: 'info' | 'good' | 'warn' | 'bad';
  missionId?: string;
}

export type GovMissionStatus = 'active' | 'waiting' | 'blocked' | 'suspended' | 'done';

export interface GovMissionView {
  id: string;
  office: GovOffice;
  type: string;
  priority: number;
  status: GovMissionStatus;
  /** Raison du blocage ou de l'attente (clé engine.gov.why.*). */
  why?: LocText;
  budget: GovBudget;
  spent: number;
  /** Disponible maintenant dans l'enveloppe. */
  available: number;
  goal: number;
  done: number;
  /** Actions en cours (chantiers, commandes, recherches, opérations). */
  pending: number;
  /** Avancement 0..1. */
  progress: number;
  resource?: string;
  branch?: string;
  category?: string;
  nationId?: NationId;
  provinceId?: ProvinceId;
  radiusKm?: number;
  /** Repère sur la carte des actions en cours. */
  at?: LngLat[];
  since: GameTime;
  /** Dernière action. */
  last?: LocText;
  /** Mission retirée par le joueur (historique). */
  cancelled?: boolean;
}

export interface GovOfficeView {
  id: GovOffice;
  ministry: GovMinistry;
  group: GovGroup;
  head: GovHeadView | null;
  candidates: GovHeadView[];
  journal: GovJournalEntry[];
}

export interface GovernmentView {
  offices: GovOfficeView[];
  missions: GovMissionView[];
  /** Missions terminées ou retirées récemment. */
  history: GovMissionView[];
  missionDefs: Record<string, GovMissionDef>;
  officeDefs: Record<string, GovOfficeDef>;
  /** Coût total des titulaires, par jour. */
  salaryPerDay: number;
  /** Plancher de trésorerie respecté par les missions (prudence, mission Réserves). */
  reserveFloor: number;
  maxMissions: number;
  /** Budget de défense par jour (enveloppe par défaut). */
  budgetDay: number;
}

/** Note d'un titulaire pour un poste (moyenne des compétences utiles). */
export function govRating(skills: Record<GovSkill, number>, used: readonly GovSkill[]): number {
  if (!used.length) return 0;
  let s = 0;
  for (const k of used) s += skills[k] ?? 0;
  return s / used.length;
}
