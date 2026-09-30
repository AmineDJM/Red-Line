/**
 * Placement glouton anti-collision des étiquettes cartouches à filets coudés (critique 6.4) :
 * un ensemble LIMITÉ d'étiquettes, triées par priorité ; pour chacune on essaie des positions
 * candidates (quatre quadrants × plusieurs distances), la première valide gagne. Une étiquette
 * garde sa position précédente tant qu'elle reste valide (pas de sautillement pendant les
 * déplacements de caméra). Les étiquettes qui ne trouvent pas de place sont omises.
 */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CalloutInput {
  id: string;
  anchor: Point;
  w: number;
  h: number;
  priority: number;
}

export interface PlacedCallout {
  id: string;
  rect: Rect;
  /** Filet coudé : ancre → coude → point d'attache sur le bord de l'étiquette. */
  leader: [Point, Point, Point];
  candidate: number;
}

export interface PlacementOptions {
  bounds: Rect;
  /** Zones interdites supplémentaires (panneaux d'interface, icônes). */
  obstacles?: Rect[];
  /** Taille de la zone réservée autour de chaque ancre (icône). */
  anchorBox?: number;
  margin?: number;
  previous?: Map<string, number>;
  max?: number;
  /** Segments à ne pas recouvrir (trajectoires affichées). */
  avoidSegments?: [Point, Point][];
}

const OFFSETS: [number, number][] = [
  [22, 22],
  [34, 34],
  [22, 50],
  [52, 26],
  [46, 66],
  [72, 40],
  [66, 80],
];
/** Ordre des quadrants : NE, NO, SE, SO (sx, sy ; y écran vers le bas). */
const QUADRANTS: [number, number][] = [
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];
const RUN = 10;

export const CANDIDATE_COUNT = OFFSETS.length * QUADRANTS.length;

export function candidateGeometry(c: CalloutInput, index: number): { rect: Rect; leader: [Point, Point, Point] } {
  const [kx, ky] = OFFSETS[Math.floor(index / QUADRANTS.length)]!;
  const [sx, sy] = QUADRANTS[index % QUADRANTS.length]!;
  const elbow = { x: c.anchor.x + sx * kx, y: c.anchor.y + sy * ky };
  const attach = { x: elbow.x + sx * RUN, y: elbow.y };
  const rect = { x: sx > 0 ? attach.x : attach.x - c.w, y: elbow.y - c.h / 2, w: c.w, h: c.h };
  return { rect, leader: [c.anchor, elbow, attach] };
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

function inside(r: Rect, b: Rect): boolean {
  return r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;
}

function segIntersectsRect(p: Point, q: Point, r: Rect): boolean {
  // Liang–Barsky
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const checks: [number, number][] = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ];
  for (const [pp, qq] of checks) {
    if (pp === 0) {
      if (qq < 0) return false;
    } else {
      const t = qq / pp;
      if (pp < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

export function placeCallouts(items: CalloutInput[], opts: PlacementOptions): PlacedCallout[] {
  const margin = opts.margin ?? 4;
  const box = opts.anchorBox ?? 22;
  const max = opts.max ?? items.length;
  const sorted = [...items].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const anchorRects: Rect[] = sorted.map((c) => ({ x: c.anchor.x - box / 2, y: c.anchor.y - box / 2, w: box, h: box }));
  const blocked = [...(opts.obstacles ?? []), ...anchorRects];
  const placed: PlacedCallout[] = [];

  const valid = (rect: Rect, leader: [Point, Point, Point]): boolean => {
    if (!inside(rect, opts.bounds)) return false;
    for (const o of blocked) if (rectsOverlap(rect, o)) return false;
    for (const [a, b] of opts.avoidSegments ?? []) if (segIntersectsRect(a, b, rect)) return false;
    for (const p of placed) {
      if (rectsOverlap(rect, p.rect, margin)) return false;
      // Le nouveau filet ne traverse pas une étiquette posée, et inversement.
      if (segIntersectsRect(leader[0], leader[1], p.rect) || segIntersectsRect(leader[1], leader[2], p.rect)) return false;
      if (segIntersectsRect(p.leader[0], p.leader[1], rect) || segIntersectsRect(p.leader[1], p.leader[2], rect)) return false;
    }
    return true;
  };

  for (const c of sorted) {
    if (placed.length >= max) break;
    if (!inside({ x: c.anchor.x, y: c.anchor.y, w: 0, h: 0 }, opts.bounds)) continue;
    const prev = opts.previous?.get(c.id);
    const order = prev !== undefined ? [prev, ...Array.from({ length: CANDIDATE_COUNT }, (_, i) => i).filter((i) => i !== prev)] : Array.from({ length: CANDIDATE_COUNT }, (_, i) => i);
    for (const i of order) {
      const g = candidateGeometry(c, i);
      if (valid(g.rect, g.leader)) {
        placed.push({ id: c.id, rect: g.rect, leader: g.leader, candidate: i });
        break;
      }
    }
  }
  return placed;
}
