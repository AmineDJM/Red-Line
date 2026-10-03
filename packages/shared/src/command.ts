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

/**
 * Commandements (armes) : chacun a son vivier de généraux (compétences de son arme), son général en
 * chef et ses forces (les piles de son arme). Chapeautés par le ministère de la Défense.
 */
export const BRANCHES = ['land', 'air', 'sea', 'ad'] as const;
export type Branch = (typeof BRANCHES)[number];

/** Arme d'un système : aviation, marine, défense sol-air (et radars au sol), sinon armée de terre. */
export function branchOfSystem(s: { movement: string; category: string }): Branch | null {
  if (s.category === 'space' || s.category === 'nuclear') return null;
  if (s.movement === 'air') return 'air';
  if (s.movement === 'sea') return 'sea';
  if (s.category === 'air_defense' || s.category === 'radar') return 'ad';
  return 'land';
}

/** Compétence maîtresse d'un commandement (classement du vivier). */
export const BRANCH_SKILL: Record<Branch, GeneralSkill> = {
  land: 'offense',
  air: 'air',
  sea: 'naval',
  ad: 'defense',
};

/**
 * Objectifs d'opération (ordre d'opération : pays cibles, objectif, généraux) : affaiblir les forces
 * (attrition), contrôle aérien total, conquête totale, décapitation (capitale), frappes stratégiques,
 * neutraliser la défense antiaérienne, blocus naval, tenir une frontière, occuper une région.
 */
export const OP_GOALS = [
  'attrition',
  'air_control',
  'conquest',
  'decapitation',
  'strategic',
  'sead',
  'blockade',
  'defend_border',
  'occupy',
] as const;
export type OpGoal = (typeof OP_GOALS)[number];

export type OpStatus =
  | 'planning'
  | 'active'
  | 'holding' // objectif de durée atteint, maintenu
  | 'awaiting'
  | 'suspended'
  | 'success'
  | 'failed';

/** Phase du planificateur : rassemblement borné, suppression, maîtrise du ciel, offensive, maintien. */
export type OpPhase = 'stage' | 'sead' | 'air' | 'offensive' | 'hold' | 'done';

/** Mesures de progression d'une opération. */
export type OpMetric =
  'forces' | 'provinces' | 'capital' | 'sams' | 'aircraft' | 'buildings' | 'ports' | 'front';

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

const OpGoalDefSchema = z.object({
  /** Ordre d'affichage. */
  order: num(0),
  /** Commandements recommandés (conseil affiché ; l'ordre n'est pas refusé sans eux). */
  branches: z.array(z.enum(BRANCHES)).default(['land']),
  /** Cible : un ou plusieurs pays, ou une liste de provinces (région). */
  target: z.enum(['nation', 'provinces']).default('nation'),
  /** Objectif de durée : une fois atteint, il est maintenu (contrôle aérien, frontière, blocus). */
  continuous: z.boolean().default(false),
  /** Seuil de réussite (part de la mesure principale). */
  success: z.number().min(0).max(1).default(1),
});
export type OpGoalDef = z.infer<typeof OpGoalDefSchema>;

const DEFAULT_GOALS: Record<OpGoal, z.input<typeof OpGoalDefSchema>> = {
  attrition: { order: 1, branches: ['air', 'land', 'sea'], success: 0.5 },
  air_control: { order: 2, branches: ['air', 'ad'], continuous: true },
  conquest: { order: 3, branches: ['land', 'air', 'ad', 'sea'] },
  decapitation: { order: 4, branches: ['land', 'air'] },
  strategic: { order: 5, branches: ['air', 'land'], success: 0.8 },
  sead: { order: 6, branches: ['air'] },
  blockade: { order: 7, branches: ['sea', 'air'], continuous: true },
  defend_border: { order: 8, branches: ['land', 'ad', 'air'], continuous: true },
  occupy: { order: 9, branches: ['land', 'air', 'ad'], target: 'provinces' },
};

