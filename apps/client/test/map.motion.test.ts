import { describe, expect, it } from 'vitest';
import {
  HOUR,
  distanceKm,
  type LngLat,
  type Movement,
  type NationView,
  type ProvinceDef,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import {
  AIR_LIFT,
  airLift,
  missileFeatures,
  pathFeatures,
  popLabel,
  provinceLabelFeatures,
  tokenFeatures,
  truncatePath,
  unitInfos,
} from '../src/map/features.js';
import { groupItems } from '../src/map/grouping.js';
import { PION_H, PION_W } from '../src/map/pions.js';
import { CityIndex } from '../src/map/unitCat.js';

const nation = (id: string, relation?: NationView['relation']): NationView => ({
  id,
  name: id.toUpperCase(),
  color: '#336699',
  isAi: true,
  isPlayer: false,
  alive: true,
  provinceCount: 1,
  ...(relation ? { relation } : {}),
});
const nations = { fra: nation('fra'), deu: nation('deu', 'ally'), rus: nation('rus', 'war') };
const sys = (id: string, category: string, movement = 'land'): WeaponSystem =>
  ({ id, name: id, category, movement, icon: category }) as unknown as WeaponSystem;
const catalog = {
  tank: sys('tank', 'tank'),
  f16: sys('f16', 'fighter', 'air'),
  frig: sys('frig', 'surface_ship', 'sea'),
};
const unit = (id: string, over: Partial<UnitView> = {}): UnitView => ({
  id,
  owner: 'fra',
  level: 'own',
  pos: [2, 48],
  lastSeen: 0,
  uncertaintyKm: 0,
  systemId: 'tank',
  count: 10,
  hpRatio: 0.8,
  status: 'idle',
  ...over,
});
const ctx = {
  me: 'fra',
  nations,
  catalog,
  selection: new Set<string>(),
  target: null,
  t: HOUR,
};
const flight = (t0: number, t1: number): Movement => ({
  legs: [{ from: [0, 40], to: [10, 40], t0, t1, medium: 'air' }],
});

describe('aéronefs en vol : altitude d’affichage et ombre', () => {
  it('montée, croisière, descente ; au sol : pas de hauteur', () => {
    expect(airLift(null)).toBe(0);
    expect(airLift(0)).toBe(0);
    expect(airLift(0.5)).toBe(AIR_LIFT);
    expect(airLift(1)).toBe(0);
    expect(airLift(0.05)).toBeGreaterThan(0);
    expect(airLift(0.05)).toBeLessThan(AIR_LIFT);
  });

  it('pion soulevé (décalage vers le haut) et ombre au sol sous la trace', () => {
    const infos = unitInfos(
      [unit('jet', { systemId: 'f16', status: 'moving', move: flight(0, 2 * HOUR) })],
      ctx,
    );
    expect(infos[0]!.air).toBe(true);
    expect(infos[0]!.prog).toBeCloseTo(0.5);
    const r = tokenFeatures(infos, { nations, zoom: 6, group: true });
    expect(r.shadows).toHaveLength(1);
    const pion = r.tokens[0]!.properties!;
    const shadow = r.shadows[0]!.properties!;
    // Le pion est plus haut (y plus petit) que son ombre, du hauteur de croisière.
    const dy = (shadow.off as number[])[1]! - (pion.off as number[])[1]!;
    expect(dy).toBeGreaterThan(AIR_LIFT);
    expect(r.shadows[0]!.geometry.coordinates).toEqual(r.tokens[0]!.geometry.coordinates);
  });

  it('unités terrestres : ni hauteur ni ombre', () => {
    const move: Movement = {
      legs: [{ from: [0, 40], to: [1, 40], t0: 0, t1: 2 * HOUR, medium: 'land' }],
    };
    const infos = unitInfos([unit('t', { status: 'moving', move })], ctx);
    expect(infos[0]!.air).toBe(false);
    expect(tokenFeatures(infos, { nations, zoom: 6, group: true }).shadows).toHaveLength(0);
  });
});

describe('trajets', () => {
  it('coupe une polyligne à la longueur voulue', () => {
    const line: LngLat[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    const cut = truncatePath(line, 150);
    expect(distanceKm(cut[0]!, cut[cut.length - 1]!)).toBeCloseTo(150, 0);
    expect(truncatePath(line, 10_000)).toEqual(line);
  });

  it('étrangers visibles : couleur de relation, amorce seulement ; arrivée connue', () => {
    const long: Movement = {
      legs: [{ from: [0, 45], to: [20, 45], t0: 0, t1: 40 * HOUR, medium: 'land' }],
    };
    const units = [
      unit('mine', { move: long, status: 'moving' }),
      unit('foe', { owner: 'rus', level: 'precise', move: long, status: 'moving' }),
      unit('ally', { owner: 'deu', level: 'precise', move: long, status: 'moving' }),
    ];
    const own = pathFeatures(units, HOUR, 'fra', new Set());
    expect(own.lines.features.map((f) => f.properties!.id)).toEqual(['mine']);
    const all = pathFeatures(units, HOUR, 'fra', new Set(), { foreign: true, nations });
    const rel = Object.fromEntries(
      all.lines.features.map((f) => [f.properties!.id, f.properties!.rel]),
    );
    expect(rel).toEqual({ mine: 'own', foe: 'enemy', ally: 'ally' });
    const len = (id: string) => {
      const c = all.lines.features.find((f) => f.properties!.id === id)!.geometry
        .coordinates as LngLat[];
      let km = 0;
      for (let i = 1; i < c.length; i++) km += distanceKm(c[i - 1]!, c[i]!);
      return km;
    };
    expect(len('mine')).toBeGreaterThan(1000);
    expect(len('foe')).toBeLessThan(170);
    expect(all.heads.features.find((f) => f.properties!.id === 'mine')!.properties!.end).toBe(
      40 * HOUR,
    );
  });

  it('sillage des navires et trace au sol de près, dans l’étendue visible seulement', () => {
    const sea: Movement = {
      legs: [{ from: [0, 40], to: [5, 40], t0: 0, t1: 10 * HOUR, medium: 'sea' }],
    };
    const land: Movement = {
      legs: [{ from: [0, 41], to: [5, 41], t0: 0, t1: 10 * HOUR, medium: 'land' }],
    };
    const units = [
      unit('ship', { systemId: 'frig', move: sea, status: 'moving' }),
      unit('col', { move: land, status: 'moving' }),
    ];
    const far = missileFeatures(units, 5 * HOUR, 'fra', { zoom: 3 });
    expect(far.trails.features).toHaveLength(0);
    const close = missileFeatures(units, 5 * HOUR, 'fra', { zoom: 6 });
    const kinds = close.trails.features.map((f) => f.properties!.kind).sort();
    expect(kinds).toEqual(['land', 'sea']);
    const out = missileFeatures(units, 5 * HOUR, 'fra', { zoom: 6, bounds: [30, 30, 40, 50] });
    expect(out.trails.features).toHaveLength(0);
  });
});

describe('retranchement et piles écartées', () => {
  it('unité terrestre à l’arrêt au contact de sa ville : marquée retranchée', () => {
    const defs = [{ id: 'p1', cityPoint: [2, 48] }] as unknown as ProvinceDef[];
    const cities = new CityIndex(defs);
    const provinces = { p1: { id: 'p1', owner: 'fra', buildings: [] } };
    const infos = unitInfos(
      [
        unit('a', { pos: [2.01, 48] }),
        unit('b', { pos: [3, 48] }),
        unit('c', {
          pos: [2.01, 48],
          status: 'moving',
          move: { legs: [{ from: [2.01, 48], to: [3, 48], t0: 0, t1: 3 * HOUR, medium: 'land' }] },
        }),
      ],
      { ...ctx, cities, provinces, contactKm: 5 },
    );
    const f = Object.fromEntries(infos.map((i) => [i.id, i.flags]));
    expect(f.a).toContain('f');
    expect(f.b).not.toContain('f');
    expect(f.c).not.toContain('f');
  });

  it('nations différentes au même endroit : écartées et rattachées au même groupe', () => {
    const items = [
      { id: 'a', pos: [2, 48] as LngLat, key: 'fra', priority: 2 },
      { id: 'b', pos: [2.001, 48] as LngLat, key: 'rus', priority: 1 },
      { id: 'c', pos: [20, 40] as LngLat, key: 'fra', priority: 1 },
    ];
    const g = groupItems(items, { zoom: 8, w: PION_W, h: PION_H });
    const a = g.find((x) => x.id === 'a')!;
    const b = g.find((x) => x.id === 'b')!;
    expect(a.cluster).toBeDefined();
    expect(a.cluster).toBe(b.cluster);
    expect(g.find((x) => x.id === 'c')!.cluster).toBeUndefined();
  });
});

describe('villes et provinces', () => {
  it('population compacte', () => {
    expect(popLabel(undefined)).toBe('');
    expect(popLabel(640_000)).toBe('640 k hab.');
    expect(popLabel(2_140_000)).toBe('2,1 M hab.');
    expect(popLabel(12_400_000)).toBe('12 M hab.');
  });

  it('noms de province distincts de la ville et éloignés d’elle', () => {
    const defs = [
      {
        id: 'a',
        name: 'Bretagne',
        cityName: 'Rennes',
        centroid: [-3, 48],
        cityPoint: [-1.7, 48.1],
        areaKm2: 27000,
      },
      {
        id: 'b',
        name: 'Paris',
        cityName: 'Paris',
        centroid: [2.3, 48.8],
        cityPoint: [2.35, 48.85],
        areaKm2: 100,
      },
      {
        id: 'c',
        name: 'Corse',
        cityName: 'Ajaccio',
        centroid: [8.74, 41.93],
        cityPoint: [8.74, 41.92],
        areaKm2: 8000,
      },
    ] as unknown as ProvinceDef[];
    const f = provinceLabelFeatures(defs);
    expect(f.features.map((x) => x.properties!.name)).toEqual(['Bretagne']);
  });
});
