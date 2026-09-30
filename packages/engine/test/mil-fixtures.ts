import {
  WeaponSystemSchema,
  type GameNotification,
  type MapData,
  type WeaponSystem,
  type WeaponSystemInput,
} from '@redline/shared';
import { buildWorld, createGame, type GameSetup, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, CATALOG, buildMap } from './fixtures.js';
import { diploModule } from '../src/modules/diplo/index.js';

/**
 * Monde de test du module militaire : carte synthétique de fixtures.ts avec bases aériennes et ports,
 * catalogue de test complété (aéronefs à carburant, ravitailleur, avion radar, lanceurs, défense
 * antimissile, navires, sous-marin, porte-avions, forces spéciales, satellites).
 */

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
    generation: 3,
    canCapture: false,
    cost: { money: 200, resources: {} },
    buildTimeH: 12,
    upkeepPerDay: 5,
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

const SHEET = (rangeKm: number) => ({
  engine: null,
  lengthM: null,
  wingspanM: null,
  mtowKg: null,
  warheadKg: null,
  speedLabel: null,
  rangeKm,
});

export const MIL_CATALOG: WeaponSystem[] = [
  ...CATALOG,
  sys({
    id: 'tst.jet',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 900,
    operationalRadiusKm: 1000,
    weaponRangeKm: { min: 0, max: 60 },
    damage: { ...zero, aircraft: 12, helicopter: 10, drone: 8, armor: 2, infantry: 2, building: 4, missile: 4 },
    hp: 25,
    detectionRangeKm: 150,
    air: { fuelH: 3, refuelable: true },
  }),
  sys({
    id: 'tst.navyjet',
    category: 'fighter',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 900,
    operationalRadiusKm: 800,
    weaponRangeKm: { min: 0, max: 60 },
    damage: { ...zero, aircraft: 12, ship: 6 },
    hp: 25,
    detectionRangeKm: 150,
    air: { fuelH: 3, refuelable: true, carrierCapable: true },
  }),
  sys({
    id: 'tst.tanker',
    category: 'air_support',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 800,
    operationalRadiusKm: 2500,
    hp: 30,
    detectionRangeKm: 60,
    air: { fuelH: 12, tankerFuelH: 8 },
  }),
  sys({
    id: 'tst.awacs',
    category: 'air_support',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 700,
    operationalRadiusKm: 2000,
    hp: 30,
    detectionRangeKm: 100,
    sensor: { kind: 'aew', rangeKm: 400, stealthDetect: 0.3 },
    air: { fuelH: 10 },
  }),
  sys({
    id: 'tst.bomber',
    category: 'bomber',
    targetClass: 'aircraft',
    movement: 'air',
    speedKmh: 800,
    operationalRadiusKm: 2000,
    weaponRangeKm: { min: 0, max: 5 },
    damage: { ...zero, building: 30, armor: 10, infantry: 10 },
    hp: 40,
    detectionRangeKm: 80,
    air: { fuelH: 10 },
  }),
  // Munitions (catalogue réel) : piles de missiles en stock, mouvement « air », consommées au tir.
  sys({
    id: 'tst.cruise',
    category: 'strike_missile',
    targetClass: 'missile',
    movement: 'air',
    speedKmh: 800,
    operationalRadiusKm: 1500,
    weaponRangeKm: { min: 0, max: 1500 },
    damage: { ...zero, building: 40, armor: 25, infantry: 25, ship: 30 },
    hp: 10,
    detectionRangeKm: 20,
    missile: { kind: 'cruise', speedKmh: 800, warhead: 'conventional', evasion: 0, blastKm: 1 },
  }),
  sys({
    id: 'tst.ballistic',
    category: 'strike_missile',
    targetClass: 'missile',
    movement: 'air',
    speedKmh: 6000,
    operationalRadiusKm: 1500,
    weaponRangeKm: { min: 0, max: 1500 },
    damage: { ...zero, building: 60, armor: 40, infantry: 40 },
    hp: 10,
    detectionRangeKm: 20,
    missile: { kind: 'ballistic', speedKmh: 6000, warhead: 'conventional', evasion: 0.5, blastKm: 2 },
  }),
  sys({
    id: 'tst.icbm',
    category: 'nuclear',
    targetClass: 'missile',
    movement: 'air',
    speedKmh: 20000,
    weaponRangeKm: { min: 0, max: 12000 },
    damage: { ...zero, building: 500, armor: 500, infantry: 500, ship: 500 },
    hp: 10,
    detectionRangeKm: 20,
    missile: { kind: 'icbm', speedKmh: 20000, warhead: 'nuclear', evasion: 0.9, blastKm: 30 },
  }),
  sys({
    id: 'tst.lancet',
    category: 'drone',
    targetClass: 'drone',
    movement: 'air',
    roles: ['loitering_munition'],
    speedKmh: 110,
    operationalRadiusKm: 40,
    weaponRangeKm: { min: 0, max: 40 },
    damage: { ...zero, armor: 30, infantry: 15 },
    hp: 5,
    detectionRangeKm: 15,
    air: { fuelH: 0.7 },
    missile: { kind: 'cruise', speedKmh: 110, warhead: 'conventional', evasion: 0.1, blastKm: 0.1 },
  }),
  sys({
    id: 'tst.patriot',
    category: 'air_defense',
    targetClass: 'armor',
    movement: 'land',
    speedKmh: 30,
    weaponRangeKm: { min: 1, max: 100 },
    damage: { ...zero, aircraft: 20, helicopter: 14, drone: 8, missile: 18 },
    hp: 20,
    detectionRangeKm: 150,
    interceptor: { against: ['cruise', 'ballistic', 'aircraft'], pk: 0.7, magazine: 4 },
  }),
  sys({
    id: 'tst.destroyer',
    category: 'surface_ship',
    targetClass: 'ship',
    movement: 'sea',
    speedKmh: 55,
    weaponRangeKm: { min: 0, max: 80 },
    damage: { ...zero, ship: 12, aircraft: 10, missile: 10 },
    hp: 80,
    detectionRangeKm: 150,
    naval: { submerged: false, asw: 0, aircraftCapacity: 0, launchCells: 8 },
  }),
  sys({
    id: 'tst.aswfrigate',
    category: 'surface_ship',
    targetClass: 'ship',
    movement: 'sea',
    speedKmh: 50,
    weaponRangeKm: { min: 0, max: 40 },
    damage: { ...zero, ship: 10, submarine: 15 },
    hp: 60,
    detectionRangeKm: 120,
    sensor: { kind: 'sonar', rangeKm: 40, stealthDetect: 0 },
    naval: { submerged: false, asw: 0.8, aircraftCapacity: 0, launchCells: 0 },
  }),
  sys({
    id: 'tst.sub',
    category: 'submarine',
    targetClass: 'submarine',
    movement: 'sea',
    speedKmh: 40,
    weaponRangeKm: { min: 0, max: 30 },
    damage: { ...zero, ship: 20 },
    hp: 50,
    stealth: 0.3,
    detectionRangeKm: 50,
    naval: { submerged: true, asw: 0, aircraftCapacity: 0, launchCells: 4 },
  }),
  sys({
    id: 'tst.carrier',
    category: 'surface_ship',
    targetClass: 'ship',
    movement: 'sea',
    speedKmh: 50,
    hp: 200,
    detectionRangeKm: 150,
    naval: { submerged: false, asw: 0, aircraftCapacity: 4, launchCells: 0 },
  }),
  sys({
    id: 'tst.sf',
    category: 'infantry',
    targetClass: 'infantry',
    movement: 'land',
    roles: ['special_forces'],
    speedKmh: 60,
    weaponRangeKm: { min: 0, max: 3 },
    damage: { ...zero, infantry: 6, armor: 3, building: 5 },
    hp: 10,
    detectionRangeKm: 20,
    stealth: 0.5,
  }),
  sys({
    id: 'tst.optsat',
    category: 'space',
    targetClass: 'missile',
    movement: 'static',
    speedKmh: 0,
    hp: 10,
    detectionRangeKm: 60,
    sensor: { kind: 'satellite', rangeKm: 60, stealthDetect: 0.3 },
    space: { orbit: 'leo', revisitH: 6, swathKm: 600 },
  }),
  sys({
    id: 'tst.ewsat',
    category: 'space',
    targetClass: 'missile',
    movement: 'static',
    speedKmh: 0,
    hp: 10,
    detectionRangeKm: 10000,
    sensor: { kind: 'early_warning', rangeKm: 10000, stealthDetect: 0 },
    space: { orbit: 'geo', revisitH: 24, swathKm: 5000 },
  }),
  sys({
    id: 'tst.asat',
    category: 'space',
    targetClass: 'armor',
    movement: 'land',
    roles: ['asat', 'direct_ascent'],
    speedKmh: 40,
    weaponRangeKm: { min: 200, max: 2000 },
    damage: { ...zero, missile: 30 },
    hp: 10,
    detectionRangeKm: 50,
    missile: { kind: 'ballistic', speedKmh: 20000, warhead: 'conventional', evasion: 0.5, blastKm: 0 },
  }),
];