const OperationsBalanceSchema = z.object({
  /** Opérations simultanées par nation. */
  maxOps: z.number().int().min(1).default(8),
  /** Généraux par opération. */
  maxCommanders: z.number().int().min(1).max(12).default(6),
  /** Rassemblement avant l'offensive : borné (heures), puis offensive quoi qu'il arrive. */
  stageHours: pos(6),
  /** Forces d'un commandement engagées d'office (part des piles libres de son arme) selon l'agressivité. */
  forceShare: z
    .object({
      cautious: z.number().min(0.05).max(1).default(0.5),
      balanced: z.number().min(0.05).max(1).default(0.75),
      bold: z.number().min(0.05).max(1).default(1),
    })
    .default({}),
  /** Piles libres prises d'office jusqu'à cette distance des cibles (km). */
  autoReachKm: pos(4000),
  /** Secteurs terrestres au plus (un par général de l'armée de terre). */
  sectors: z.number().int().min(1).max(8).default(4),
  /** Groupe d'assaut : jusqu'à cette part des piles terrestres du général. */
  groupShare: z.number().min(0.1).max(1).default(0.5),
  /** Un objectif simultané de plus par tranche de n piles terrestres. */
  pilesPerObjective: z.number().min(1).default(4),
  /** Sorties de frappe par réflexion : base + compétence aviation / perSkill, au plus une part des appareils. */
  sorties: z
    .object({ base: pos(2), perSkill: pos(25), share: z.number().min(0).max(1).default(0.6) })
    .default({}),
  /** Salves de missiles par réflexion et par général. */
  salvos: pos(3),
  /** Reconnaissance (patrouille au-dessus de la cible) relancée faute de cibles connues (heures). */
  reconHours: pos(12),
  /** Affaiblir : chasse terrestre des forces ennemies vues jusqu'à cette distance de son territoire (km). */
  huntKm: pos(150),
  /** Piles sans objectif ramenées vers la ville amie la plus avancée de leur secteur (au-delà de, km). */
  frontKm: pos(60),
  /** Alertes : pertes lourdes (part de la valeur engagée perdue en 24 h), opération enlisée (heures). */
  heavyLossShare: z.number().min(0).max(1).default(0.2),
  stuckHours: pos(36),
  /** Opération offensive sans aucun progrès pendant ce délai : échec (heures). */
  failStuckHours: pos(120),
  /** Général en chef : part de son avance (note − 50) ajoutée aux compétences des généraux de son arme. */
  chiefBonus: z.number().min(0).max(1).default(0.2),
  /** Solde du général en chef (multiplicateur). */
  chiefSalary: pos(1.5),
  /** Général blessé : son adjoint commande avec cette part des compétences. */
  deputySkill: z.number().min(0).max(1).default(0.7),
  goals: z.record(z.string(), OpGoalDefSchema).default(DEFAULT_GOALS),
});
export type OperationsBalance = z.infer<typeof OperationsBalanceSchema>;

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
  /** Réglages tactiques des généraux (distances, mémoires, délais). */
  tactics: z
    .object({
      /** Aviation ennemie vue à moins de cette distance de l'objectif ou de la zone : chasse en l'air (km). */
      airThreatKm: pos(600),
      /** Défenses antiaériennes frappées autour des objectifs (suppression, km). */
      seadKm: pos(300),
      /** Forces terrestres frappées autour des objectifs (appui aérien, km). */
      supportKm: pos(40),
      /** Contacts ennemis perdus de vue encore comptés (heures). */
      contactMemoryHours: pos(12),
      /** Province ennemie non vue : part supposée des forces publiques de la nation (débarquement). */
      blindShare: pos(0.25),
      /** Distance maximale d'où le général fait venir les piles de son armée (km). */
      reachKm: pos(5000),
      /** Remise en ligne d'une pile repliée : santé au-dessus du seuil de repli + cette marge. */
      restMargin: pos(0.25),
      /** Délais : constat « forces insuffisantes », « aucun renseignement » (heures). */
      weakNoticeHours: pos(12),
      noIntelNoticeHours: pos(24),
      /** Zone à tenir entièrement perdue : échec après ce délai (heures). */
      zoneLostHours: pos(6),
    })
    .default({}),
  /** Opérations (ordres d'opération multi-généraux). */
  operations: OperationsBalanceSchema.default({}),
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

/**
 * Général d'une opération : recruté (`generalId`) ou candidat du vivier (`candidateId`), avec ses
 * forces : une armée existante, des piles, ou d'office (piles libres de son arme, part `share`).
 */
export const OpCommanderSchema = z.object({
  generalId: id.optional(),
  candidateId: id.optional(),
  armyId: id.optional(),
  unitIds: unitIdList.optional(),
  /** Rôle (commandement) ; défaut : l'arme du général. */
  role: z.enum(BRANCHES).optional(),
  /** Forces prises d'office : part des piles libres de l'arme (défaut : selon l'agressivité). */
  share: z.number().min(0.05).max(1).optional(),
});
export type OpCommanderInput = z.input<typeof OpCommanderSchema>;

