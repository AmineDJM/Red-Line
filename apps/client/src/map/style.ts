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
import { COUNT_TEXT, EMPTY } from './features.js';
import { BATTLE_ICON_DY } from './battles.js';
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
  /** Noms des provinces (centroïdes), affichés de près quand ils diffèrent de la ville. */
  provinceLabels?: FeatureCollection | null;
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
  units: [
    'tracks',
    'wakes',
    'air-shadow',
    'battle-area',
    'battle-pulse',
    'battle-pulse-2',
    'battle-icon',
    'hover-frame',
    'units-hex',
    'units-hp',
    'units-count',
    'units-stack',
    'units-m-hex',
    'units-m-hp',
    'units-m-count',
    'units-m-stack',
    'units-heading',
    'missiles',
    'focus-frame',
    'focus-hex',
    'focus-hp',
    'focus-count',
    'focus-stack',
    'focus-heading',
  ],
  orders: [
    'paths-casing',
    'paths',
    'path-heads',
    'attack-links',
    'orbits',
    'orbit-pts',
    'missile-ahead',
    'trails',
    'trails-air',
    'impacts',
  ],
  ranges: ['range-fill', 'range-lines', 'detect-line', 'uncert-fill', 'uncert-line'],
  cities: [
    'cities-0',
    'cities-1',
    'cities-2',
    'cities-3',
    'cities-0-dot',
    'cities-1-dot',
    'cities-2-dot',
    'cities-3-dot',
  ],
  buildings: ['bld', 'bld-reveal', 'prov-markers'],
  labels: [
    'prov-labels',
    'sea-labels-0',
    'sea-labels-1',
    'sea-labels-2',
    'sea-labels-3',
    'country-labels-l',
    'country-labels-m',
    'country-labels-s',
    'country-labels-xs',
  ],
  fog: ['fog', 'fog-edge'],
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

/**
 * Décalage d'icône lu dans une propriété tableau. Les requêtes de rendu (queryRenderedFeatures)
 * relisent les propriétés sérialisées (tableaux → chaînes) : repli sur [0, 0] sans avertissement.
 */
