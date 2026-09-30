/**
 * Frontières calculées à partir de la topologie des provinces : une arête partagée par deux provinces
 * de propriétaires différents (ou non partagée : côte) est une frontière nationale. Les arêtes du
 * territoire du joueur donnent le halo violet. Suppose des sommets partagés exactement entre provinces
 * voisines (topologie issue de mapshaper) ; sinon, les arêtes non appariées sont traitées comme des côtes.
 */
import type { Feature, FeatureCollection, MultiLineString, Position } from 'geojson';

type Owner = string | undefined;

export interface BorderResult {
  /** Frontières entre nations différentes et côtes. */
  nations: FeatureCollection<MultiLineString>;
  /** Contour extérieur du territoire du joueur. */
  mine: FeatureCollection<MultiLineString>;
}

const key = (p: Position) => `${p[0]!.toFixed(4)},${p[1]!.toFixed(4)}`;

interface EdgeInfo {
  a: Position;
  b: Position;
  owners: Owner[];
  provinces: string[];
}

/**
 * Tolérance (degrés) pour apparier des arêtes quasi colinéaires : jonctions en T et frontières
 * internes simplifiées indépendamment de part et d'autre (≈ 2 km, constaté dans data/map).
 */
const EPS = 0.02;
/** Sinus maximal de l'angle entre deux arêtes appariées (≈ 25°). */
const MAX_SIN = 0.42;
const CELL = 0.1;

function distPointSeg(p: Position, a: Position, b: Position): number {
  const ax = a[0]!;
  const ay = a[1]!;
  const dx = b[0]! - ax;
  const dy = b[1]! - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0]! - ax) * dx + (p[1]! - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0]! - (ax + t * dx), p[1]! - (ay + t * dy));
}

/**
 * Deuxième passe : une arête non appariée dont le milieu se trouve sur une arête non appariée
 * d'une autre province est partagée (sommet présent d'un seul côté, « jonction en T »).
 */
function matchCollinear(edges: Map<string, EdgeInfo>) {
  const single = [...edges.values()].filter((e) => e.owners.length === 1);
  const grid = new Map<string, EdgeInfo[]>();
  for (const e of single) {
    const x0 = Math.floor(Math.min(e.a[0]!, e.b[0]!) / CELL);
    const x1 = Math.floor(Math.max(e.a[0]!, e.b[0]!) / CELL);
    const y0 = Math.floor(Math.min(e.a[1]!, e.b[1]!) / CELL);
    const y1 = Math.floor(Math.max(e.a[1]!, e.b[1]!) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x}:${y}`;
        const l = grid.get(k);
        if (l) l.push(e);
        else grid.set(k, [e]);
      }
  }
  for (const e of single) {
    const mid: Position = [(e.a[0]! + e.b[0]!) / 2, (e.a[1]! + e.b[1]!) / 2];
    const cx = Math.floor(mid[0]! / CELL);
    const cy = Math.floor(mid[1]! / CELL);
    const ex = e.b[0]! - e.a[0]!;
    const ey = e.b[1]! - e.a[1]!;
    const el = Math.hypot(ex, ey) || 1;
    let best: EdgeInfo | null = null;
    let bestD = EPS;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const f of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (f === e || f.provinces[0] === e.provinces[0]) continue;
          const d = distPointSeg(mid, f.a, f.b);
          if (d >= bestD) continue;
          const fx = f.b[0]! - f.a[0]!;
          const fy = f.b[1]! - f.a[1]!;
          const sin = Math.abs(ex * fy - ey * fx) / (el * (Math.hypot(fx, fy) || 1));
          if (sin > MAX_SIN) continue;
          best = f;
          bestD = d;
        }
    if (best) {
      e.owners.push(best.owners[0]);
      e.provinces.push(best.provinces[0]!);
    }
  }
}

function rings(f: Feature): Position[][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

/** Arêtes indexées par paire de sommets non orientée, avec les propriétaires des provinces adjacentes. */
export function buildEdgeIndex(
  geo: FeatureCollection,
  ownerOf: (provinceId: string) => Owner,
): Map<string, EdgeInfo> {
  const edges = new Map<string, EdgeInfo>();
  for (const f of geo.features) {
    const id = String(f.properties?.id ?? f.id ?? '');
    const owner = ownerOf(id);
    for (const ring of rings(f)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const e = edges.get(k);
        if (e) {
          e.owners.push(owner);
          e.provinces.push(id);
        } else edges.set(k, { a, b, owners: [owner], provinces: [id] });
      }
    }
  }
  matchCollinear(edges);
  return edges;
}

/** Fusionne des segments en polylignes (moins de sommets à envoyer au GPU). */
function chain(segs: [Position, Position][]): Position[][] {
  const byStart = new Map<string, number[]>();
  segs.forEach(([a], i) => {
    const k = key(a);
    const l = byStart.get(k);
    if (l) l.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Uint8Array(segs.length);
  const lines: Position[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: Position[] = [segs[i]![0], segs[i]![1]];
    for (;;) {
      const nextIdx = byStart.get(key(line[line.length - 1]!))?.find((j) => !used[j]);
      if (nextIdx === undefined) break;
      used[nextIdx] = 1;
      line.push(segs[nextIdx]![1]);
    }
    lines.push(line);
  }
  return lines;
}

export function computeBorders(
  geo: FeatureCollection,
  ownerOf: (provinceId: string) => Owner,
  me: string | null,
): BorderResult {
  const edges = buildEdgeIndex(geo, ownerOf);
  const nationSegs: [Position, Position][] = [];
  const mineSegs: [Position, Position][] = [];
  for (const e of edges.values()) {
    const [o1, o2] = e.owners;
    const shared = e.owners.length >= 2;
    if (!shared || o1 !== o2) nationSegs.push([e.a, e.b]);
    if (me) {
      const mineCount = e.owners.filter((o) => o === me).length;
      if (mineCount === 1 && (!shared || o1 !== o2)) mineSegs.push([e.a, e.b]);
    }
  }
  const fc = (segs: [Position, Position][]): FeatureCollection<MultiLineString> => ({
    type: 'FeatureCollection',
    features: segs.length
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiLineString', coordinates: chain(segs) },
          },
        ]
      : [],
  });
  return { nations: fc(nationSegs), mine: fc(mineSegs) };
}
