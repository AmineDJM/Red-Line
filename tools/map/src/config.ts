/**
 * Paramètres du pipeline de carte. Tout ce qui est « choix éditorial » (regroupements, détroits,
 * zones disputées, palette) est ici, séparé du code de calcul.
 */

export const NE_BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

export const NE_FILES = {
  admin0: 'ne_10m_admin_0_countries',
  mapUnits: 'ne_10m_admin_0_map_units',
  admin1: 'ne_10m_admin_1_states_provinces',
  places: 'ne_10m_populated_places',
  marine: 'ne_10m_geography_marine_polys',
  coastline: 'ne_10m_coastline',
} as const;

export const H3_RES = 4;

/** Unités admin-0 « indéterminées » sans propriétaire : leurs cellules sont infranchissables. */
export const IMPASSABLE_ADM0 = new Set([
  'ATA', // Antarctique
  'KAS', // glacier de Siachen
  'CNM', // zone tampon de l'ONU à Chypre
  'BRT', // Bir Tawil
  'BRI', // Ilha Brasileira
  'BJN', // banc de Bajo Nuevo
  'SER', // banc de Serranilla
  'SCR', // récif de Scarborough
  'SPI', // champ de glace Sud de Patagonie
  'PGA', // Wake (indéterminé dans Natural Earth)
]);

/** Souveraineté (SOV_A3 de Natural Earth) → unité admin-0 principale. */
export const SOV_PRIMARY: Record<string, string> = {
  AU1: 'AUS',
  CH1: 'CHN',
  DN1: 'DNK',
  FI1: 'FIN',
  FR1: 'FRA',
  GB1: 'GBR',
  IS1: 'ISR',
  KA1: 'KAZ',
  NL1: 'NLD',
  NZ1: 'NZL',
  US1: 'USA',
  CU1: 'CUB',
};

/** Identifiants de nation pour les unités sans code ISO alpha-3. */
export const NATION_ID_OVERRIDE: Record<string, string> = {
  KOS: 'xkx',
  SOL: 'sol',
  CYN: 'cyn',
  SAH: 'esh',
  ISR: 'isr',
};

/** Entités non membres de l'ONU (kind = "entity"). Critère factuel, sans jugement politique. */
export const ENTITY_IDS = new Set(['gaza', 'pse', 'twn', 'xkx', 'sol', 'cyn', 'esh', 'vat']);

/** Noms français courts pour l'interface (sinon NAME_FR de Natural Earth). */
export const NATION_NAME_OVERRIDE: Record<string, string> = {
  chn: 'Chine',
  gaza: 'Bande de Gaza',
  pse: 'Autorité palestinienne',
  isr: 'Israël',
  cod: 'RD Congo',
  cog: 'Congo',
  caf: 'Centrafrique',
  fsm: 'Micronésie',
  vat: 'Vatican',
  are: 'Émirats arabes unis',
  gbr: 'Royaume-Uni',
  usa: 'États-Unis',
  esh: 'Sahara occidental',
  kna: 'Saint-Christophe-et-Niévès',
  vct: 'Saint-Vincent-et-les-Grenadines',
};

/** Codes « iso » des entités sans code ISO propre. */
export const NATION_ISO_OVERRIDE: Record<string, string> = {
  gaza: 'GAZ',
  pse: 'PSE',
  xkx: 'XKX',
  sol: 'SOL',
  cyn: 'CYN',
};

/** Capitales explicites (nom NE), quand la règle « Admin-0 capital le plus peuplé » ne suffit pas. */
export const CAPITAL_OVERRIDE: Record<string, string> = {
  gaza: 'Gaza City',
  pse: 'Ramallah',
  zaf: 'Pretoria',
  bol: 'La Paz',
  nld: 'Amsterdam',
  mys: 'Kuala Lumpur',
  civ: 'Yamoussoukro',
  lka: 'Colombo',
  ben: 'Porto-Novo',
  bdi: 'Gitega',
  ssd: 'Juba',
};

/**
 * Regroupement des unités admin-1. Cible de provinces par nation avant découpage :
 *   T = round(mergeArea * sqrt(superficie / 1000 km²) + mergePop * sqrt(population / 1 M))
 * Découpage des grandes provinces en k parties (Voronoï sur k-moyennes) :
 *   k = round(sqrt(superficie / splitArea) + population estimée / splitPop), plafonné à splitMax.
 */
