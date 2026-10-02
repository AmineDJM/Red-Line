import { describe, expect, it } from 'vitest';
import type { UnitView, WeaponSystem } from '@redline/shared';
import { directOrder, unitActions, usefulRangeKm } from '../src/lib/unitActions.js';

const base = {
  weaponRangeKm: { min: 0, max: 0 },
  damage: {
    infantry: 0,
    armor: 0,
    aircraft: 0,
    helicopter: 0,
    drone: 0,
    ship: 0,
    submarine: 0,
    missile: 0,
    building: 0,
  },
  roles: [],
  speedKmh: 50,
  operationalRadiusKm: null,
  sheet: { rangeKm: null },
} as unknown as WeaponSystem;
const sys = (id: string, over: Partial<WeaponSystem>): WeaponSystem =>
  ({ ...base, id, ...over, damage: { ...base.damage, ...(over.damage ?? {}) } }) as WeaponSystem;

const catalog: Record<string, WeaponSystem> = {
  tank: sys('tank', {
    category: 'tank',
    movement: 'land',
    weaponRangeKm: { min: 0, max: 5 },
    damage: { armor: 10 } as never,
  }),
  sam: sys('sam', {
    category: 'air_defense',
    movement: 'land',
    weaponRangeKm: { min: 3, max: 200 },
    damage: { aircraft: 20 } as never,
  }),
  isk: sys('isk', {
    category: 'strike_missile',
    movement: 'air',
    speedKmh: 7000,
    weaponRangeKm: { min: 0, max: 400 },
    sheet: { rangeKm: 500 } as never,
    missile: { kind: 'ballistic' } as never,
    damage: { armor: 10, building: 30 } as never,
  }),
  jet: sys('jet', {
    category: 'fighter',
    movement: 'air',
    speedKmh: 2000,
    operationalRadiusKm: 1100,
    weaponRangeKm: { min: 0, max: 100 },
    damage: { aircraft: 15, armor: 4, building: 8 } as never,
  }),
  ship: sys('ship', {
    category: 'surface_ship',
    movement: 'sea',
    weaponRangeKm: { min: 0, max: 150 },
    damage: { ship: 20 } as never,
    naval: { launchCells: 16 } as never,
  }),
};
const u = (id: string, systemId: string, extra: Partial<UnitView> = {}): UnitView =>
  ({ id, systemId, owner: 'fra', level: 'own', count: 1, ...extra }) as UnitView;
const act = (units: UnitView[], id: string) =>
  unitActions(units, catalog).find((a) => a.id === id)!;

describe('actions de la sélection', () => {
  it('S-300 seul : pas de frappe ni de patrouille, attaque possible (le moteur motive le refus au sol)', () => {
    const s = [u('u1', 'sam')];
    expect(act(s, 'strike').enabled).toBe(false);
    expect(act(s, 'strike').reason).toBe('noStrike');
    expect(act(s, 'patrol').enabled).toBe(false);
    expect(act(s, 'attack').enabled).toBe(true);
    expect(act(s, 'rtb').label).toBe('resupply');
  });

  it('missiles : frappe et attaque, pas de déplacement ; portée = portée de frappe du moteur', () => {
    const s = [u('u1', 'isk')];
    expect(act(s, 'strike').enabled).toBe(true);
    expect(act(s, 'attack').enabled).toBe(true);
    expect(act(s, 'move').enabled).toBe(false);
    expect(usefulRangeKm(catalog.isk!)).toBe(500);
  });

  it('chasseur : intercepter, patrouiller, retour base ; navire : blocus et frappe', () => {
    const jets = [u('u1', 'jet')];
    expect(act(jets, 'intercept').enabled).toBe(true);
    expect(act(jets, 'patrol').enabled).toBe(true);
    expect(act(jets, 'rtb').label).toBe('rtbAir');
    const ships = [u('u2', 'ship')];
    expect(act(ships, 'blockade').enabled).toBe(true);
    expect(act(ships, 'strike').enabled).toBe(true);
    expect(act(ships, 'rtb').label).toBe('rtbSea');
  });

  it('sélection mixte : chaque action ne vise que les unités capables', () => {
    const s = [u('u1', 'tank'), u('u2', 'jet', { status: 'moving' })];
    expect(act(s, 'patrol').unitIds).toEqual(['u2']);
    expect(act(s, 'stop').unitIds).toEqual(['u2']);
    expect(directOrder(act(s, 'stop'))).toEqual({ kind: 'stop', unitIds: ['u2'] });
    expect(directOrder(act(s, 'attack'))).toBeNull();
  });
});
