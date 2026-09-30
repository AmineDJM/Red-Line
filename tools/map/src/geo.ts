/** Outils géométriques simples (coordonnées [lng, lat], anneaux GeoJSON). */
import { area as turfArea } from '@turf/turf';

export type Pos = [number, number];
export type Ring = Pos[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];
export type BBox = [number, number, number, number];

export interface PolyGeom {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: Polygon | MultiPolygon;
}

export function toMulti(geom: PolyGeom | null | undefined): MultiPolygon {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates as Polygon];
  if (geom.type === 'MultiPolygon') return geom.coordinates as MultiPolygon;
  return [];
}

export function multiGeom(mp: MultiPolygon): PolyGeom {
  return mp.length === 1
    ? { type: 'Polygon', coordinates: mp[0]! }
    : { type: 'MultiPolygon', coordinates: mp };
}

export function bboxOfRing(ring: Ring): BBox {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const [x, y] of ring) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

export function bboxOf(mp: MultiPolygon): BBox {
  let bb: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of mp) {
    const r = poly[0];
    if (!r) continue;
    const b = bboxOfRing(r);
    bb = [
      Math.min(bb[0], b[0]),
      Math.min(bb[1], b[1]),
      Math.max(bb[2], b[2]),
      Math.max(bb[3], b[3]),
    ];
  }
  return bb;
}

export function inBBox(p: Pos, b: BBox, pad = 0): boolean {
  return p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;
}

function pointInRing(p: Pos, ring: Ring): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Pos, poly: Polygon): boolean {
  if (!poly[0] || !pointInRing(p, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(p, poly[i]!)) return false;
  return true;
}

export function pointInMulti(p: Pos, mp: MultiPolygon): boolean {
  for (const poly of mp) if (pointInPolygon(p, poly)) return true;
  return false;
}

/** Superficie en km² (turf, sphérique). */
export function areaKm2(mp: MultiPolygon): number {
  if (mp.length === 0) return 0;
  return turfArea({ type: 'Feature', properties: {}, geometry: multiGeom(mp) } as never) / 1e6;
}

export function polygonAreaKm2(poly: Polygon): number {
  return (
    turfArea({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: poly },
    } as never) / 1e6
  );
}

export function largestPolygon(mp: MultiPolygon): Polygon | undefined {
  let best: Polygon | undefined;
  let bestA = -1;
  for (const poly of mp) {
    const a = polygonAreaKm2(poly);
    if (a > bestA) {
      bestA = a;
      best = poly;
    }
  }
  return best;
}

const R = 6371.0088;
export function haversineKm(a: Pos, b: Pos): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthKm(coords: Pos[]): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversineKm(coords[i - 1]!, coords[i]!);
  return s;
}

// ---------- Pôle d'inaccessibilité (algorithme « polylabel » de Mapbox, version compacte) ----------

function segDistSq(px: number, py: number, a: Pos, b: Pos): number {
  let x = a[0],
    y = a[1],
    dx = b[0] - x,
    dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

/** Distance signée du point au contour (positive à l'intérieur), dans l'espace (lng·cosφ, lat). */
function signedDist(x: number, y: number, poly: Polygon, k: number): number {
  let inside = false;
  let minSq = Infinity;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      const ax = a[0] * k,
        bx = b[0] * k;
      if (a[1] > y !== b[1] > y && x < ((bx - ax) * (y - a[1])) / (b[1] - a[1]) + ax)
        inside = !inside;
      minSq = Math.min(minSq, segDistSq(x, y, [ax, a[1]], [bx, b[1]]));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

/** Tas binaire max minimal. */
export class MaxHeap<T> {
  private a: T[] = [];
  constructor(private key: (t: T) => number) {}
  get size(): number {
    return this.a.length;
  }
  push(t: T): void {
    const a = this.a;
    a.push(t);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key(a[p]!) >= this.key(a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && this.key(a[l]!) > this.key(a[m]!)) m = l;
        if (r < a.length && this.key(a[r]!) > this.key(a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

interface Cell {
  x: number;
  y: number;
  h: number;
  d: number;
  max: number;
}

export function polylabel(poly: Polygon, precisionDeg = 0.01): Pos {
  const outer = poly[0]!;
  const [minX0, minY, maxX0, maxY] = bboxOfRing(outer);
  const k = Math.max(0.05, Math.cos((((minY + maxY) / 2) * Math.PI) / 180));
  const minX = minX0 * k,
    maxX = maxX0 * k;
  const w = maxX - minX,
    hgt = maxY - minY;
  const cellSize = Math.min(w, hgt);
  const mk = (x: number, y: number, h: number): Cell => {
    const d = signedDist(x, y, poly, k);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  if (cellSize === 0) return [minX0, minY];
  const queue: Cell[] = [];
  let h = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize)
    for (let y = minY; y < maxY; y += cellSize) queue.push(mk(x + h, y + h, h));
  // point de départ : barycentre de l'anneau extérieur
  let cx = 0,
    cy = 0,
    ar = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[i]!,
      b = outer[j]!;
    const f = a[0] * k * b[1] - b[0] * k * a[1];
    cx += (a[0] * k + b[0] * k) * f;
    cy += (a[1] + b[1]) * f;
    ar += f * 3;
  }
  let best = ar === 0 ? mk(outer[0]![0] * k, outer[0]![1], 0) : mk(cx / ar, cy / ar, 0);
  const bbCell = mk(minX + w / 2, minY + hgt / 2, 0);
  if (bbCell.d > best.d) best = bbCell;
  const heap = new MaxHeap<Cell>((c) => c.max);
  for (const c of queue) heap.push(c);
  let guard = 0;
  while (heap.size > 0 && guard++ < 50000) {
    const cell = heap.pop()!;
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precisionDeg) continue;
    h = cell.h / 2;
    heap.push(mk(cell.x - h, cell.y - h, h));
    heap.push(mk(cell.x + h, cell.y - h, h));
    heap.push(mk(cell.x - h, cell.y + h, h));
    heap.push(mk(cell.x + h, cell.y + h, h));
  }
  return [best.x / k, best.y];
}

/** Point intérieur représentatif d'un multipolygone (pôle d'inaccessibilité de la plus grande partie). */
export function interiorPoint(mp: MultiPolygon): Pos {
  const poly = largestPolygon(mp);
  if (!poly) return [0, 0];
  const p = polylabel(poly, 0.005);
  return [round(p[0], 4), round(p[1], 4)];
}

export function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** Hachage déterministe FNV-1a 32 bits → [0, 1). */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