const nationList = z.array(id).max(8);
const provinceList = z.array(id).max(300);

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
  /** Général en chef d'un commandement (null : poste vacant). */
  z.object({ kind: z.literal('commandChief'), branch: z.enum(BRANCHES), generalId: id.nullable() }),
  /** Nouvelle opération : pays cibles (ou provinces), objectif, généraux et leurs forces. */
  z.object({
    kind: z.literal('campaignCreate'),
    name: z.string().max(40).optional(),
    goal: z.string().min(1).max(32),
    nations: nationList,
    provinces: provinceList.optional(),
    aggr: z.enum(AGGRESSIVENESS).optional(),
    roe: z.enum(ROE).optional(),
    retreatAt: z.number().min(0).max(0.9).optional(),
    /** Échéance facultative (heures de jeu). */
    deadlineHours: z
      .number()
      .min(1)
      .max(24 * 90)
      .optional(),
    commanders: z.array(OpCommanderSchema).min(1).max(12),
  }),
  /** Changer d'objectif, de cibles ou de paramètres (l'opération repart en préparation). */
  z.object({
    kind: z.literal('campaignEdit'),
    opId: id,
    name: z.string().min(1).max(40).optional(),
    goal: z.string().min(1).max(32).optional(),
    nations: nationList.optional(),
    provinces: provinceList.optional(),
    aggr: z.enum(AGGRESSIVENESS).optional(),
    roe: z.enum(ROE).optional(),
    deadlineHours: z
      .number()
      .min(1)
      .max(24 * 90)
      .nullable()
      .optional(),
  }),
  /** Renforcer (nouveaux généraux, forces), retirer un général, changer les rôles. */
  z.object({
    kind: z.literal('campaignForces'),
    opId: id,
    add: z.array(OpCommanderSchema).max(12).optional(),
    remove: z.array(id).max(12).optional(),
    roles: z
      .array(z.object({ armyId: id, role: z.enum(BRANCHES) }))
      .max(12)
      .optional(),
  }),
  z.object({ kind: z.literal('campaignSuspend'), opId: id, on: z.boolean() }),
  /** Annuler (ou clore) : les généraux et leurs armées sont libérés. */
  z.object({ kind: z.literal('campaignCancel'), opId: id }),
  z.object({
    kind: z.literal('campaignAnswer'),
    opId: id,
    requestId: id,
    accept: z.boolean(),
  }),
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
  /** Opération dont l'armée fait partie, et son rôle. */
  opId?: string;
  role?: Branch;
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
  /** Commandement (arme) ; absent : ancien général (déduit de ses compétences). */
  branch?: Branch;
  /** Général en chef de son commandement. */
  chief?: boolean;
  /** Opération commandée. */
  opId?: string | null;
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
  /** Opérations en cours et terminées (non closes). */
  ops?: CampaignView[];
  maxOps?: number;
  /** Objectifs d'opération disponibles (données). */
  goals?: Record<string, OpGoalDef>;
  /**
   * Commandements (armes) : chef, généraux, vivier, forces, opérations — structure lue par le
   * ministère de la Défense (commandements → chefs → généraux → opérations).
   */
  branches?: CommandBranchView[];
}

export interface CommandBranchView {
  id: Branch;
  chiefId: string | null;
  generalIds: string[];
  candidates: CommandGeneralView[];
  /** Piles de l'arme : total, libres (hors armée), éléments, valeur (dollars). */
  forces: { piles: number; free: number; elements: number; value: number };
  opIds: string[];
}

export type OpSector = 'north' | 'south' | 'east' | 'west' | 'center' | 'all';

export interface CampaignCommanderView {
  armyId: string;
  generalId: string | null;
  role: Branch;
  /** Secteur (armée de terre) : orientation par rapport à la cible, ou tout le théâtre. */
  sector: OpSector | null;
  /** Provinces de son secteur encore à prendre / au total. */
  sectorLeft: number;
  sectorTotal: number;
  aims: LngLat[];
  piles: number;
  value: number;
  status: ArmyStatus;
}

export interface CampaignView {
  id: string;
  name: string;
  goal: string;
  nations: NationId[];
  provinces?: ProvinceId[];
  status: OpStatus;
  phase: OpPhase;
  aggr: Aggressiveness;
  roe: Roe;
  deadline: GameTime | null;
  since: GameTime;
  commanders: CampaignCommanderView[];
  /** Mesures chiffrées (fait / total) ; `pct` : avancement de la mesure principale (0 à 1). */
  progress: { key: OpMetric; done: number; total: number }[];
  pct: number;
  journal: ArmyJournalEntry[];
  request: { id: string; kind: 'declare_war'; nationId: NationId } | null;
  estimate: { ratio: number; etaHours: number | null; chance: number } | null;
  stats: { strikes: number; captures: number; losses: number; kills: number };
  value: { start: number; now: number };
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
