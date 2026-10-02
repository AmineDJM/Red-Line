import { z } from 'zod';
import type { GameTime, LngLat, NationId, ProvinceId, SystemId, UnitId } from './ids.js';
import { RESOURCES, type Resource } from './catalog.js';
import type { BuildingType } from './map.js';

// ——— Recherche (arbre libre, sans doctrine imposée) ———

export const RESEARCH_BRANCHES = [
  'aero', // aviation : générations d'avions, furtivité, ravitaillement
  'land', // blindés, artillerie, infanterie
  'naval', // surface, sous-marins, lutte anti-sous-marine
  'missiles', // frappe, antimissile, hypersonique, nucléaire
  'sensors', // radars, satellites, brouillage, guerre électronique
  'cyber', // cyber offensif et défensif
  'intel', // niveaux des services de renseignement
  'industry', // production, logistique, économie
] as const;
export type ResearchBranch = (typeof RESEARCH_BRANCHES)[number];

export const ResearchNodeSchema = z.object({
  id: z.string().regex(/^research\.[a-z0-9.-]+$/),
  name: z.string(),
  description: z.string().default(''),
  branch: z.enum(RESEARCH_BRANCHES),
  /** Rang dans la branche (affichage de l'arbre). */
  tier: z.number().int().min(0),
  cost: z.object({
    money: z.number().min(0),
    resources: z.record(z.enum(RESOURCES), z.number().min(0)).default({}),
  }),
  durationH: z.number().positive(),
  requires: z.array(z.string()).default([]),
  /**
   * Effets : modificateurs multiplicatifs nommés, cumulés par produit (ex. "production.speed": 1.1,
   * "sensors.radarRange": 1.15, "intel.exterior.level": 1 → +1 niveau). Liste des clés : MODIFIER_KEYS.
   */
  effects: z.record(z.string(), z.number()).default({}),
  /** Époque minimale du scénario (ex. 1985 : les nœuds postérieurs sont exclus de la Guerre froide). */
  eraYear: z.number().int().optional(),
});
export type ResearchNode = z.infer<typeof ResearchNodeSchema>;

export const ResearchFileSchema = z.object({ nodes: z.array(ResearchNodeSchema) });

/** Clés de modificateurs reconnues par le moteur (les autres sont ignorées avec un avertissement). */
export const MODIFIER_KEYS = [
  'production.speed',
  'production.cost',
  'research.speed',
  'income.money',
  'income.oil',
  'income.metals',
  'income.electronics',
  'income.food',
  'upkeep',
  'supply.range',
  'combat.damage',
  'combat.armor',
  'air.range',
  'air.fuel',
  'sensors.radarRange',
  'sensors.stealthDetect',
  'sensors.satellitePasses',
  'ew.jamming',
  'ew.jamResistance',
  'missiles.accuracy',
  'missiles.interception',
  'naval.sonar',
  'cyber.attack',
  'cyber.defense',
  'intel.interior.level',
  'intel.exterior.level',
  'intel.military.level',
  'intel.capacity',
  'stability.recovery',
] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

export interface ResearchView {
  /** Nœud en cours (un seul à la fois, plus une file). */
  current: { id: string; startedAt: GameTime; completesAt: GameTime } | null;
  queue: string[];
  done: string[];
  /** Modificateurs cumulés actuels (produit des effets). */
  modifiers: Partial<Record<ModifierKey, number>>;
}

// ——— Bâtiments stratégiques (génériques) ———

export interface BuildingView {
  type: BuildingType;
  /** Niveau 1 à 5 (comme dans Conflict of Nations) ; absent = 1. */
  level?: number;
  /** Construction ou amélioration en cours. */
  upgradeUntil?: GameTime | null;
  /** 0..1 ; en dessous de 1 l'effet est réduit, à 0 il est nul jusqu'à réparation. */
  health: number;
  /** Réparation en cours. */
  repairUntil?: GameTime | null;
  /** Construction en cours (bâtiment pas encore opérationnel). */
  buildUntil?: GameTime | null;
  /**
   * Prochain niveau (provinces possédées) : coût en dollars et durée en heures de jeu, calculés par le
   * moteur (croissance par niveau, industrie locale). `null` au niveau maximal.
   */
  next?: { level: number; cost: number; hours: number } | null;
}

