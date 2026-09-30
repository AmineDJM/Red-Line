import {
  BalanceSchema,
  ResearchNodeSchema,
  OrbatSchema,
  WeaponSystemSchema,
  type BuildingType,
  type MapData,
  type Orbat,
  type ResearchNode,
  type WeaponSystem,
  type WeaponSystemInput,
} from '@redline/shared';
import { buildWorld, createGame, type GameSetup, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, CATALOG, buildMap } from './fixtures.js';

/**
 * Fixtures synthétiques de l'économie réelle : bâtiments sur la carte de test, systèmes à portes de
 * recherche, arbre de recherche et ORBAT de test (indépendants des données réelles).
 */
const BUILDINGS: Record<string, BuildingType[]> = {
  'aaa-1': ['port', 'power_plant', 'refinery'],
  'aaa-2': ['military_base', 'air_base', 'arms_factory', 'research_center'],
  'aaa-3': ['air_base'],
  'bbb-2': ['military_base', 'air_base', 'arms_factory', 'port'],
  'bbb-4': ['air_base'],
  'ccc-1': ['military_base', 'arms_factory'],
  'ddd-1': ['port', 'air_base'],
};

const INCOME: Record<string, number> = { 'aaa-1': 100, 'aaa-2': 300, 'aaa-3': 100 };

export function ecoMap(): MapData {
  const m = buildMap();
  return {
    ...m,
    provinces: m.provinces.map((p) => ({
      ...p,
      buildings: BUILDINGS[p.id] ?? [],
      income: { ...p.income, money: INCOME[p.id] ?? p.income.money },
    })),
  };
}

const zero = {
  infantry: 0,
  armor: 0,
  aircraft: 0,
  helicopter: 0,
  drone: 0,
  ship: 0,
  submarine: 0,
  missile: 0,
  building: 0,
};

function sys(
  p: Partial<WeaponSystemInput> &
    Pick<WeaponSystemInput, 'id' | 'category' | 'targetClass' | 'movement'>,
): WeaponSystem {
  return WeaponSystemSchema.parse({
    name: p.id,
    doctrine: 'other',
    origin: 'XX',
    generation: 4,
    canCapture: false,
    cost: { money: 1e6, resources: {} },
    buildTimeH: 24,
    upkeepPerDay: 1000,
    speedKmh: 40,
    operationalRadiusKm: null,
    weaponRangeKm: { min: 0, max: 0 },
    damage: zero,
    hp: 20,
    armor: 0,
    stealth: 0,
    detectionRangeKm: 20,
    ew: { jamming: 0, jamResistance: 0 },
    payload: { slots: 0 },
    unitSize: 1,
    requires: [],
    licensable: false,
    exportable: false,
    icon: 'unit',
    sheet: {
      engine: null,
      lengthM: null,
      wingspanM: null,
      mtowKg: null,
      warheadKg: null,
      speedLabel: null,
      rangeKm: null,
    },
    ...p,
  });
}

export const ECO_SYSTEMS: WeaponSystem[] = [
  sys({
    id: 'ru.su-57',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 2000,
    operationalRadiusKm: 1500,
    hp: 30,
    cost: { money: 40e6, resources: { electronics: 5 } },
    unitPriceUsd: 40e6,
    buildTimeH: 48,
    upkeepPerDay: 30_000,
    requires: ['research.aero.gen5'],
    licensable: true,
    exportable: false,
  }),
  sys({
    id: 'us.f-16',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 2000,
    operationalRadiusKm: 1500,
    hp: 25,
    cost: { money: 30e6, resources: {} },
    unitPriceUsd: 30e6,
    buildTimeH: 36,
    upkeepPerDay: 20_000,
    requires: ['research.aero.gen4'],
    licensable: true,
    exportable: true,
  }),
  sys({
    id: 'tst.icbm',
    category: 'nuclear',
    targetClass: 'building',
    movement: 'static',
    speedKmh: 0,
    cost: { money: 50e6, resources: {} },
    requires: ['research.nuclear.icbm'],
    licensable: true,
    exportable: true,
  }),
  sys({
    id: 'other.supply-convoy',
    category: 'logistics',
    targetClass: 'armor',
    movement: 'land',
    speedKmh: 60,
    hp: 10,
    upkeepPerDay: 0,
  }),
  sys({
    id: 'other.cargo-ship',
    category: 'logistics',
    targetClass: 'ship',
    movement: 'sea',
    speedKmh: 30,
    hp: 30,
    upkeepPerDay: 0,
  }),
  sys({
    id: 'other.cargo-aircraft',
    category: 'logistics',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 700,
    hp: 15,
    upkeepPerDay: 0,
  }),
];

