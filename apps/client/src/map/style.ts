/**
 * Style MapLibre de Red Line : imagerie satellite sombre (PMTiles) avec fondu vers un fond
 * vectoriel sombre au-delà de son zoom max, territoires teintés par feature-state, brouillard,
 * frontières claires, étiquettes (glyphes PBF, ou images de repli), et calques de jeu.
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
import { EMPTY, ORANGE } from './features.js';
import { TEXT_IMAGE_PREFIX, type TextStyle } from './sprites.js';

export interface StyleInput {
  tiles: TilesInfo | null;
  glyphs: boolean;
  basemap: BasemapData | null;
  provinces: FeatureCollection | null;
  nationLabels: FeatureCollection;
  attribution: string;
  mode: 'game' | 'sandbox' | 'picker';
  clusterUnits: boolean;
}

const geo = (data: FeatureCollection | null = EMPTY, extra: Record<string, unknown> = {}): SourceSpecification =>
  ({ type: 'geojson', data: data ?? EMPTY, ...extra }) as SourceSpecification;

const UNIT_SIZE: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 1.5, 0.44, 4, 0.56, 7, 0.68, 10, 0.78];
const UNCLUSTERED: ExpressionSpecification = ['!', ['has', 'point_count']];

/** Étiquette : texte MapLibre si les glyphes existent, sinon image générée (`txt|style|texte`). */
function label(
  glyphs: boolean,
  field: ExpressionSpecification,
  opts: {
    style: TextStyle;
    font: string;
    size: number;
    spacing: number;
    color: string;
    halo: string;
    haloWidth: number;
    upper?: boolean;
    italic?: boolean;
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
        'text-padding': 4,
      },
      paint: { 'text-color': opts.color, 'text-halo-color': opts.halo, 'text-halo-width': opts.haloWidth, 'text-halo-blur': 0.8 },
    };
  }
  return {
    layout: {
      'icon-image': ['concat', `${TEXT_IMAGE_PREFIX}${opts.style}|`, field] as ExpressionSpecification,
      'icon-allow-overlap': false,
      'icon-padding': 4,
    },
    paint: {},
  };
}

