/**
 * Style MapLibre de Red Line (niveau Conflict of Nations, direction « Terminal tactique ») :
 * imagerie satellite assombrie (PMTiles) avec fondu vers un fond vectoriel sombre, territoires teintés
 * par feature-state (joueur en violet), hachures (disputé, révolte, exclusion aérienne, voile du
 * renseignement), brouillard, frontières nettes, villes proportionnées, bâtiments, ordres animés,
 * portées ambre, pions d'unités composites.
 *
 * Les calques sont rangés par groupes (`LAYER_GROUPS`) que l'interface peut masquer ou afficher.
 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { FONTS } from '../config.js';
import type { BasemapData, TilesInfo } from '../api/types.js';
import { EMPTY } from './features.js';
import { PION_SCALE_STOPS } from './grouping.js';
import { C } from './palette.js';
import { INTEL_COLORS, PION_H } from './pions.js';
import { TEXT_IMAGE_PREFIX, type TextStyle } from './sprites.js';

export interface StyleInput {
  tiles: TilesInfo | null;
  glyphs: boolean;
  basemap: BasemapData | null;
  provinces: FeatureCollection | null;
  nationLabels: FeatureCollection;
  attribution: string;
  mode: 'game' | 'sandbox' | 'picker';
  /** Regroupement des pions selon le zoom (partie) ; sinon pions toujours individuels. */
  clusterUnits: boolean;
  /** Villes des provinces (sinon, villes du fond vectoriel). */
  cities?: FeatureCollection | null;
}

/** Groupes de calques pilotables par l'interface (`GameMap.setLayerGroup`). */
export type MapLayerGroup =
  | 'units'
  | 'orders'
  | 'ranges'
  | 'cities'
  | 'buildings'
  | 'labels'
  | 'fog'
  | 'intel'
  | 'radar'
  | 'satellites';

/** Groupes masqués au démarrage. */
export const HIDDEN_BY_DEFAULT: MapLayerGroup[] = ['intel'];

export const LAYER_GROUPS: Record<MapLayerGroup, string[]> = {
  units: ['units-hex', 'units-heading', 'missiles', 'focus-frame', 'focus-hex', 'focus-heading'],
  orders: [
    'paths-casing',
    'paths',
    'path-heads',
    'attack-links',
    'orbits',
    'orbit-pts',
    'missile-ahead',
    'trails',
    'impacts',
  ],
  ranges: ['range-fill', 'range-lines', 'detect-line', 'uncert-fill', 'uncert-line'],
  cities: ['cities-0', 'cities-1', 'cities-2', 'cities-3', 'cities-0-dot', 'cities-1-dot', 'cities-2-dot', 'cities-3-dot'],
  buildings: ['bld', 'bld-reveal', 'prov-markers'],
  labels: ['sea-labels-0', 'sea-labels-1', 'sea-labels-2', 'sea-labels-3', 'country-labels-l', 'country-labels-m', 'country-labels-s', 'country-labels-xs'],
  fog: ['fog', 'fog-hatch', 'fog-edge'],
  intel: ['intel-fill', 'intel-line', 'intel-badges', 'radar-foreign'],
  radar: ['radar-own'],
  satellites: ['sat-fill', 'sat-line'],
};

const geo = (
  data: FeatureCollection | null = EMPTY,
  extra: Record<string, unknown> = {},
): SourceSpecification =>
  ({ type: 'geojson', data: data ?? EMPTY, ...extra }) as SourceSpecification;

/** Sources mises à jour par différentiel : identifiant promu depuis la propriété `id`. */
const dyn = (extra: Record<string, unknown> = {}): SourceSpecification =>
  geo(EMPTY, { promoteId: 'id', ...extra });

const PION_SIZE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...PION_SCALE_STOPS.flat(),
] as ExpressionSpecification;

