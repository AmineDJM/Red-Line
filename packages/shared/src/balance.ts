import { z } from 'zod';

/** Chiffres d'équilibrage globaux (data/balance/*.json). Tout est réglable par l'admin. */
export const BalanceSchema = z.object({
  version: z.number().int(),
  time: z.object({
    /** Vitesses proposées à la création d'une partie. */
    speeds: z.array(z.number().positive()).default([1, 2, 4, 8, 16]),
    /** Durée d'un round de combat, en minutes de jeu. */
    combatRoundMinutes: z.number().positive(),
    /** Temps d'occupation d'une ville sans défenseur pour capturer la province, en minutes de jeu. */
    captureMinutes: z.number().positive(),
    /** Période de réflexion des IA, en minutes de jeu. */
    aiThinkMinutes: z.number().positive(),
  }),
  combat: z.object({
    /** Variance des dégâts : multiplicateur tiré dans [1 - v, 1 + v]. */
    variance: z.number().min(0).max(1),
    /** Distance de contact entre deux unités terrestres, en km. */
    groundContactKm: z.number().positive(),
    /** Bonus du défenseur retranché dans une ville. */
    defenderCityBonus: z.number().min(0),
    /** Expérience nécessaire pour les niveaux de vétérance. */
    veterancyXp: z.array(z.number()),
    /** Bonus de dégâts par niveau de vétérance. */
    veterancyDamageBonus: z.number().min(0),
  }),
  movement: z.object({
    /** Facteur de vitesse d'une unité terrestre embarquée en mer. */
    embarkedSpeedFactor: z.number().positive(),
    /** Délai d'embarquement/débarquement, en minutes de jeu. */
    embarkMinutes: z.number().min(0),
  }),
  sensors: z.object({
    /** Couverture radar de base autour de la ville de chaque province possédée, en km. */
    provinceDetectionKm: z.number().min(0),
    /** Fractions de la portée de détection pour passer « identifiée » puis « précise ». */
    identifiedAtFraction: z.number().min(0).max(1),
    preciseAtFraction: z.number().min(0).max(1),
    /** Vitesse de croissance de l'incertitude d'une position non réobservée, en km/h de jeu. */
    uncertaintyGrowthKmh: z.number().min(0),
    /** Au-delà de cet âge (minutes de jeu), un contact perdu est oublié. */
    forgetAfterMinutes: z.number().positive(),
  }),
  economy: z.object({
    startingMoney: z.number().min(0),
    startingResources: z.record(z.string(), z.number()),
    /** Multiplicateur appliqué aux revenus des provinces. */
    incomeMultiplier: z.number().min(0),
  }),
  victory: z.object({
    /** Part des provinces du monde à contrôler pour gagner (0 à 1). */
    provinceShare: z.number().min(0).max(1),
    /** Ou contrôle de toutes les capitales ennemies. */
    allEnemyCapitals: z.boolean(),
  }),
  // ——— Phases 2+ : sections optionnelles (le moteur applique des valeurs par défaut documentées) ———
  /** Monnaie : dollars US. Budget = budget de défense annuel réel (data/orbat), versé chaque jour. */
  money: z
    .object({
      currency: z.literal('USD').default('USD'),
      /** Fraction du budget annuel versée par jour de jeu (1/365 par défaut). */
      budgetPerDayFraction: z
        .number()
        .positive()
        .default(1 / 365),
      /** Multiplicateur global (accélérer les parties sans changer les prix). */
      budgetMultiplier: z.number().positive().default(1),
      /** Part du budget liée aux provinces (conquérir rapporte, perdre coûte), le reste est national. */
      provinceShare: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
  research: z
    .object({
      /** Multiplicateur de durée des recherches. */
      durationMultiplier: z.number().positive().default(1),
      maxQueue: z.number().int().min(1).default(5),
    })
    .optional(),
  licences: z
    .object({
      /** Prix d'une licence = prix unitaire × ce facteur. */
      priceFactor: z.number().positive().default(20),
      /** Remise de production sous licence. */
      productionDiscount: z.number().min(0).max(1).default(0.3),
    })
    .optional(),
  blackMarket: z
    .object({
      priceFactor: z.number().positive().default(2.5),
      detectionChance: z.number().min(0).max(1).default(0.25),
    })
    .optional(),
  logistics: z
    .object({
      /** Distance max à une province amie / dépôt pour être ravitaillé (km). */
      supplyRangeKm: z.number().positive().default(300),
      limitedEfficiency: z.number().min(0).max(1).default(0.7),
      cutEfficiency: z.number().min(0).max(1).default(0.35),
    })
    .optional(),
  mobilization: z
    .object({
      infantryPerProvince: z.number().int().min(0).default(1),
      incomePenalty: z.number().min(0).max(1).default(0.25),
      stabilityPerDay: z.number().default(-1),
    })
    .optional(),
  buildings: z
    .object({
      /** Effets par type de bâtiment (clés libres documentées par le moteur). */
      effects: z.record(z.string(), z.record(z.string(), z.number())).default({}),
      repairHours: z.number().positive().default(48),
      buildHours: z.record(z.string(), z.number()).default({}),
      buildCostUsd: z.record(z.string(), z.number()).default({}),
    })
    .optional(),
  alert: z
    .object({
      /** Seuils de « tension mondiale » pour passer aux niveaux 4, 3, 2, 1. */
      thresholds: z.array(z.number()).length(4).default([20, 45, 70, 90]),
      decayPerDay: z.number().min(0).default(5),
    })
    .optional(),
  intel: z
    .object({
      /** Notes quotidiennes par département (heure de jeu de publication). */
      dailyReportHour: z.number().int().min(0).max(23).default(7),
      reportsPerDay: z.number().int().min(1).default(1),
      ops: z
        .record(
          z.string(),
          z.object({
            money: z.number(),
            durationH: z.number(),
            baseSuccess: z.number(),
            exposure: z.number(),
          }),
        )
        .default({}),
    })
    .optional(),
  diplomacy: z
    .object({
      councilEveryDays: z.number().positive().default(30),
      /** Fenêtre de vote en heures RÉELLES (convertie avec la vitesse de la partie). */
      voteWindowRealHours: z.number().positive().default(12),
      majority: z.enum(['simple', 'two_thirds']).default('simple'),
      veto: z.boolean().default(true),
      rotatingSeats: z.number().int().min(0).default(3),
      leaderInactiveDays: z.number().positive().default(3),
    })
    .optional(),
  stability: z
    .object({
      start: z.number().min(0).max(100).default(70),
      coupThreshold: z.number().min(0).max(100).default(15),
      revoltThreshold: z.number().min(0).max(100).default(30),
    })
    .optional(),
  /** Armée de départ par nation jouable, posée autour de la capitale (repli si pas d'ORBAT). */
  startingArmy: z.array(z.object({ systemId: z.string(), count: z.number().int().min(1) })),
  /** Armée de départ réduite pour les nations non jouées (IA neutres). */
  garrisonArmy: z.array(z.object({ systemId: z.string(), count: z.number().int().min(1) })),
});
export type Balance = z.infer<typeof BalanceSchema>;

// ——— ORBAT : budget et arsenal réels estimés par nation (data/orbat/<nation>.json) ———

export const OrbatSchema = z.object({
  nationId: z.string(),
  /** Année de référence (ex. 2025 ; 1985 pour la Guerre froide). */
  year: z.number().int(),
  doctrine: z.enum(['us', 'ru', 'cn', 'eu', 'other']),
  /** Budget de défense annuel en dollars US courants. */
  defenseBudgetUsd: z.number().min(0),
  /** Effectifs militaires actifs (information, conversion en infanterie). */
  activePersonnel: z.number().int().min(0).optional(),
  /** Inventaire en service estimé : identifiants de data/catalog-ids.json. */
  inventory: z.array(
    z.object({
      systemId: z.string(),
      count: z.number().int().min(0),
      /** Modèle réel détaillé (variante), pour l'affichage. */
      variant: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  /** Nœuds de recherche déjà acquis en début de partie (niveau technologique réel). */
  research: z.array(z.string()).default([]),
  /** Licences de production déjà détenues. */
  licences: z.array(z.string()).default([]),
  /** Sources et niveau de confiance de l'estimation. */
  sources: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type Orbat = z.infer<typeof OrbatSchema>;

// ——— Scénarios ———

export const ScenarioFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  playableNations: z.union([z.literal('all'), z.array(z.string())]),
  /** Nations présentes (scénario régional) ; absent = toutes. */
  nationIds: z.array(z.string()).optional(),
  /** Année de référence : filtre le catalogue (era) et la recherche (eraYear). */
  year: z.number().int().default(2025),
  /** Jeu d'ORBAT à charger : data/orbat/<set>/ (ex. "2025", "1985"). */
  orbatSet: z.string().default('2025'),
  /** Centre et zoom initiaux de la carte. */
  camera: z.object({ center: z.tuple([z.number(), z.number()]), zoom: z.number() }).optional(),
  balanceOverrides: z.record(z.string(), z.unknown()).optional(),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;
