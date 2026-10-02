import { z } from 'zod';
import type { GameTime, LngLat, NationId, ProvinceId, UnitId } from './ids.js';
import type { LocText } from './i18n.js';

/**
 * Centre de commandement : armées (formations nommées de piles existantes), missions confiées à un
 * général, généraux recrutés et payés. Le général est l'IA : il commande les piles de son armée selon
 * la mission, ses compétences et ses traits (moteur : packages/engine/src/modules/command).
 * Section `command` de data/balance (optionnelle, chaque valeur a un défaut).
 */

/** Cerveaux de mission (exécution par le moteur). Une mission des données en choisit un. */
export const MISSION_BRAINS = [
  'conquer',
  'defend',
  'hold_front',
  'air_superiority',
  'air_defense',
  'deep_strike',
  'sea_control',
  'landing',
  'reserve',
] as const;
export type MissionBrain = (typeof MISSION_BRAINS)[number];

/** Cible d'une mission : province (ou région autour d'elle), nation, zone (centre + rayon), aucune. */
export const MISSION_TARGETS = ['province', 'nation', 'zone', 'none'] as const;
export type MissionTargetKind = (typeof MISSION_TARGETS)[number];

export const AGGRESSIVENESS = ['cautious', 'balanced', 'bold'] as const;
export type Aggressiveness = (typeof AGGRESSIVENESS)[number];

/**
 * Règles d'engagement : `strict` (défense seulement chez soi ou dans la zone, autorisation pour toute
 * guerre et toute frappe stratégique), `standard` (autorisation avant d'ouvrir une guerre ou de frapper
 * l'arrière ennemi), `free` (le général décide seul, guerre comprise contre la cible de la mission).
 */
export const ROE = ['strict', 'standard', 'free'] as const;
export type Roe = (typeof ROE)[number];

/** Renforts automatiques : jamais, sur autorisation du joueur, ou d'office. */
export const REINFORCE_MODES = ['off', 'ask', 'auto'] as const;
export type ReinforceMode = (typeof REINFORCE_MODES)[number];

/** Compétences d'un général (0 à 100). `audacity` : 0 = très prudent, 100 = très audacieux. */
export const GENERAL_SKILLS = [
  'offense',
  'defense',
  'logistics',
  'air',
  'naval',
  'audacity',
  'experience',
] as const;
export type GeneralSkill = (typeof GENERAL_SKILLS)[number];

const num = (d: number) => z.number().default(d);
const pos = (d: number) => z.number().min(0).default(d);

const MissionDefSchema = z.object({
  brain: z.enum(MISSION_BRAINS),
  target: z.enum(MISSION_TARGETS),
  /** Milieux attendus dans l'armée (conseil affiché, l'ordre n'est pas refusé sans eux). */
  domains: z.array(z.enum(['land', 'air', 'sea'])).default(['land']),
  /** Rayon par défaut de la zone (km) ; région autour d'une province pour Conquérir. */
  radiusKm: pos(150),
  /** Ordre d'affichage. */
  order: num(0),
  /** Une mission de durée (défendre, tenir) n'est jamais « réussie » : elle est tenue ou perdue. */
  continuous: z.boolean().default(false),
  /** Sea control : blocus des ports ennemis de la zone. */
  blockade: z.boolean().default(false),
});
export type MissionDef = z.infer<typeof MissionDefSchema>;

const DEFAULT_MISSIONS: Record<string, z.input<typeof MissionDefSchema>> = {
  conquer: {
    brain: 'conquer',
    target: 'province',
    domains: ['land', 'air'],
    radiusKm: 0,
    order: 1,
  },
  defend: {
    brain: 'defend',
    target: 'zone',
    domains: ['land', 'air'],
    radiusKm: 150,
    order: 2,
    continuous: true,
  },
  hold_front: {
    brain: 'hold_front',
    target: 'nation',
    domains: ['land'],
    radiusKm: 0,
    order: 3,
    continuous: true,
  },
  air_superiority: {
    brain: 'air_superiority',
    target: 'zone',
    domains: ['air'],
    radiusKm: 250,
    order: 4,
    continuous: true,
  },
  air_defense: {
    brain: 'air_defense',
    target: 'zone',
    domains: ['land', 'air'],
    radiusKm: 200,
    order: 5,
    continuous: true,
  },
  deep_strike: { brain: 'deep_strike', target: 'nation', domains: ['air'], radiusKm: 0, order: 6 },
  sea_control: {
    brain: 'sea_control',
    target: 'zone',
    domains: ['sea'],
    radiusKm: 300,
    order: 7,
    continuous: true,
    blockade: true,
  },
  landing: {
    brain: 'landing',
    target: 'province',
    domains: ['land', 'sea'],
    radiusKm: 0,
    order: 8,
  },
  reserve: {
    brain: 'reserve',
    target: 'zone',
    domains: ['land'],
    radiusKm: 400,
    order: 9,
    continuous: true,
  },
};