export const ECO_CATALOG: WeaponSystem[] = [...CATALOG, ...ECO_SYSTEMS];

function node(p: Partial<ResearchNode> & Pick<ResearchNode, 'id' | 'branch' | 'tier'>) {
  return ResearchNodeSchema.parse({
    name: p.id,
    cost: { money: 1e8, resources: {} },
    durationH: 48,
    ...p,
  });
}

export const RESEARCH: ResearchNode[] = [
  node({ id: 'research.industry.l1', branch: 'industry', tier: 0, effects: { 'production.speed': 1.25 } }),
  node({ id: 'research.aero.gen4', branch: 'aero', tier: 3 }),
  node({ id: 'research.aero.gen4plus', branch: 'aero', tier: 4, requires: ['research.aero.gen4'] }),
  node({
    id: 'research.aero.gen5',
    branch: 'aero',
    tier: 5,
    requires: ['research.aero.gen4plus'],
    cost: { money: 1e9, resources: { electronics: 10 } },
    durationH: 240,
    effects: { 'combat.damage': 1.1 },
  }),
  node({ id: 'research.nuclear.icbm', branch: 'missiles', tier: 5, durationH: 500 }),
  node({ id: 'research.future.laser', branch: 'sensors', tier: 6, eraYear: 2040 }),
];

export const ORBATS: Orbat[] = [
  OrbatSchema.parse({
    nationId: 'aaa',
    year: 2025,
    doctrine: 'ru',
    defenseBudgetUsd: 36.5e9,
    inventory: [
      { systemId: 'ru.su-57', count: 14 },
      { systemId: 'us.f-16', count: 50 },
      { systemId: 'tst.tank', count: 130 },
      { systemId: 'tst.infantry', count: 25 },
      { systemId: 'tst.sam', count: 13 },
      { systemId: 'tst.frigate', count: 5 },
      { systemId: 'xx.absent', count: 3 },
    ],
    research: ['research.aero.gen4', 'research.aero.gen4plus'],
  }),
  OrbatSchema.parse({
    nationId: 'bbb',
    year: 2025,
    doctrine: 'us',
    defenseBudgetUsd: 73e9,
    inventory: [
      { systemId: 'tst.infantry', count: 10 },
      { systemId: 'tst.fighter', count: 3 },
    ],
    research: [],
  }),
  OrbatSchema.parse({
    nationId: 'ddd',
    year: 2025,
    doctrine: 'other',
    defenseBudgetUsd: 3.65e9,
    inventory: [{ systemId: 'tst.infantry', count: 2 }],
  }),
];

export const ECO_BALANCE = BalanceSchema.parse({
  ...BALANCE,
  money: {},
  research: {},
  licences: {},
  blackMarket: {},
  logistics: {},
  mobilization: {},
  industry: {},
  buildings: {},
});

let cached: World | null = null;

export function ecoWorld(): World {
  if (!cached)
    cached = buildWorld(ecoMap(), ECO_CATALOG, ECO_BALANCE, {
      research: RESEARCH,
      orbats: { '2025': ORBATS },
    });
  return cached;
}

export function ecoGame(
  opts: {
    seed?: number;
    players?: GameSetup['players'];
    units?: GameSetup['units'];
    world?: World;
    year?: number;
  } = {},
): EngineState {
  return createGame(opts.world ?? ecoWorld(), {
    seed: opts.seed ?? 1,
    players: opts.players ?? [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
      { nationId: 'ccc', isAi: false },
      { nationId: 'ddd', isAi: false },
    ],
    ...(opts.units ? { units: opts.units } : {}),
    ...(opts.year
      ? {
          scenario: {
            id: 'test',
            name: 'test',
            description: '',
            playableNations: 'all',
            year: opts.year,
            orbatSet: '2025',
          },
        }
      : {}),
  }) as EngineState;
}

export function upkeepOf(state: EngineState, n: string): number {
  let s = 0;
  for (const u of Object.values(state.units))
    if (u.owner === n) s += state.world.catalog.get(u.sys)!.upkeepPerDay * u.count;
  return s;
}
