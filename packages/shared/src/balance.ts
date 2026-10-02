import { z } from 'zod';
import { CATEGORIES, RESOURCES } from './catalog.js';
import { BUILDING_TYPES } from './map.js';
import { StacksBalanceSchema } from './stacks.js';
import { DOMESTIC_POLICIES, DomesticPolicyEffectsSchema } from './domestic.js';

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
      /** Interception (ordre d'attaque d'un aéronef contre une cible aérienne) : rayon de veille (km). */
      interceptRadiusKm: num(100),
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
      /**
       * Ordre d'attaque d'une pile de munitions contre une unité : missiles tirés = ce facteur × le
       * nombre nécessaire pour détruire la cible (au moins 1, au plus la pile).
       */
      attackSalvoFactor: num(1.5),
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
  /**
   * Défense antiaérienne détaillée (systèmes dont la fiche porte `interceptor.envelopes`, voir
   * docs/defense-aerienne.md) : priorités, doctrine de tir par défaut, dégradation de la probabilité
   * en limite d'enveloppe, réengagement des aéronefs, placement par l'IA.
   */
  airDefense: z
    .object({
      /** Priorité de tir par catégorie (plus grand = engagé d'abord). */
      priority: z
        .object({
          hypersonic: num(6),
          ballistic_missile: num(5),
          cruise_missile: num(4),
          aircraft: num(3),
          helicopter: num(2),
          drone: num(1.5),
        })
        .default({}),
      /** Menace qui vise un point de la bulle de la batterie (ce qu'elle protège) : priorité × ce facteur. */
      protectFactor: num(2),
      /** Intercepteurs par cible quand la fiche ne le précise pas (doctrine). */
      shots: z
        .object({
          hypersonic: num(2),
          ballistic_missile: num(2),
          cruise_missile: num(2),
          aircraft: num(2),
          helicopter: num(1),
          drone: num(1),
        })
        .default({}),
      /** Délai de réaction par défaut (secondes). */
      reactionS: num(15),
      /** Part de la portée maximale où la probabilité est pleine ; au-delà elle décroît. */
      fullPkShare: num(0.6),
      /** Facteur de probabilité à la portée maximale (décroissance linéaire depuis fullPkShare). */
      farPkFactor: num(0.5),
      /** Furtivité d'un aéronef : pk × (1 − furtivité × (1 − détection furtive du radar) × ce facteur). */
      stealthPkFactor: num(1),
      /** Réengagement d'un avion, hélicoptère ou drone après un tir (minutes). */
      aircraftReengageMinutes: num(5),
      /**
       * Chasseurs (sans fiche `interceptor`) contre missiles de croisière et drones : pk = dégâts
       * « missile » × ce facteur (plafonné), missiles air-air disponibles par appareil.
       */
      fighterPkPerDamage: num(0.08),
      fighterPkMax: num(0.6),
      fighterMagazine: num(4),
      /** IA : placement de la défense antiaérienne (capitale, bases aériennes, front). */
      ai: z
        .object({
          /** Batteries voulues à la capitale, sur chaque base aérienne, dans chaque ville du front. */
          capital: num(2),
          airBase: num(1),
          front: num(1),
          /** Ville du front : ville à elle à moins de cette distance d'un ennemi vu (km). */
          frontKm: num(250),
          /** Une batterie couvre un point si elle est à moins de cette part de sa portée principale. */
          coverShare: num(0.5),
          /** Distance maximale d'un redéploiement (km). */
          reachKm: num(1200),
          /** Redéploiements au plus par réflexion ; une réflexion sur `everyThinks`. */
          movesPerThink: num(3),
          everyThinks: num(2),
          /** Batterie à moins de cette part de son magasin : relevée du front (stocks). */
          minAmmoShare: num(0.3),
        })
        .default({}),
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
      /** Bataille en cours : derniers tirs joints au résumé de la vue (affichage des combats). */
      liveShots: num(16),
      /** Ancienneté maximale de ces tirs (minutes de jeu). */
      liveMinutes: num(20),
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
  /**
   * Rapport après action (rapports de bataille) : conversion des faits simulés (éléments détruits,
   * dégâts, rounds de tir) en chiffres de rapport militaire. Personnels par élément : `casualties`.
   */
  report: z
    .object({
      /** Répartition des personnels d'un élément détruit, par milieu : tués, blessés (le reste : disparus). */
      killedShare: z.object({ land: num(0.25), air: num(0.35), sea: num(0.3) }).default({}),
      woundedShare: z.object({ land: num(0.55), air: num(0.3), sea: num(0.45) }).default({}),
      /** Personnels blessés par élément endommagé (part de l'équipage). */
      damagedWoundedShare: num(0.3),
      /** Un élément est compté « endommagé » s'il a encaissé cette part de ses points de vie sans être détruit. */
      damagedHpShare: num(0.25),
      /** Disparus devenus prisonniers quand le camp perd la province des combats. */
      prisonerShare: num(0.6),
      /** Munitions principales (obus, missiles, bombes) tirées par élément et par round de tir, par catégorie. */
      munitionsPerRound: z.record(z.string(), z.number().min(0)).default({
        infantry: 4,
        tank: 2,
        ifv: 6,
        artillery: 8,
        air_defense: 2,
        strike_missile: 1,
        fighter: 2,
        bomber: 6,
        air_support: 4,
        helicopter: 4,
        drone: 2,
        surface_ship: 4,
        submarine: 1,
        logistics: 0,
      }),
      /** Pas de la courbe des pertes et du découpage en phases (minutes). */
      bucketMinutes: num(30),
      /** Points de la courbe des pertes conservés au plus (les plus anciens sont fusionnés). */
      maxPoints: num(32),
      maxPhases: num(10),
      /** Fourchette des estimations du camp adverse selon le niveau d'identification (± part). */
      spreadIdentified: num(0.25),
      spreadDetected: num(0.6),
      /** Pertes adverses confirmées par ses propres tirs : fourchette (sous-estimation possible). */
      killSpread: num(0.3),
    })
    .default({}),
});
export type MilitaryBalance = z.infer<typeof MilitaryBalanceSchema>;

// ——— Intelligence artificielle : heuristiques de décision des nations tenues par l'IA ———