const AggrSchema = z.object({
  /** Force engagée / force ennemie connue exigée avant d'attaquer. */
  attackRatio: pos(1.5),
  /** Seuil de repli par défaut : une pile sous cette santé se replie (0 = jamais). */
  retreatAt: z.number().min(0).max(0.95).default(0.35),
  /** Poursuite au-delà de la zone (× rayon). */
  pursuit: pos(1.5),
  /** Part de l'aviation engagée en même temps (le reste en réserve). */
  airShare: z.number().min(0).max(1).default(0.75),
  /** Objectifs supplémentaires par réflexion. */
  objectives: num(0),
});

/** Effets d'un trait (additifs, sauf mentions). */
const TraitSchema = z.object({
  /** Poids au tirage. */
  weight: pos(1),
  attackRatio: num(0),
  retreatAt: num(0),
  objectives: num(0),
  sorties: num(0),
  escorts: num(0),
  /** Bonus de dégâts en attaque et de protection à l'arrêt (s'ajoutent aux bonus de compétence). */
  damage: num(0),
  armor: num(0),
  /** Autonomie et portée de ravitaillement. */
  logistics: num(0),
  /** Rassemblement avant l'assaut (départs échelonnés), même sans compétence logistique. */
  rally: z.boolean().default(false),
  /** Préférence pour les provinces à moitié encerclées (voisins amis), multiplicatif. */
  encircle: num(0),
  /** Frictions (ordres retardés) : multiplicateur. */
  friction: pos(1),
  /** Salaire : multiplicateur. */
  salary: pos(1),
  /** Gain d'expérience : multiplicateur. */
  xp: pos(1),
});
export type GeneralTraitDef = z.infer<typeof TraitSchema>;

const DEFAULT_TRAITS: Record<string, z.input<typeof TraitSchema>> = {
  encircler: { weight: 1, encircle: 0.6, objectives: 1 },
  thrifty: { weight: 1.2, attackRatio: 0.4, retreatAt: 0.15 },
  reckless: { weight: 1, attackRatio: -0.35, retreatAt: -0.15, damage: 0.02, friction: 1.3 },
  logistician: { weight: 1, logistics: 0.08, rally: true },
  airman: { weight: 1, sorties: 1, escorts: 1 },
  sailor: { weight: 0.8, escorts: 1 },
  fortifier: { weight: 1, armor: 0.03 },
  methodical: { weight: 1.2, friction: 0.5, attackRatio: 0.15 },
  blitz: { weight: 0.8, objectives: 1, attackRatio: -0.1 },
  veteran: { weight: 0.6, xp: 1.5, salary: 1.1 },
};

/** Grade (étoiles) d'après la note globale, et coût du commandement (solde + état-major). */
const RankSchema = z.object({
  /** Note globale minimale (moyenne des compétences hors audace). */
  minRating: z.number(),
  /** Coût par jour de jeu (dollars US, prix américains : × indice de coût local de la nation). */
  salaryUsdPerDay: z.number().min(0),
});

