import { describe, expect, it } from 'vitest';
import type { LngLat, ProvinceDef, UnitView, WeaponSystem } from '@redline/shared';
import { nearestCity, unitLocation } from '../src/lib/location.js';

const prov = (id: string, cityName: string, cityPoint: LngLat) =>
  ({ id, name: `Province ${id}`, cityName, cityPoint }) as unknown as ProvinceDef;

const provinces: Record<string, ProvinceDef> = {
  a: prov('a', 'Rabat', [-6.84, 34.02]),
  b: prov('b', 'Oran', [-0.64, 35.7]),
  c: prov('c', 'Fidji', [178.4, -18.1]),
  d: prov('d', 'Samoa', [-171.8, -13.8]),
};

const unit = (status: UnitView['status'] = 'idle') =>
  ({ id: 'u1', owner: 'mar', level: 'own', pos: [0, 0], status }) as unknown as UnitView;
const sys = (movement: WeaponSystem['movement']) => ({ movement }) as unknown as WeaponSystem;

describe('position des unités (onglet Armée)', () => {
  it('ville la plus proche, y compris de part et d’autre de l’antiméridien', () => {
    expect(nearestCity(provinces, [-6.5, 34.2])!.name).toBe('Rabat');
    expect(nearestCity(provinces, [-1, 35.5])!.name).toBe('Oran');
    expect(nearestCity(provinces, [179.9, -16])!.name).toBe('Fidji');
    expect(nearestCity(provinces, [-179.9, -14])!.name).toBe('Fidji');
    expect(nearestCity(provinces, [-172.5, -13.5])!.name).toBe('Samoa');
    expect(nearestCity({}, [0, 0])).toBeNull();
  });

  it('en ville, à N km, en mer, en vol, embarquée', () => {
    const near: LngLat = [-6.9, 34.0];
    const far: LngLat = [-3.5, 34.8];
    const sea: LngLat = [-4.0, 36.2];
    expect(unitLocation(unit(), sys('land'), near, provinces, false)).toMatchObject({
      kind: 'city',
      city: 'Rabat',
    });
    expect(unitLocation(unit(), sys('land'), far, provinces, false).kind).toBe('near');
    expect(unitLocation(unit(), sys('sea'), sea, provinces, false).kind).toBe('sea');
    expect(unitLocation(unit(), sys('sea'), near, provinces, false).kind).toBe('city');
    expect(unitLocation(unit('moving'), sys('air'), far, provinces, true).kind).toBe('air');
    expect(unitLocation(unit(), sys('air'), near, provinces, false).kind).toBe('city');
    expect(unitLocation(unit('embarked'), sys('land'), sea, provinces, false).kind).toBe(
      'embarked',
    );
  });
});