interface AiLevelDefaults {
  warRatio: number;
  casusBelliWaiverRatio: number;
  maxWars: number;
  warChancePerDay: number;
  warChanceHumanPerDay: number;
  warmupDays: number;
  caution: number;
  peaceRatio: number;
  acceptRatio: number;
  humanTargetBias: number;
  alliances: boolean;
  proxy: boolean;
  council: boolean;
  capitalGarrison: number;
  defendCities: boolean;
  counterattack: boolean;
  offensive: 'none' | 'started' | 'all';
  maxCounterPerThink: number;
  maxOffensivePerThink: number;
  groupMax: number;
  attackRatio: number;
  pathBudget: number;
  enemyCapitalBonus: number;
  salvosPerThink: number;
  salvoSize: number;
  blockades: number;
  airStrikesPerThink: number;
  caps: number;
  supportStrikes: boolean;
  adaptiveProduction: boolean;
  reconChance: number;
  humanWarFromDays: number;
  humanWarRatio: number;
  humanMotiveFactor: number;
  satisfiedPeaceDays: number;
  warGoalShare: number;
  humanPrepHours: number;
  ultimatumHours: number;
  humanAggressors: number;
  coalition: boolean;
  humanCooldownDays: number;
  stageUnits: number;
  rally: boolean;
  amphibious: boolean;
  escortShips: number;
  airEscorts: number;
  sead: boolean;
  deepStrikesPerThink: number;
}

/** Profil d'un niveau de difficulté (stratégie, tactique, combat, production, renseignement). */
const aiLevel = (d: AiLevelDefaults) =>
  z
    .object({
      // ——— Stratégie : guerres, paix, alliances ———
      /** Rapport de force minimal (estimé, sans tricher) pour déclarer une guerre. */
      warRatio: num(d.warRatio),
      /** Sans motif public (casus belli), il faut au moins cette supériorité ; 0 = jamais sans motif. */
      casusBelliWaiverRatio: num(d.casusBelliWaiverRatio),
      /** Guerres simultanées voulues au plus (0 : jamais d'agression). */
      maxWars: num(d.maxWars),
      /**
       * Probabilité par jour de passer à l'acte quand une cible convient (IA visée : déclaration de
       * guerre ; joueur humain visé : début des préparatifs, puis ultimatum et guerre) : indépendante de
       * la fréquence de réflexion, elle ne s'accumule pas avec l'agitation.
       */
      warChancePerDay: z.number().min(0).max(1).default(d.warChancePerDay),
      warChanceHumanPerDay: z.number().min(0).max(1).default(d.warChanceHumanPerDay),
      /** Pas d'agression avant ce délai depuis le début de la partie (jours). */
      warmupDays: num(d.warmupDays),
      /** Majoration de la force supposée de l'adversaire. */
      caution: num(d.caution),
      /** Sous ce rapport (et avec des pertes), elle demande la paix. */
      peaceRatio: num(d.peaceRatio),
      /** Sous ce rapport, elle accepte une proposition de paix. */
      acceptRatio: num(d.acceptRatio),
      /** Multiplicateur du rapport de force contre un joueur humain (> 1 : cible préférée). */
      humanTargetBias: num(d.humanTargetBias),
      alliances: z.boolean().default(d.alliances),
      /** Guerres par procuration : courtiser des neutres, financer des rebelles. */
      proxy: z.boolean().default(d.proxy),
      council: z.boolean().default(d.council),
      // ——— Tactique terrestre ———
      /** Unités terrestres gardées en permanence dans la capitale en guerre. */
      capitalGarrison: num(d.capitalGarrison),
      /** Renforcer les villes menacées par des forces ennemies vues. */
      defendCities: z.boolean().default(d.defendCities),
      /** Reprendre les provinces perdues voisines. */
      counterattack: z.boolean().default(d.counterattack),
      /** Offensives : aucune, seulement dans les guerres qu'elle a déclarées, ou contre tout ennemi. */
      offensive: z.enum(['none', 'started', 'all']).default(d.offensive),
      maxCounterPerThink: num(d.maxCounterPerThink),
      maxOffensivePerThink: num(d.maxOffensivePerThink),
      /** Unités envoyées ensemble au plus (concentration des forces). */
      groupMax: num(d.groupMax),
      /** Force engagée / force ennemie connue près de l'objectif (sinon pas d'attaque). */
      attackRatio: num(d.attackRatio),
      /** Calculs de trajet par réflexion tactique (budget de calcul). */
      pathBudget: num(d.pathBudget),
      /** Attrait d'une capitale ennemie comme objectif (multiplicateur de score). */
      enemyCapitalBonus: num(d.enemyCapitalBonus),
      // ——— Combat aérien et missiles ———
      salvosPerThink: num(d.salvosPerThink),
      /** Munitions tirées par salve (les stocks sont consommés). */
      salvoSize: num(d.salvoSize),
      /** Blocus de ports ennemis tenus à la fois au plus (navires de surface libres). */
      blockades: num(d.blockades),
      airStrikesPerThink: num(d.airStrikesPerThink),
      /** Patrouilles de chasse au-dessus de la capitale en cas de menace aérienne. */
      caps: num(d.caps),
      /** Frappes aériennes d'appui sur les défenseurs des objectifs de ses offensives. */
      supportStrikes: z.boolean().default(d.supportStrikes),
      // ——— Production et renseignement ———
      /** Production adaptée aux forces ennemies observées (sinon : meilleur rapport valeur / prix). */
      adaptiveProduction: z.boolean().default(d.adaptiveProduction),
      /** Probabilité quotidienne d'une reconnaissance militaire de l'ennemi en guerre. */
      reconChance: z.number().min(0).max(1).default(d.reconChance),
      // ——— Menace contre un joueur humain (préparatifs, ultimatum, guerre) ———
      /** Pas de préparatifs contre un joueur humain avant ce jour de partie. */
      humanWarFromDays: num(d.humanWarFromDays),
      /**
       * Rapport de force estimé (sans tricher) exigé pour menacer un joueur humain voisin ; aucun motif
       * public n'est exigé (voisin opportuniste). La probabilité quotidienne de lancer les préparatifs
       * est `warChanceHumanPerDay`.
       */
      humanWarRatio: num(d.humanWarRatio),
      /**
       * Sans motif (territoire revendiqué, revanche, allié attaqué, paria, ou opportunité : la cible est
       * déjà en guerre ou instable), le rapport exigé est multiplié par ce facteur ; 0 = jamais sans motif.
       */
      humanMotiveFactor: num(d.humanMotiveFactor),
      /**
       * Guerre limitée : agresseur qui tient des provinces adverses depuis ce délai (jours) propose la
       * paix (il garde ses gains) et accepte celle qu'on lui propose ; 0 = jamais (va jusqu'au bout).
       */
      satisfiedPeaceDays: num(d.satisfiedPeaceDays),
      /**
       * But de guerre limité : agresseur qui tient cette part des provinces d'origine de sa cible arrête
       * ses offensives contre elle (il défend ses gains et propose la paix) ; 1 = jusqu'au bout.
       */
      warGoalShare: num(d.warGoalShare),
      /** Durée des préparatifs (troupes massées à la frontière, plan connu du renseignement), heures. */
      humanPrepHours: num(d.humanPrepHours),
      /** Délai de l'ultimatum public avant la déclaration de guerre (heures). */
      ultimatumHours: num(d.ultimatumHours),
      /** Nations IA menaçant ou attaquant le même joueur humain à la fois, au plus. */
      humanAggressors: num(d.humanAggressors),
      /** Coalition : les forces des autres agresseurs du même joueur comptent dans le rapport de force. */
      coalition: z.boolean().default(d.coalition),
      /** Après une menace abandonnée ou une paix avec ce joueur : pas de nouvelle menace avant (jours). */
      humanCooldownDays: num(d.humanCooldownDays),
      /** Unités massées à la frontière pendant les préparatifs. */
      stageUnits: num(d.stageUnits),
      // ——— Opérations ———
      /** Point de rassemblement avant une offensive dont les unités arriveraient trop étalées. */
      rally: z.boolean().default(d.rally),
      /** Débarquements amphibies sur les provinces ennemies accessibles par la mer. */
      amphibious: z.boolean().default(d.amphibious),
      /** Navires d'escorte envoyés tenir la zone de débarquement. */
      escortShips: num(d.escortShips),
      /** Chasseurs d'escorte (patrouille sur l'objectif) par frappe aérienne hors de son territoire. */
      airEscorts: num(d.airEscorts),
      /** Suppression des défenses antiaériennes identifiées avant les frappes profondes. */
      sead: z.boolean().default(d.sead),
      /** Frappes profondes par réflexion (installations ennemies révélées par le renseignement). */
      deepStrikesPerThink: num(d.deepStrikesPerThink),
    })
    .default({});