/** Pourquoi un chantier est impossible pour l'instant (hors trésorerie). */
export type BuildBlock =
  | 'in_progress'
  | 'damaged'
  | 'max_level'
  /** Bâtiment d'extraction sans la ressource dans la province (ProvinceDef.resources). */
  | 'no_resource'
  /** Réservé aux provinces côtières (port, base navale, batterie côtière). */
  | 'coastal_only'
  /** Usine d'électronique hors pôle électronique et hors grande ville. */
  | 'not_urban';

/** Option de construction d'une province possédée (bâtiment absent ou fortification). */
export interface BuildOptionView {
  type: BuildingType | 'fortification';
  /** Niveau visé. */
  level: number;
  /** Coût en dollars. */
  cost: number;
  /** Durée en heures de jeu. */
  hours: number;
  blocked?: BuildBlock;
}

/** Effets des bâtiments (data/balance) : production, ressources, bases, recherche. */
export const BUILDING_EFFECTS_DOC = {
  refinery: 'Produit du pétrole ; détruite, le pétrole de la nation baisse.',
  power_plant: 'Multiplie la vitesse de production et de recherche des provinces voisines.',
  port: 'Production navale, commerce maritime, embarquement ; bloquable.',
  air_base: 'Production et base des aéronefs (rayon d’action, ravitaillement au sol).',
  military_base: 'Production terrestre, dépôt logistique, garnison.',
  arms_factory: 'Production d’armement lourd (blindés, artillerie, missiles).',
  research_center: 'Points de recherche.',
  oil_field: 'Extraction de pétrole.',
  mine: 'Extraction de métaux.',
  farm: 'Production de nourriture.',
  electronics_plant: 'Production de composants électroniques.',
  local_industry: 'Industrie locale : revenus et vitesse de construction de la province.',
  recruiting_office: 'Recrutement : production d’infanterie, mobilisation plus rapide.',
  naval_base: 'Base navale : production et réparation des navires et sous-marins.',
  bunker: 'Bunkers : forte protection des unités terrestres qui défendent la province.',
  air_defense_site: 'Site de défense aérienne fixe (engage les aéronefs et missiles).',
  coastal_battery: 'Batterie côtière antinavire.',
  radar_station: 'Station radar fixe : détection aérienne étendue autour de la province.',
  missile_silo: 'Silo : lancement de missiles balistiques (et nucléaires si autorisés).',
  hospital: 'Hôpital militaire : les unités se rétablissent plus vite, pertes réduites.',
  secret_lab: 'Laboratoire secret : recherche avancée plus rapide.',
  forward_base: 'Base avancée : dépôt logistique et point de ravitaillement du front.',
} as const satisfies Record<BuildingType, string>;

// ——— Licences, marché, marché noir, livraisons ———

export interface LicenceView {
  systemId: SystemId;
  acquiredAt: GameTime;
}

export type TradeItem =
  | { type: 'resource'; resource: Resource; qty: number }
  | { type: 'money'; amount: number }
  | { type: 'units'; systemId: SystemId; count: number }
  | { type: 'licence'; systemId: SystemId };

export interface MarketOffer {
  id: string;
  seller: NationId;
  item: TradeItem;
  price: number;
  /** Offre réservée à une nation, sinon publique. */
  to: NationId | null;
  createdAt: GameTime;
  expiresAt: GameTime;
}

/** Livraison qui voyage sur la carte (interceptable). */
export interface DeliveryView {
  id: string;
  from: NationId;
  to: NationId;
  item: TradeItem;
  /** Unité porteuse (convoi, cargo, avion de transport) visible sur la carte. */
  carrierUnitId: UnitId | null;
  eta: GameTime;
  covert: boolean;
}