const offsetProp = (k: string): ExpressionSpecification => [
  'case',
  ['==', ['typeof', ['get', k]], 'string'],
  ['literal', [0, 0]],
  ['array', 'number', 2, ['get', k]],
];

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
    veil: geo(),
    'prov-flags': geo(),
    'prov-sel': geo(),
    'prov-hover': geo(),
    'prov-labels': geo(i.provinceLabels ?? null),
    battles: geo(EMPTY, { promoteId: 'id' }),
    shadows: dyn(),
    hover: geo(),
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
    'units-moving': dyn(),
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
      // Sous l'imagerie opaque, inutile de la dessiner.
      ...(i.tiles ? { minzoom: i.tiles.maxzoom } : {}),
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
    // Voile du renseignement (province étrangère inconnue : 0, à peine aperçue : 1) et marques
    // des provinces (disputé, révolte, exclusion aérienne) : sources dédiées ne contenant que les
    // provinces concernées (une passe de dessin sur les seules géométries utiles).
    {
      id: 'prov-veil',
      type: 'fill',
      source: 'veil',
      filter: ['==', ['get', 'lvl'], 0],
      paint: { 'fill-pattern': 'hatch-veil' },
    },
    {
      id: 'prov-veil-light',
      type: 'fill',
      source: 'veil',
      filter: ['==', ['get', 'lvl'], 1],
      paint: { 'fill-pattern': 'hatch-veil-light' },
    },
    {
      id: 'prov-disputed',
      type: 'fill',
      source: 'prov-flags',
      filter: ['==', ['get', 'disp'], 1],
      paint: { 'fill-pattern': 'hatch-disputed', 'fill-opacity': 0.85 },
    },
    {
      id: 'prov-unrest',
      type: 'fill',
      source: 'prov-flags',
      filter: ['>', ['get', 'unrest'], 30],
      paint: {
        'fill-pattern': 'hatch-unrest',
        'fill-opacity': ['interpolate', ['linear'], ['get', 'unrest'], 30, 0.2, 100, 0.9],
      },
    },
    {
      id: 'prov-nfz',
      type: 'fill',
      source: 'prov-flags',
      filter: ['==', ['get', 'nfz'], 1],
      paint: { 'fill-pattern': 'hatch-nfz', 'fill-opacity': 0.9 },
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
      // Brouillard : assombrissement et hachures fines dans un seul motif (une passe de dessin).
      id: 'fog',
      type: 'fill',
      source: 'fog',
      paint: { 'fill-pattern': 'hatch-fog' },
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
      source: 'prov-flags',
      filter: ['==', ['get', 'blk'], 1],
      paint: {
        'line-color': C.red,
        'line-width': 1.6,
        'line-dasharray': [1, 1.5],
        'line-opacity': 0.85,
      },
    },
    {
      id: 'prov-nfz-line',
      type: 'line',
      source: 'prov-flags',
      filter: ['==', ['get', 'nfz'], 1],
      paint: {
        'line-color': C.red,
        'line-width': 1.2,
        'line-dasharray': [4, 2],
        'line-opacity': 0.8,
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
      // Survol d'une province (ordinateur) : voile clair et contour net.
      id: 'prov-hover-fill',
      type: 'fill',
      source: 'prov-hover',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.05, 'fill-antialias': false },
    },
    {
      id: 'prov-hover-casing',
      type: 'line',
      source: 'prov-hover',
      layout: { 'line-join': 'round' },
      paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 3 },
    },
    {
      id: 'prov-hover',
      type: 'line',
      source: 'prov-hover',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'mine'], 1], '#d9c8ff', '#eef3f8'],
        'line-width': 1.4,
        'line-opacity': 0.9,
      },
    },
    {
      id: 'prov-sel',
      type: 'line',
      source: 'prov-sel',
      paint: { 'line-color': C.cyan, 'line-width': 1.8, 'line-opacity': 0.95 },
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
  if (i.glyphs && i.provinceLabels) {
    // Noms des provinces (de près) : discrets, en capitales espacées, sous les villes.
    layers.push({
      id: 'prov-labels',
      type: 'symbol',
      source: 'prov-labels',
      minzoom: 5.8,
      layout: {
        'text-field': ['upcase', ['get', 'name']],
        'text-font': [FONTS.italic],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5.8, 9.5, 8, 11],
        'text-letter-spacing': 0.18,
        'text-max-width': 8,
        'text-padding': 6,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': 'rgba(196,206,218,0.5)',
        'text-halo-color': 'rgba(0,0,0,0.55)',
        'text-halo-width': 1,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 5.8, 0, 6.3, 1],
      },
    } as LayerSpecification);
  }

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
          'line-opacity': ['case', ['==', ['coalesce', ['get', 'dim'], 0], 1], 0.35, 1],
          'line-width': [
            'case',
            ['==', ['get', 'sel'], 1],
            4.6,
            ['==', ['coalesce', ['get', 'rel'], 'own'], 'own'],
            3.2,
            2.4,
          ],
        },
      },
      {
        // Trajectoires : vert (ses forces), cyan (sélection), violet (alliés), gris (neutres),
        // rouge (ennemis en guerre), tirets qui défilent vers la destination.
        id: 'paths',
        type: 'line',
        source: 'paths',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'sel'], 1], C.cyan, relColor()],
          'line-width': [
            'case',
            ['==', ['get', 'sel'], 1],
            2.2,
            ['==', ['coalesce', ['get', 'rel'], 'own'], 'own'],
            1.5,
            1.1,
          ],
          'line-opacity': [
            'case',
            ['==', ['get', 'sel'], 1],
            1,
            // Une sélection existe : les autres trajets passent au second plan.
            ['==', ['coalesce', ['get', 'dim'], 0], 1],
            0.32,
            ['==', ['coalesce', ['get', 'rel'], 'own'], 'own'],
            0.8,
            0.65,
          ],
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'path-heads',
        type: 'symbol',
        source: 'path-heads',
        layout: {
          'icon-image': 'arrow',
          'icon-size': [
            'case',
            ['==', ['get', 'sel'], 1],
            0.46,
            ['==', ['coalesce', ['get', 'rel'], 'own'], 'own'],
            0.34,
            0.28,
          ],
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // Faisceau : nombre de trajets fusionnés, sous la flèche.
          ...(i.glyphs
            ? {
                'text-field': ['coalesce', ['get', 'cnt'], ''],
                'text-font': [FONTS.title],
                'text-size': 12,
                'text-anchor': 'top',
                'text-offset': [0, 0.7],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-optional': true,
              }
            : {}),
        },
        paint: {
          'icon-color': ['case', ['==', ['get', 'sel'], 1], C.cyan, relColor()],
          'icon-halo-color': 'rgba(0,0,0,0.6)',
          'icon-halo-width': 1,
          'icon-opacity': ['case', ['==', ['coalesce', ['get', 'dim'], 0], 1], 0.45, 1],
          ...(i.glyphs
            ? {
                'text-color': ['case', ['==', ['get', 'sel'], 1], C.cyan, relColor()],
                'text-halo-color': 'rgba(3,6,10,0.92)',
                'text-halo-width': 2,
                'text-opacity': ['case', ['==', ['coalesce', ['get', 'dim'], 0], 1], 0.5, 1],
              }
            : {}),
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
        // Traînée de condensation des aéronefs (blanc bleuté).
        id: 'trails-air',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'air'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': 1.6,
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            'rgba(200,236,255,0)',
            1,
            'rgba(226,246,255,0.85)',
          ],
        },
      },
      {
        id: 'trails',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'missile'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': 2.6,
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
        paint: {
          'icon-color': C.amber,
          'icon-halo-color': 'rgba(0,0,0,0.6)',
          'icon-halo-width': 1,
        },
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
          'icon-offset': [
            'match',
            ['get', 'kind'],
            'blockade',
            ['literal', [-16, -12]],
            ['literal', [-16, 1]],
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      {
        id: 'bld',
        type: 'symbol',
        source: 'buildings',
        minzoom: 6.7,
        layout: {
          'icon-image': ['get', 'img'],
          'icon-offset': offsetProp('off'),
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6.7, 0.92, 8.5, 1.12],
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
        minzoom: 6.7,
        layout: {
          'icon-image': 'ring',
          'icon-offset': offsetProp('roff'),
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6.7, 0.62 * 0.92, 8.5, 0.62 * 1.12],
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
        minzoom: 4.8,
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
      // ——— Mouvements au sol et en mer : sillages, traces (de près) ———
      {
        id: 'wakes',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'sea'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 8, 5],
          'line-blur': 1.6,
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            'rgba(220,240,255,0)',
            1,
            'rgba(230,245,255,0.55)',
          ],
        },
      },
      {
        id: 'tracks',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'land'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 8, 3.4],
          'line-blur': 1,
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            'rgba(214,200,170,0)',
            1,
            'rgba(226,214,186,0.5)',
          ],
        },
      },
      // ——— Combats : zone, pulsations (animées), marqueur ———
      {
        id: 'battle-area',
        type: 'circle',
        source: 'battles',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 26, 9, 40],
          'circle-color': C.red,
          'circle-opacity': ['*', 0.16, ['get', 'heat']],
          'circle-blur': 0.85,
        },
      },
      {
        // Ondes des combats actifs (heat ≥ 0,5) : rayon et opacité animés par valeurs constantes.
        id: 'battle-pulse',
        type: 'circle',
        source: 'battles',
        filter: ['>=', ['get', 'heat'], 0.5],
        paint: {
          'circle-radius': 16,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': C.red,
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.6,
        },
      },
      {
        id: 'battle-pulse-2',
        type: 'circle',
        source: 'battles',
        filter: ['>=', ['get', 'heat'], 0.5],
        paint: {
          'circle-radius': 24,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': C.red,
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.3,
        },
      },
      // Ombres des aéronefs en vol (au sol, sous le pion soulevé).
      {
        id: 'air-shadow',
        type: 'symbol',
        source: 'shadows',
        layout: {
          'icon-image': 'air-shadow',
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            ...PION_SCALE_STOPS.flatMap(([z, v]) => [z, ['*', v, ['get', 'sz']]]),
          ] as unknown as ExpressionSpecification,
          'icon-offset': offsetProp('off'),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      // Survol d'un pion (ordinateur) : crochets discrets.
      {
        id: 'hover-frame',
        type: 'symbol',
        source: 'hover',
        layout: {
          'icon-image': 'sel-frame',
          'icon-size': PION_SIZE,
          'icon-offset': offsetProp('foff'),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': '#eef3f8',
          'icon-opacity': 0.55,
          'icon-halo-color': 'rgba(0,0,0,0.5)',
          'icon-halo-width': 1,
        },
      },
      // ——— Unités ———
      {
        id: 'units-hex',
        type: 'symbol',
        source: 'units',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': PION_SIZE,
          'icon-offset': offsetProp('off'),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      ...pionPartLayers('units', 'units', i.glyphs),
      // Piles en mouvement : même rendu, source séparée (les piles immobiles ne sont pas
      // retraitées à chaque déplacement).
      {
        id: 'units-m-hex',
        type: 'symbol',
        source: 'units-moving',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': PION_SIZE,
          'icon-offset': offsetProp('off'),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      ...pionPartLayers('units-m', 'units-moving', i.glyphs),
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
          'icon-offset': offsetProp('foff'),
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
          'icon-offset': offsetProp('off'),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      },
      ...pionPartLayers('focus', 'units-focus', i.glyphs),
      {
        id: 'focus-heading',
        type: 'symbol',
        source: 'headings',
        filter: ['==', ['get', 'f'], 1],
        layout: headingLayout(),
        paint: headingPaint(),
      },
      // Marqueur de bataille au-dessus des pions, décalé vers le haut (ne masque pas la cible).
      {
        id: 'battle-icon',
        type: 'symbol',
        source: 'battles',
        layout: {
          'icon-image': [
            'concat',
            'battle|',
            ['get', 'side'],
            '|',
            ['case', ['>=', ['get', 'heat'], 0.6], '1', '0'],
          ],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.75, 6, 1, 9, 1.12],
          // Au-dessus du nom de la ville (qui reste lisible), bilan des pertes à droite de l'icône.
          'icon-offset': [0, -BATTLE_ICON_DY],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['-', 0, ['get', 'heat']],
          ...(i.glyphs
            ? {
                'text-field': ['get', 'label'],
                'text-font': [FONTS.semibold],
                'text-size': 10.5,
                'text-anchor': 'left',
                'text-offset': [1.5, -BATTLE_ICON_DY / 10.5],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-optional': true,
              }
            : {}),
        },
        paint: {
          ...(i.glyphs
            ? {
                'text-color': '#ffd1d6',
                'text-halo-color': 'rgba(22,11,15,0.95)',
                'text-halo-width': 2.2,
                // Bilan des pertes à partir de l'échelle régionale (à petite échelle : l'icône seule).
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 0, 5.4, 1],
              }
            : {}),
        },
      } as LayerSpecification,
    );
  }

  return {
    version: 8,
    ...(i.glyphs ? { glyphs: `${window.location.origin}/glyphs/{fontstack}/{range}.pbf` } : {}),
    sources,
    layers,
  };
}