// ——— Monde vivant : guerres entre IA (rivalités, opportunisme, fin des guerres) ———

interface AiWorldLevelDefaults {
  fromDays: number;
  maxWars: number;
  maxActiveWars: number;
  rivalryChancePerDay: number;
  rivalryRatio: number;
  opportunismChancePerDay: number;
  opportunismRatio: number;
  warGoalShare: number;
  satisfiedPeaceDays: number;
  capitulationShare: number;
  capitulationMinDays: number;
  rematchDays: number;
  stalemateDays: number;
}

/** Rythme du monde pour un niveau de difficulté (guerres que les IA se font entre elles). */
const aiWorldLevel = (d: AiWorldLevelDefaults) =>
  z
    .object({
      /** Pas de guerre entre IA avant ce jour de partie. */
      fromDays: num(d.fromDays),
      /** Guerres entre IA qu'une même nation lance et mène à la fois, au plus (0 : jamais). */
      maxWars: num(d.maxWars),
      /**
       * Guerres entre IA en cours dans le monde au plus (multiplié par l'intensité) : au-delà, aucune
       * nouvelle agression entre IA (vraisemblance et coût de calcul). Les guerres d'alliance ne sont
       * pas bloquées.
       */
      maxActiveWars: num(d.maxActiveWars),
      /**
       * Probabilité par jour qu'une rivalité de poids 1 dégénère en guerre (multipliée par le poids de
       * la rivalité et par l'intensité), si le rapport de force estimé le permet.
       */
      rivalryChancePerDay: z.number().min(0).max(1).default(d.rivalryChancePerDay),
      /** Rapport de force estimé (sans tricher) exigé pour attaquer un rival historique. */
      rivalryRatio: num(d.rivalryRatio),
      /**
       * Probabilité par jour d'attaquer un voisin affaibli (en guerre et en train de perdre, instable,
       * capitale perdue), multipliée par l'intensité et réduite par la retenue de son bloc.
       */
      opportunismChancePerDay: z.number().min(0).max(1).default(d.opportunismChancePerDay),
      /** Rapport de force estimé exigé pour attaquer un voisin affaibli. */
      opportunismRatio: num(d.opportunismRatio),
      /** Guerre entre IA : part des provinces de la cible au-delà de laquelle l'agresseur s'arrête et propose la paix. */
      warGoalShare: num(d.warGoalShare),
      /** Guerre entre IA : l'agresseur qui tient des gains depuis ce délai (jours) propose la paix et les garde. */
      satisfiedPeaceDays: num(d.satisfiedPeaceDays),
      /** Capitulation : une IA qui a perdu sa capitale ou cette part de ses provinces accepte la paix. */
      capitulationShare: num(d.capitulationShare),
      /** Capitulation par perte de territoire : pas avant ce délai de guerre (jours ; la chute de la capitale suffit toujours). */
      capitulationMinDays: num(d.capitulationMinDays),
      /** Après une paix, pas de nouvelle guerre entre IA entre les deux mêmes nations avant ce délai (jours). */
      rematchDays: num(d.rematchDays),
      /** Guerre entre IA enlisée (aucune province n'a changé de main depuis ce délai, jours) : paix au statu quo. */
      stalemateDays: num(d.stalemateDays),
    })
    .default({});

/**
 * Section `ai.world` : le monde des parties solo (guerres que les IA se font entre elles). Les rivalités
 * et les blocs sont des données (data/balance), pas du code.
 */