export const CommandBalanceSchema = z.object({
  enabled: z.boolean().default(true),
  /** Armées par nation. */
  maxArmies: z.number().int().min(1).default(12),
  /** Piles par armée. */
  maxPiles: z.number().int().min(1).default(120),
  /** Entrées du journal conservées par armée. */
  journalMax: z.number().int().min(5).default(40),
  missions: z.record(z.string(), MissionDefSchema).default(DEFAULT_MISSIONS),
  aggressiveness: z
    .object({ cautious: AggrSchema, balanced: AggrSchema, bold: AggrSchema })
    .default({
      cautious: { attackRatio: 2.2, retreatAt: 0.5, pursuit: 1, airShare: 0.5, objectives: 0 },
      balanced: { attackRatio: 1.5, retreatAt: 0.35, pursuit: 1.5, airShare: 0.75, objectives: 0 },
      bold: { attackRatio: 1.1, retreatAt: 0.2, pursuit: 2.2, airShare: 1, objectives: 1 },
    }),
  /** Échec d'une mission : effectifs sous cette part des effectifs du lancement. */
  failShare: z.number().min(0).max(1).default(0.25),
  /** Mission offensive sans objectif atteignable pendant ce délai : échec (heures). */
  stuckHours: pos(48),
  generals: z
    .object({
      /** Candidats proposés à la fois par nation. */
      poolSize: z.number().int().min(1).max(20).default(6),
      /** Un candidat non recruté est remplacé au bout de ce délai (jours ; 0 = jamais). */
      poolRefreshDays: pos(7),
      /** Note globale : moyenne et dispersion du tirage. */
      skillMean: num(52),
      skillSpread: pos(15),
      traitChance: z.number().min(0).max(1).default(0.55),
      secondTraitChance: z.number().min(0).max(1).default(0.25),
      /**
       * Grades : ★ brigade (~150 officiers d'état-major), ★★ division, ★★★ corps d'armée, ★★★★ armée.
       * Coût réel d'un état-major (solde, transmissions, protection), ordre de grandeur américain.
       */
      ranks: z
        .array(RankSchema)
        .min(1)
        .default([
          { minRating: 0, salaryUsdPerDay: 35_000 },
          { minRating: 50, salaryUsdPerDay: 80_000 },
          { minRating: 63, salaryUsdPerDay: 190_000 },
          { minRating: 76, salaryUsdPerDay: 400_000 },
        ]),
      /** Prime de compétence dans le grade : jusqu'à +x % en haut de la plage. */
      rankPremium: pos(0.3),
      /** Indice de coût local de la nation appliqué (ORBAT : salaires locaux). */
      useCostIndex: z.boolean().default(true),
      /** Prime d'engagement (jours de salaire, versée au recrutement). */
      signingBonusDays: pos(5),
      /** Indemnité de limogeage (jours de salaire). */
      severanceDays: pos(10),
      /** Jours de salaire impayés avant démission. */
      resignAfterUnpaidDays: pos(3),
      /** Expérience gagnée : province prise, mission réussie, jour de combat ; 1 point = +1 en expérience. */
      xpCapture: pos(2),
      xpSuccess: pos(6),
      xpCombatDay: pos(1),
      /** Progression : une compétence de la spécialité gagne 1 point tous les n points d'expérience. */
      xpPerSkill: pos(3),
      /** Bonus d'efficacité maximaux (compétence 100, expérience 100) : modestes et réalistes. */
      bonus: z.object({ damage: pos(0.05), armor: pos(0.05), logistics: pos(0.08) }).default({}),
      /** Probabilité maximale (expérience 0) qu'une réflexion soit perdue en frictions. */
      frictionMax: z.number().min(0).max(1).default(0.25),
      /** QG frappé (pile de tête) : probabilité de blessure / de mort par coup reçu, durée de convalescence. */
      hq: z
        .object({ woundChance: pos(0.04), killChance: pos(0.01), woundDays: pos(3) })
        .default({}),
      traits: z.record(z.string(), TraitSchema).default(DEFAULT_TRAITS),
    })
    .default({}),
  reinforce: z
    .object({
      /** Demande de renforts quand les effectifs passent sous cette part du lancement de la mission. */
      triggerShare: z.number().min(0).max(1).default(0.7),
      /** Piles proposées par demande. */
      maxPiles: z.number().int().min(1).default(3),
      /** Rayon de recherche des piles libres (km). */
      reachKm: pos(1500),
      /** Délai entre deux demandes (heures). */
      cooldownHours: pos(12),
    })
    .default({}),
});
export type CommandBalance = z.infer<typeof CommandBalanceSchema>;

// ——— Ordres ———

const id = z.string().max(64);
const unitIdList = z.array(z.string().max(32)).max(200);
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const MissionInputSchema = z.object({
  /** Identifiant de mission des données (balance.command.missions). */
  type: z.string().min(1).max(32),
  provinceId: id.optional(),
  nationId: id.optional(),
  at: lngLat.optional(),
  radiusKm: z.number().min(0).max(2000).optional(),
  /** Défaut : équilibrée. */
  aggr: z.enum(AGGRESSIVENESS).optional(),
  /** Défaut : standard. */
  roe: z.enum(ROE).optional(),
  /** Seuil de repli (santé d'une pile, 0 à 0,9) ; absent = défaut de l'agressivité. */
  retreatAt: z.number().min(0).max(0.9).optional(),
});
export type MissionInput = z.input<typeof MissionInputSchema>;

