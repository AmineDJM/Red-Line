import type { HelpEntry } from './rules.js';

/** Section `command` (centre de commandement : armées, missions, généraux). */
const AGGR: [string, string][] = [
  ['cautious', 'Prudente'],
  ['balanced', 'Équilibrée'],
  ['bold', 'Audacieuse'],
];

const AGGR_HELP: Record<string, HelpEntry> = {
  attackRatio: [
    'Rapport de force exigé',
    'Force engagée / force ennemie connue avant d’attaquer (s’ajoute au profil du général).',
    'x',
  ],
  retreatAt: [
    'Seuil de repli',
    'Santé d’une pile sous laquelle elle se replie (valeur par défaut de la mission).',
    'frac',
  ],
  pursuit: ['Poursuite', 'Rayon de poursuite au-delà de la zone confiée.', 'x'],
  airShare: ['Part de l’aviation engagée', 'Le reste de la chasse reste en alerte au sol.', 'frac'],
  objectives: ['Objectifs supplémentaires', 'Par réflexion du général.', 'n'],
};

export const COMMAND_SECTION: [string, string] = [
  'Centre de commandement',
  'Armées formées par le joueur, missions confiées à un général recruté et payé qui commande comme l’IA : missions, profils d’agressivité, généraux (vivier, grades, soldes, traits), tactique et renforts.',
];