function AiWorldSchema() {
  return z
    .object({
      /** Intensité du monde : multiplie les probabilités de guerre entre IA et le plafond de guerres (0 : monde figé). */
      intensity: z.number().min(0).max(5).default(1),
      levels: z
        .object({
          easy: aiWorldLevel({
            fromDays: 5,
            maxWars: 1,
            maxActiveWars: 3,
            rivalryChancePerDay: 0.006,
            rivalryRatio: 1.8,
            opportunismChancePerDay: 0,
            opportunismRatio: 3,
            warGoalShare: 0.2,
            satisfiedPeaceDays: 3,
            capitulationShare: 0.3,
            capitulationMinDays: 2,
            rematchDays: 20,
            stalemateDays: 4,
          }),
          normal: aiWorldLevel({
            fromDays: 2,
            maxWars: 1,
            maxActiveWars: 6,
            rivalryChancePerDay: 0.03,
            rivalryRatio: 1.3,
            opportunismChancePerDay: 0.01,
            opportunismRatio: 2,
            warGoalShare: 0.34,
            satisfiedPeaceDays: 5,
            capitulationShare: 0.5,
            capitulationMinDays: 3,
            rematchDays: 10,
            stalemateDays: 6,
          }),
          hard: aiWorldLevel({
            fromDays: 1,
            maxWars: 2,
            maxActiveWars: 10,
            rivalryChancePerDay: 0.035,
            rivalryRatio: 1.15,
            opportunismChancePerDay: 0.02,
            opportunismRatio: 1.6,
            warGoalShare: 0.5,
            satisfiedPeaceDays: 7,
            capitulationShare: 0.5,
            capitulationMinDays: 3,
            rematchDays: 6,
            stalemateDays: 9,
          }),
        })
        .default({}),
      /** Un rival non voisin (frappes à distance, débarquement) est visé si sa capitale est à cette distance (km). */
      rivalReachKm: num(2500),
      /** Voisin « affaibli » : stabilité publique sous ce seuil. */
      weakStability: num(25),
      /**
       * Défense mutuelle d'un bloc : un membre IA voisin entre en guerre contre l'agresseur IA d'un autre
       * membre si leurs forces réunies (estimées) pèsent au moins cette part de celles de l'agresseur.
       */
      blocDefenseRatio: num(0.6),
      /** Défense mutuelle d'un bloc : seulement pendant les premiers jours de la guerre (jours). */
      blocDefenseDays: num(3),
      /**
       * Guerres sans motif (niveau difficile, `casusBelliWaiverRatio`) : permises seulement aux nations
       * dont la retenue de bloc ne dépasse pas ce seuil.
       */
      waiverMaxRestraint: z.number().min(0).max(1).default(0.3),
      /**
       * Rivalités et revendications historiques entre nations : poids (0 à 1) de la probabilité de
       * guerre, motif public invoqué (dépêche). Le déclencheur est réglable (`initiator`).
       */
      rivalries: z
        .array(
          z.object({
            a: z.string(),
            b: z.string(),
            weight: z.number().min(0).max(1).default(0.5),
            motive: z.string().default(''),
            /** Qui peut déclencher la guerre : l'un ou l'autre (both), seulement `a`, seulement `b`. */
            initiator: z.enum(['both', 'a', 'b']).default('both'),
          }),
        )
        .default([]),
      /**
       * Blocs politiques (alliances réelles, unions régionales) : jamais de guerre de choix entre
       * membres (sauf rivalité déclarée) ; la retenue (0 à 1) réduit les guerres opportunistes ou sans
       * motif de ses membres contre les autres.
       */
      blocs: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().default(''),
            members: z.array(z.string()),
            restraint: z.number().min(0).max(1).default(1),
            /** Défense mutuelle : les membres IA voisins secourent un membre attaqué par une IA. */
            mutualDefense: z.boolean().default(false),
          }),
        )
        .default([]),
    })
    .default({});
}

/**
 * Section `ai` de data/balance (optionnelle) : chaque valeur a une valeur par défaut ; le moteur lit
 * `AiBalanceSchema.parse(balance.ai ?? {})`. Ce sont des heuristiques de décision, pas des règles :
 * l'IA joue avec les mêmes ordres et le même brouillard de guerre que les joueurs.
 */
