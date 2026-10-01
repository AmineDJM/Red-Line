import { beforeAll, describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { HOUR, type NationView, type UnitView, type WeaponSystem } from '@redline/shared';
import { EMPTY, unitFeatures } from '../src/map/features.js';
import { buildStyle, type StyleInput } from '../src/map/style.js';

beforeAll(() => {
  // buildStyle construit des URL absolues à partir de l'origine de la page.
  (globalThis as unknown as { window: unknown }).window = {
    location: { origin: 'http://localhost:5173' },
  };
});

const input = (over: Partial<StyleInput>): StyleInput => ({
  tiles: { satellite: '/tiles/satellite-lowzoom.pmtiles', maxzoom: 5 },
  glyphs: true,
  basemap: { land: EMPTY, coastline: EMPTY, seas: EMPTY, countries: EMPTY, cities: EMPTY },
  provinces: EMPTY,
  nationLabels: EMPTY,
  attribution: 'test',
  mode: 'game',
  clusterUnits: true,
  ...over,
});

describe('style MapLibre', () => {
  for (const glyphs of [true, false]) {
    for (const mode of ['game', 'sandbox', 'picker'] as const) {
      it(`est valide (glyphes ${glyphs ? 'PBF' : 'absents → images'}, mode ${mode})`, () => {
        const style = buildStyle(input({ glyphs, mode, clusterUnits: mode === 'game' }));
        const errors = validateStyleMin(style as never);
        expect(errors.map((e) => e.message)).toEqual([]);
        const usesText = style.layers.some(
          (l) => 'layout' in l && l.layout && 'text-field' in (l.layout as object),
        );
        expect(usesText).toBe(glyphs);
        if (glyphs)
          expect(style.glyphs).toBe('http://localhost:5173/glyphs/{fontstack}/{range}.pbf');
      });
    }
  }

  it('fonctionne sans imagerie satellite', () => {
    const style = buildStyle(input({ tiles: null }));
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(style.sources.satellite).toBeUndefined();
  });

  it('utilise exactement les fontstacks convenus', () => {
    const style = buildStyle(input({}));
    const fonts = new Set<string>();
    for (const l of style.layers) {
      const f = (l as { layout?: { 'text-font'?: string[] } }).layout?.['text-font'];
      f?.forEach((x) => fonts.add(x));
    }
    for (const f of fonts)
      expect([
        'Barlow Condensed Bold',
        'IBM Plex Sans Regular',
        'IBM Plex Sans SemiBold',
        'IBM Plex Sans Italic',
      ]).toContain(f);
  });
});

describe('performances du calcul des positions', () => {
  it('800 unités en mouvement : construction des entités en quelques millisecondes', () => {
    const sys = {
      id: 'x.tank',
      category: 'tank',
      movement: 'land',
      icon: 'tank',
    } as unknown as WeaponSystem;
    const nations: Record<string, NationView> = {
      fra: {
        id: 'fra',
        name: 'France',
        color: '#123456',
        isAi: false,
        isPlayer: true,
        alive: true,
        provinceCount: 1,
      },
    };
    const units: UnitView[] = Array.from({ length: 800 }, (_, i) => ({
      id: `u${i}`,
      owner: 'fra',
      level: 'own',
      pos: [i % 40, (i / 40) % 40],
      lastSeen: 0,
      uncertaintyKm: 0,
      systemId: 'x.tank',
      move: {
        legs: [{ from: [i % 40, 0], to: [(i % 40) + 5, 10], t0: 0, t1: 10 * HOUR, medium: 'land' }],
      },
    }));
    const ctx = {
      me: 'fra',
      nations,
      catalog: { 'x.tank': sys },
      selection: new Set<string>(),
      target: null,
      t: 5 * HOUR,
    };
    unitFeatures(units, ctx); // chauffe
    // Médiane de 30 mesures : insensible aux pauses du ramasse-miettes et aux machines de CI partagées.
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      unitFeatures(units, { ...ctx, t: 5 * HOUR + i * 1000 });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const ms = samples[samples.length >> 1]!;
    // Budget : ~8 ms par mise à jour à 12 Hz reste < 10 % du temps d'une seconde sur mobile.
    expect(ms).toBeLessThan(8);
  });
});