export interface MarketView {
  offers: MarketOffer[];
  deliveries: DeliveryView[];
  /** Nations sous embargo (achats au catalogue interdits, marché noir seulement). */
  embargoed: NationId[];
}

// ——— Logistique ———

export type SupplyState = 'supplied' | 'limited' | 'cut';

export interface LogisticsView {
  /** Dépôts / bases avancées du joueur. */
  depots: { id: string; provinceId: ProvinceId; at: LngLat; rangeKm: number }[];
  mobilized: boolean;
  /** Fin de la mobilisation générale possible (délai minimal). */
  mobilizedSince: GameTime | null;
}

// ——— Tableau de bord économique (onglet Économie) ———

/** Clés du grand livre (flux en dollars, signés : recette > 0, dépense < 0). */
export type LedgerKey =
  | 'budgetNational'
  | 'budgetProvincial'
  | 'trade'
  | 'mobilization'
  | 'modifiers'
  | 'upkeep'
  | 'production'
  | 'imports'
  | 'research'
  | 'buildings'
  | 'licences'
  | 'blackMarket'
  | 'marketPurchases'
  | 'marketSales'
  | 'transfersIn'
  | 'transfersOut'
  /** Tout le reste (renseignement, trésorerie d'alliance, dons…), déduit de la variation de trésorerie. */
  | 'other';

export interface ResourceFlowView {
  stock: number;
  /** Production par jour (provinces, bâtiments, modificateurs). */
  production: number;
  /** Consommation par jour (unités). */
  consumption: number;
  net: number;
  /** Stock épuisé au dernier jour : production ralentie (et moral en baisse pour la nourriture). */
  shortage: boolean;
  /** Jours avant épuisement au rythme actuel (null si le stock ne baisse pas). */
  daysLeft: number | null;
}

export interface ProvinceEconomyView {
  id: ProvinceId;
  population: number;
  /** Moral 0..100. */
  morale: number;
  /** Revenu en dollars par jour de la province (part provinciale, moral et industrie compris). */
  income: number;
  /** Ressources produites par jour. */
  resources: Partial<Record<Resource, number>>;
}

export interface EconomyDetailView {
  /** Budget de défense annuel (ORBAT), null sans ORBAT. */
  budgetUsdPerYear: number | null;
  /** Revenus prévus par jour, par poste (dollars). */
  income: {
    national: number;
    provincial: number;
    /** Effet des sanctions et du blocus sur la part commerciale (≤ 0). */
    trade: number;
    /** Effet de la mobilisation (≤ 0). */
    mobilization: number;
    /** Effet des modificateurs (recherche…). */
    modifiers: number;
    total: number;
  };
  /** Entretien prévu par jour, par catégorie d'unités (dollars). */
  upkeep: Record<string, number>;
  upkeepTotal: number;
  /**
   * Ajustement de l'entretien (âge du matériel, coût local, facteur national de départ) : entretien
   * au prix catalogue, facteur moyen appliqué (upkeepTotal / catalog) et indice de coût local.
   */
  upkeepAdjust?: { catalog: number; factor: number; costIndex: number };
  /** Flux réels des dernières 24 h de jeu et du jour en cours (dollars signés). */
  lastDay: Partial<Record<LedgerKey, number>>;
  today: Partial<Record<LedgerKey, number>>;
  /** Balance commerciale des dernières 24 h : ventes et cessions reçues − achats et importations. */
  tradeBalance: number;
  resources: Record<Resource, ResourceFlowView>;
  /** Solde prévu par jour et trésorerie prévue. */
  forecast: { netPerDay: number; money7d: number; money30d: number };
  population: number;
  /** Moral moyen pondéré par la population. */
  morale: number;
  provinces: ProvinceEconomyView[];
}