export const AiBalanceSchema = z.object({
  levels: z
    .object({
      easy: aiLevel({
        warRatio: 99,
        casusBelliWaiverRatio: 0,
        maxWars: 0,
        warChancePerDay: 0,
        warChanceHumanPerDay: 0.08,
        warmupDays: 999,
        caution: 1.5,
        peaceRatio: 1.2,
        acceptRatio: 3,
        humanTargetBias: 1,
        alliances: false,
        proxy: false,
        council: false,
        capitalGarrison: 1,
        defendCities: false,
        counterattack: false,
        offensive: 'none',
        maxCounterPerThink: 0,
        maxOffensivePerThink: 0,
        groupMax: 2,
        attackRatio: 1,
        pathBudget: 4,
        enemyCapitalBonus: 1,
        salvosPerThink: 0,
        salvoSize: 2,
        blockades: 0,
        airStrikesPerThink: 0,
        caps: 1,
        supportStrikes: false,
        adaptiveProduction: false,
        reconChance: 0.2,
        humanWarFromDays: 10,
        humanWarRatio: 3,
        humanMotiveFactor: 0,
        satisfiedPeaceDays: 3,
        warGoalShare: 0.2,
        humanPrepHours: 72,
        ultimatumHours: 24,
        humanAggressors: 1,
        coalition: false,
        humanCooldownDays: 12,
        stageUnits: 2,
        rally: false,
        amphibious: false,
        escortShips: 0,
        airEscorts: 0,
        sead: false,
        deepStrikesPerThink: 0,
      }),
      normal: aiLevel({
        warRatio: 2,
        casusBelliWaiverRatio: 0,
        maxWars: 1,
        warChancePerDay: 0.1,
        warChanceHumanPerDay: 0.2,
        warmupDays: 7,
        caution: 1.2,
        peaceRatio: 0.7,
        acceptRatio: 1.3,
        humanTargetBias: 1,
        alliances: true,
        proxy: true,
        council: true,
        capitalGarrison: 2,
        defendCities: true,
        counterattack: true,
        offensive: 'started',
        maxCounterPerThink: 2,
        maxOffensivePerThink: 1,
        groupMax: 4,
        attackRatio: 1.5,
        pathBudget: 8,
        enemyCapitalBonus: 1.5,
        salvosPerThink: 1,
        salvoSize: 4,
        blockades: 0,
        airStrikesPerThink: 1,
        caps: 1,
        supportStrikes: true,
        adaptiveProduction: true,
        reconChance: 0.6,
        humanWarFromDays: 3,
        humanWarRatio: 1.6,
        humanMotiveFactor: 1.5,
        satisfiedPeaceDays: 5,
        warGoalShare: 0.34,
        humanPrepHours: 36,
        ultimatumHours: 24,
        humanAggressors: 1,
        coalition: false,
        humanCooldownDays: 6,
        stageUnits: 6,
        rally: true,
        amphibious: true,
        escortShips: 2,
        airEscorts: 1,
        sead: true,
        deepStrikesPerThink: 1,
      }),
      hard: aiLevel({
        warRatio: 2,
        casusBelliWaiverRatio: 5,
        maxWars: 2,
        warChancePerDay: 0.01,
        warChanceHumanPerDay: 0.35,
        warmupDays: 3,
        caution: 1,
        peaceRatio: 0.5,
        acceptRatio: 1,
        humanTargetBias: 1.25,
        alliances: true,
        proxy: true,
        council: true,
        capitalGarrison: 3,
        defendCities: true,
        counterattack: true,
        offensive: 'all',
        maxCounterPerThink: 3,
        maxOffensivePerThink: 2,
        groupMax: 6,
        attackRatio: 2,
        pathBudget: 12,
        enemyCapitalBonus: 2.5,
        salvosPerThink: 2,
        salvoSize: 8,
        blockades: 1,
        airStrikesPerThink: 2,
        caps: 2,
        supportStrikes: true,
        adaptiveProduction: true,
        reconChance: 0.9,
        humanWarFromDays: 2,
        humanWarRatio: 1.3,
        humanMotiveFactor: 1,
        satisfiedPeaceDays: 0,
        warGoalShare: 1,
        humanPrepHours: 24,
        ultimatumHours: 12,
        humanAggressors: 2,
        coalition: true,
        humanCooldownDays: 3,
        stageUnits: 10,
        rally: true,
        amphibious: true,
        escortShips: 3,
        airEscorts: 2,
        sead: true,
        deepStrikesPerThink: 2,
      }),
    })
    .default({}),
  tactical: z
    .object({
      /** Distance maximale d'intervention défensive (km). */
      defendReachKm: num(1500),
      /** Distance maximale entre une unité et l'objectif d'une offensive ou contre-attaque (km). */
      attackReachKm: num(2500),
      /** Rayon autour d'une ville dans lequel une force ennemie la menace (km). */
      threatRadiusKm: num(150),
      /** Rayon autour d'une ville où l'on compte ses défenseurs et la force ennemie qui la tient (km). */
      cityRadiusKm: num(25),
      /** Distance maximale des renforts envoyés vers une ville menacée (km). */
      reinforceReachKm: num(800),
      /** Villes menacées renforcées par réflexion. */
      maxReinforcePerThink: num(2),
      /** Patrouille de chasse au-dessus de la capitale si un aéronef ennemi est vu à cette distance (km). */
      capAlertKm: num(600),
      capRadiusKm: num(250),
      /** Contacts ennemis perdus de vue retenus comme menace pendant ce délai (heures). */
      contactMemoryHours: num(12),
      /** Une unité lancée dans une offensive n'est pas rappelée en renfort pendant ce délai (heures). */
      commitHours: num(8),
      /** Délai avant de retenter une capture sans chemin praticable (heures de jeu). */
      captureRetryHours: num(6),
      /** Plafond d'unités en paix, par province possédée, plus une base. */
      peaceUnitsPerProvince: num(0.5),
      peaceUnitsBase: num(2),
      /** Plafond d'unités en guerre. */
      warUnitsPerProvince: num(1.5),
      warUnitsBase: num(6),
      /** Productions simultanées maximales (paix / guerre). */
      maxQueuePeace: num(1),
      maxQueueWar: num(2),
      /** Débarquement : distance maximale entre sa ville côtière d'embarquement et la ville visée (km). */
      amphibiousReachKm: num(700),
      /** Débarquement : force exigée multipliée par ce facteur (unités sans défense pendant la traversée). */
      amphibiousRatio: num(1.5),
      /** Escorte « sur zone » : navire à moins de cette distance du point de débarquement (km). */
      escortOnStationKm: num(120),
      /** Pas de traversée sans escorte si un navire ennemi identifié est à cette distance du débarquement (km). */
      seaControlKm: num(300),
      /** Rassemblement : écart des heures d'arrivée au-delà duquel le groupe se regroupe d'abord (heures). */
      rallySpreadHours: num(6),
      /** Rassemblement : une unité est « au point » à cette distance (km). */
      rallyRadiusKm: num(40),
      /** Rassemblement : attente maximale avant de partir avec les unités arrivées (heures). */
      rallyMaxHours: num(18),
      /** Départs échelonnés depuis le point de rassemblement (les plus lents d'abord) pour arriver ensemble. */
      staggerDepartures: z.boolean().default(true),
      /** Frappes profondes : distance maximale de l'installation visée à son territoire (km). */
      deepStrikeKm: num(600),
    })
    .default({}),
  economy: z
    .object({
      /** En paix, on ne produit que si l'argent couvre ce multiple du coût. */
      peaceReserveFactor: num(2),
      /** Réserve gardée, en jours de budget de défense (guerre / paix). */
      reserveDaysWar: num(5),
      reserveDaysPeace: num(20),
      /** Entretien supérieur aux revenus : la réserve couvre aussi ce nombre de jours de déficit. */
      deficitDays: num(20),
      /** Une recherche n'est lancée que si elle coûte moins que cette part de la trésorerie. */
      researchSpendShare: num(0.25),
      /** Avance (en rangs) des branches de recherche prioritaires sur les autres. */
      researchFocus: num(0.6),
      /** Achats de guerre des IA actives (module eco) : catégories, par ordre de préférence. */
      warCategories: z
        .array(z.enum(CATEGORIES))
        .default(['air_defense', 'fighter', 'tank', 'artillery', 'drone']),
      /** Réserve des achats de guerre : jours de budget (ou part de la trésorerie sans ORBAT). */
      warReserveDays: num(10),
      warReserveShare: num(0.5),
      /** Achats de guerre simultanés au plus, et taille d'une série. */
      warMaxQueue: num(3),
      warBatch: num(4),
      /** Une réparation n'est lancée que si l'argent couvre ce multiple de son coût. */
      repairFactor: num(3),
      /** Investissement en paix : seulement si la trésorerie dépasse ce nombre de jours de budget. */
      investDays: num(60),
      /** Bâtiments améliorés en priorité (ressources, industrie). */
      investIn: z
        .array(z.enum(BUILDING_TYPES))
        .default(['oil_field', 'mine', 'farm', 'electronics_plant', 'local_industry']),
    })
    .default({}),
  /**
   * Estimation des forces adverses sans tricher : ORBAT public de départ (inventaire réel publié),
   * corrigé par la perte de territoire et la production possible (budget de défense public), avec une
   * incertitude ; jamais en dessous des forces réellement vues (contacts).
   */
  estimate: z
    .object({
      /** Partir de l'ORBAT public (sinon : hypothèse miroir, autant de forces par province que soi). */
      useOrbat: z.boolean().default(true),
      /** Incertitude de départ selon la fiabilité publiée de l'ORBAT (fraction). */
      uncertaintyHigh: num(0.1),
      uncertaintyMedium: num(0.2),
      uncertaintyLow: num(0.35),
      /** Hausse de l'incertitude par jour de partie (l'ORBAT vieillit), et plafond. */
      uncertaintyPerDay: num(0.01),
      maxUncertainty: num(0.6),
      /** Réduction de l'incertitude par la part du pays couverte par une reconnaissance militaire. */
      reconDiscount: num(0.6),
      /** Part du budget de défense public supposée consacrée à de nouveaux matériels chaque jour. */
      productionShare: num(0.3),
      /** Part des forces supposée perdue avec le territoire perdu (0 : aucune, 1 : proportionnelle). */
      territoryLoss: num(0.5),
    })
    .default({}),
  strategy: z
    .object({
      /** Réflexions tactiques entre deux réflexions stratégiques (en guerre / au calme). */
      strategicEveryHot: num(4),
      strategicEveryCalm: num(24),
      /** Réflexions tactiques espacées pour les nations éloignées de tout conflit. */
      tacticalEveryCalm: num(8),
      /** Une nation n'est pas réinvitée dans la même alliance avant ce délai (jours). */
      inviteCooldownDays: num(5),
      /** Guerre sans front (pas voisins, rien perdu ni pris) : paix blanche proposée après ce délai (jours). */
      unreachablePeaceDays: num(3),
      /** Pas de guerre d'agression sous cette stabilité. */
      minStabilityForWar: num(45),
      /**
       * Menace contre un joueur : à chaque étape (fin des préparatifs, fin de l'ultimatum), elle
       * renonce si le rapport de force estimé est tombé sous cette part du rapport exigé (dissuasion).
       */
      planHoldShare: num(0.8),
      /** Menace contre un joueur : sa capitale à moins de cette distance d'une de ses villes (km). */
      threatReachKm: num(1500),
      /** Ses propres forces (sans les alliés) doivent peser cette part du rapport de force voulu. */
      ownRatioShare: num(0.6),
      /** Après une reprise en main (joueur remplacé) : pas de décision brutale pendant ce délai (jours). */
      takeoverCalmDays: num(1),
      /** Délai entre deux demandes de paix au même ennemi (jours). */
      peaceAskEveryDays: num(2),
      /** Délai entre deux actions de guerre par procuration (jours). */
      proxyEveryDays: num(3),
      /** Part de la trésorerie offerte à un neutre courtisé / versée à des rebelles. */
      courtShare: num(0.02),
      fundShare: num(0.01),
      /** Taille minimale (provinces) pour fonder une alliance. */
      allianceMinProvinces: num(4),
      /** Une alliance au plus pour ce nombre de nations (pas de poussière d'alliances). */
      nationsPerAlliance: num(20),
      /** Au-delà, l'IA ne charge plus l'ordre du jour du Conseil. */
      maxCouncilProposals: num(8),
      invitesPerThink: num(3),
      /** Penchant (guerre par procuration) au-delà duquel une invitation est acceptée d'office. */
      inviteLeaning: num(0.4),
    })
    .default({}),
  world: AiWorldSchema(),
});
export type AiBalance = z.infer<typeof AiBalanceSchema>;
export type AiWorldBalance = AiBalance['world'];
export type AiWorldLevelBalance = AiWorldBalance['levels']['normal'];
export type AiLevelBalance = AiBalance['levels']['normal'];

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
     * Cadence de base : temps de jeu écoulé par unité de temps réel à la vitesse ×1 (10 : ×1 = 10 min de
     * jeu par minute réelle, ×2 = 20 min, ×4 = 40 min…). Absent : 1 (temps réel).
     */
    realtimeFactor: z.number().positive().optional(),
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
    /** Unités terrestres : distance maximale (km) entre le point visé et le réseau de routes. */
    roadSnapKm: z.number().positive().optional(),
    /** Unités terrestres sur le réseau de routes (défaut : activé) ; false = déplacement libre sur la grille H3. */
    roadNetwork: z.boolean().optional(),
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
      /**
       * Conversion des budgets ORBAT en dollars du catalogue (prix 2025) : 1 pour les budgets 2025,
       * indice des prix à la consommation pour un scénario historique (≈ 2,97 de 1985 à 2025).
       */
      budgetDollarFactor: z.number().positive().default(1),
    })
    .optional(),
  /**
   * Entretien des unités : le prix catalogue (`upkeepPerDay`, dollars 2025) est ajusté à l'âge du
   * matériel et au coût local de la nation, puis plafonné au départ pour qu'aucune armée réelle ne
   * coûte plus que son budget (facteur national calculé à la création de la partie).
   */
  upkeep: z
    .object({
      /** Facteur selon la génération du matériel (clés « 1 » à « 5 » ; absent = 1). */
      generationFactor: z.record(z.string(), z.number().positive()).default({}),
      /** Catégories dont l'entretien ne dépend pas de la génération (soldes de l'infanterie). */
      generationExempt: z.array(z.string()).default(['infantry']),
      /**
       * Part locale de l'entretien par catégorie (soldes, carburant, main-d'œuvre), payée au niveau de
       * prix de la nation (`costIndex` de l'ORBAT) ; le reste (pièces, munitions importées) au prix mondial.
       */
      localShare: z.record(z.string(), z.number().min(0).max(1)).default({}),
      /** Part locale des catégories absentes de `localShare`. */
      localShareDefault: z.number().min(0).max(1).default(0.5),
      /** Indice de coût local d'une nation dont l'ORBAT ne précise pas `costIndex` (États-Unis = 1). */
      defaultCostIndex: z.number().positive().default(1),
      /**
       * Part maximale du budget de défense absorbée par l'entretien des forces de départ (après âge et
       * coût local) ; au-delà, un facteur national réduit l'entretien de toutes ses unités. L'ORBAT
       * peut la préciser par nation (`upkeepShare`).
       */
      maxStartShare: z.number().positive().default(0.7),
      /** Part minimale (0 = aucune) : relève l'entretien des armées très petites devant leur budget. */
      minStartShare: z.number().min(0).default(0),
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
  /**
   * Ressources des provinces (data/map, champ `resources`) et constructions : les bâtiments
   * d'extraction exigent la ressource ; rendement selon la richesse ; provinces « argent seulement »
   * (services, finances) avec bonus de revenu. Sans `resources` sur la carte : aucune restriction.
   */
  resources: z
    .object({
      /** Bâtiment d'extraction → ressource exigée dans la province. */
      extraction: z.record(z.string(), z.enum(RESOURCES)).optional(),
      /** Usine d'électronique : pôle électronique exigé, sauf ville de rang ≤ cette valeur. */
      electronicsUrbanRank: z.number().int().min(0).max(4).optional(),
      /** Facteur du rendement des bâtiments d'extraction par richesse (1, 2, 3). */
      richnessYield: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]).optional(),
      /** Facteur supplémentaire quand la ressource n'est que secondaire. */
      secondaryYield: z.number().min(0).optional(),
      /** Province sans ressource (services, finances) : revenu × (1 + bonus). */
      servicesIncomeBonus: z.number().min(0).optional(),
      /** Industrie locale d'une province de services (quartier d'affaires) : effet × facteur. */
      servicesIndustryFactor: z.number().min(0).optional(),
      /** Bâtiments réservés aux provinces côtières. */
      coastalOnly: z.array(z.string()).optional(),
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
      /**
       * Profondeur du renseignement (SIGINT, HUMINT, renseignement militaire, sécurité intérieure).
       * Tous les champs sont optionnels ; valeurs par défaut dans packages/engine/src/modules/intel/deep.ts.
       */
      deep: z
        .object({
          /** Poids des capteurs : satellite d'écoute, appareil SIGINT/ELINT, satellite ou drone d'imagerie, brouilleur. */
          sigintSatWeight: z.number().min(0).optional(),
          sigintAirWeight: z.number().min(0).optional(),
          imagerySatWeight: z.number().min(0).optional(),
          imageryAirWeight: z.number().min(0).optional(),
          ewWeight: z.number().min(0).optional(),
          /** Score de capteurs donnant la moitié du bonus maximal. */
          sensorRef: z.number().positive().optional(),
          /** Bonus maximal des capteurs sur la réussite des opérations SIGINT/imagerie. */
          sensorBonusMax: z.number().min(0).max(2).optional(),
          /** Chiffrement d'une nation : base + par niveau de service (intérieur et militaire) au-delà de 1. */
          encryptionBase: z.number().min(0).max(1).optional(),
          encryptionPerLevel: z.number().min(0).max(1).optional(),
          /** Cryptanalyse réussie : progression du décryptage (× qualité / chiffrement). */
          cryptoStep: z.number().min(0).max(1).optional(),
          /** Perte quotidienne du décryptage (changements de clés). */
          cryptoDecayPerDay: z.number().min(0).max(1).optional(),
          /** Décryptage minimal pour lire les ordres de mouvement, puis les intentions. */
          decryptOrders: z.number().min(0).max(1).optional(),
          decryptPlans: z.number().min(0).max(1).optional(),
          /** Unités dont les ordres de mouvement sont révélés par interception, au maximum. */
          interceptMaxUnits: z.number().int().min(1).optional(),
          /** Risque de faux trafic : base × qualité du contre-espionnage adverse × (1 − décryptage). */
          disinfoBase: z.number().min(0).max(1).optional(),
          /** Émetteurs géolocalisés au maximum, incertitude de position (km). */
          geolocateMax: z.number().int().min(1).optional(),
          geolocateUncKm: z.number().min(0).optional(),
          /** Brouillage adverse : incertitude multipliée sur les contacts révélés dans la zone. */
          jamUncFactor: z.number().min(1).optional(),
          /** Brouillage : rayon augmenté par les brouilleurs en service (× (1 + bonus × part)). */
          ewJamBonus: z.number().min(0).optional(),
          /** Détection quotidienne d'un agent selon sa couverture (multiplicateur). */
          coverDetect: z
            .object({ diplomatic: z.number().min(0), nonofficial: z.number().min(0) })
            .partial()
            .optional(),
          /** Tension ajoutée à l'arrestation selon la couverture (× exposureTension). */
          coverTension: z
            .object({ diplomatic: z.number().min(0), nonofficial: z.number().min(0) })
            .partial()
            .optional(),
          /** Fiabilité perçue d'un agent : départ, progression quotidienne, plafond. */
          reliabilityStart: z.number().min(0).max(1).optional(),
          reliabilityPerDay: z.number().min(0).max(1).optional(),
          reliabilityMax: z.number().min(0).max(1).optional(),
          /** Officier traitant présent dans le pays : progression des sources multipliée. */
          handlerBonus: z.number().min(1).optional(),
          /** Culture d'une source : fiabilité minimale requise ; détection multipliée par niveau d'accès. */
          cultivateMinReliability: z.number().min(0).max(1).optional(),
          accessDetect: z.number().min(1).optional(),
          /** Vérification des agents : chance de démasquer un agent double (× qualité). */
          vetDetect: z.number().min(0).max(1).optional(),
          /** Ordre de bataille estimé : écart relatif maximal (service faible) et minimal (excellent). */
          orbatSpreadMax: z.number().min(0).max(2).optional(),
          orbatSpreadMin: z.number().min(0).max(1).optional(),
          /** Nations suivies dans les dossiers. */
          dossierNations: z.number().int().min(1).max(20).optional(),
          /** Indice de menace : poids (points) des indicateurs. */
          threatWeights: z
            .object({
              war: z.number(),
              massing: z.number(),
              plans: z.number(),
              comms: z.number(),
              mobilization: z.number(),
              covert: z.number(),
            })
            .partial()
            .optional(),
          /** Éléments (chars, avions, bataillons…) près de la frontière donnant le poids « concentration » complet. */
          massingRef: z.number().positive().optional(),
          /** Seuil d'alerte stratégique et délai minimal entre deux alertes (heures). */
          alertThreshold: z.number().min(0).max(100).optional(),
          alertCooldownH: z.number().positive().optional(),
          /** Évaluation des dégâts après frappe : rayon (km). */
          bdaRadiusKm: z.number().positive().optional(),
          /** Désignation de cibles : rayon autour de la ville de la province, incertitude (km), cibles max. */
          designateRadiusKm: z.number().positive().optional(),
          designateUncKm: z.number().min(0).optional(),
          designateMax: z.number().int().min(1).optional(),
          /** Démantèlement d'un réseau : chance de capture de chaque agent (× qualité + 0,5). */
          dismantleCatch: z.number().min(0).max(1).optional(),
          /** Sites durcis : durée (jours) et réduction de la réussite des sabotages et cyberattaques industrielles. */
          hardenDays: z.number().positive().optional(),
          hardenReduction: z.number().min(0).max(1).optional(),
        })
        .optional(),
      /**
       * Renseignement intérieur (contre-espionnage, protection des sites sensibles, surveillance des
       * troubles). Valeurs par défaut dans packages/engine/src/modules/intel/interior.ts.
       */
      interior: z
        .object({
          /**
           * Effet de la priorité du département (balanced, counterintel, protection, surveillance) :
           * multiplicateurs de la détection des agents, de la détection des opérations, de la protection
           * des sites et de la réduction des troubles.
           */
          focus: z
            .record(
              z.string(),
              z.object({
                agentDetect: z.number().min(0).default(1),
                opDetect: z.number().min(0).default(1),
                protection: z.number().min(0).default(1),
                unrest: z.number().min(0).default(1),
              }),
            )
            .default({}),
          /** Détection d'une opération étrangère en préparation : base × (0,4 + qualité) × priorité. */
          opDetectBase: z.number().min(0).max(1).optional(),
          /** Plafond de la chance de détection d'une opération. */
          opDetectMax: z.number().min(0).max(1).optional(),
          /** Opération détectée : chance de réussite multipliée par (1 − foilFactor). */
          foilFactor: z.number().min(0).max(1).optional(),
          /** Opération détectée : risque d'être démasquée multiplié par ce facteur. */
          detectedExposure: z.number().min(1).optional(),
          /** Site protégé : réduction maximale de la réussite adverse (× qualité × priorité). */
          protectionMax: z.number().min(0).max(1).optional(),
          /** Sites protégés simultanément : base + par niveau du département (+ bonus de la priorité « protection »). */
          protectedBase: z.number().int().min(0).optional(),
          protectedPerLevel: z.number().int().min(0).optional(),
          protectionFocusBonus: z.number().int().min(0).optional(),
          /** Réduction maximale du risque de troubles (× qualité × priorité « surveillance »). */
          unrestReductionMax: z.number().min(0).max(1).optional(),
          /** Mémoire des incidents par province (menace) : facteur de décroissance quotidien. */
          threatDecay: z.number().min(0).max(1).optional(),
          /** Poids des incidents dans la menace d'une province (points). */
          threatWeights: z.record(z.string(), z.number().min(0)).default({}),
        })
        .optional(),
    })
    .optional(),
  /**
   * Gestion intérieure (onglet Intérieur) : politiques intérieures choisies par le joueur, soutien à la
   * guerre, événements intérieurs (grèves, manifestations, sabotages). Valeurs par défaut dans
   * packages/engine/src/modules/diplo/domestic.ts.
   */
  domestic: z
    .object({
      /** Délai minimal (jours de jeu) avant de pouvoir changer à nouveau une même politique. */
      changeCooldownDays: z.number().min(0).default(2),
      /** Effets chiffrés de chaque politique. */
      policies: z.record(z.enum(DOMESTIC_POLICIES), DomesticPolicyEffectsSchema).default({}),
      /** Soutien de la population à la guerre (0..100). */
      warSupport: z
        .object({
          start: z.number().min(0).max(100).default(60),
          /** Rapprochement quotidien vers la valeur visée. */
          driftPerDay: z.number().min(0).default(2),
          /** Guerre défensive (agressé) : soutien visé en plus. */
          defensiveBonus: z.number().default(15),
          /** Guerre d'agression : soutien visé en moins. */
          offensivePenalty: z.number().default(10),
          /** Baisse par unité perdue (plafonnée par jour). */
          lossPerUnit: z.number().min(0).default(0.3),
          lossCapPerDay: z.number().min(0).default(5),
          /** Baisse par province perdue. */
          provinceLost: z.number().min(0).default(2),
          /** Sous ce seuil, la lassitude de guerre est multipliée par lowWeariness ; au-dessus de highThreshold, par highWeariness. */
          lowThreshold: z.number().min(0).max(100).default(35),
          lowWeariness: z.number().min(0).default(2),
          highThreshold: z.number().min(0).max(100).default(75),
          highWeariness: z.number().min(0).default(0.6),
        })
        .default({}),
      /** Événements intérieurs : chances quotidiennes de base (selon moral, stabilité, agitation). */
      events: z
        .object({
          /** Grève : moral moyen sous moraleThreshold ; production ralentie pendant strikeHours. */
          strikeChance: z.number().min(0).max(1).default(0.25),
          moraleThreshold: z.number().min(0).max(100).default(55),
          strikeHours: z.number().positive().default(48),
          strikeProduction: z.number().positive().max(1).default(0.8),
          /** Manifestation : stabilité sous stabilityThreshold ; stabilité et agitation locale. */
          protestChance: z.number().min(0).max(1).default(0.25),
          stabilityThreshold: z.number().min(0).max(100).default(50),
          protestStability: z.number().min(0).default(2),
          protestUnrest: z.number().min(0).default(8),
          /** Sabotage intérieur (réseaux rebelles) : agitation locale ≥ sabotageUnrest. */
          sabotageChance: z.number().min(0).max(1).default(0.2),
          sabotageUnrest: z.number().min(0).max(100).default(25),
          sabotageDamage: z.tuple([z.number(), z.number()]).default([0.1, 0.3]),
          /** Émeute : manifestation qui dégénère si la stabilité est sous riotThreshold. */
          riotThreshold: z.number().min(0).max(100).default(30),
          riotStability: z.number().min(0).default(4),
          /** Au plus un événement de chaque type par nation pendant ce délai (jours). */
          cooldownDays: z.number().min(0).default(3),
        })
        .default({}),
      /** Risque de troubles d'une province occupée (points ajoutés). */
      occupiedRisk: z.number().min(0).max(100).default(25),
      /** Politiques de l'IA (règles simples). */
      ai: z.boolean().default(true),
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
  /** Piles mixtes (regroupement de départ, fusion, emploi par l'IA) : voir StacksBalanceSchema. */
  stacks: StacksBalanceSchema.optional(),
  /**
   * Mode illimité (compte administrateur) : la réserve d'une nation illimitée est gelée à ces plafonds
   * et remise à niveau après chaque événement ou ordre (aucune dépense n'est refusée faute de fonds).
   */
  unlimited: z
    .object({
      /** Réserve de dollars gelée. */
      moneyUsd: z.number().positive().default(1e15),
      /** Stock gelé de chaque ressource. */
      resources: z.number().positive().default(1e12),
    })
    .optional(),
  /** Heuristiques de décision de l'IA par niveau de difficulté : voir AiBalanceSchema (défauts). */
  ai: AiBalanceSchema.optional(),
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
  /**
   * Indice de coût local (niveau des prix en parité de pouvoir d'achat, États-Unis = 1) : la part
   * locale de l'entretien (soldes, carburant, main-d'œuvre) est payée à ce niveau de prix.
   */
  costIndex: z.number().positive().max(3).optional(),
  /** Part maximale du budget absorbée par l'entretien de départ (sinon `upkeep.maxStartShare`). */
  upkeepShare: z.number().positive().max(1).optional(),
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
