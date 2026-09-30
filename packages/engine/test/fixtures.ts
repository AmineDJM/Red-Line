import { gridDisk, gridPathCells, latLngToCell, polygonToCells } from 'h3-js';
import {
  BalanceSchema,
  WeaponSystemSchema,
  type Balance,
  type LngLat,
  type MapData,
  type ProvinceDef,
  type WeaponSystem,
  type WeaponSystemInput,
} from '@redline/shared';
import { buildWorld, createGame, type GameSetup, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';

/**
 * Carte synthétique (H3 résolution 4) :
 *
 *   lat 50 ┌──────┬───────────────┬──────┐
 *          │ a-3  │  c-1  │  c-2  │ b-3  │
 *   lat 46 │──────┼───────────────┤──────│
 *          │ a-2  │  mer intérieure  b-2 │ ← détroit (lat 44) vers l'océan à l'est
 *   lat 42 │──────┼───────────────┤──────│
 *          │ a-1  │  b-4  │  b-5  │ b-1  │          ┌─────┐ île d-1 (lon 24–27, lat 42–45)
 *   lat 38 └──────┴───────────────┴──────┘          └─────┘
 *        lon 0    5              15     20
 */
export const RES = 4;

interface ProvSpec {
  id: string;
  nation: string;
  rect: [number, number, number, number]; // lonMin, latMin, lonMax, latMax
  capital?: boolean;
}

export const PROVINCES: ProvSpec[] = [
  { id: 'aaa-1', nation: 'aaa', rect: [0, 38, 5, 42] },
  { id: 'aaa-2', nation: 'aaa', rect: [0, 42, 5, 46], capital: true },
  { id: 'aaa-3', nation: 'aaa', rect: [0, 46, 5, 50] },
  { id: 'ccc-1', nation: 'ccc', rect: [5, 46, 10, 50], capital: true },
  { id: 'ccc-2', nation: 'ccc', rect: [10, 46, 15, 50] },
  { id: 'bbb-1', nation: 'bbb', rect: [15, 38, 20, 42] },
  { id: 'bbb-2', nation: 'bbb', rect: [15, 42, 20, 46], capital: true },
  { id: 'bbb-3', nation: 'bbb', rect: [15, 46, 20, 50] },
  { id: 'bbb-4', nation: 'bbb', rect: [5, 38, 10, 42] },
  { id: 'bbb-5', nation: 'bbb', rect: [10, 38, 15, 42] },
  { id: 'ddd-1', nation: 'ddd', rect: [24, 42, 27, 45], capital: true },
];

export function rectCenter(r: [number, number, number, number]): LngLat {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}

export function cityOf(id: string): LngLat {
  return rectCenter(PROVINCES.find((p) => p.id === id)!.rect);
}

export function buildMap(opts: { strait?: boolean } = {}): MapData {
  const cells: Record<string, string> = {};
  for (const p of PROVINCES) {
    const [x0, y0, x1, y1] = p.rect;
    const ring = [
      [y0, x0],
      [y0, x1],
      [y1, x1],
      [y1, x0],
      [y0, x0],
    ];
    for (const c of polygonToCells(ring, RES)) cells[c] = p.id;
  }
  const provNeighbors = new Map<string, Set<string>>();
  const coastal = new Set<string>();
  const counts = new Map<string, number>();
  for (const [c, pid] of Object.entries(cells)) {
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
    for (const n of gridDisk(c, 1)) {
      const q = cells[n];
      if (!q) coastal.add(pid);
      else if (q !== pid) {
        if (!provNeighbors.has(pid)) provNeighbors.set(pid, new Set());
        provNeighbors.get(pid)!.add(q);
      }
    }
  }
  const provinces: ProvinceDef[] = PROVINCES.map((p) => ({
    id: p.id,
    name: `Province ${p.id}`,
    nationId: p.nation,
    centroid: rectCenter(p.rect),
    cityPoint: rectCenter(p.rect),
    isCapital: !!p.capital,
    coastal: coastal.has(p.id),
    income: { money: 100, oil: 5, metals: 5 },
    buildings: p.capital ? ['military_base'] : [],
    neighbors: [...(provNeighbors.get(p.id) ?? [])].sort(),
    areaKm2: (counts.get(p.id) ?? 0) * 1770,
  }));
  const colors: Record<string, string> = {
    aaa: '#aa0000',
    bbb: '#0000aa',
    ccc: '#00aa00',
    ddd: '#aaaa00',
  };
  const nations = ['aaa', 'bbb', 'ccc', 'ddd'].map((id) => ({
    id,
    iso: id.toUpperCase(),
    name: `Nation ${id.toUpperCase()}`,
    kind: 'state' as const,
    color: colors[id]!,
    capitalProvinceId: PROVINCES.find((p) => p.nation === id && p.capital)!.id,
  }));
  const straits = [];
  if (opts.strait !== false) {
    const path = gridPathCells(latLngToCell(44, 14.6, RES), latLngToCell(44, 20.6, RES));
    straits.push({ id: 'detroit-est', name: 'Détroit de l’Est', seaCells: path });
  }
  return { nations, provinces, cells: { res: RES, cells }, straits, disputed: [] };
}

const zeroDamage = {
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

function sys(p: Partial<WeaponSystemInput> & Pick<WeaponSystemInput, 'id' | 'category' | 'targetClass' | 'movement'>): WeaponSystem {
  return WeaponSystemSchema.parse({
    name: p.id,
    doctrine: 'other',
    origin: 'XX',
    generation: 3,
    canCapture: false,
    cost: { money: 200, resources: {} },
    buildTimeH: 12,
    upkeepPerDay: 5,
    speedKmh: 40,
    operationalRadiusKm: null,
    weaponRangeKm: { min: 0, max: 0 },
    damage: zeroDamage,
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

export const CATALOG: WeaponSystem[] = [
  sys({
    id: 'tst.infantry',
    category: 'infantry',
    targetClass: 'infantry',
    movement: 'land',
    canCapture: true,
    speedKmh: 30,
    weaponRangeKm: { min: 0, max: 3 },
    damage: { ...zeroDamage, infantry: 4, armor: 1, helicopter: 1 },
    hp: 10,
    unitSize: 3,
    detectionRangeKm: 20,
    cost: { money: 100, resources: { food: 5 } },
  }),
  sys({
    id: 'tst.tank',
    category: 'tank',
    targetClass: 'armor',
    movement: 'land',
    canCapture: true,
    speedKmh: 50,
    weaponRangeKm: { min: 0, max: 4 },
    damage: { ...zeroDamage, infantry: 6, armor: 8, building: 4, helicopter: 1 },
    hp: 30,
    armor: 0.3,
    unitSize: 2,
    detectionRangeKm: 25,
    cost: { money: 300, resources: { oil: 10, metals: 10 } },
  }),
  sys({
    id: 'tst.artillery',
    category: 'artillery',
    targetClass: 'armor',
    movement: 'land',
    speedKmh: 30,
    weaponRangeKm: { min: 5, max: 40 },
    damage: { ...zeroDamage, infantry: 5, armor: 4, building: 6 },
    hp: 15,
    detectionRangeKm: 30,
  }),
  sys({
    id: 'tst.sam',
    category: 'air_defense',
    targetClass: 'armor',
    movement: 'land',
    speedKmh: 30,
    weaponRangeKm: { min: 0, max: 80 },
    damage: { ...zeroDamage, aircraft: 20, helicopter: 20, drone: 15, missile: 10 },
    hp: 20,
    detectionRangeKm: 120,
    cost: { money: 400, resources: { electronics: 10 } },
  }),
  sys({
    id: 'tst.fighter',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 1800,
    operationalRadiusKm: 800,
    weaponRangeKm: { min: 0, max: 60 },
    damage: { ...zeroDamage, aircraft: 12, helicopter: 10, drone: 8, armor: 1, infantry: 1 },
    hp: 25,
    stealth: 0.1,
    detectionRangeKm: 150,
    ew: { jamming: 0, jamResistance: 0.4 },
    cost: { money: 800, resources: { electronics: 20 } },
  }),
  sys({
    id: 'tst.stealth',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 1900,
    operationalRadiusKm: 900,
    weaponRangeKm: { min: 0, max: 60 },
    damage: { ...zeroDamage, aircraft: 14, helicopter: 10, drone: 8 },
    hp: 25,
    stealth: 0.8,
    detectionRangeKm: 150,
  }),
  sys({
    id: 'tst.helo',
    category: 'helicopter',
    targetClass: 'helicopter',
    movement: 'air',
    speedKmh: 250,
    operationalRadiusKm: 600,
    hp: 20,
    detectionRangeKm: 30,
  }),
  sys({
    id: 'tst.drone',
    category: 'drone',
    targetClass: 'drone',
    movement: 'air',
    speedKmh: 200,
    operationalRadiusKm: 1000,
    hp: 5,
    stealth: 0.3,
    detectionRangeKm: 250,
  }),
  sys({
    id: 'tst.jammer',
    category: 'air_support',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 800,
    operationalRadiusKm: 1000,
    hp: 20,
    detectionRangeKm: 150,
    ew: { jamming: 0.5, jamResistance: 0.5 },
  }),
  sys({
    id: 'tst.frigate',
    category: 'surface_ship',
    targetClass: 'ship',
    movement: 'sea',
    speedKmh: 50,
    weaponRangeKm: { min: 0, max: 100 },
    damage: { ...zeroDamage, ship: 10, aircraft: 8, helicopter: 8, missile: 5 },
    hp: 60,
    detectionRangeKm: 150,
    cost: { money: 900, resources: { metals: 30 } },
  }),
  sys({
    id: 'tst.radar',
    category: 'air_defense',
    targetClass: 'building',
    movement: 'static',
    speedKmh: 0,
    hp: 15,
    detectionRangeKm: 200,
  }),
];

export const BALANCE: Balance = BalanceSchema.parse({
  version: 1,
  time: { speeds: [1, 2, 4], combatRoundMinutes: 10, captureMinutes: 60, aiThinkMinutes: 30 },
  combat: {
    variance: 0.1,
    groundContactKm: 8,
    defenderCityBonus: 0.25,
    veterancyXp: [50, 150, 400],
    veterancyDamageBonus: 0.1,
  },
  movement: { embarkedSpeedFactor: 0.5, embarkMinutes: 60 },
  sensors: {
    provinceDetectionKm: 60,
    identifiedAtFraction: 0.6,
    preciseAtFraction: 0.3,
    uncertaintyGrowthKmh: 20,
    forgetAfterMinutes: 360,
  },
  economy: {
    startingMoney: 2000,
    startingResources: { oil: 100, metals: 100, electronics: 100, food: 100 },
    incomeMultiplier: 1,
  },
  victory: { provinceShare: 0.7, allEnemyCapitals: false },
  startingArmy: [
    { systemId: 'tst.infantry', count: 2 },
    { systemId: 'tst.tank', count: 1 },
    { systemId: 'tst.sam', count: 1 },
    { systemId: 'tst.fighter', count: 1 },
  ],
  garrisonArmy: [
    { systemId: 'tst.infantry', count: 2 },
    { systemId: 'tst.sam', count: 1 },
  ],
});

let cachedWorld: World | null = null;

export function testWorld(): World {
  if (!cachedWorld) cachedWorld = buildWorld(buildMap(), CATALOG, BALANCE);
  return cachedWorld;
}

export function worldWith(balance: Partial<Balance>, catalog = CATALOG, map?: MapData): World {
  return buildWorld(map ?? testWorld().map, catalog, { ...BALANCE, ...balance });
}

/** Partie sans armée de départ, avec les unités données (humains : aaa, bbb ; IA passives ailleurs). */
export function sandbox(
  units: GameSetup['units'],
  opts: { world?: World; players?: GameSetup['players']; seed?: number } = {},
): EngineState {
  return createGame(opts.world ?? testWorld(), {
    seed: opts.seed ?? 1,
    players: opts.players ?? [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
      { nationId: 'ccc', isAi: false },
      { nationId: 'ddd', isAi: false },
    ],
    units: units ?? [],
  }) as EngineState;
}

export function unitsOf(state: EngineState, owner: string, sys?: string) {
  return Object.values(state.units)
    .filter((u) => u.owner === owner && (!sys || u.sys === sys))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
