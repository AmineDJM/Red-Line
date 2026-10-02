import { beforeAll, describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { HOUR, type NationView, type UnitView, type WeaponSystem } from '@redline/shared';
import { EMPTY, resourceImageId, unitFeatures } from '../src/map/features.js';
import {
  CITY_LABEL_LAYERS,
  LAYER_GROUPS,
  RESOURCE_ICON_ZOOM,
  buildStyle,
  cityTextField,
  type StyleInput,
} from '../src/map/style.js';

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

  it('insigne des ressources devant le nom des villes : style valide, de près seulement', () => {
    for (const resources of [true, false]) {
      const style = buildStyle(input({ cities: EMPTY, resources }));
      expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
      const field = (id: string) =>
        JSON.stringify(
          (style.layers.find((l) => l.id === id) as { layout: Record<string, unknown> }).layout[
            'text-field'
          ],
        );
      for (const [id] of CITY_LABEL_LAYERS)
        expect(field(id).includes('"image"'), `${id} ${resources}`).toBe(resources);
    }
    // Paliers : nom seul au zoom monde, insigne à partir de RESOURCE_ICON_ZOOM (ou du zoom de la
    // classe), population ensuite ; paliers strictement croissants.
    for (const [, cls] of CITY_LABEL_LAYERS) {
      const e = cityTextField(cls, true) as unknown[];
      expect(e[0]).toBe('step');
      expect(e[2]).toEqual(['get', 'name']);
      const zooms = e.filter((_, i) => i >= 3 && (i - 3) % 2 === 0) as number[];
      expect(zooms.length).toBe(2);
      expect(zooms[1]!).toBeGreaterThan(zooms[0]!);
      // Insigne jamais avant RESOURCE_ICON_ZOOM : premier palier avec image ≥ ce zoom.
      const firstImg = zooms.find((_, k) => JSON.stringify(e[4 + 2 * k]).includes('"image"'));
      expect(firstImg).toBeGreaterThanOrEqual(RESOURCE_ICON_ZOOM);
      expect(JSON.stringify(cityTextField(cls, false))).not.toContain('"image"');
    }
    // Groupe pilotable par l'interface, sans calque propre (texte des villes).
    expect(LAYER_GROUPS.resources).toEqual([]);
  });

  it('image de l’insigne : principale, richesse, secondaire ; rien sans ressource', () => {
    expect(
      resourceImageId({
        resources: [
          { type: 'oil', richness: 3, source: 'data' },
          { type: 'metals', richness: 1, source: 'heuristic' },
        ],
      }),
    ).toBe('res|oil|3|metals');
    expect(resourceImageId({ resources: [{ type: 'food', richness: 2, source: 'data' }] })).toBe(
      'res|food|2|',
    );
    expect(resourceImageId({ resources: [] })).toBe('');
    expect(resourceImageId({})).toBe('');
  });

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
