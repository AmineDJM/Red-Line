/**
 * Réseau de routes des unités terrestres sur la carte (façon Conflict of Nations) :
 * - couche discrète (tracés, nœuds de passage), plus marquée quand une unité terrestre est sélectionnée ;
 * - accrochage magnétique du pointeur : ville d'abord, puis nœud, puis point de route le plus proche ;
 * - trajet réel le long des routes pour l'aperçu d'un ordre (traversée par les ports si besoin).
 *
 * Le graphe (RoadNet) est le même code que celui du moteur (@redline/shared) : l'aperçu et la
 * destination accrochée correspondent à ce que le serveur calculera.
 */
import type {
  CircleLayerSpecification,
  GeoJSONSource,
  LineLayerSpecification,
  Map as MlMap,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import {
  distanceKm,
  interpolate,
  unwrapLngs,
  type LngLat,
  type RoadNet,
  type RoadNodeKind,
  type RoadPoint,
} from '@redline/shared';
import { C } from './palette.js';

/** Rayon d'accrochage par défaut (km), comme `balance.movement.roadSnapKm` côté moteur. */
export const DEFAULT_ROAD_SNAP_KM = 60;
/** Aimant des villes (pixels écran), et rayon minimal (km) : une ville toute proche l'emporte. */
export const CITY_MAGNET_PX = { mouse: 34, touch: 48 } as const;
const CITY_MAGNET_MIN_KM = 6;
/** Aimant des autres nœuds (ports, passages, carrefours, centres), en pixels écran. */
export const NODE_MAGNET_PX = { mouse: 16, touch: 26 } as const;
/** Rattachement d'une unité hors réseau (même valeur que le moteur). */
const JOIN_MAX_KM = 4000;
/** Ports candidats de chaque côté d'une traversée (aperçu). */
const PORT_CANDIDATES = 6;

export type SnapKind = RoadNodeKind | 'road';

export interface RoadSnap {
  pos: LngLat;
  kind: SnapKind;
  /** Nœud visé (−1 : point d'une route). */
  node: number;
  /** Distance au point visé (km). */
  d: number;
}

/** Kilomètres par pixel à cette latitude et ce zoom (tuiles de 512 px). */
export function kmPerPx(lat: number, zoom: number): number {
  return (40075.016686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/**
 * Accrochage magnétique d'un point visé : la ville la plus proche dans l'aimant des villes, sinon un
 * nœud dans l'aimant des nœuds, sinon le point de route le plus proche à moins de `maxKm` (rayon du
 * moteur). Null : point hors du réseau (ordre refusé par le moteur).
 */
export function snapToRoads(
  net: RoadNet,
  p: LngLat,
  opts: { cityKm: number; nodeKm: number; maxKm?: number },
): RoadSnap | null {
  const maxKm = opts.maxKm ?? DEFAULT_ROAD_SNAP_KM;
  const nodeSnap = (i: number): RoadSnap => {
    const n = net.nodes[i]!;
    return { pos: n.pos, kind: n.kind, node: i, d: distanceKm(p, n.pos) };
  };
  const city = net.nearestNode(
    p,
    Math.max(opts.cityKm, CITY_MAGNET_MIN_KM),
    (i) => net.nodes[i]!.kind === 'city',
  );
  if (city >= 0) return nodeSnap(city);
  const node = net.nearestNode(p, opts.nodeKm);
  if (node >= 0) return nodeSnap(node);
  const r = net.snap(p, maxKm);
  if (!r) return null;
  return r.node >= 0 ? nodeSnap(r.node) : { pos: r.pos, kind: 'road', node: -1, d: r.d };
}

/** Rayons d'accrochage (km) pour le zoom et le pointeur courants. */
export function magnetKm(lat: number, zoom: number, pointer: 'mouse' | 'touch' | 'pen') {
  const k = kmPerPx(lat, zoom);
  const key = pointer === 'mouse' ? 'mouse' : 'touch';
  return { cityKm: CITY_MAGNET_PX[key] * k, nodeKm: NODE_MAGNET_PX[key] * k };
}

export interface RoadPath {
  /** Tracé de la position de l'unité à la destination. */
  pts: LngLat[];
  km: number;
  /** Part maritime (traversée embarquée), km. */
  seaKm: number;
}

/** Point du réseau à partir d'une position quelconque (unité). */
function joinPoint(net: RoadNet, from: LngLat): RoadPoint | null {
  return net.snapNearest(from, JOIN_MAX_KM);
}

function concat(out: LngLat[], pts: LngLat[]): void {
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
}

/**
 * Trajet le long des routes de `from` (position d'une unité) à `to` (point accroché), avec une
 * traversée maritime approchée en ligne droite de port à port si la destination est sur une autre
 * masse continentale. Null si inatteignable.
 */
export function roadPath(net: RoadNet, from: LngLat, to: LngLat, seaFactor = 0.6): RoadPath | null {
  const S = joinPoint(net, from);
  const D = net.snap(to, 1) ?? net.snap(to, DEFAULT_ROAD_SNAP_KM);
  if (!S || !D) return null;
  const pts: LngLat[] = [from];
  if (net.compOf(S) === net.compOf(D)) {
    const r = net.route(S, D);
    if (!r) return null;
    concat(pts, r.pts);
    return { pts, km: polyKm(pts), seaKm: 0 };
  }
  // Traversée : meilleurs ports de chaque côté (route + mer en ligne droite).
  const dS = net.distancesFrom(S);
  const dD = net.distancesFrom(D);
  const best = (reached: Map<number, number>, toward: LngLat) =>
    [...reached]
      .filter(([i]) => net.nodes[i]!.port)
      .map(([i, km]) => ({ i, s: km + distanceKm(net.nodes[i]!.pos, toward) / seaFactor }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .slice(0, PORT_CANDIDATES)
      .map((x) => x.i);
  const ps = best(dS, D.pos);
  const qs = best(dD, S.pos);
  let pick: { p: number; q: number; cost: number } | null = null;
  for (const p of ps)
    for (const q of qs) {
      const sea = distanceKm(net.nodes[p]!.pos, net.nodes[q]!.pos);
      const cost = dS.get(p)! + sea / seaFactor + dD.get(q)!;
      if (!pick || cost < pick.cost) pick = { p, q, cost };
    }
  if (!pick) return null;
  const a = net.route(S, net.nodePoint(pick.p));
  const b = net.route(net.nodePoint(pick.q), D);
  if (!a || !b) return null;
  concat(pts, a.pts);
  const pa = net.nodes[pick.p]!.pos;
  const qa = net.nodes[pick.q]!.pos;
  const n = Math.max(1, Math.ceil(distanceKm(pa, qa) / 60));
  const sea: LngLat[] = [];
  for (let i = 0; i <= n; i++) sea.push(i === 0 ? pa : i === n ? qa : interpolate(pa, qa, i / n));
  concat(pts, sea);
  concat(pts, b.pts);
  return {
    pts,
    km: polyKm(pts),
    seaKm: distanceKm(net.nodes[pick.p]!.pos, net.nodes[pick.q]!.pos),
  };
}

function polyKm(pts: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distanceKm(pts[i - 1]!, pts[i]!);
  return km;
}

/** Durée du trajet (ms) : route à la vitesse de l'unité, mer à vitesse réduite plus l'embarquement. */
export function roadPathMs(
  path: RoadPath,
  speedKmh: number,
  seaFactor = 0.6,
  embarkMinutes = 60,
): number {
  if (speedKmh <= 0) return 0;
  const land = path.km - path.seaKm;
  const sea = path.seaKm / seaFactor;
  const wait = path.seaKm > 0 ? 2 * embarkMinutes * 60_000 : 0;
  return ((land + sea) / speedKmh) * 3_600_000 + wait;
}

/** GeoJSON du réseau : un tracé par arête, et les nœuds (hors villes, déjà dessinées). */
export function roadsGeoJSON(net: RoadNet): {
  lines: FeatureCollection<LineString>;
  nodes: FeatureCollection<Point>;
} {
  const lines: Feature<LineString>[] = net.edges.map((e, i) => ({
    type: 'Feature',
    id: i,
    properties: { ferry: e.ferry ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: unwrapLngs(e.pts) },
  }));
  const nodes: Feature<Point>[] = [];
  net.nodes.forEach((n, i) => {
    if (n.kind === 'city') return;
    nodes.push({
      type: 'Feature',
      id: i,
      properties: { kind: n.kind, port: n.port ? 1 : 0 },
      geometry: { type: 'Point', coordinates: n.pos },
    });
  });
  return {
    lines: { type: 'FeatureCollection', features: lines },
    nodes: { type: 'FeatureCollection', features: nodes },
  };
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Identifiants des calques de la couche « routes ». */
export const ROAD_LAYERS = ['roads', 'road-nodes', 'road-snap', 'road-snap-off'] as const;

/** Couche « routes » : ajoutée à la carte quand le réseau est chargé, sous les trajets et les pions. */
export class RoadLayer {
  private net: RoadNet | null = null;
  private emphasized = false;
  private markerKey = '';

  constructor(
    private readonly map: MlMap,
    private readonly beforeId?: string,
  ) {}

  get roads(): RoadNet | null {
    return this.net;
  }

  attach(net: RoadNet | null): void {
    if (!net || net === this.net) return;
    this.net = net;
    const data = roadsGeoJSON(net);
    const m = this.map;
    const before = this.beforeId && m.getLayer(this.beforeId) ? this.beforeId : undefined;
    if (m.getSource('roads')) {
      (m.getSource('roads') as GeoJSONSource).setData(data.lines);
      (m.getSource('road-nodes') as GeoJSONSource).setData(data.nodes);
      return;
    }
    m.addSource('roads', { type: 'geojson', data: data.lines, tolerance: 0.6 });
    m.addSource('road-nodes', { type: 'geojson', data: data.nodes });
    m.addSource('road-snap', { type: 'geojson', data: EMPTY_FC });
    m.addLayer(
      {
        id: 'roads',
        type: 'line',
        source: 'roads',
        minzoom: 3,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: this.linePaint(),
      },
      before,
    );
    m.addLayer(
      {
        id: 'road-nodes',
        type: 'circle',
        source: 'road-nodes',
        minzoom: 5,
        paint: this.nodePaint(),
      },
      before,
    );
    m.addLayer(
      {
        id: 'road-snap',
        type: 'circle',
        source: 'road-snap',
        filter: ['==', ['get', 'ok'], 1],
        paint: {
          'circle-radius': 7,
          'circle-color': 'rgba(76,201,240,0.18)',
          'circle-stroke-color': C.cyan,
          'circle-stroke-width': 1.6,
        },
      },
      before,
    );
    m.addLayer(
      {
        id: 'road-snap-off',
        type: 'circle',
        source: 'road-snap',
        filter: ['==', ['get', 'ok'], 0],
        paint: {
          'circle-radius': 6,
          'circle-color': 'rgba(255,77,94,0.15)',
          'circle-stroke-color': C.red,
          'circle-stroke-width': 1.4,
        },
      },
      before,
    );
  }

  private linePaint(): NonNullable<LineLayerSpecification['paint']> {
    const on = this.emphasized;
    return {
      'line-color': on ? '#9fc4dc' : '#8b9aa8',
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        3,
        on ? 0.3 : 0,
        4.5,
        on ? 0.6 : 0.22,
        7,
        on ? 0.8 : 0.38,
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        3,
        0.5,
        6,
        on ? 1.4 : 1,
        9,
        on ? 2.4 : 1.6,
      ],
    };
  }

  private nodePaint(): NonNullable<CircleLayerSpecification['paint']> {
    const on = this.emphasized;
    return {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 8, on ? 3 : 2.2],
      'circle-color': ['match', ['get', 'kind'], 'port', C.cyan, 'pass', C.amber, '#8b9aa8'],
      'circle-opacity': on ? 0.85 : 0.45,
      'circle-stroke-color': 'rgba(0,0,0,0.6)',
      'circle-stroke-width': 0.6,
    };
  }

  /** Couche plus marquée quand une unité terrestre est sélectionnée. */
  emphasize(on: boolean): void {
    if (on === this.emphasized) return;
    this.emphasized = on;
    if (!this.map.getLayer('roads')) return;
    for (const [k, v] of Object.entries(this.linePaint()))
      this.map.setPaintProperty('roads', k as never, v as never);
    for (const [k, v] of Object.entries(this.nodePaint()))
      this.map.setPaintProperty('road-nodes', k as never, v as never);
  }

  /** Marqueur d'accrochage sous le pointeur : point du réseau visé, ou point refusé (rouge). */
  marker(at: LngLat | null, ok: boolean): void {
    const key = at ? `${at[0].toFixed(5)},${at[1].toFixed(5)},${ok ? 1 : 0}` : '';
    if (key === this.markerKey) return;
    this.markerKey = key;
    const src = this.map.getSource('road-snap') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      at
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { ok: ok ? 1 : 0 },
                geometry: { type: 'Point', coordinates: at },
              },
            ],
          }
        : EMPTY_FC,
    );
  }
}