/** Carte de fixtures.ts avec bâtiments militaires. */
export function milMap(): MapData {
  const map = buildMap();
  const extra: Record<string, string[]> = {
    'aaa-1': ['air_base', 'military_base'],
    'aaa-2': ['air_base', 'military_base', 'port'],
    'aaa-3': ['air_base'],
    'bbb-2': ['air_base', 'military_base', 'port'],
    'bbb-4': ['arms_factory', 'refinery', 'port'],
    'bbb-5': ['air_base'],
    'ccc-1': ['air_base', 'military_base'],
  };
  return {
    ...map,
    provinces: map.provinces.map((p) => ({
      ...p,
      buildings: [...new Set([...p.buildings, ...((extra[p.id] ?? []) as typeof p.buildings)])].sort(),
    })),
  };
}

let cached: World | null = null;

export function milWorld(): World {
  if (!cached) cached = buildWorld(milMap(), MIL_CATALOG, BALANCE);
  return cached;
}

export function milSandbox(
  units: GameSetup['units'],
  opts: { players?: GameSetup['players']; seed?: number; world?: World } = {},
): EngineState {
  return createGame(opts.world ?? milWorld(), {
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

/** Capture des signaux entre modules pendant `fn` (branché sur le module diplo, puis restauré). */
export function captureSignals<T>(
  fn: (signals: { name: string; data: Record<string, unknown> }[]) => T,
): T {
  const signals: { name: string; data: Record<string, unknown> }[] = [];
  const orig = diploModule.hooks;
  diploModule.hooks = {
    ...orig,
    onSignal(state, name, data) {
      orig?.onSignal?.(state, name, data);
      signals.push({ name, data });
    },
  };
  try {
    return fn(signals);
  } finally {
    diploModule.hooks = orig;
  }
}

export function notesOf<K extends GameNotification['kind']>(
  notes: GameNotification[],
  kind: K,
): Extract<GameNotification, { kind: K }>[] {
  return notes.filter((n) => n.kind === kind) as Extract<GameNotification, { kind: K }>[];
}
