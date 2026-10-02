import { describe, expect, it } from 'vitest';
import {
  BalanceSchema,
  WeaponSystemSchema,
  type UnitView,
  type WeaponSystem,
  type WeaponSystemInput,
} from '@redline/shared';
import {
  canSplit,
  detachOrder,
  detachPartsOrder,
  isMixed,
  mergeOrder,
  splitByTypeOrder,
  splitHalfOrder,
  stackParts,
  stackSummary,
} from '../src/lib/stacks.js';

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
  p: Partial<WeaponSystemInput> & Pick<WeaponSystemInput, 'id' | 'category'>,
): WeaponSystem {
  return WeaponSystemSchema.parse({
    name: p.id,
    doctrine: 'other',
    origin: 'XX',
    generation: 3,
    targetClass: 'armor',
    movement: 'land',
    cost: { money: 100, resources: {} },
    buildTimeH: 1,
    upkeepPerDay: 1,
    speedKmh: 40,
    operationalRadiusKm: null,
    weaponRangeKm: { min: 0, max: 3 },
    damage: zero,
    hp: 10,
    armor: 0,
    stealth: 0,
    detectionRangeKm: 20,
    ew: { jamming: 0, jamResistance: 0 },
    payload: { slots: 0 },
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

const catalog = Object.fromEntries(
  [
    sys({ id: 'tst.inf', category: 'infantry', speedKmh: 30 }),
    sys({ id: 'tst.tank', category: 'tank', speedKmh: 60, weaponRangeKm: { min: 0, max: 4 } }),
    sys({ id: 'tst.jet', category: 'fighter', movement: 'air', speedKmh: 1800 }),
    sys({
      id: 'tst.sam',
      category: 'air_defense',
      interceptor: { against: ['aircraft'], pk: 0.5, magazine: 4 },
    }),
  ].map((s) => [s.id, s]),
);
const balance = BalanceSchema.parse({
  version: 1,
  time: { speeds: [1], combatRoundMinutes: 10, captureMinutes: 60, aiThinkMinutes: 30 },
  combat: {
    variance: 0,
    groundContactKm: 5,
    defenderCityBonus: 0,
    veterancyXp: [1],
    veterancyDamageBonus: 0,
  },
  movement: { embarkedSpeedFactor: 1, embarkMinutes: 1 },
  sensors: {
    provinceDetectionKm: 1,
    identifiedAtFraction: 0.5,
    preciseAtFraction: 0.2,
    uncertaintyGrowthKmh: 1,
    forgetAfterMinutes: 1,
  },
  economy: { startingMoney: 0, startingResources: {}, incomeMultiplier: 1 },
  victory: { provinceShare: 1, allEnemyCapitals: false },
  startingArmy: [],
  garrisonArmy: [],
});

const unit = (id: string, over: Partial<UnitView> = {}): UnitView => ({
  id,
  owner: 'fra',
  level: 'own',
  pos: [2, 48],
  lastSeen: 0,
  uncertaintyKm: 0,
  systemId: 'tst.tank',
  count: 6,
  status: 'idle',
  ...over,
});

const brigade = unit('u1', {
  systemId: 'tst.tank',
  count: 10,
  parts: [
    { systemId: 'tst.inf', count: 6 },
    { systemId: 'tst.tank', count: 4 },
  ],
});

describe('piles : composition et caractéristiques', () => {
  it('éléments, pile mixte, résumé (plus lent, plus longue portée)', () => {
    expect(stackParts(unit('u2'))).toEqual([{ systemId: 'tst.tank', count: 6 }]);
    expect(isMixed(unit('u2'))).toBe(false);
    expect(isMixed(brigade)).toBe(true);
    expect(stackSummary(brigade, catalog)).toEqual({
      count: 10,
      systems: 2,
      speedKmh: 30,
      rangeKm: 4,
      detectionKm: 20,
    });
  });
});

describe('piles : ordres rapides', () => {
  it('diviser en 2, détacher N, détacher par matériel, séparer par type', () => {
    expect(splitHalfOrder(brigade)).toEqual({ kind: 'split', unitId: 'u1', mode: 'half' });
    expect(detachOrder(brigade, 3)).toEqual({ kind: 'split', unitId: 'u1', count: 3 });
    expect(detachOrder(brigade, 10)).toBeNull();
    expect(detachOrder(brigade, 0)).toBeNull();
    expect(detachPartsOrder(brigade, [{ systemId: 'tst.tank', count: 2 }])).toEqual({
      kind: 'split',
      unitId: 'u1',
      parts: [{ systemId: 'tst.tank', count: 2 }],
    });
    expect(detachPartsOrder(brigade, [{ systemId: 'tst.tank', count: 5 }])).toBeNull();
    expect(splitByTypeOrder(brigade)).toEqual({ kind: 'split', unitId: 'u1', mode: 'type' });
    expect(splitByTypeOrder(unit('u2'))).toBeNull();
    // Pile d'un seul élément, ou étrangère : rien.
    expect(canSplit(unit('u3', { count: 1 }))).toBe(false);
    expect(splitHalfOrder(unit('u4', { level: 'precise' }))).toBeNull();
  });

  it('fusionner la sélection : compatibilité, distance, mouvement', () => {
    const inf = unit('u5', { systemId: 'tst.inf', count: 3, pos: [2.01, 48] });
    expect(mergeOrder([brigade, inf], catalog, balance, 0)).toEqual({
      order: { kind: 'merge', unitIds: ['u1', 'u5'] },
      block: null,
    });
    expect(mergeOrder([brigade], catalog, balance, 0).block).toBe('count');
    const far = unit('u6', { systemId: 'tst.inf', pos: [3, 48] });
    expect(mergeOrder([brigade, far], catalog, balance, 0).block).toBe('distance');
    const jet = unit('u7', { systemId: 'tst.jet' });
    expect(mergeOrder([brigade, jet], catalog, balance, 0).block).toBe('domain');
    const sam = unit('u8', { systemId: 'tst.sam' });
    expect(mergeOrder([unit('u9', { systemId: 'tst.inf' }), sam], catalog, balance, 0).block).toBe(
      'domain',
    );
    // Deux piles du même matériel non mélangeable : fusion permise.
    expect(mergeOrder([sam, unit('u10', { systemId: 'tst.sam' })], catalog, balance, 0).block).toBe(
      null,
    );
    expect(
      mergeOrder([brigade, unit('u11', { status: 'moving' })], catalog, balance, 0).block,
    ).toBe('moving');
    expect(
      mergeOrder([brigade, unit('u12', { level: 'precise' })], catalog, balance, 0).block,
    ).toBe('owner');
  });
});