export const COMMAND_HELP: Record<string, HelpEntry> = {
  'command.enabled': ['Activé', 'Le centre de commandement est proposé aux joueurs.'],
  'command.maxArmies': ['Armées par nation', undefined, 'n'],
  'command.maxPiles': ['Piles par armée', undefined, 'n'],
  'command.journalMax': ['Entrées du journal', 'Comptes rendus conservés par armée.', 'n'],
  'command.missions': [
    'Missions',
    'Catalogue extensible : chaque mission choisit un cerveau (exécution par le moteur) et une cible.',
  ],
  'command.missions.brain': [
    'Cerveau',
    'conquer, defend, hold_front, air_superiority, air_defense, deep_strike, sea_control, landing, reserve.',
  ],
  'command.missions.target': ['Cible', 'province, nation, zone ou aucune.'],
  'command.missions.domains': ['Milieux attendus', 'Conseil affiché dans l’assistant.'],
  'command.missions.radiusKm': ['Rayon par défaut', 'Zone ou région autour de la cible.', 'km'],
  'command.missions.order': ['Ordre d’affichage', undefined, 'n'],
  'command.missions.continuous': [
    'Mission de durée',
    'Tenue ou perdue, jamais « réussie » (défendre, tenir, contrôler).',
  ],
  'command.missions.blockade': ['Blocus', 'Contrôle maritime : ports ennemis de la zone bloqués.'],
  'command.aggressiveness': [
    'Agressivité',
    'Profils choisis par le joueur pour chaque mission (prudente, équilibrée, audacieuse).',
  ],
  ...Object.fromEntries(
    AGGR.flatMap(([k, label]): [string, HelpEntry][] => [
      [`command.aggressiveness.${k}`, [label, `Profil « ${label.toLowerCase()} ».`]],
      ...Object.entries(AGGR_HELP).map(([f, h]): [string, HelpEntry] => [
        `command.aggressiveness.${k}.${f}`,
        h,
      ]),
    ]),
  ),
  'command.failShare': [
    'Échec par pertes',
    'Mission échouée sous cette part des effectifs du lancement.',
    'frac',
  ],
  'command.stuckHours': [
    'Échec sans progrès',
    'Mission offensive sans prise ni offensive pendant ce délai.',
    'h',
  ],
  'command.generals': ['Généraux', 'Vivier, grades et soldes, expérience, bonus, traits.'],
  'command.generals.poolSize': ['Candidats proposés', 'Par nation, à la fois.', 'n'],
  'command.generals.poolRefreshDays': [
    'Renouvellement du vivier',
    'Un candidat non recruté est remplacé au bout de ce délai (0 = jamais).',
    'j',
  ],
  'command.generals.skillMean': ['Note moyenne', 'Des candidats (0 à 100).', 'pts'],
  'command.generals.skillSpread': ['Dispersion des notes', undefined, 'pts'],
  'command.generals.traitChance': ['Probabilité d’un trait', undefined, 'frac'],
  'command.generals.secondTraitChance': ['Probabilité d’un second trait', undefined, 'frac'],
  'command.generals.ranks': [
    'Grades',
    '★ brigade, ★★ division, ★★★ corps d’armée, ★★★★ armée : note minimale et coût de l’état-major.',
  ],
  'command.generals.ranks.minRating': ['Note minimale', undefined, 'pts'],
  'command.generals.ranks.salaryUsdPerDay': [
    'Coût par jour',
    'Solde, état-major, transmissions et protection (prix américains, × indice de coût local).',
    '$',
  ],
  'command.generals.rankPremium': [
    'Prime de compétence',
    'Supplément maximal en haut de la plage du grade.',
    'frac',
  ],
  'command.generals.useCostIndex': [
    'Coût local',
    'Applique l’indice de coût de la nation (ORBAT) à la solde.',
  ],
  'command.generals.signingBonusDays': [
    'Prime d’engagement',
    'Jours de solde versés au recrutement.',
    'j',
  ],
  'command.generals.severanceDays': ['Indemnité de limogeage', 'Jours de solde.', 'j'],
  'command.generals.resignAfterUnpaidDays': [
    'Démission',
    'Jours de solde impayés avant démission.',
    'j',
  ],
  'command.generals.xpCapture': ['Expérience par province prise', undefined, 'pts'],
  'command.generals.xpSuccess': ['Expérience par mission réussie', undefined, 'pts'],
  'command.generals.xpCombatDay': ['Expérience par jour de combat', undefined, 'pts'],
  'command.generals.xpPerSkill': [
    'Progression',
    'Points d’expérience pour +1 en expérience (et une fois sur deux dans la spécialité).',
    'pts',
  ],
  'command.generals.bonus': [
    'Bonus d’efficacité',
    'Maximum à compétence et expérience pleines : modestes et réalistes.',
  ],
  'command.generals.bonus.damage': ['Dégâts en attaque', 'Selon la compétence offensive.', 'frac'],
  'command.generals.bonus.armor': [
    'Protection à l’arrêt',
    'Selon la compétence défensive.',
    'frac',
  ],
  'command.generals.bonus.logistics': [
    'Autonomie et ravitaillement',
    'Selon la logistique (ou l’aviation pour l’autonomie).',
    'frac',
  ],
  'command.generals.frictionMax': [
    'Frictions',
    'Probabilité qu’une réflexion soit perdue (général sans expérience).',
    'frac',
  ],
  'command.generals.hq': [
    'QG frappé',
    'Blessure ou mort du général quand la pile de tête est touchée.',
  ],
  'command.generals.hq.woundChance': ['Probabilité de blessure', 'Par coup sérieux.', 'frac'],
  'command.generals.hq.killChance': ['Probabilité de mort', 'Par coup sérieux.', 'frac'],
  'command.generals.hq.woundDays': ['Convalescence', undefined, 'j'],
  'command.generals.traits': [
    'Traits',
    'Effets additifs (sauf multiplicateurs) et poids au tirage.',
  ],
  'command.generals.traits.weight': ['Poids au tirage', undefined, 'x'],
  'command.generals.traits.attackRatio': ['Rapport de force', 'Ajouté au rapport exigé.', 'x'],
  'command.generals.traits.retreatAt': ['Seuil de repli', 'Ajouté au seuil.', 'frac'],
  'command.generals.traits.objectives': ['Objectifs par réflexion', undefined, 'n'],
  'command.generals.traits.sorties': ['Sorties aériennes', 'Par réflexion.', 'n'],
  'command.generals.traits.escorts': ['Escortes', 'Navires et chasseurs d’escorte.', 'n'],
  'command.generals.traits.damage': ['Dégâts', 'Bonus ajouté.', 'frac'],
  'command.generals.traits.armor': ['Protection', 'Bonus ajouté.', 'frac'],
  'command.generals.traits.logistics': ['Logistique', 'Bonus ajouté.', 'frac'],
  'command.generals.traits.rally': ['Rassemblement', 'Départs échelonnés même sans logistique.'],
  'command.generals.traits.encircle': [
    'Encerclement',
    'Préférence pour les provinces entourées de provinces amies.',
    'x',
  ],
  'command.generals.traits.friction': ['Frictions', 'Multiplicateur.', 'x'],
  'command.generals.traits.salary': ['Solde', 'Multiplicateur.', 'x'],
  'command.generals.traits.xp': ['Expérience', 'Multiplicateur des gains.', 'x'],
  'command.tactics': ['Tactique des généraux', 'Distances, mémoires et délais.'],
  'command.tactics.airThreatKm': [
    'Alerte aérienne',
    'Aviation ennemie vue à cette distance : la chasse décolle.',
    'km',
  ],
  'command.tactics.seadKm': [
    'Suppression',
    'Défenses antiaériennes frappées autour des objectifs.',
    'km',
  ],
  'command.tactics.supportKm': [
    'Appui aérien',
    'Forces terrestres frappées autour des objectifs.',
    'km',
  ],
  'command.tactics.contactMemoryHours': ['Mémoire des contacts', undefined, 'h'],
  'command.tactics.blindShare': [
    'Province non vue',
    'Part supposée des forces publiques de la nation dans une province non observée.',
    'frac',
  ],
  'command.tactics.reachKm': [
    'Rayon de l’armée',
    'Distance d’où le général rappelle ses piles.',
    'km',
  ],
  'command.tactics.restMargin': [
    'Remise en ligne',
    'Marge de santé au-dessus du seuil de repli pour reprendre une pile repliée.',
    'frac',
  ],
  'command.tactics.weakNoticeHours': ['Rappel « forces insuffisantes »', undefined, 'h'],
  'command.tactics.noIntelNoticeHours': ['Rappel « renseignement insuffisant »', undefined, 'h'],
  'command.tactics.zoneLostHours': ['Zone perdue', 'Échec après ce délai.', 'h'],
  'command.reinforce': ['Renforts', 'Demandes du général quand les effectifs baissent.'],
  'command.reinforce.triggerShare': [
    'Seuil de demande',
    'Effectifs sous cette part du lancement de la mission.',
    'frac',
  ],
  'command.reinforce.maxPiles': ['Piles par demande', undefined, 'n'],
  'command.reinforce.reachKm': ['Rayon de recherche', 'Piles libres proches de l’armée.', 'km'],
  'command.reinforce.cooldownHours': ['Délai entre deux demandes', undefined, 'h'],
  'command.operations': [
    'Opérations',
    'Opérations du QG : pays visés, objectif, plusieurs généraux des quatre commandements (terre, air, marine, défense antiaérienne).',
  ],
  'command.operations.maxOps': ['Opérations simultanées', 'Par nation.', 'n'],
  'command.operations.maxCommanders': ['Généraux par opération', undefined, 'n'],
  'command.operations.stageHours': [
    'Rassemblement',
    'Durée maximale du rassemblement avant l’offensive, lancée quoi qu’il arrive ensuite.',
    'h',
  ],
  'command.operations.forceShare': [
    'Forces engagées d’office',
    'Part des piles libres de l’arme d’un général confiées à l’opération, selon l’agressivité.',
  ],
  'command.operations.forceShare.cautious': ['Prudente', undefined, 'frac'],
  'command.operations.forceShare.balanced': ['Équilibrée', undefined, 'frac'],
  'command.operations.forceShare.bold': ['Audacieuse', undefined, 'frac'],
  'command.operations.autoReachKm': [
    'Rayon des forces d’office',
    'Piles libres prises d’office jusqu’à cette distance des cibles.',
    'km',
  ],
  'command.operations.sectors': [
    'Secteurs terrestres',
    'Au plus, un par général de l’armée de terre.',
    'n',
  ],
  'command.operations.groupShare': [
    'Taille des groupes d’assaut',
    'Part des piles terrestres du général engagées dans un même groupe.',
    'frac',
  ],
  'command.operations.pilesPerObjective': [
    'Piles par objectif simultané',
    'Un objectif de plus par tranche de piles terrestres.',
    'n',
  ],
  'command.operations.sorties': [
    'Sorties de frappe',
    'Par réflexion : base + compétence aviation / tranche, au plus une part des appareils.',
  ],
  'command.operations.sorties.base': ['Sorties de base', undefined, 'n'],
  'command.operations.sorties.perSkill': ['Points d’aviation par sortie de plus', undefined, 'pts'],
  'command.operations.sorties.share': ['Part maximale des appareils', undefined, 'frac'],
  'command.operations.salvos': ['Salves de missiles', 'Par réflexion et par général.', 'n'],
  'command.operations.reconHours': [
    'Relance de la reconnaissance',
    'Faute de cibles connues, patrouille au-dessus des pays visés.',
    'h',
  ],
  'command.operations.huntKm': [
    'Chasse terrestre (Affaiblir)',
    'Forces ennemies vues poursuivies jusqu’à cette distance du territoire.',
    'km',
  ],
  'command.operations.frontKm': [
    'Ramener au front',
    'Piles sans objectif ramenées vers la ville amie la plus avancée de leur secteur au-delà de cette distance.',
    'km',
  ],
  'command.operations.heavyLossShare': [
    'Alerte pertes lourdes',
    'Part de la valeur engagée perdue en 24 h.',
    'frac',
  ],
  'command.operations.stuckHours': ['Alerte enlisement', 'Sans progrès pendant ce délai.', 'h'],
  'command.operations.failStuckHours': [
    'Échec par enlisement',
    'Opération offensive sans aucun progrès pendant ce délai.',
    'h',
  ],
  'command.operations.chiefBonus': [
    'Bonus du général en chef',
    'Part de son avance (note − 50) ajoutée aux compétences des généraux de son commandement.',
    'frac',
  ],
  'command.operations.chiefSalary': ['Solde du général en chef', 'Multiplicateur.', 'x'],
  'command.operations.deputySkill': [
    'Adjoint d’un général blessé',
    'Part des compétences avec laquelle l’adjoint commande.',
    'frac',
  ],
  'command.operations.maxPhases': [
    'Phases par opération',
    'Nombre maximal de phases enchaînées (objectif composé compris).',
    'n',
  ],
  'command.operations.phaseStageHours': [
    'Rassemblement entre deux phases',
    'Durée bornée du rassemblement au début de chaque nouvelle phase.',
    'h',
  ],
  'command.operations.returnHours': [
    'Retour à la base',
    'Délai maximal avant que les forces d’une opération terminée soient rendues au joueur.',
    'h',
  ],
  'command.operations.holdAirKm': [
    'Couverture des gains',
    'Après l’opération : chasse en patrouille si l’aviation ennemie approche à moins de cette distance.',
    'km',
  ],
  'command.operations.goals': [
    'Objectifs',
    'Par objectif : ordre, catégorie du catalogue, commandements recommandés, type de cible (pays, provinces, lieu, son territoire, allié), objectif continu, seuil de réussite, guerre ou non, phases d’un objectif composé et leurs échéances, réglages propres.',
  ],
};