export const GROUPING = {
  mergeArea: 0.55,
  mergePop: 1.0,
  /** Pénalité (en parts de score) pour fusionner deux unités de régions différentes. */
  regionPenalty: 1.5,
  /** Distance max (km) pour rattacher une île à une autre unité de la même nation. */
  islandMergeKm: 500,
  /** Au-dessous de cette superficie (km²), une île se rattache à la plus proche sans limite. */
  tinyIslandKm2: 2000,
  splitAreaKm2: 60_000,
  splitPop: 25_000_000,
  /** Pas de découpe au-dessous de cette superficie (évite de couper une métropole dense). */
  splitMinAreaKm2: 40_000,
  splitMax: 8,
  /** Îlots rattachés d'office à l'unité notable la plus proche (superficie et population max). */
  tinyUnitKm2: 500,
  tinyUnitPop: 150_000,
};

/** Nations dont le champ « region » de Natural Earth est un nom lisible (français ou local). */
export const REGION_NAMED = new Set(['fra', 'ita', 'esp', 'svn', 'lva', 'mlt', 'bfa', 'gbr']);

/** Traductions des noms de régions (clé « nation|région »). */
export const REGION_NAME_FR: Record<string, string> = {
  'gbr|Greater London': 'Grand Londres',
  'gbr|North West': 'Nord-Ouest de l’Angleterre',
  'gbr|North East': 'Nord-Est de l’Angleterre',
  'gbr|South East': 'Sud-Est de l’Angleterre',
  'gbr|South West': 'Sud-Ouest de l’Angleterre',
  'gbr|East': 'Est de l’Angleterre',
  'gbr|West Midlands': 'Midlands de l’Ouest',
  'gbr|East Midlands': 'Midlands de l’Est',
  'gbr|Yorkshire and the Humber': 'Yorkshire-et-Humber',
  'gbr|Northern Ireland': 'Irlande du Nord',
  'gbr|Highlands and Islands': 'Highlands et îles',
  'gbr|South Western': 'Sud-Ouest de l’Écosse',
  'gbr|North Eastern': 'Nord-Est de l’Écosse',
  'gbr|Eastern': 'Est de l’Écosse',
  'gbr|West Wales and the Valleys': 'Pays de Galles de l’Ouest',
  'gbr|East Wales': 'Pays de Galles de l’Est',
  'ita|Apulia': 'Pouilles',
  'ita|Sardegna': 'Sardaigne',
  'ita|Sicily': 'Sicile',
  'ita|Lombardia': 'Lombardie',
  'ita|Piemonte': 'Piémont',
  'ita|Toscana': 'Toscane',
  'ita|Liguria': 'Ligurie',
  'ita|Campania': 'Campanie',
  'ita|Calabria': 'Calabre',
  'ita|Veneto': 'Vénétie',
  'ita|Lazio': 'Latium',
  'ita|Emilia-Romagna': 'Émilie-Romagne',
  'ita|Friuli-Venezia Giulia': 'Frioul-Vénétie julienne',
  'ita|Trentino-Alto Adige': 'Trentin-Haut-Adige',
  'ita|Abruzzo': 'Abruzzes',
  'ita|Basilicata': 'Basilicate',
  'ita|Umbria': 'Ombrie',
  'ita|Marche': 'Marches',
  'esp|Andalucía': 'Andalousie',
  'esp|Cataluña': 'Catalogne',
  'esp|Castilla y León': 'Castille-et-León',
  'esp|Castilla-La Mancha': 'Castille-La Manche',
  'esp|Valenciana': 'Communauté valencienne',
  'esp|País Vasco': 'Pays basque',
  'esp|Aragón': 'Aragon',
  'esp|Foral de Navarra': 'Navarre',
  'esp|Galicia': 'Galice',
  'esp|Canary Is.': 'Canaries',
  'esp|Islas Baleares': 'Baléares',
  'esp|Extremadura': 'Estrémadure',
};

/** Noms d'unités admin-1 à corriger (clé « ADM0_A3|nom anglais Natural Earth »). */
export const ADM1_NAME_OVERRIDE: Record<string, string> = {
  'BRA|Distrito Federal': 'District fédéral',
  'USA|District of Columbia': 'District de Columbia',
  'MEX|Distrito Federal': 'Mexico',
  'RUS|Amur': 'Amour',
  'UKR|Kiev City': 'Kiev (ville)',
  'SHN|Saint Helena': 'Sainte-Hélène',
};

/** Simplification de la géométrie publiée. */
export const SIMPLIFY = { percentage: '15%', precision: 0.001 };