export function buildStyle(i: StyleInput): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    provinces: { type: 'geojson', data: i.provinces ?? EMPTY, promoteId: 'id' } as SourceSpecification,
    'basemap-land': geo(i.basemap?.land ?? null),
    'basemap-coast': geo(i.basemap?.coastline ?? null),
    'basemap-seas': geo(i.basemap?.seas ?? null),
    'nation-labels': geo(i.nationLabels),
    borders: geo(),
    'my-border': geo(),
    fog: geo(),
    uncert: geo(),
    range: geo(),
    'range-lines': geo(),
    paths: geo(),
    'path-heads': geo(),
    preview: geo(),
    'preview-pts': geo(),
    buildings: geo(),
    units: geo(
      EMPTY,
      i.clusterUnits
        ? {
            cluster: true,
            clusterMaxZoom: 4,
            clusterRadius: 34,
            clusterProperties: { mine: ['+', ['get', 'mine']] },
          }
        : {},
    ),
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
    { id: 'bg', type: 'background', paint: { 'background-color': '#04070d' } },
    { id: 'land', type: 'fill', source: 'basemap-land', paint: { 'fill-color': '#121a26', 'fill-antialias': false } },
    {
      id: 'prov-base',
      type: 'fill',
      source: 'provinces',
      paint: { 'fill-color': '#131b28', 'fill-antialias': false },
    },
  ];
  if (i.tiles) {
    layers.push({
      id: 'sat',
      type: 'raster',
      source: 'satellite',
      paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], mz, 1, mz + 2, 0.3],
        'raster-saturation': -0.2,
        'raster-contrast': 0.06,
        'raster-brightness-max': 0.82,
        'raster-fade-duration': 150,
        'raster-resampling': 'linear',
      },
    });
  }
  const mine: ExpressionSpecification = ['boolean', ['feature-state', 'mine'], false];
  const pick: ExpressionSpecification = ['boolean', ['feature-state', 'pick'], false];
  layers.push(
    {
      id: 'prov-fill',
      type: 'fill',
      source: 'provinces',
      paint: {
        'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#3a4252']],
        'fill-opacity': ['case', mine, 0.52, pick, 0.6, i.mode === 'picker' ? 0.3 : 0.2],
        'fill-antialias': false,
      },
    },
    {
      id: 'prov-disputed',
      type: 'fill',
      source: 'provinces',
      filter: ['has', 'disputed'],
      paint: { 'fill-pattern': 'hatch-disputed', 'fill-opacity': 0.7 },
    },
    { id: 'fog', type: 'fill', source: 'fog', paint: { 'fill-color': '#01030a', 'fill-opacity': 0.42, 'fill-antialias': false } },
    { id: 'fog-hatch', type: 'fill', source: 'fog', paint: { 'fill-pattern': 'hatch-fog', 'fill-opacity': 0.8 } },
    {
      id: 'prov-line',
      type: 'line',
      source: 'provinces',
      minzoom: 2.5,
      paint: {
        'line-color': ['case', mine, 'rgba(215,200,255,0.5)', 'rgba(220,228,240,0.22)'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 7, 0.9],
      },
    },
    {
      id: 'coast',
      type: 'line',
      source: 'basemap-coast',
      paint: { 'line-color': 'rgba(170,190,215,0.35)', 'line-width': 0.6 },
    },
    {
      id: 'borders',
      type: 'line',
      source: 'borders',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': 'rgba(236,241,248,0.7)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 4, 0.9, 8, 1.4],
      },
    },
    {
      id: 'my-glow',
      type: 'line',
      source: 'my-border',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#a77bff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 6, 5, 12, 8, 18],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 5, 5, 10, 8, 14],
        'line-opacity': 0.55,
      },
    },
    {
      id: 'my-edge',
      type: 'line',
      source: 'my-border',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#d2bcff', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.9, 6, 1.8] },
    },
    {
      id: 'capture',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': ['case', ['==', ['coalesce', ['feature-state', 'cap'], 0], 2], '#e5343a', ORANGE],
        'line-width': 2,
        'line-dasharray': [2, 1.5],
        'line-opacity': ['case', ['>', ['coalesce', ['feature-state', 'cap'], 0], 0], 0.95, 0],
      },
    },
    {
      id: 'prov-sel',
      type: 'line',
      source: 'provinces',
      paint: {
        'line-color': '#ffffff',
        'line-width': 2,
        'line-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 0.9, 0],
      },
    },
  );

  // ——— Étiquettes ———
  const seas = (rank: number, style: TextStyle, size: number, minzoom: number): LayerSpecification => {
    const l = label(i.glyphs, ['get', 'name'], {
      style,
      font: FONTS.italic,
      size,
      spacing: 0.1,
      color: '#8d99ad',
      halo: 'rgba(0,0,0,0.5)',
      haloWidth: 1,
    });
    return {
      id: `sea-labels-${rank}`,
      type: 'symbol',
      source: 'basemap-seas',
      minzoom,
      filter: rank === 1 ? ['<=', ['coalesce', ['get', 'rank'], 1], 1] : ['>', ['coalesce', ['get', 'rank'], 1], 1],
      layout: l.layout!,
      paint: l.paint!,
    } as LayerSpecification;
  };
  layers.push(seas(1, 'sea-l', 14, 1.5), seas(2, 'sea-s', 12, 3.2));
  const country = (rank: 'l' | 'm' | 's', size: number, minzoom: number, maxzoom: number): LayerSpecification => {
    const l = label(i.glyphs, ['get', 'name'], {
      style: `country-${rank}`,
      font: FONTS.title,
      size,
      spacing: 0.2,
      color: '#ffffff',
      halo: 'rgba(0,0,0,0.75)',
      haloWidth: 1.4,
      upper: true,
    });
    return {
      id: `country-labels-${rank}`,
      type: 'symbol',
      source: 'nation-labels',
      minzoom,
      maxzoom,
      filter: ['==', ['get', 'rank'], rank],
      layout: { ...l.layout!, 'symbol-sort-key': ['-', 0, ['get', 'area']] },
      paint: l.paint!,
    } as LayerSpecification;
  };
  layers.push(country('l', 19, 1.5, 8), country('m', 15, 2.6, 8.5), country('s', 12, 4, 9));

  if (i.mode !== 'picker') {
    layers.push(
      // ——— Contacts incertains ———
      { id: 'uncert-fill', type: 'fill', source: 'uncert', paint: { 'fill-color': '#9aa6bd', 'fill-opacity': 0.08 } },
      {
        id: 'uncert-line',
        type: 'line',
        source: 'uncert',
        paint: { 'line-color': 'rgba(200,210,228,0.55)', 'line-width': 1, 'line-dasharray': [2, 2] },
      },
      // ——— Arc de portée ———
      { id: 'range-fill', type: 'fill', source: 'range', paint: { 'fill-color': ORANGE, 'fill-opacity': 0.2 } },
      {
        id: 'range-lines',
        type: 'line',
        source: 'range-lines',
        paint: {
          'line-color': ORANGE,
          'line-width': ['match', ['get', 'kind'], 'max', 2.2, 'min', 1, 1.2],
          'line-opacity': ['match', ['get', 'kind'], 'max', 0.95, 'min', 0.5, 0.7],
          'line-dasharray': ['match', ['get', 'kind'], 'radius', ['literal', [3, 3]], ['literal', [1, 0]]],
        },
      },
      // ——— Trajectoires des unités en mouvement ———
      {
        id: 'paths',
        type: 'line',
        source: 'paths',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ORANGE,
          'line-width': ['case', ['==', ['get', 'sel'], 1], 2.6, 1.4],
          'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.7],
        },
      },
      {
        id: 'path-heads',
        type: 'symbol',
        source: 'path-heads',
        layout: {
          'icon-image': 'arrow',
          'icon-size': ['case', ['==', ['get', 'sel'], 1], 0.5, 0.36],
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-color': ORANGE },
      },
      // ——— Aperçu d'ordre ———
      {
        id: 'preview-casing',
        type: 'line',
        source: 'preview',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 6 },
      },
      {
        id: 'preview',
        type: 'line',
        source: 'preview',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ORANGE, 'line-width': 3.2 },
      },
      {
        id: 'preview-target',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'target'],
        layout: { 'icon-image': 'ring', 'icon-size': 0.95, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: { 'icon-color': '#e5343a' },
      },
      {
        id: 'preview-launch',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'launch'],
        layout: { 'icon-image': 'tri', 'icon-size': 0.62, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-offset': [0, 30] },
        paint: { 'icon-color': ORANGE, 'icon-halo-color': 'rgba(0,0,0,0.6)', 'icon-halo-width': 1 },
      },
      {
        id: 'preview-arrow',
        type: 'symbol',
        source: 'preview-pts',
        filter: ['==', ['get', 'kind'], 'arrow'],
        layout: {
          'icon-image': 'arrow',
          'icon-size': 0.62,
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-color': ORANGE, 'icon-halo-color': 'rgba(0,0,0,0.6)', 'icon-halo-width': 1 },
      },
      // ——— Bâtiments ———
      ...buildingLayers('mine', 3, ['==', ['get', 'mine'], 1]),
      ...buildingLayers('other', 5, ['==', ['get', 'mine'], 0]),
      // ——— Unités ———
      {
        id: 'cluster-hex',
        type: 'symbol',
        source: 'units',
        filter: ['has', 'point_count'],
        layout: { 'icon-image': 'hex', 'icon-size': 0.62, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: {
          'icon-color': ['case', ['>=', ['get', 'mine'], ['-', ['get', 'point_count'], ['get', 'mine']]], '#7b4cf0', '#56607a'],
          'icon-halo-color': 'rgba(255,255,255,0.9)',
          'icon-halo-width': 1.4,
        },
      },
      clusterCount(i.glyphs),
      {
        id: 'units-sel',
        type: 'symbol',
        source: 'units',
        filter: ['all', UNCLUSTERED, ['>', ['get', 'sel'], 0]],
        layout: { 'icon-image': 'hex-sel', 'icon-size': UNIT_SIZE, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: { 'icon-color': ['case', ['==', ['get', 'sel'], 2], '#e5343a', ORANGE] },
      },
      {
        id: 'units-hex',
        type: 'symbol',
        source: 'units',
        filter: UNCLUSTERED,
        layout: {
          'icon-image': 'hex',
          'icon-size': UNIT_SIZE,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: {
          'icon-color': ['get', 'color'],
          'icon-halo-color': ['case', ['==', ['get', 'mine'], 1], 'rgba(235,225,255,0.95)', 'rgba(255,255,255,0.8)'],
          'icon-halo-width': 1.2,
          'icon-opacity': ['get', 'op'],
        },
      },
      {
        id: 'units-pic',
        type: 'symbol',
        source: 'units',
        filter: UNCLUSTERED,
        layout: {
          'icon-image': ['concat', 'pic-', ['get', 'pic']],
          'icon-size': UNIT_SIZE,
          'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: { 'icon-color': '#ffffff', 'icon-opacity': ['get', 'op'] },
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

function buildingLayers(kind: 'mine' | 'other', minzoom: number, filter: FilterSpecification): LayerSpecification[] {
  const size: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], minzoom, 0.34, 8, 0.48];
  return [
    {
      id: `bld-${kind}-hex`,
      type: 'symbol',
      source: 'buildings',
      minzoom,
      filter,
      layout: {
        'icon-image': 'hex',
        'icon-size': size,
        'icon-offset': ['get', 'off'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': 'rgba(255,255,255,0.7)', 'icon-halo-width': 1 },
    },
    {
      id: `bld-${kind}-pic`,
      type: 'symbol',
      source: 'buildings',
      minzoom,
      filter,
      layout: {
        'icon-image': ['concat', 'pic-', ['get', 'pic']],
        'icon-size': size,
        'icon-offset': ['get', 'off'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': '#ffffff' },
    },
  ];
}

function clusterCount(glyphs: boolean): LayerSpecification {
  if (glyphs) {
    return {
      id: 'cluster-count',
      type: 'symbol',
      source: 'units',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': [FONTS.semibold],
        'text-size': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 1 },
    };
  }
  return {
    id: 'cluster-count',
    type: 'symbol',
    source: 'units',
    filter: ['has', 'point_count'],
    layout: {
      'icon-image': ['concat', `${TEXT_IMAGE_PREFIX}count|`, ['to-string', ['get', 'point_count']]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  };
}