/** Ordres du centre de commandement (ajoutés à OrderSchema). */
export const COMMAND_ORDERS = [
  /**
   * Nouvelle armée formée de piles existantes ; en un seul ordre (assistant), avec son général
   * (candidat du vivier à recruter, ou général déjà recruté) et sa mission.
   */
  z.object({
    kind: z.literal('armyCreate'),
    name: z.string().min(1).max(40),
    unitIds: unitIdList,
    candidateId: id.optional(),
    generalId: id.optional(),
    mission: MissionInputSchema.optional(),
  }),
  z.object({
    kind: z.literal('armyEdit'),
    armyId: id,
    name: z.string().min(1).max(40).optional(),
    add: unitIdList.optional(),
    remove: unitIdList.optional(),
    reinforce: z.enum(REINFORCE_MODES).optional(),
  }),
  z.object({ kind: z.literal('armyMission'), armyId: id, mission: MissionInputSchema.nullable() }),
  z.object({ kind: z.literal('armySuspend'), armyId: id, on: z.boolean() }),
  z.object({ kind: z.literal('armyDissolve'), armyId: id }),
  /** Réponse à une demande du général (autorisation, renforts). */
  z.object({ kind: z.literal('armyAnswer'), armyId: id, requestId: id, accept: z.boolean() }),
  /** Recrute un candidat du vivier (prime d'engagement) et, si donné, lui confie une armée. */
  z.object({ kind: z.literal('generalHire'), candidateId: id, armyId: id.optional() }),
  /** Confie une armée à un général déjà recruté (null : en réserve). */
  z.object({ kind: z.literal('generalAssign'), generalId: id, armyId: id.nullable() }),
  /** Limogeage (indemnité). */
  z.object({ kind: z.literal('generalDismiss'), generalId: id }),
] as const;

// ——— Vue (PlayerView.command, propre nation seulement) ———

export type ArmyStatus =
  | 'idle' // sans mission
  | 'passive' // mission sans général
  | 'preparing' // rassemblement, préparatifs
  | 'active'
  | 'awaiting' // attend une autorisation du joueur
  | 'success'
  | 'failed'
  | 'suspended';

export interface CommandMissionView {
  type: string;
  brain: MissionBrain;
  provinceId?: ProvinceId;
  nationId?: NationId;
  at?: LngLat;
  radiusKm?: number;
  aggr: Aggressiveness;
  roe: Roe;
  retreatAt: number;
  since: GameTime;
}

export interface ArmyRequestView {
  id: string;
  kind: 'declare_war' | 'strategic_strike' | 'reinforce';
  nationId?: NationId;
  unitIds?: UnitId[];
  at: GameTime;
}

export interface ArmyJournalEntry {
  t: GameTime;
  text: LocText;
  /** info, succès, alerte. */
  tone?: 'info' | 'good' | 'warn' | 'bad';
}

export interface ArmyView {
  id: string;
  name: string;
  generalId: string | null;
  unitIds: UnitId[];
  /** Piles sous ordre manuel du joueur (le général les reprend à la fin de l'ordre). */
  manualIds: UnitId[];
  mission: CommandMissionView | null;
  status: ArmyStatus;
  reinforce: ReinforceMode;
  request: ArmyRequestView | null;
  journal: ArmyJournalEntry[];
  /** Valeur (dollars) au lancement de la mission et maintenant. */
  strength: { start: number; now: number };
  /** Objectif mesurable : fait / total (provinces prises, villes tenues…). */
  objective: { done: number; total: number } | null;
  /** Estimation de la mission en cours (rapport de force, durée, chances). */
  estimate: { ratio: number; etaHours: number | null; chance: number } | null;
  /** Objectifs en cours sur la carte (villes visées, zone). */
  aims: LngLat[];
  captures: number;
  losses: number;
  createdAt: GameTime;
}

export interface CommandGeneralView {
  id: string;
  first: string;
  last: string;
  /** Aire culturelle (portrait, consonance du nom). */
  culture: string;
  rank: number;
  skills: Record<GeneralSkill, number>;
  traits: string[];
  xp: number;
  salaryPerDay: number;
  /** Recrutement : prime d'engagement ; recruté : indemnité de limogeage. */
  hireCost: number;
  severance: number;
  status: 'candidate' | 'active' | 'wounded' | 'dead' | 'resigned';
  armyId: string | null;
  woundedUntil?: GameTime;
  /** Jours impayés (démission au-delà du seuil). */
  unpaidDays?: number;
  victories: number;
}

export interface CommandView {
  armies: ArmyView[];
  generals: CommandGeneralView[];
  candidates: CommandGeneralView[];
  /** Coût total des généraux recrutés, par jour. */
  salaryPerDay: number;
  maxArmies: number;
  maxPiles: number;
  /** Missions disponibles (données). */
  missions: Record<string, MissionDef>;
  /** Forces estimées (dollars) des nations voisines, ennemies ou visées (renseignement, sans tricher). */
  estimates: Record<NationId, number>;
}

/** Note globale d'un général (moyenne des compétences hors audace). */
export function generalRating(skills: Record<GeneralSkill, number>): number {
  let s = 0;
  let k = 0;
  for (const g of GENERAL_SKILLS) {
    if (g === 'audacity') continue;
    s += skills[g];
    k++;
  }
  return k ? s / k : 0;
}
