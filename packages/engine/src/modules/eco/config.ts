import type { Balance, BuildingType, Category } from '@redline/shared';
import type { World } from '../../api.js';

/**
 * Réglages du module économie. Chaque valeur vient de data/balance (sections optionnelles de
 * BalanceSchema) ; les valeurs ci-dessous sont les DÉFAUTS DOCUMENTÉS appliqués quand une section ou
 * une clé est absente. Aucun autre chiffre d'équilibrage n'est codé dans le module.
 */
export const ECO_DEFAULTS = {
  money: {
    budgetPerDayFraction: 1 / 365,
    budgetMultiplier: 1,
    provinceShare: 0.5,
    startingDays: 30,
    tradeShare: 0.3,
  },
  research: { durationMultiplier: 1, maxQueue: 5 },
  licences: { priceFactor: 20, productionDiscount: 0.3 },
  blackMarket: { priceFactor: 2.5, detectionChance: 0.25 },
  logistics: { supplyRangeKm: 300, limitedEfficiency: 0.7, cutEfficiency: 0.35 },
  mobilization: { infantryPerProvince: 1, incomePenalty: 0.25, stabilityPerDay: -1, minDays: 3 },
  industry: {
    importPriceFactor: 1.3,
    importDeliveryHours: 72,
    batchTimeFactor: 0.25,
    cancelRefund: 0.5,
    repairCostFactor: 0.5,
    offerHours: 72,
    blackMarketDeliveryHours: 96,
  },
  startingForces: {
    stackMax: {
      fighter: 24,
      bomber: 12,
      air_support: 8,
      helicopter: 24,
      drone: 24,
      tank: 60,
      ifv: 60,
      artillery: 36,
      air_defense: 12,
      strike_missile: 12,
      nuclear: 10,
      surface_ship: 4,
      submarine: 2,
      infantry: 12,
      space: 50,
      logistics: 20,
    } as Record<string, number>,
    maxStacksPerNation: 150,
  },
  buildings: {
    /**
     * Effets par bâtiment (clés lues par le moteur) :
     *  - refinery.oilPerDay : pétrole produit par jour (× santé) ;
     *  - power_plant.productionSpeed / researchSpeed : multiplicateurs pour sa province et les
     *    provinces voisines de la même nation (bonus × santé) ;
     *  - <bâtiment requis>.productionSpeed : vitesse de production de la province pour les systèmes
     *    qui en dépendent (à pleine santé ; moitié de la vitesse à santé nulle… mais production refusée
     *    si le bâtiment est détruit) ;
     *  - research_center.researchSpeed : bonus additif de vitesse de recherche par centre (× santé),
     *    plafonné par research_center.researchSpeedCap ;
     *  - military_base.supplyRangeFactor : portée de ravitaillement d'une base (× supplyRangeKm) ;
     *  - forward_base.rangeKm : portée d'un dépôt logistique avancé ;
     *  - fortification.armorPerLevel / maxLevel : blindage du défenseur par niveau ;
     *  - port.trade : un port non bloqué porte la part commerciale du revenu.
     */
    effects: {
      refinery: { oilPerDay: 20 },
      power_plant: { productionSpeed: 1.2, researchSpeed: 1.15 },
      arms_factory: { productionSpeed: 1 },
      air_base: { productionSpeed: 1 },
      port: { productionSpeed: 1, trade: 1 },
      military_base: { productionSpeed: 1, supplyRangeFactor: 1.5 },
      research_center: { productionSpeed: 1, researchSpeed: 0.15, researchSpeedCap: 1 },
      fortification: { armorPerLevel: 0.2, maxLevel: 3 },
      forward_base: { rangeKm: 400 },
    } as Record<string, Record<string, number>>,
    repairHours: 48,
    buildHours: {
      refinery: 336,
      power_plant: 504,
      port: 336,
      air_base: 240,
      military_base: 168,
      arms_factory: 504,
      research_center: 336,
      fortification: 72,
      forward_base: 24,
    } as Record<string, number>,
    buildCostUsd: {
      refinery: 2e9,
      power_plant: 3e9,
      port: 1.5e9,
      air_base: 1e9,
      military_base: 5e8,
      arms_factory: 2.5e9,
      research_center: 1.5e9,
      fortification: 2e8,
      forward_base: 1e8,
    } as Record<string, number>,
  },
};

export type EcoConfig = typeof ECO_DEFAULTS;

const cache = new WeakMap<World, EcoConfig>();

function merge<T extends object>(def: T, over: object | undefined): T {
  const out = { ...def } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Réglages résolus d'un monde (défauts + data/balance), mis en cache. */
export function cfg(world: World): EcoConfig {
  let c = cache.get(world);
  if (c) return c;
  const b: Balance = world.balance;
  const D = ECO_DEFAULTS;
  const effects: Record<string, Record<string, number>> = {};
  const over = b.buildings?.effects ?? {};
  for (const k of [...new Set([...Object.keys(D.buildings.effects), ...Object.keys(over)])].sort())
    effects[k] = { ...(D.buildings.effects[k] ?? {}), ...(over[k] ?? {}) };
  c = {
    money: merge(D.money, b.money),
    research: merge(D.research, b.research),
    licences: merge(D.licences, b.licences),
    blackMarket: merge(D.blackMarket, b.blackMarket),
    logistics: merge(D.logistics, b.logistics),
    mobilization: merge(D.mobilization, b.mobilization),
    industry: merge(D.industry, b.industry),
    startingForces: {
      stackMax: { ...D.startingForces.stackMax, ...(b.startingForces?.stackMax ?? {}) },
      maxStacksPerNation:
        b.startingForces?.maxStacksPerNation ?? D.startingForces.maxStacksPerNation,
    },
    buildings: {
      effects,
      repairHours: b.buildings?.repairHours ?? D.buildings.repairHours,
      buildHours: { ...D.buildings.buildHours, ...(b.buildings?.buildHours ?? {}) },
      buildCostUsd: { ...D.buildings.buildCostUsd, ...(b.buildings?.buildCostUsd ?? {}) },
    },
  };
  cache.set(world, c);
  return c;
}

export function effect(world: World, building: string, key: string, fallback = 0): number {
  return cfg(world).buildings.effects[building]?.[key] ?? fallback;
}

/** Bâtiment requis pour produire un système, déduit de sa catégorie si non précisé. */
export function requiredBuilding(sys: {
  category: Category;
  requiresBuilding?: BuildingType | undefined;
}): BuildingType {
  if (sys.requiresBuilding) return sys.requiresBuilding;
  switch (sys.category) {
    case 'fighter':
    case 'bomber':
    case 'air_support':
    case 'helicopter':
    case 'drone':
      return 'air_base';
    case 'surface_ship':
    case 'submarine':
      return 'port';
    case 'infantry':
    case 'logistics':
      return 'military_base';
    case 'space':
      return 'research_center';
    default:
      return 'arms_factory';
  }
}