/** Étiquette : texte MapLibre si les glyphes existent, sinon image générée (`txt|style|texte`). */
function label(
  glyphs: boolean,
  field: ExpressionSpecification,
  opts: {
    style: TextStyle;
    font: string;
    size: number | ExpressionSpecification;
    spacing: number;
    color: string;
    halo: string;
    haloWidth: number;
    upper?: boolean;
  },
): Pick<SymbolLayerSpecification, 'layout' | 'paint'> {
  const text: ExpressionSpecification = opts.upper ? ['upcase', field] : field;
  if (glyphs) {
    return {
      layout: {
        'text-field': text,
        'text-font': [opts.font],
        'text-size': opts.size,
        'text-letter-spacing': opts.spacing,
        'text-max-width': 12,
        'text-allow-overlap': false,
        'text-padding': 3,
      },
      paint: {
        'text-color': opts.color,
        'text-halo-color': opts.halo,
        'text-halo-width': opts.haloWidth,
        'text-halo-blur': 0.6,
      },
    };
  }
  return {
    layout: {
      'icon-image': [
        'concat',
        `${TEXT_IMAGE_PREFIX}${opts.style}|`,
        field,
      ] as ExpressionSpecification,
      'icon-allow-overlap': false,
      'icon-padding': 3,
    },
    paint: {},
  };
}

const fs = (k: string, fallback: unknown = 0): ExpressionSpecification =>
  ['coalesce', ['feature-state', k], fallback] as ExpressionSpecification;