/** Revenus (par jour de jeu). Voir economy.ts. */
export const ECONOMY = {
  moneyMin: 20,
  moneyMax: 400,
  moneyBase: 20,
  moneyPerSqrtGdp: 0.55, // GDP en millions de dollars
  variation: 0.15,
  /** Facteur pétrolier par nation (0 à 1), le reste à `oilDefault`. Grands producteurs seulement. */
  oilFactor: {
    sau: 1,
    irq: 0.9,
    irn: 0.8,
    kwt: 0.9,
    are: 0.9,
    qat: 0.8,
    rus: 0.7,
    usa: 0.5,
    can: 0.5,
    ven: 0.8,
    nga: 0.6,
    ago: 0.6,
    lby: 0.8,
    dza: 0.6,
    kaz: 0.6,
    nor: 0.5,
    mex: 0.4,
    bra: 0.3,
    omn: 0.7,
    aze: 0.6,
    chn: 0.25,
    gab: 0.5,
    cog: 0.5,
    gnq: 0.6,
    tkm: 0.5,
    brn: 0.7,
    ecu: 0.4,
    col: 0.3,
    idn: 0.25,
    mys: 0.3,
    egy: 0.25,
    sdn: 0.3,
    ssd: 0.5,
    yem: 0.3,
    syr: 0.2,
    gbr: 0.2,
    arg: 0.2,
    tcd: 0.3,
  } as Record<string, number>,
  oilDefault: 0.04,
};

/**
 * Palette des teintes de nation : lumineuses, bien distinctes (teinte ET luminosité),
 * aucune teinte violette/magenta (réservée au joueur) : teintes HSL hors de [245°, 335°].
 */
export const PALETTE = [
  '#ff5a4e', // rouge
  '#ffa040', // orange
  '#ffd84d', // jaune
  '#b5e04a', // vert-jaune
  '#44c76a', // vert
  '#2fd4b8', // turquoise
  '#62d8f5', // cyan
  '#3f95ee', // azur
  '#b4d6ff', // bleu pâle
  '#ffb8a6', // saumon clair
  '#d39a5c', // fauve
  '#eeeaa0', // paille
  '#9debc0', // menthe
  '#e0662e', // orange brûlé
];
export const VIOLET_HUE_RANGE: [number, number] = [245, 335];

/** Zones disputées : la géométrie suit le point de vue par défaut de Natural Earth. */
export interface DisputedDef {
  id: string;
  name: string;
  /** Sélection des unités admin-1 (nation Natural Earth ADM0_A3 + nom admin-1 anglais). */
  match: { adm0: string; names?: string[] }[];
  claimants: string[];
  tension: number;
  revoltRate: number;
}

export const DISPUTED: DisputedDef[] = [
  {
    id: 'crimee',
    name: 'Crimée',
    match: [{ adm0: 'RUS', names: ['Crimea', 'Sevastopol'] }],
    claimants: ['ukr', 'rus'],
    tension: 70,
    revoltRate: 0.03,
  },
  {
    id: 'taiwan',
    name: 'Taïwan',
    match: [{ adm0: 'TWN' }],
    claimants: ['twn', 'chn'],
    tension: 60,
    revoltRate: 0.01,
  },
  {
    id: 'cachemire',
    name: 'Cachemire',
    match: [
      { adm0: 'IND', names: ['Jammu and Kashmir', 'Ladakh'] },
      { adm0: 'PAK', names: ['Azad Kashmir', 'Northern Areas'] },
    ],
    claimants: ['ind', 'pak'],
    tension: 75,
    revoltRate: 0.03,
  },
  {
    id: 'sahara-occidental',
    name: 'Sahara occidental',
    match: [{ adm0: 'SAH' }],
    claimants: ['mar', 'esh'],
    tension: 50,
    revoltRate: 0.02,
  },
];

/**
 * Détroits et canaux : ligne brisée [lng, lat] traversant le passage, d'eau libre à eau libre.
 * Toutes les cellules H3 du tracé sont rendues navigables.
 */
export interface StraitDef {
  id: string;
  name: string;
  path: [number, number][];
}

