import type { Balance, BuildingType, Category, Resource } from '@redline/shared';
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
    budgetDollarFactor: 1,
  },
  /**
   * Entretien des unités (voir upkeep.ts) : facteurs par génération (absent = 1), catégories qui n'en
   * dépendent pas, part locale par catégorie (payée au niveau de prix de la nation), plafond et
   * plancher de la part du budget absorbée par l'entretien des forces de départ (0 = sans plancher).
   */
  upkeep: {
    generationFactor: {} as Record<string, number>,
    generationExempt: ['infantry'] as string[],
    localShare: {} as Record<string, number>,
    localShareDefault: 0.5,
    defaultCostIndex: 1,
    maxStartShare: 0.7,
    minStartShare: 0,
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
      radar: 6,
    } as Record<string, number>,
    maxStacksPerNation: 150,
    maxStacksWorld: 5000,
  },
  buildings: {
    /**
     * Effets par bâtiment. Sauf mention contraire, un effet « par niveau » est multiplié par le niveau
     * (1 à 5) et par la santé (0..1) du bâtiment.
     *  - refinery.oilPerDay : pétrole par jour et par niveau ;
     *  - oil_field / mine / farm / electronics_plant : yieldPerLevel (part du rendement de la province
     *    dans la ressource correspondante) + flatPerLevel (production fixe) ;
     *  - power_plant.productionSpeed / researchSpeed : bonus (effet − 1) × niveau × santé pour sa
     *    province et les provinces voisines de la même nation ;
     *  - <bâtiment requis>.productionSpeed : vitesse de production nominale, levelSpeed : bonus par
     *    niveau au-delà du premier ; vitesse × (0,5 + 0,5 × santé) ; production refusée si détruit ;
     *  - research_center.researchSpeed / secret_lab.researchSpeedPerLevel : bonus additifs de vitesse
     *    de recherche nationale, plafonnés par research_center.researchSpeedCap ;
     *  - local_industry.incomePerLevel (revenu de la province) et buildSpeedPerLevel (chantiers) ;
     *  - recruiting_office.mobilizationPerLevel : bataillons supplémentaires à la mobilisation ;
     *  - naval_base.healPerLevel / hospital.healPerLevel : part des points de vie rendus par jour ;
     *  - bunker.armorPerLevel / fortification.armorPerLevel (+ maxLevel) : blindage du défenseur ;
     *  - military_base.supplyRangeFactor, forward_base.rangeKm (+ rangePerLevel) : ravitaillement ;
     *  - air_defense_site / coastal_battery / radar_station.rangeKmPerLevel : portée exposée au
     *    module militaire (board.sites) ;
     *  - port.trade : un port non bloqué porte la part commerciale du revenu.
     */
    effects: {
      refinery: { oilPerDay: 20 },
      oil_field: { yieldPerLevel: 0.5, flatPerLevel: 0 },
      mine: { yieldPerLevel: 0.5, flatPerLevel: 0 },
      farm: { yieldPerLevel: 0.4, flatPerLevel: 3 },
      electronics_plant: {
        yieldPerLevel: 0.5,
        flatPerLevel: 2,
        productionSpeed: 1,
        levelSpeed: 0.1,
      },
      local_industry: { incomePerLevel: 0.05, buildSpeedPerLevel: 0.1 },
      power_plant: { productionSpeed: 1.2, researchSpeed: 1.15 },
      arms_factory: { productionSpeed: 1, levelSpeed: 0.15 },
      air_base: { productionSpeed: 1, levelSpeed: 0.15 },
      port: { productionSpeed: 1, levelSpeed: 0.1, trade: 1 },
      naval_base: { productionSpeed: 1.2, levelSpeed: 0.15, healPerLevel: 0.1 },
      military_base: { productionSpeed: 1, levelSpeed: 0.15, supplyRangeFactor: 1.5 },
      recruiting_office: { productionSpeed: 1.2, levelSpeed: 0.15, mobilizationPerLevel: 1 },
      research_center: {
        productionSpeed: 1,
        levelSpeed: 0.1,
        researchSpeed: 0.15,
        researchSpeedCap: 1.5,
      },
      secret_lab: { productionSpeed: 1, levelSpeed: 0.1, researchSpeedPerLevel: 0.1 },
      missile_silo: { productionSpeed: 1, levelSpeed: 0.1 },
      hospital: { healPerLevel: 0.1 },
      bunker: { armorPerLevel: 0.25 },
      air_defense_site: { rangeKmPerLevel: 40 },
      coastal_battery: { rangeKmPerLevel: 60 },
      radar_station: { rangeKmPerLevel: 150 },
      fortification: { armorPerLevel: 0.2, maxLevel: 3 },
      forward_base: { rangeKm: 400, rangePerLevel: 0.25 },
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
      oil_field: 240,
      mine: 240,
      farm: 120,
      electronics_plant: 336,
      local_industry: 336,
      recruiting_office: 72,
      naval_base: 504,
      bunker: 96,
      air_defense_site: 240,
      coastal_battery: 168,
      radar_station: 168,
      missile_silo: 504,
      hospital: 168,
      secret_lab: 504,
      forward_base: 24,
      fortification: 72,
    } as Record<string, number>,
    buildCostUsd: {
      refinery: 2e8,
      power_plant: 3e8,
      port: 1.5e8,
      air_base: 1e8,
      military_base: 5e7,
      arms_factory: 2.5e8,
      research_center: 1.5e8,
      oil_field: 8e7,
      mine: 6e7,
      farm: 2e7,
      electronics_plant: 1.2e8,
      local_industry: 1e8,
      recruiting_office: 1e7,
      naval_base: 2e8,
      bunker: 3e7,
      air_defense_site: 1.5e8,
      coastal_battery: 8e7,
      radar_station: 5e7,
      missile_silo: 2e8,
      hospital: 3e7,
      secret_lab: 2.5e8,
      forward_base: 1e7,
      fortification: 2e7,
    } as Record<string, number>,
    maxLevel: 5,
    levelCostGrowth: 1.6,
    levelTimeGrowth: 0.25,
    distribute: true,
  },
  /**
   * Ressources des provinces (ProvinceDef.resources) : bâtiments d'extraction réservés aux provinces
   * qui ont la ressource, rendement selon la richesse (1..3) et le rang (principale / secondaire),
   * usine d'électronique dans un pôle ou une grande ville (rang ≤ electronicsUrbanRank), bonus de
   * revenu des provinces « argent seulement » (services, finances) et de leur industrie locale
   * (quartier d'affaires), bâtiments côtiers. Carte sans `resources` : aucune restriction.
   */
  resources: {
    extraction: { oil_field: 'oil', mine: 'metals', farm: 'food' } as Record<string, Resource>,
    electronicsUrbanRank: 2,
    richnessYield: [0.8, 1, 1.25] as [number, number, number],
    secondaryYield: 0.7,
    servicesIncomeBonus: 0.1,
    servicesIndustryFactor: 1.5,
    coastalOnly: ['port', 'naval_base', 'coastal_battery'] as string[],
    /**
     * Plancher national de production (par jour) : max(minPerDay, economyShare × poids économique de
     * la nation × production mondiale de la carte). Voir budget.ts `nationalFloor`.
     */
    nationalFloor: {
      economyShare: 0.05,
      minPerDay: { oil: 1, metals: 1, electronics: 1, food: 2 } as Partial<
        Record<Resource, number>
      >,
    },
  },
  morale: {
    start: 70,
    occupied: 30,
    recoveryPerDay: 2,
    hitPenalty: 10,
    nuclearPenalty: 50,
    shortagePenalty: 5,
    incomeFloor: 0.5,
  },
  consumption: {
    foodPerInfantry: 0.02,
    oilPerVehicle: 0.005,
    oilPerAircraft: 0.03,
    oilPerShip: 0.1,
    electronicsPerSpace: 0.02,
    shortageProductionFactor: 0.5,
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
  const B = b.buildings;
  c = {
    money: merge(D.money, b.money),
    upkeep: {
      ...merge(D.upkeep, b.upkeep),
      generationFactor: { ...D.upkeep.generationFactor, ...(b.upkeep?.generationFactor ?? {}) },
      localShare: { ...D.upkeep.localShare, ...(b.upkeep?.localShare ?? {}) },
    },
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
      maxStacksWorld: b.startingForces?.maxStacksWorld ?? D.startingForces.maxStacksWorld,
    },
    buildings: {
      effects,
      repairHours: B?.repairHours ?? D.buildings.repairHours,
      buildHours: { ...D.buildings.buildHours, ...(B?.buildHours ?? {}) },
      buildCostUsd: { ...D.buildings.buildCostUsd, ...(B?.buildCostUsd ?? {}) },
      maxLevel: B?.maxLevel ?? D.buildings.maxLevel,
      levelCostGrowth: B?.levelCostGrowth ?? D.buildings.levelCostGrowth,
      levelTimeGrowth: B?.levelTimeGrowth ?? D.buildings.levelTimeGrowth,
      distribute: B?.distribute ?? D.buildings.distribute,
    },
    resources: {
      ...merge(D.resources, b.resources),
      extraction: b.resources?.extraction ?? D.resources.extraction,
      nationalFloor: {
        economyShare:
          b.resources?.nationalFloor?.economyShare ?? D.resources.nationalFloor.economyShare,
        minPerDay: b.resources?.nationalFloor?.minPerDay ?? D.resources.nationalFloor.minPerDay,
      },
    },
    morale: merge(D.morale, b.morale),
    consumption: merge(D.consumption, b.consumption),
  };
  cache.set(world, c);
  return c;
}