const scaled = (k: number): ExpressionSpecification =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    ...PION_SCALE_STOPS.flatMap(([z, v]) => [z, v * k]),
  ] as ExpressionSpecification;

/**
 * Éléments variables du pion, en calques dédiés au-dessus de l'image : barre d'état (`hp-N`),
 * effectif et numéro de pile (texte ; images de texte sans glyphes).
 */
function pionPartLayers(prefix: string, source: string, glyphs: boolean): LayerSpecification[] {
  const common = { 'icon-allow-overlap': true, 'icon-ignore-placement': true } as const;
  const out: LayerSpecification[] = [
    {
      id: `${prefix}-hp`,
      type: 'symbol',
      source,
      filter: ['>=', ['get', 'hp'], 0],
      layout: {
        ...common,
        'icon-image': ['concat', 'hp-', ['to-string', ['get', 'hp']]],
        'icon-size': PION_SIZE,
        'icon-offset': offsetProp('hoff'),
        'symbol-sort-key': ['get', 'sort'],
      },
      paint: { 'icon-opacity': ['get', 'op'] },
    },
  ];
  if (glyphs) {
    const text = (
      id: string,
      field: string,
      size: number,
      off: string,
      anchor: 'right' | 'center',
      color: string,
      font: string = FONTS.semibold,
    ) =>
      ({
        id,
        type: 'symbol',
        source,
        filter: ['!=', ['get', field], ''],
        layout: {
          'text-field': ['get', field],
          'text-font': [font],
          'text-size': scaled(size),
          'text-offset': offsetProp(off),
          'text-anchor': anchor,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'text-color': color, 'text-opacity': ['get', 'op'] },
      }) as LayerSpecification;
    out.push(
      text(`${prefix}-count`, 'cnt', COUNT_TEXT, 'toff', 'right', '#eef3f8', FONTS.title),
      text(`${prefix}-stack`, 'stk', 8.5, 'soff', 'center', C.bg),
    );
  } else {
    const img = (id: string, field: string, k: number, off: string, anchor: 'right' | 'center') =>
      ({
        id,
        type: 'symbol',
        source,
        filter: ['!=', ['get', field], ''],
        layout: {
          ...common,
          'icon-image': ['concat', `${TEXT_IMAGE_PREFIX}count|`, ['get', field]],
          'icon-size': scaled(k),
          // Décalage en px d'image : ramené à l'échelle du texte (k).
          'icon-offset': offsetProp(off),
          'icon-anchor': anchor,
        },
        paint: { 'icon-opacity': ['get', 'op'] },
      }) as LayerSpecification;
    out.push(
      img(`${prefix}-count`, 'cnt', COUNT_TEXT / 12, 'tpx', 'right'),
      img(`${prefix}-stack`, 'stk', 8.5 / 12, 'spx', 'center'),
    );
  }
  return out;
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

/** Couleur de relation (vert, violet, gris, rouge) lue dans la propriété `rel`. */
function relColor(): ExpressionSpecification {
  return [
    'match',
    ['coalesce', ['get', 'rel'], 'own'],
    'own',
    C.green,
    'ally',
    C.violet,
    'neutral',
    C.grey,
    C.red,
  ];
}

function headingLayout(): SymbolLayerSpecification['layout'] {
  return {
    'icon-image': 'heading',
    'icon-size': PION_SIZE,
    'icon-rotate': ['get', 'rot'],
    'icon-rotation-alignment': 'map',
    'icon-offset': offsetProp('off'),
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

function headingPaint(): SymbolLayerSpecification['paint'] {
  return {
    'icon-color': [
      'match',
      ['get', 'rel'],
      'own',
      C.green,
      'ally',
      C.violet,
      'neutral',
      C.grey,
      C.red,
    ],
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
  const specs: [number, number, number, string, number, number][] = [
    // classe, zoom mini, taille du texte, police, halo, zoom de la ligne « population »
    [0, 2.2, 12.5, FONTS.semibold, 1.5, 4.6],
    [1, 3.6, 11, FONTS.semibold, 1.3, 5.6],
    [2, 5, 10.5, FONTS.regular, 1.2, 7],
    [3, 6.3, 10, FONTS.regular, 1.2, 8.2],
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
  for (const [cls, minzoom, size, font, halo, popZoom] of specs) {
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
    // Population en seconde ligne (plus petite, atténuée) à partir d'un zoom propre à la classe.
    const name: ExpressionSpecification = ['get', 'name'];
    const withPop: ExpressionSpecification = [
      'case',
      ['==', ['coalesce', ['get', 'pop'], ''], ''],
      name,
      [
        'format',
        name,
        {},
        '\n',
        {},
        ['get', 'pop'],
        { 'font-scale': 0.78, 'text-color': 'rgba(170,184,199,0.92)' },
      ],
    ];
    const layout: Record<string, unknown> = i.glyphs
      ? {
          ...l.layout!,
          ...(i.cities ? { 'text-field': ['step', ['zoom'], name, popZoom, withPop] } : {}),
          'icon-image': icon,
          'icon-allow-overlap': true,
          'text-optional': true,
          // Nom au-dessus du marqueur (une garnison posée sur la ville masquerait un nom à droite) ;
          // à gauche ou à droite seulement s'il entre en collision avec une autre étiquette.
          'text-variable-anchor': ['bottom', 'left', 'right'],
          // Au-dessus d'un pion posé sur la ville (demi-hauteur + onglet de pile), à toute échelle.
          'text-radial-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            ...PION_SCALE_STOPS.flatMap(([z, v]) => [
              z,
              Math.max(cls === 0 ? 1.55 : 1.45, ((PION_H / 2 + 14) * v) / size),
            ]),
          ],
          'text-justify': 'auto',
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
      paint:
        i.glyphs && i.cities
          ? {
              ...l.paint!,
              // Villes du joueur : blanc teinté de violet.
              'text-color': [
                'case',
                ['==', ['get', 'mine'], 1],
                cls === 3 ? '#cbbcf0' : '#ece4ff',
                cls === 3 ? '#b9c4cf' : cls === 2 ? '#dfe6ee' : '#ffffff',
              ],
            }
          : l.paint!,
    } as LayerSpecification);
  }
  return out;
}

/** Hauteur de pion exportée pour la surcouche (placement des infobulles). */
export const PION_HALF_H = PION_H / 2;