export function buildStyle(i: StyleInput): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    provinces: {
      type: 'geojson',
      data: i.provinces ?? EMPTY,
      promoteId: 'id',
    } as SourceSpecification,
    'basemap-land': geo(i.basemap?.land ?? null),
    'basemap-coast': geo(i.basemap?.coastline ?? null),
    'basemap-seas': geo(i.basemap?.seas ?? null),
    'basemap-cities': geo(i.basemap?.cities ?? null),
    cities: geo(i.cities ?? null, { promoteId: 'id' }),
    'nation-labels': geo(i.nationLabels),
    borders: geo(),
    'my-border': geo(),
    capture: geo(),
    fog: geo(),
    uncert: geo(),
    range: geo(),
    'range-lines': geo(),
    detect: geo(),
    radar: geo(),
    satellites: geo(),
    paths: geo(),
    'path-heads': geo(),
    'attack-links': geo(),
    orbits: geo(),
    'orbit-pts': geo(),
    trails: geo(EMPTY, { lineMetrics: true }),
    'missile-ahead': geo(),
    impacts: geo(),
    preview: geo(),
    'preview-pts': geo(),
    buildings: dyn(),
    'prov-markers': geo(),
    'intel-badges': geo(),
    units: dyn(),
    'units-focus': dyn(),
    headings: dyn(),
    missiles: dyn(),
  };
  if (i.tiles) {
    sources.satellite = {
      type: 'raster',
      url: `pmtiles://${window.location.origin}${i.tiles.satellite}`,
      tileSize: 256,
      attribution: i.attribution,
    };
  }

  const mz = i.tiles?.maxzoom ?? 5;
  const layers: LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': '#060b14' } },
    {
      id: 'land',
      type: 'fill',
      source: 'basemap-land',
      paint: { 'fill-color': '#101822', 'fill-antialias': false },
    },
    {
      id: 'prov-base',
      type: 'fill',
      source: 'provinces',
      paint: { 'fill-color': '#111a25', 'fill-antialias': false },
    },
  ];
  if (i.tiles) {
    layers.push({
      id: 'sat',
      type: 'raster',
      source: 'satellite',
      paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], mz, 1, mz + 2, 0.35],
        'raster-saturation': -0.25,
        'raster-contrast': 0.1,
        'raster-brightness-max': 0.8,
        'raster-fade-duration': 150,
        'raster-resampling': 'linear',
      },
    });
  }
  const mine: ExpressionSpecification = ['boolean', ['feature-state', 'mine'], false];
  const pick: ExpressionSpecification = ['boolean', ['feature-state', 'pick'], false];
  const intelLvl = fs('intel', -1);
  layers.push(
    {
      id: 'prov-fill',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#3a4252']],
        'fill-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          3,
          ['case', mine, 0.36, pick, 0.6, i.mode === 'picker' ? 0.3 : 0.24],
          8,
          ['case', mine, 0.24, pick, 0.5, i.mode === 'picker' ? 0.24 : 0.14],
        ] as ExpressionSpecification,
        'fill-antialias': false,
      },
    },
    // Voile du renseignement : province étrangère inconnue (0) ou à peine aperçue (1).
    {
      id: 'prov-veil-dark',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-color': '#04070b',
        'fill-opacity': ['match', intelLvl, 0, 0.34, 1, 0.16, 0] as ExpressionSpecification,
        'fill-antialias': false,
      },
    },
    {
      id: 'prov-veil',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch-veil',
        'fill-opacity': ['match', intelLvl, 0, 1, 0] as ExpressionSpecification,
      },
    },
    {
      id: 'prov-veil-light',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch-veil-light',
        'fill-opacity': ['match', intelLvl, 1, 1, 0] as ExpressionSpecification,
      },
    },
    {
      id: 'prov-disputed',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch-disputed',
        'fill-opacity': ['case', ['boolean', ['feature-state', 'disp'], false], 0.85, 0],
      },
    },
    {
      id: 'prov-unrest',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch-unrest',
        'fill-opacity': [
          'interpolate',
          ['linear'],
          fs('unrest'),
          30,
          0,
          100,
          0.9,
        ] as ExpressionSpecification,
      },
    },
    {
      id: 'prov-nfz',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-pattern': 'hatch-nfz',
        'fill-opacity': ['case', ['boolean', ['feature-state', 'nfz'], false], 0.9, 0],
      },
    },
    {
      id: 'capture-fill',
      type: 'fill',
      source: 'capture',
      paint: {
        'fill-color': ['case', ['==', ['get', 'cap'], 2], C.red, C.amber],
        'fill-opacity': 0.12,
        'fill-antialias': false,
      },
    },
    // Calque « Renseignement » : niveau de connaissance par province étrangère.
    {
      id: 'intel-fill',
      type: 'fill',
      source: 'provinces',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match',
          intelLvl,
          0,
          INTEL_COLORS[0],
          1,
          INTEL_COLORS[1],
          2,
          INTEL_COLORS[2],
          3,
          INTEL_COLORS[3],
          '#000000',
        ] as ExpressionSpecification,
        'fill-opacity': ['case', ['>=', intelLvl, 0], 0.26, 0] as ExpressionSpecification,
        'fill-antialias': false,
      },
    },
    {
      id: 'fog',
      type: 'fill',
      source: 'fog',
      paint: { 'fill-color': '#02050a', 'fill-opacity': 0.42, 'fill-antialias': false },
    },
    {
      id: 'fog-hatch',
      type: 'fill',
      source: 'fog',
      paint: {
        'fill-pattern': 'hatch-fog',
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.8],
      },
    },
    {
      id: 'prov-line',
      type: 'line',
      source: 'provinces',
      minzoom: 3,
      paint: {
        'line-color': ['case', mine, 'rgba(196,170,255,0.34)', 'rgba(214,221,230,0.16)'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 7, 0.9],
      },
    },
    {
      id: 'coast',
      type: 'line',
      source: 'basemap-coast',
      paint: {
        'line-color': 'rgba(150,176,204,0.32)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 7, 1],
      },
    },
    {
      id: 'intel-line',
      type: 'line',
      source: 'provinces',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'match',
          intelLvl,
          0,
          INTEL_COLORS[0],
          1,
          INTEL_COLORS[1],
          2,
          INTEL_COLORS[2],
          3,
          INTEL_COLORS[3],
          '#000000',
        ] as ExpressionSpecification,
        'line-opacity': ['case', ['>=', intelLvl, 0], 0.45, 0] as ExpressionSpecification,
        'line-width': 0.8,
      },
    },
    {
      id: 'borders-casing',
      type: 'line',
      source: 'borders',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': 'rgba(0,0,0,0.5)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 4, 2.4, 8, 3.4],
      },
    },
    {
      id: 'borders',
      type: 'line',
      source: 'borders',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': 'rgba(232,238,245,0.72)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 4, 0.9, 8, 1.4],
      },
    },
    {
      id: 'fog-edge',
      type: 'line',
      source: 'fog',
      minzoom: 2.5,
      paint: {
        'line-color': C.cyan,
        'line-opacity': 0.22,
        'line-width': 0.8,
        'line-dasharray': [2, 3],
      },
    },
    {
      id: 'my-glow',
      type: 'line',
      source: 'my-border',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': C.violet,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 5, 5, 10, 8, 16],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 4, 5, 8, 8, 12],
        'line-opacity': 0.5,
      },
    },
    {
      id: 'my-edge',
      type: 'line',
      source: 'my-border',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#cbb6ff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.9, 6, 1.8],
      },
    },
    {
      id: 'prov-blockade',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': C.red,
        'line-width': 1.6,
        'line-dasharray': [1, 1.5],
        'line-opacity': ['case', ['boolean', ['feature-state', 'blk'], false], 0.85, 0],
      },
    },
    {
      id: 'prov-nfz-line',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': C.red,
        'line-width': 1.2,
        'line-dasharray': [4, 2],
        'line-opacity': ['case', ['boolean', ['feature-state', 'nfz'], false], 0.8, 0],
      },
    },
    {
      // Source dédiée (provinces en capture seulement) : l'animation des tirets reste bon marché.
      id: 'capture',
      type: 'line',
      source: 'capture',
      paint: {
        'line-color': ['case', ['==', ['get', 'cap'], 2], C.red, C.amber],
        'line-width': 2,
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.95,
      },
    },
    {
      id: 'prov-sel',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': C.cyan,
        'line-width': 1.8,
        'line-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 0.95, 0],
      },
    },
    {
      id: 'sat-fill',
      type: 'fill',
      source: 'satellites',
      paint: {
        'fill-pattern': 'hatch-sat',
        'fill-opacity': ['case', ['==', ['get', 'soon'], 1], 0.9, 0.5],
      },
    },
    {
      id: 'sat-line',
      type: 'line',
      source: 'satellites',
      paint: {
        'line-color': C.cyan,
        'line-width': 1,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      },
    },
  );

  // ——— Étiquettes du fond ———
  const seaLayer = (
    id: string,
    filter: FilterSpecification,
    style: TextStyle,
    size: number,
    minzoom: number,
  ): LayerSpecification => {
    const l = label(i.glyphs, ['get', 'name'], {
      style,
      font: FONTS.italic,
      size,
      spacing: 0.12,
      color: '#6f8196',
      halo: 'rgba(0,0,0,0.45)',
      haloWidth: 1,
    });
    return {
      id,
      type: 'symbol',
      source: 'basemap-seas',
      minzoom,
      filter,
      layout: l.layout!,
      paint: l.paint!,
    } as LayerSpecification;
  };
  const rank: ExpressionSpecification = ['coalesce', ['get', 'rank'], 1];
  layers.push(
    seaLayer('sea-labels-0', ['<=', rank, 1], 'sea-l', 13, 1.5),
    seaLayer('sea-labels-1', ['all', ['>', rank, 1], ['<=', rank, 3]], 'sea-s', 11.5, 3),
    seaLayer('sea-labels-2', ['all', ['>', rank, 3], ['<=', rank, 5]], 'sea-s', 11.5, 4.5),
    seaLayer('sea-labels-3', ['>', rank, 5], 'sea-s', 11.5, 5.5),
  );

  // Pays : grandes capitales espacées, discrètes, par paliers de zoom.
  const labelMz: ExpressionSpecification = ['coalesce', ['get', 'minzoom'], 3];
  const country = (
    id: string,
    filter: FilterSpecification,
    style: TextStyle,
    size: number,
    minzoom: number,
  ): LayerSpecification => {
    const l = label(i.glyphs, ['get', 'name'], {
      style,
      font: FONTS.title,
      size,
      spacing: 0.28,
      color: 'rgba(255,255,255,0.86)',
      halo: 'rgba(0,0,0,0.7)',
      haloWidth: 1.3,
      upper: true,
    });
    return {
      id,
      type: 'symbol',
      source: 'nation-labels',
      minzoom,
      maxzoom: 7,
      filter,
      layout: { ...l.layout!, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 5] },
      paint: {
        ...l.paint!,
        // Les noms de pays s'effacent quand les villes prennent le relais.
        ...(i.glyphs
          ? { 'text-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 1, 7, 0] }
          : { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 1, 7, 0] }),
      },
    } as LayerSpecification;
  };
  layers.push(
    country('country-labels-l', ['<=', labelMz, 2], 'country-l', 17, 1.5),
    country(
      'country-labels-m',
      ['all', ['>', labelMz, 2], ['<=', labelMz, 3]],
      'country-m',
      14,
      2.5,
    ),
    country(
      'country-labels-s',
      ['all', ['>', labelMz, 3], ['<=', labelMz, 4.5]],
      'country-s',
      12,
      3.5,
    ),
    country('country-labels-xs', ['>', labelMz, 4.5], 'country-s', 11, 4.8),
  );

  if (i.mode !== 'picker') {
    layers.push(
      // ——— Renseignement et capteurs ———
      {
        id: 'radar-foreign',
        type: 'line',
        source: 'radar',
        filter: ['==', ['get', 'own'], 0],
        layout: { visibility: 'none' },
        paint: {
          'line-color': C.red,
          'line-opacity': 0.55,
          'line-width': 1,
          'line-dasharray': [1, 2.5],
        },
      },
      {
        id: 'radar-own',
        type: 'line',
        source: 'radar',
        filter: ['==', ['get', 'own'], 1],
        paint: {
          'line-color': C.cyan,
          'line-opacity': 0.4,
          'line-width': 1,
          'line-dasharray': [1, 2.5],
        },
      },
      // ——— Contacts incertains ———
      {
        id: 'uncert-fill',
        type: 'fill',
        source: 'uncert',
        paint: {
          'fill-color': C.dim,
          'fill-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.1, 1, 0.03],
        },
      },
      {
        id: 'uncert-line',
        type: 'line',
        source: 'uncert',
        paint: {
          'line-color': C.text,
          'line-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.55, 1, 0.2],
          'line-width': 1,
          'line-dasharray': [2, 2],
        },
      },
      // ——— Portées (sélection) ———
      {
        id: 'detect-line',
        type: 'line',
        source: 'detect',
        paint: {
          'line-color': C.cyan,
          'line-width': 1.2,
          'line-opacity': 0.75,
          'line-dasharray': [1, 2],
        },
      },
      {
        id: 'range-fill',
        type: 'fill',
        source: 'range',
        paint: { 'fill-color': C.amber, 'fill-opacity': 0.07 },
      },
      {
        id: 'range-lines',
        type: 'line',
        source: 'range-lines',
        paint: {
          'line-color': C.amber,
          'line-width': ['match', ['get', 'kind'], 'max', 1.6, 'min', 1, 1.1],
          'line-opacity': ['match', ['get', 'kind'], 'max', 0.95, 'min', 0.6, 0.6],
          'line-dasharray': [
            'match',
            ['get', 'kind'],
            'radius',
            ['literal', [4, 3]],
            'min',
            ['literal', [2, 2]],
            ['literal', [1, 0]],
          ],
        },
      },
      // ——— Orbites de patrouille ———
      {
        id: 'orbits',
        type: 'line',
        source: 'orbits',
        paint: {
          'line-color': C.cyan,
          'line-width': ['case', ['==', ['get', 'sel'], 1], 1.6, 1],
          'line-opacity': ['case', ['==', ['get', 'sel'], 1], 0.95, 0.5],
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'orbit-pts',
        type: 'symbol',
        source: 'orbit-pts',
        layout: {
          'icon-image': ['match', ['get', 'kind'], 'center', 'plus', 'arrow'],
          'icon-size': ['match', ['get', 'kind'], 'center', 0.4, 0.3],
          'icon-rotate': ['coalesce', ['get', 'rot'], 0],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': C.cyan,
          'icon-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.55],
        },
      },
      // ——— Liens d'attaque ———
      {
        id: 'attack-links',
        type: 'line',
        source: 'attack-links',
        paint: {
          'line-color': C.amber,
          'line-width': 1.2,
          'line-opacity': 0.8,
          'line-dasharray': [1, 2],
        },
      },
      // ——— Trajectoires des unités en mouvement (tirets animés) ———
      {
        id: 'paths-casing',
        type: 'line',
        source: 'paths',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': 'rgba(0,0,0,0.55)',
          'line-width': ['case', ['==', ['get', 'sel'], 1], 4.6, 3.2],
        },
      },
      {
        id: 'paths',
        type: 'line',
        source: 'paths',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'sel'], 1], C.cyan, C.green],
          'line-width': ['case', ['==', ['get', 'sel'], 1], 2.2, 1.5],
          'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.8],
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'path-heads',
        type: 'symbol',
        source: 'path-heads',
        layout: {
          'icon-image': 'arrow',
          'icon-size': ['case', ['==', ['get', 'sel'], 1], 0.46, 0.34],
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['case', ['==', ['get', 'sel'], 1], C.cyan, C.green],
          'icon-halo-color': 'rgba(0,0,0,0.6)',
          'icon-halo-width': 1,
        },
      },
      // ——— Missiles et aéronefs : traînées, trajectoire prévue, impacts ———
      {
        id: 'missile-ahead',
        type: 'line',
        source: 'missile-ahead',
        paint: {
          'line-color': ['case', ['==', ['get', 'own'], 1], C.amber, C.red],
          'line-width': 1.2,
          'line-opacity': 0.75,
          'line-dasharray': [2, 3],
        },
      },
      {
        id: 'trails',
        type: 'line',
        source: 'trails',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': ['match', ['get', 'kind'], 'missile', 2.6, 1.6],
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            'rgba(255,176,32,0)',
            1,
            'rgba(255,214,140,0.95)',
          ],
        },
      },
      // ——— Aperçu d'ordre ———
      {
        id: 'preview-casing',
        type: 'line',
        source: 'preview',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': 'rgba(0,0,0,0.6)', 'line-width': 5.5 },
      },
      {
        id: 'preview',
        type: 'line',
        source: 'preview',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'kind'], 'attack', C.amber, C.cyan],
          'line-width': 2.6,
          'line-dasharray': [2, 1.5],
        },
      },
      {
        id: 'preview-target',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'target'],
        layout: {
          'icon-image': 'reticle',
          'icon-size': 0.7,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-color': C.red, 'icon-halo-color': 'rgba(0,0,0,0.6)', 'icon-halo-width': 1 },
      },
      {
        id: 'preview-dest',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'dest'],
        layout: {
          'icon-image': 'dest',
          'icon-size': 0.55,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-color': C.cyan, 'icon-halo-color': 'rgba(0,0,0,0.6)', 'icon-halo-width': 1 },
      },
      {
        id: 'preview-launch',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'launch'],
        layout: {
          'icon-image': 'tri',
          'icon-size': 0.5,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-offset': [0, 40],
        },
        paint: { 'icon-color': C.amber, 'icon-halo-color': 'rgba(0,0,0,0.6)', 'icon-halo-width': 1 },
      },
      {
        id: 'preview-arrow',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'arrow'],
        layout: {
          'icon-image': 'arrow',
          'icon-size': 0.55,
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['case', ['has', 'n'], C.amber, C.cyan],
          'icon-halo-color': 'rgba(0,0,0,0.6)',
          'icon-halo-width': 1,
        },
      },
    );
  }

  // ——— Villes ———
  layers.push(...cityLayers(i));

  if (i.mode !== 'picker') {
    layers.push(
      // ——— Bâtiments et marqueurs de province (zoom proche) ———
      {
        id: 'prov-markers',
        type: 'symbol',
        source: 'prov-markers',
        minzoom: 4.5,
        layout: {
          'icon-image': ['match', ['get', 'kind'], 'blockade', 'blockade', ['get', 'img']],
          'icon-offset': ['match', ['get', 'kind'], 'blockade', ['literal', [-16, -12]], ['literal', [-16, 1]]],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      {
        id: 'bld',
        type: 'symbol',
        source: 'buildings',
        minzoom: 6.3,
        layout: {
          'icon-image': ['get', 'img'],
          'icon-offset': ['get', 'off'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6.3, 0.9, 8.5, 1.12],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          // Révélation par le renseignement : fondu animé (feature-state `reveal`, voir GameMap).
          'icon-opacity': revealOpacity(1),
        },
      },
      {
        id: 'bld-reveal',
        type: 'symbol',
        source: 'buildings',
        minzoom: 6.3,
        layout: {
          'icon-image': 'ring',
          'icon-offset': ['get', 'roff'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6.3, 0.62 * 0.9, 8.5, 0.62 * 1.12],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': C.cyan,
          'icon-opacity': ['case', ['boolean', ['feature-state', 'reveal'], false], 0, 0],
        },
      },
      {
        id: 'intel-badges',
        type: 'symbol',
        source: 'intel-badges',
        minzoom: 3.5,
        layout: {
          visibility: 'none',
          'icon-image': ['get', 'img'],
          'icon-allow-overlap': false,
          'icon-padding': 2,
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      {
        id: 'impacts',
        type: 'symbol',
        source: 'impacts',
        layout: {
          'icon-image': 'impact',
          'icon-size': 0.5,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-color': ['case', ['==', ['get', 'own'], 1], C.amber, C.red] },
      },
      // ——— Unités ———
      {
        id: 'units-hex',
        type: 'symbol',
        source: 'units',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': PION_SIZE,
          'icon-offset': ['get', 'off'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      {
        id: 'units-heading',
        type: 'symbol',
        source: 'headings',
        filter: ['==', ['get', 'f'], 0],
        layout: headingLayout(),
        paint: headingPaint(),
      },
      {
        id: 'missiles',
        type: 'symbol',
        source: 'missiles',
        layout: {
          'icon-image': 'missile',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.34, 7, 0.46],
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['match', ['get', 'rel'], 'own', C.amber, 'ally', C.violet, C.red],
          'icon-halo-color': 'rgba(0,0,0,0.7)',
          'icon-halo-width': 1.2,
          'icon-opacity': ['get', 'op'],
        },
      },
      // Unités sélectionnées ou ciblées : source séparée, jamais regroupées.
      {
        id: 'focus-frame',
        type: 'symbol',
        source: 'units-focus',
        layout: {
          'icon-image': 'sel-frame',
          'icon-size': PION_SIZE,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['case', ['==', ['get', 'sel'], 2], C.red, C.cyan],
          'icon-halo-color': 'rgba(0,0,0,0.55)',
          'icon-halo-width': 1,
        },
      },
      {
        id: 'focus-hex',
        type: 'symbol',
        source: 'units-focus',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': PION_SIZE,
          'icon-offset': ['get', 'off'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      {
        id: 'focus-heading',
        type: 'symbol',
        source: 'headings',
        filter: ['==', ['get', 'f'], 1],
        layout: headingLayout(),
        paint: headingPaint(),
      },
    );
  }

  return {
    version: 8,
    ...(i.glyphs ? { glyphs: `${window.location.origin}/glyphs/{fontstack}/{range}.pbf` } : {}),
    sources,
    layers,
  };
}

/**
 * Opacité des bâtiments : ancienneté du renseignement (`op`) × phase de révélation (0 → 1) pour
 * ceux qui viennent d'être découverts (feature-state `reveal`).
 */
export function revealOpacity(phase: number): ExpressionSpecification {
  return [
    '*',
    ['coalesce', ['get', 'op'], 1],
    ['case', ['boolean', ['feature-state', 'reveal'], false], phase, 1],
  ];
}

/** Anneau de révélation : visible pendant l'animation, puis éteint. */
export function revealRingOpacity(phase: number): ExpressionSpecification {
  return ['case', ['boolean', ['feature-state', 'reveal'], false], phase, 0];
}

function headingLayout(): SymbolLayerSpecification['layout'] {
  return {
    'icon-image': 'heading',
    'icon-size': PION_SIZE,
    'icon-rotate': ['get', 'rot'],
    'icon-rotation-alignment': 'map',
    'icon-offset': ['get', 'off'],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

function headingPaint(): SymbolLayerSpecification['paint'] {
  return {
    'icon-color': ['match', ['get', 'rel'], 'own', C.green, 'ally', C.violet, 'neutral', C.grey, C.red],
    'icon-halo-color': 'rgba(0,0,0,0.7)',
    'icon-halo-width': 1.2,
  };
}

/**
 * Villes des provinces, façon Conflict of Nations : capitales dès le zoom monde, grandes villes au
 * zoom région, puis villes moyennes et petites de près. Marqueur (image) et nom à droite.
 * Sans villes de provinces, repli sur les villes du fond vectoriel.
 */
function cityLayers(i: StyleInput): LayerSpecification[] {
  const src = i.cities ? 'cities' : 'basemap-cities';
  const out: LayerSpecification[] = [];
  const specs: [number, number, number, string, number][] = [
    // classe, zoom mini, taille du texte, police, halo
    [0, 2.2, 12.5, FONTS.semibold, 1.5],
    [1, 3.6, 11, FONTS.semibold, 1.3],
    [2, 5, 10.5, FONTS.regular, 1.2],
    [3, 6.3, 10, FONTS.regular, 1.2],
  ];
  const clsExpr: ExpressionSpecification = i.cities
    ? ['get', 'cls']
    : [
        'case',
        ['==', ['coalesce', ['get', 'capital'], 0], 1],
        0,
        ['<=', ['coalesce', ['get', 'minzoom'], 9], 4],
        1,
        ['<=', ['coalesce', ['get', 'minzoom'], 9], 5.5],
        2,
        3,
      ];
  for (const [cls, minzoom, size, font, halo] of specs) {
    const l = label(i.glyphs, ['get', 'name'], {
      style: `city-${cls}` as TextStyle,
      font,
      size,
      spacing: cls === 0 ? 0.06 : 0.02,
      color: cls === 3 ? '#b9c4cf' : cls === 2 ? '#dfe6ee' : '#ffffff',
      halo: 'rgba(3,6,10,0.85)',
      haloWidth: halo,
      upper: false,
    });
    const icon = i.cities ? ['get', 'img'] : `city|${cls}|none`;
    const layout: Record<string, unknown> = i.glyphs
      ? {
          ...l.layout!,
          'icon-image': icon,
          'icon-allow-overlap': true,
          'text-optional': true,
          'text-anchor': 'left',
          'text-offset': [cls === 0 ? 0.95 : 0.7, 0],
          'text-max-width': 9,
          'symbol-sort-key': ['get', 'rank'],
        }
      : {
          // Sans glyphes : le nom est une image ; le marqueur est porté par un second calque.
          ...l.layout!,
          'icon-anchor': 'left',
          'icon-offset': [cls === 0 ? 11 : 8, 0],
          'symbol-sort-key': ['get', 'rank'],
        };
    if (!i.glyphs) {
      out.push({
        id: `cities-${cls}-dot`,
        type: 'symbol',
        source: src,
        minzoom,
        filter: ['==', clsExpr, cls],
        layout: {
          'icon-image': icon as ExpressionSpecification,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      } as LayerSpecification);
    }
    out.push({
      id: `cities-${cls}`,
      type: 'symbol',
      source: src,
      minzoom,
      filter: ['==', clsExpr, cls],
      layout,
      paint: l.paint!,
    } as LayerSpecification);
  }
  return out;
}

/** Hauteur de pion exportée pour la surcouche (placement des infobulles). */
export const PION_HALF_H = PION_H / 2;