export const STRAITS: StraitDef[] = [
  {
    id: 'bosphore',
    name: 'Bosphore',
    path: [
      [29.3, 41.45],
      [29.08, 41.18],
      [29.0, 41.02],
      [28.6, 40.8],
    ],
  },
  {
    id: 'dardanelles',
    name: 'Dardanelles',
    path: [
      [28.6, 40.8],
      [27.4, 40.6],
      [26.65, 40.38],
      [26.35, 40.08],
      [25.9, 39.95],
    ],
  },
  {
    id: 'suez',
    name: 'Canal de Suez',
    path: [
      [32.35, 31.6],
      [32.31, 31.25],
      [32.3, 30.6],
      [32.55, 30.0],
      [32.6, 29.6],
      [33.1, 28.8],
      [33.6, 28.0],
      [34.0, 27.5],
    ],
  },
  {
    id: 'panama',
    name: 'Canal de Panama',
    path: [
      [-79.95, 9.6],
      [-79.9, 9.3],
      [-79.75, 9.1],
      [-79.6, 8.9],
      [-79.5, 8.6],
    ],
  },
  {
    id: 'gibraltar',
    name: 'Détroit de Gibraltar',
    path: [
      [-6.4, 35.9],
      [-5.6, 35.95],
      [-4.8, 36.15],
    ],
  },
  {
    id: 'ormuz',
    name: "Détroit d'Ormuz",
    path: [
      [55.7, 26.3],
      [56.4, 26.5],
      [56.75, 26.2],
      [57.1, 25.7],
    ],
  },
  {
    id: 'bab-el-mandeb',
    name: 'Bab-el-Mandeb',
    path: [
      [42.7, 13.4],
      [43.3, 12.65],
      [43.6, 12.45],
      [44.1, 12.3],
    ],
  },
  {
    id: 'malacca',
    name: 'Détroit de Malacca',
    path: [
      [98.5, 5.0],
      [100.3, 3.3],
      [101.4, 2.5],
      [102.5, 1.8],
      [103.4, 1.2],
      [103.9, 1.2],
      [104.5, 1.35],
    ],
  },
  {
    id: 'kertch',
    name: 'Détroit de Kertch',
    path: [
      [36.8, 45.7],
      [36.6, 45.3],
      [36.5, 44.9],
    ],
  },
  {
    id: 'oresund',
    name: 'Øresund',
    path: [
      [12.4, 56.35],
      [12.65, 56.0],
      [12.75, 55.6],
      [12.9, 55.25],
    ],
  },
  {
    id: 'grand-belt',
    name: 'Grand Belt',
    path: [
      [11.0, 56.3],
      [10.95, 55.6],
      [11.05, 55.2],
      [11.2, 54.75],
      [11.4, 54.5],
    ],
  },
  {
    id: 'kiel',
    name: 'Canal de Kiel',
    path: [
      [8.9, 53.85],
      [9.2, 53.9],
      [9.7, 54.2],
      [10.15, 54.37],
      [10.35, 54.5],
    ],
  },
  {
    id: 'messine',
    name: 'Détroit de Messine',
    path: [
      [15.55, 38.45],
      [15.63, 38.2],
      [15.55, 37.85],
    ],
  },
  {
    id: 'pas-de-calais',
    name: 'Pas de Calais',
    path: [
      [1.2, 50.75],
      [1.55, 51.0],
      [2.0, 51.3],
    ],
  },
  {
    id: 'tiran',
    name: "Détroit de Tiran et golfe d'Aqaba",
    path: [
      [34.4, 27.8],
      [34.6, 28.25],
      [34.75, 28.8],
      [34.95, 29.45],
    ],
  },
];

/**
 * Tests de connectivité maritime : deux points en mer reliés par la grille navale
 * (cellules hors terre + cellules des détroits), dans un rayon limité autour du passage.
 */
export const SEA_LINKS: {
  name: string;
  from: [number, number];
  to: [number, number];
  maxKm: number;
}[] = [
  { name: 'Méditerranée ↔ mer Noire', from: [25.5, 39.6], to: [30.0, 42.0], maxKm: 700 },
  { name: 'Méditerranée ↔ mer Rouge (Suez)', from: [32.4, 32.2], to: [34.3, 27.0], maxKm: 700 },
  { name: 'Atlantique ↔ Pacifique (Panama)', from: [-79.9, 10.2], to: [-79.4, 8.0], maxKm: 500 },
  {
    name: 'Atlantique ↔ Méditerranée (Gibraltar)',
    from: [-7.5, 35.8],
    to: [-3.5, 36.3],
    maxKm: 500,
  },
  {
    name: 'Golfe Persique ↔ golfe d’Oman (Ormuz)',
    from: [54.5, 26.2],
    to: [58.0, 24.9],
    maxKm: 600,
  },
  { name: 'Mer Rouge ↔ golfe d’Aden', from: [41.5, 14.5], to: [45.0, 12.0], maxKm: 600 },
  { name: 'Malacca', from: [97.5, 6.0], to: [105.0, 2.0], maxKm: 1400 },
  { name: 'Mer d’Azov ↔ mer Noire', from: [36.9, 46.0], to: [36.4, 44.6], maxKm: 400 },
  { name: 'Baltique ↔ mer du Nord', from: [11.5, 57.5], to: [12.5, 54.6], maxKm: 600 },
  { name: 'Tyrrhénienne ↔ Ionienne (Messine)', from: [15.3, 38.7], to: [15.9, 37.6], maxKm: 300 },
];