export function effect(world: World, building: string, key: string, fallback = 0): number {
  return cfg(world).buildings.effects[building]?.[key] ?? fallback;
}

/**
 * Bâtiments qui permettent de produire un système (l'un d'eux suffit) : `requiresBuilding` s'il est
 * précisé, sinon selon la catégorie.
 */
export function requiredBuildings(sys: {
  category: Category;
  requiresBuilding?: BuildingType | undefined;
  missile?: { kind: string } | undefined;
}): BuildingType[] {
  if (sys.requiresBuilding) return [sys.requiresBuilding];
  switch (sys.category) {
    case 'fighter':
    case 'bomber':
    case 'air_support':
    case 'helicopter':
    case 'drone':
      return ['air_base'];
    case 'surface_ship':
    case 'submarine':
      return ['naval_base', 'port'];
    case 'infantry':
      return ['recruiting_office', 'military_base'];
    case 'logistics':
      return ['military_base'];
    case 'space':
      return ['research_center', 'secret_lab'];
    case 'radar':
      return ['electronics_plant', 'arms_factory'];
    case 'nuclear':
      return sys.missile?.kind === 'icbm' ? ['missile_silo', 'arms_factory'] : ['arms_factory'];
    default:
      return ['arms_factory'];
  }
}

/** Économie réelle dès que la recherche ou les ORBAT sont chargés (sinon comportement phase 1). */
export function isLiveWorld(world: World): boolean {
  return !!(world.research || world.orbats);
}
