import { z } from 'zod';

// ——— Combat complet (phase 3) : chiffres d'équilibrage du module militaire du moteur ———

const num = (v: number) => z.number().min(0).default(v);

/**
 * Section `military` de data/balance (optionnelle) : chaque valeur a une valeur par défaut ; le moteur
 * lit `MilitaryBalanceSchema.parse(balance.military ?? {})`.
 */
export const MilitaryBalanceSchema = z.object({
  air: z
    .object({
      /** Réserve de carburant gardée pour le retour (heures). */
      reserveH: num(0.25),
      /** Remise en œuvre après l'atterrissage (heures) : plein refait, décollage interdit avant. */
      turnaroundH: num(1),
      /** Distance d'atterrissage / d'appontage autour de la base (km). */
      landingKm: num(25),
      /** Période de veille d'une patrouille : recherche d'intrus dans son rayon (minutes). */
      capScanMinutes: num(10),
      /** Distance de jonction avec un ravitailleur (km). */
      tankerMeetKm: num(40),
      /** Bonus de priorité des ravitailleurs et avions radar comme cibles. */
      highValueTargetFactor: num(3),
    })
    .default({}),
  strike: z
    .object({
      /** Une frappe aérienne vaut ce nombre de rounds de tir sur la cible. */
      airStrikeMult: num(3),
      /** Points de vie d'un bâtiment : dégâts / buildingHp = part de santé perdue. */
      buildingHp: num(150),
      /** Rayon d'effet minimal d'un impact (km). */
      minBlastKm: num(2),
      /** Autodirecteur : distance maximale de raccrochage d'une cible mobile (km). */
      homingKm: num(40),
      /** Missiles tirés par salve et par élément depuis des cellules de lancement (navires). */
      cellsSalvoPerElement: num(8),
      /** Distance à un port ami pour recharger les cellules (km). */
      portReloadKm: num(80),
      /** Multiplicateur des missiles antiradar contre la défense aérienne et les radars. */
      antiRadiationBonus: num(2),
      /** Exposition d'un sous-marin qui vient de tirer (minutes). */
      submarineExposureMinutes: num(30),
    })
    .default({}),
  intercept: z
    .object({
      /** Canaux de tir par élément et par fenêtre d'engagement (saturation). */
      channelsPerElement: num(2),
      /** Tirs au plus par missile et par engagement (tir-tir). */
      shotsPerMissile: num(2),
      /** Durée d'une fenêtre d'engagement ; ré-engagement ensuite si la salve est encore à portée (minutes). */
      reengageMinutes: num(3),
      /** Rechargement complet du magasin après ce délai sans tirer (heures). */
      reloadHours: num(12),
      /** Unités sans fiche `interceptor` qui touchent les missiles : pk = dégâts × ce facteur. */
      fallbackPkPerDamage: num(0.025),
      fallbackPkMax: num(0.5),
      fallbackMagazine: num(4),
      /** Probabilité de destruction d'un satellite par une arme antisatellite. */
      asatPk: num(0.7),
    })
    .default({}),
  nuclear: z
    .object({
      /** Rayon de destruction minimal (km). */
      minBlastKm: num(15),
      /** Anneau de dégâts : rayon × ce facteur, dégâts partiels (part des PV). */
      ringFactor: num(2.5),
      ringDamage: num(0.5),
      /** Niveau d'alerte le moins grave (5 = calme, 1 = crise) auquel une frappe nucléaire est permise. */
      maxAlertForStrike: z.number().int().min(1).max(5).default(2),
      /** Niveau d'alerte le moins grave auquel on peut autoriser l'emploi du nucléaire. */
      maxAlertForAuth: z.number().int().min(1).max(5).default(3),
      stabilityVictim: z.number().default(-30),
      stabilityStriker: z.number().default(-15),
      stabilityWorld: z.number().default(-5),
    })
    .default({}),
  /** Hausse de la tension mondiale (0..100) par fait militaire. */
  tension: z
    .object({
      war: num(6),
      strike: num(1.5),
      nuclearAuth: num(12),
      nuclear: num(60),
      battle: num(0.5),
      asat: num(8),
    })
    .default({}),
  sensors: z
    .object({
      /** Portée des radars d'une nation aveuglée par une cyberattaque (facteur). */
      blindFactor: num(0.25),
      /** Niveau d'information d'un passage de satellite : optique 3, radar 2, SIGINT 1. */
      satelliteOptical: num(3),
      satelliteRadar: num(2),
      satelliteSigint: num(1),
      defaultSwathKm: num(300),
      defaultRevisitH: num(12),
      /**
       * Portée maximale de la détection continue (paires) : au-delà, un radar ne sert qu'à l'alerte
       * (missiles balistiques) ou au balayage transhorizon (niveau « détecté », périodique).
       */
      maxPairKm: num(800),
      /** Un radar de veille dont la portée dépasse ce seuil est traité en transhorizon (km). */
      othMinRangeKm: num(2500),
      /** Période de balayage d'un radar transhorizon (minutes). */
      othScanMinutes: num(30),
      /** Portée sonar maximale déduite de la capacité ASM (naval.asw × détection), km. */
      aswMaxKm: num(120),
      /** Zone de brouillage (signal jam du renseignement) : perte de portée des radars adverses. */
      zoneJamFactor: num(0.5),
    })
    .default({}),
  /** Sites de défense (board.sites, signaux static_defense / radar_station du module eco). */
  defenses: z
    .object({
      /** Protection d'un silo (unité fixe de lanceurs), par niveau. */
      siloArmorPerLevel: num(0.3),
      /** Éléments de l'unité fixe créée par niveau de bâtiment. */
      unitsPerLevel: num(1),
    })
    .default({}),
  battle: z
    .object({
      /** Une bataille se clôt après ce délai sans tir (minutes). */
      gapMinutes: num(90),
      /** Rayon de regroupement des combats en une bataille (km). */
      radiusKm: num(150),
      maxReports: num(300),
      frameMinutes: num(5),
      maxFrames: num(60),
      maxUnitsPerFrame: num(60),
      maxShots: num(300),
      maxTimeline: num(40),
      /** Résumés envoyés dans la vue. */
      viewCount: num(20),
    })
    .default({}),
  generals: z
    .object({
      perNationMin: num(2),
      perNationMax: num(4),
      maxUnits: num(40),
      /** Bonus d'un trait (+15 %). */
      bonus: num(0.15),
      thinkMinutes: num(30),
      /** Rayon de la zone confiée (km). */
      areaKm: num(200),
    })
    .default({}),
  specialOps: z
    .object({
      baseSuccess: num(0.7),
      /** Malus par unité terrestre ennemie près de la ville. */
      defenderPenalty: num(0.12),
      minSuccess: num(0.1),
      sabotageDamage: num(0.5),
      raidMult: num(4),
      raidRadiusKm: num(15),
      /** Pertes de l'équipe en cas d'échec (part des PV). */
      failureLoss: num(0.5),
    })
    .default({}),
  blockade: z.object({ radiusKm: num(80) }).default({}),
  capture: z
    .object({
      /** Types de matériel récupérés en prenant une base ennemie. */
      maxSystems: num(2),
      /** Part des effectifs ennemis présents récupérée. */
      fraction: num(0.34),
    })
    .default({}),
  decoys: z.object({ hours: num(48), spreadKm: num(15) }).default({}),
  /** Victimes estimées par élément perdu, par catégorie (statistiques). */
  casualties: z.record(z.string(), z.number().min(0)).default({
    infantry: 600,
    tank: 4,
    ifv: 8,
    artillery: 6,
    air_defense: 6,
    strike_missile: 4,
    nuclear: 4,
    fighter: 1,
    bomber: 4,
    air_support: 3,
    helicopter: 3,
    drone: 0,
    surface_ship: 250,
    submarine: 100,
    space: 0,
    logistics: 5,
  }),
});
export type MilitaryBalance = z.infer<typeof MilitaryBalanceSchema>;

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
    /**
     * Aucun joueur humain connecté : les IA dont le territoire est à plus de ce rayon (km) de celui de
     * tout joueur humain, et qui ne sont pas en guerre avec lui, suspendent leurs décisions jusqu'au
     * retour d'un joueur. La simulation continue (constructions, mouvements, combats en cours).
     */
    dormancyRadiusKm: z.number().positive().optional(),
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
      /** Argent de départ : nombre de jours de budget (30 = un mois). */
      startingDays: z.number().min(0).default(30),
      /** Part commerciale du revenu (réduite par les sanctions et le blocus des ports). */
      tradeShare: z.number().min(0).max(1).default(0.3),
    })
    .optional(),
  /** Industrie et commerce (importations, séries, annulations, marché entre joueurs). */
  industry: z
    .object({
      /** Achat au catalogue d'un fournisseur étranger : prix × ce facteur. */
      importPriceFactor: z.number().positive().default(1.3),
      /** Délai de livraison d'une importation, ajouté au temps de fabrication (heures de jeu). */
      importDeliveryHours: z.number().min(0).default(72),
      /** Série de `count` unités : durée = buildTimeH × (1 + facteur × (count − 1)). */
      batchTimeFactor: z.number().min(0).default(0.25),
      /** Part remboursée à l'annulation d'une production ou d'une recherche commencée. */
      cancelRefund: z.number().min(0).max(1).default(0.5),
      /** Coût d'une réparation = coût de construction × dégâts × ce facteur. */
      repairCostFactor: z.number().min(0).default(0.5),
      /** Durée de vie d'une offre du marché (heures de jeu). */
      offerHours: z.number().positive().default(72),
      /** Délai d'une livraison du marché noir (heures de jeu). */
      blackMarketDeliveryHours: z.number().min(0).default(96),
    })
    .optional(),
  /** Forces de départ réelles (ORBAT) regroupées en piles. */
  startingForces: z
    .object({
      /** Taille maximale d'une pile par catégorie (ex. { "fighter": 24, "tank": 60 }). */
      stackMax: z.record(z.string(), z.number().int().min(1)).default({}),
      /** Nombre maximal de piles par nation (les piles grossissent au-delà). */
      maxStacksPerNation: z.number().int().min(1).default(150),
      /** Cible du nombre total de piles au départ (monde entier) : les piles grossissent au-delà. */
      maxStacksWorld: z.number().int().min(1).default(5000),
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
      /** Durée minimale de la mobilisation avant démobilisation (jours de jeu). */
      minDays: z.number().min(0).default(3),
    })
    .optional(),
  buildings: z
    .object({
      /** Effets par type de bâtiment (clés libres documentées par le moteur). */
      effects: z.record(z.string(), z.record(z.string(), z.number())).default({}),
      repairHours: z.number().positive().default(48),
      buildHours: z.record(z.string(), z.number()).default({}),
      buildCostUsd: z.record(z.string(), z.number()).default({}),
      /**
       * Niveaux 1 à 5 par type (façon Conflict of Nations) : coût et durée pour atteindre ce niveau, effets
       * (valeurs absolues, non cumulées) une fois le niveau atteint. Le niveau 1 reprend effects/buildHours/buildCostUsd.
       */
      levels: z
        .record(
          z.string(),
          z
            .array(
              z.object({
                level: z.number().int().min(1).max(5),
                costUsd: z.number().min(0),
                buildHours: z.number().positive(),
                effects: z.record(z.string(), z.number()).default({}),
              }),
            )
            .max(5),
        )
        .default({}),
      /** Niveau maximal d'un bâtiment (1 à 5 comme dans Conflict of Nations). */
      maxLevel: z.number().int().min(1).default(5),
      /** Coût du niveau L = buildCostUsd × levelCostGrowth^(L − 1). */
      levelCostGrowth: z.number().positive().default(1.6),
      /** Durée du niveau L = buildHours × (1 + levelTimeGrowth × (L − 1)). */
      levelTimeGrowth: z.number().min(0).default(0.25),
      /** Répartir au départ des bâtiments de ressources selon les revenus des provinces. */
      distribute: z.boolean().default(true),
    })
    .optional(),
  /** Moral des provinces (0..100) : en dessous de 50, les revenus de la province baissent. */
  morale: z
    .object({
      start: z.number().min(0).max(100).default(70),
      /** Moral d'une province conquise (occupée). */
      occupied: z.number().min(0).max(100).default(30),
      /** Retour vers la valeur de départ, par jour. */
      recoveryPerDay: z.number().min(0).default(2),
      /** Baisse pour un bâtiment détruit (× dégâts). */
      hitPenalty: z.number().min(0).default(10),
      nuclearPenalty: z.number().min(0).default(50),
      /** Baisse quotidienne en cas de pénurie de nourriture. */
      shortagePenalty: z.number().min(0).default(5),
      /** Revenu de la province × min(1, incomeFloor + moral / 100). */
      incomeFloor: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
  /** Consommation quotidienne de ressources par élément et effets des pénuries. */
  consumption: z
    .object({
      foodPerInfantry: z.number().min(0).default(0.02),
      /** Blindés, véhicules, artillerie, défense aérienne terrestre, convois. */
      oilPerVehicle: z.number().min(0).default(0.005),
      oilPerAircraft: z.number().min(0).default(0.03),
      oilPerShip: z.number().min(0).default(0.1),
      electronicsPerSpace: z.number().min(0).default(0.02),
      /** Vitesse de production × ce facteur par ressource en pénurie. */
      shortageProductionFactor: z.number().min(0).max(1).default(0.5),
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
      // ——— Réglages du module renseignement (optionnels, valeurs par défaut du moteur) ———
      /** Budget journalier par département au départ : part du budget de défense quotidien (ORBAT). */
      defaultBudgetShare: z.number().min(0).max(1).default(0.02),
      /** Budget journalier par département au départ, en dollars, si la nation n'a pas d'ORBAT. */
      defaultBudgetUsdPerDay: z.number().min(0).default(200_000),
      /** Budget de référence (dollars/jour) : à ce budget, la qualité due au budget vaut 50 %. */
      budgetRefUsdPerDay: z.number().positive().default(1_000_000),
      /** Âge (heures de jeu) au-delà duquel un rapport est signalé comme ancien. */
      staleAfterH: z.number().positive().default(24),
      /** Croissance de l'incertitude de position d'un rapport, en km par heure d'âge. */
      reportUncertaintyKmh: z.number().min(0).default(10),
      /** Rapports conservés par nation, et affichés dans la vue. */
      maxReports: z.number().int().min(1).default(80),
      viewReports: z.number().int().min(1).default(40),
      /** Période d'analyse des mouvements (rapports flash), en minutes de jeu. */
      scanEveryMin: z.number().positive().default(60),
      /** Rapport flash : nombre d'unités ennemies en mouvement à moins de flashBorderKm d'une ville. */
      flashMinUnits: z.number().int().min(1).default(6),
      flashBorderKm: z.number().positive().default(150),
      flashCooldownH: z.number().positive().default(12),
      /** Écoute d'une zone : durée, rayon par défaut et maximal, période de rafraîchissement. */
      listenHours: z.number().positive().default(12),
      listenRadiusKm: z.number().positive().default(150),
      listenMaxRadiusKm: z.number().positive().default(600),
      listenEveryMin: z.number().positive().default(30),
      /** Interception des communications d'une armée : durée. */
      interceptHours: z.number().positive().default(12),
      /** Brouillage d'une zone : durée. */
      jamHours: z.number().positive().default(6),
      /** Effets cyber : durée (heures). */
      cyberHours: z.number().positive().default(12),
      /** Leurres : durée, nombre de base, distance maximale au territoire. */
      decoyHours: z.number().positive().default(48),
      decoyCount: z.number().int().min(1).default(3),
      decoyMaxKm: z.number().positive().default(400),
      /** Chance quotidienne de base de démasquer un agent étranger (avant niveaux et budget). */
      agentDetectPerDay: z.number().min(0).max(1).default(0.05),
      /** Délai entre la capture discrète d'un agent et son arrestation publique (retournement possible). */
      caughtGraceH: z.number().positive().default(24),
      /** Dégâts d'un sabotage réussi (fraction de la santé du bâtiment), minimum et maximum. */
      sabotageDamage: z.tuple([z.number(), z.number()]).default([0.3, 0.6]),
      /** Désinformation : baisse de stabilité de la cible. */
      disinformationAmount: z.number().min(0).default(5),
      /** Hausse de tension mondiale quand une opération est démasquée. */
      exposureTension: z.number().min(0).default(2),
      /**
       * Ancienne reconnaissance d'une nation (missions lancées avant les phases, reprises de sauvegarde) :
       * provinces dont la connaissance progresse d'un niveau.
       */
      reconProvinces: z.number().int().min(1).default(6),
      /**
       * Reconnaissance d'un pays entier (recon_military / recon_economic ciblant une nation) : la mission
       * se déroule en phases ; chaque phase réussie couvre quelques provinces (capitale et grandes villes
       * d'abord, puis le reste), dont la connaissance progresse de `levels` niveaux sur l'axe de la mission.
       */
      reconNation: z
        .object({
          /** Coût, durée, réussite de base (par phase) et exposition d'une mission sur un pays entier. */
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
          /** Phases réparties sur la durée de la mission (révélation progressive). */
          waves: z.number().int().min(1).max(24).default(4),
          /** Provinces couvertes par phase réussie (avant l'effet de la qualité du service). */
          provincesPerWave: z.number().int().min(1).default(3),
          /** Niveaux de connaissance (sur 3) gagnés par province couverte. */
          levels: z.number().int().min(1).max(3).default(2),
          /** Effet de la qualité du service : provinces par phase × (1 + qualityBonus × (qualité − 0,5)). */
          qualityBonus: z.number().min(0).max(2).default(0.5),
        })
        .optional(),
      /** Âge (heures) au-delà duquel la connaissance d'une province vieillit (état des bâtiments masqué). */
      provinceStaleH: z.number().positive().default(72),
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
      // ——— Réglages fins (optionnels ; valeurs par défaut dans packages/engine/src/modules/diplo/config.ts) ———
      reputationStart: z.number().min(0).max(100).optional(),
      /** Délai avant l'entrée en guerre des alliés (défense mutuelle), heures de jeu. */
      mutualDefenseDelayHours: z.number().min(0).optional(),
      /** Durée des votes internes d'alliance, heures de jeu. */
      allianceVoteHours: z.number().positive().optional(),
      /** Délai de retrait des troupes après la paix (droit de passage temporaire), heures de jeu. */
      peaceGraceHours: z.number().min(0).optional(),
      /** Durée d'un cessez-le-feu négocié, jours de jeu. */
      ceasefireDays: z.number().positive().optional(),
      ceasefireViolationStability: z.number().min(0).optional(),
      ceasefireViolationReputation: z.number().min(0).optional(),
      aggressionReputation: z.number().min(0).optional(),
      proposalsPerNation: z.number().int().min(1).optional(),
      /** Durée d'effet des résolutions adoptées, jours de jeu, par type. */
      resolutionDays: z.record(z.string(), z.number().min(0)).optional(),
      /** Multiplicateur de revenus commerciaux sous sanctions (board.sanctions). */
      sanctionsIncomeFactor: z.number().min(0).max(1).optional(),
      sanctionsStabilityPerDay: z.number().min(0).optional(),
      condemnationStability: z.number().min(0).optional(),
      condemnationReputation: z.number().min(0).optional(),
      /** Unités de casques bleus déployées par province visée. */
      peacekeepersPerProvince: z.number().int().min(0).optional(),
      leaveAllianceStability: z.number().min(0).optional(),
      leaveAllianceReputation: z.number().min(0).optional(),
      /** Courtiser un neutre : aide de référence = argent du neutre × ce facteur. */
      courtRefShare: z.number().positive().optional(),
      /** Inclinaison à partir de laquelle un neutre IA rejoint l'alliance. */
      courtJoinLeaning: z.number().min(0).max(1).optional(),
      leaningDecayPerDay: z.number().min(0).optional(),
      /** Financement de rebelles : montant de référence = argent de la victime × ce facteur. */
      fundRebelsRefShare: z.number().positive().optional(),
      fundRebelsUnrestPerRef: z.number().min(0).optional(),
      /** Coût relatif du financement pour un prétendant d'un territoire disputé (0,5 = moitié prix). */
      claimantFundingDiscount: z.number().positive().max(1).optional(),
      mercenaryCostFactor: z.number().positive().optional(),
      mercenaryDays: z.number().positive().optional(),
      /** Système utilisé pour les rebelles, mercenaires et casques bleus (défaut : infanterie du catalogue). */
      irregularSystemId: z.string().optional(),
      newsKeep: z.number().int().min(10).optional(),
    })
    .optional(),
  stability: z
    .object({
      start: z.number().min(0).max(100).default(70),
      coupThreshold: z.number().min(0).max(100).default(15),
      revoltThreshold: z.number().min(0).max(100).default(30),
      // ——— Réglages fins (optionnels ; valeurs par défaut dans packages/engine/src/modules/diplo/config.ts) ———
      /** Sous ce seuil, la production et les revenus baissent (jusqu'à lowMinFactor à 0). */
      lowThreshold: z.number().min(0).max(100).optional(),
      lowMinFactor: z.number().min(0).max(1).optional(),
      recoveryPerDay: z.number().min(0).optional(),
      lossPerUnit: z.number().min(0).optional(),
      lossCapPerDay: z.number().min(0).optional(),
      provinceLost: z.number().min(0).optional(),
      capitalLost: z.number().min(0).optional(),
      provinceGained: z.number().min(0).optional(),
      warWearinessPerDay: z.number().min(0).optional(),
      nuclearVictim: z.number().min(0).optional(),
      nuclearUser: z.number().min(0).optional(),
      nuclearWorld: z.number().min(0).optional(),
      refugeePerDay: z.number().min(0).optional(),
      refugeeCapPerDay: z.number().min(0).optional(),
      /** Probabilité de coup d'État par jour à stabilité nulle (proportionnelle sous le seuil). */
      coupChancePerDay: z.number().min(0).max(1).optional(),
      coupResetTo: z.number().min(0).max(100).optional(),
      /** Un coup d'État contre un joueur humain fait passer sa nation à l'IA (sinon : changement de politique). */
      coupPlayerToAi: z.boolean().optional(),
      /** Probabilité de révolte par jour (province instable) à stabilité nulle. */
      revoltChancePerDay: z.number().min(0).max(1).optional(),
      /** Part des révoltes qui tournent au soulèvement armé (unités rebelles). */
      armedUprisingChance: z.number().min(0).max(1).optional(),
      rebelUnits: z.number().int().min(0).optional(),
      rebelDays: z.number().positive().optional(),
      disputedCaptureTension: z.number().min(0).optional(),
      disputedTensionDriftPerDay: z.number().min(0).optional(),
      unrestDecayPerDay: z.number().min(0).optional(),
    })
    .optional(),
  /** Combat complet (phase 3) : voir MilitaryBalanceSchema (valeurs par défaut documentées). */
  military: MilitaryBalanceSchema.optional(),
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
  /** Description de la nation (écran de sélection, ton neutre, en français). */
  description: z.string().optional(),
  /** Doctrine militaire en une ou deux phrases (écran de sélection). */
  doctrineText: z.string().optional(),
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
