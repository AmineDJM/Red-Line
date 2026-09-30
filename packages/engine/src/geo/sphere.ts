import { EARTH_RADIUS_KM, toVec, type Leg, type LngLat, type Movement, type Vec3 } from '@redline/shared';

/**
 * Trajectoire par morceaux sur la sphère unité : chaque morceau est soit un point fixe, soit un arc de
 * grand cercle parcouru à vitesse angulaire constante. p(t) = p0·cos θ + u·sin θ, θ = w·(t − lt0).
 */
export interface StaticPiece {
  t0: number;
  t1: number;
  s: true;
  v: Vec3;
}
export interface ArcPiece {
  t0: number;
  t1: number;
  s: false;
  p0: Vec3;
  u: Vec3;
  /** Vitesse angulaire (rad/ms). */
  w: number;
  /** Longueur angulaire de l'arc (rad). */
  len: number;
}
export type Piece = StaticPiece | ArcPiece;

export function kmToRad(km: number): number {
  return km / EARTH_RADIUS_KM;
}

export function vecAngle(a: Vec3, b: Vec3): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/** Distance en km entre deux vecteurs unitaires. */
export function vecDistKm(a: Vec3, b: Vec3): number {
  return vecAngle(a, b) * EARTH_RADIUS_KM;
}

/** Morceau correspondant à un segment de trajet (arc, ou point fixe si le segment est immobile). */
export function legPiece(leg: Leg): Piece {
  const a = toVec(leg.from);
  const b = toVec(leg.to);
  const len = vecAngle(a, b);
  if (len < 1e-12 || leg.t1 <= leg.t0) return { t0: leg.t0, t1: leg.t1, s: true, v: a };
  const c = Math.cos(len);
  const s = Math.sin(len);
  let u: Vec3;
  if (s > 1e-9) {
    u = [(b[0] - a[0] * c) / s, (b[1] - a[1] * c) / s, (b[2] - a[2] * c) / s];
  } else {
    // Points antipodaux : direction arbitraire mais déterministe, orthogonale à a.
    const ref: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0] * a[0] + ref[1] * a[1] + ref[2] * a[2];
    const x: Vec3 = [ref[0] - k * a[0], ref[1] - k * a[1], ref[2] - k * a[2]];
    const n = Math.hypot(x[0], x[1], x[2]);
    u = [x[0] / n, x[1] / n, x[2] / n];
  }
  return { t0: leg.t0, t1: leg.t1, s: false, p0: a, u, w: len / (leg.t1 - leg.t0), len };
}

/** Position (vecteur unitaire) sur un morceau à l'instant t (bornée aux extrémités). */
export function piecePos(p: Piece, t: number): Vec3 {
  if (p.s) return p.v;
  let th = p.w * (t - p.t0);
  if (th < 0) th = 0;
  else if (th > p.len) th = p.len;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [p.p0[0] * c + p.u[0] * s, p.p0[1] * c + p.u[1] * s, p.p0[2] * c + p.u[2] * s];
}

/** Découpe une position + trajet en morceaux couvrant ]−∞, +∞[. */
export function trajectoryPieces(pos: LngLat, move: Movement | null): Piece[] {
  if (!move || move.legs.length === 0) {
    return [{ t0: -Infinity, t1: Infinity, s: true, v: toVec(pos) }];
  }
  const legs = move.legs;
  const out: Piece[] = [];
  const first = legs[0]!;
  out.push({ t0: -Infinity, t1: first.t0, s: true, v: toVec(first.from) });
  for (const leg of legs) {
    if (leg.t1 <= leg.t0) continue;
    out.push(legPiece(leg));
  }
  const last = legs[legs.length - 1]!;
  out.push({ t0: last.t1, t1: Infinity, s: true, v: toVec(last.to) });
  return out;
}

/** Index du morceau actif à l'instant t (dernier morceau dont t0 <= t). */
export function pieceIndexAt(pieces: Piece[], t: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid]!.t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function posAt(pieces: Piece[], t: number): Vec3 {
  return piecePos(pieces[pieceIndexAt(pieces, t)]!, t);
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Racines exactes (en temps) de « p(t)·c = k » sur un arc, pour t dans [ts, te].
 * p(θ)·c = A cos θ + B sin θ = M cos(θ − φ) : θ = φ ± acos(k / M).
 */
export function arcCircleRoots(p: ArcPiece, c: Vec3, k: number, ts: number, te: number): number[] {
  const A = dot3(p.p0, c);
  const B = dot3(p.u, c);
  const M = Math.hypot(A, B);
  if (M < 1e-15) return [];
  const ratio = k / M;
  if (ratio > 1 || ratio < -1) return [];
  const alpha = Math.acos(ratio);
  const phi = Math.atan2(B, A);
  const ths = Math.max(0, p.w * (ts - p.t0));
  const the = Math.min(p.len, p.w * (te - p.t0));
  const out: number[] = [];
  const eps = 1e-12;
  for (const base of [phi - alpha, phi + alpha]) {
    for (let n = -2; n <= 2; n++) {
      const th = base + 2 * Math.PI * n;
      if (th >= ths - eps && th <= the + eps) out.push(p.t0 + th / p.w);
    }
  }
  out.sort((x, y) => x - y);
  return out;
}

/**
 * Entrée et sortie exactes d'un segment dans une zone circulaire fixe (utilitaire public et tests).
 * Renvoie les intervalles de temps [entrée, sortie] pendant lesquels le mobile est dans la zone.
 */
export function legZoneIntervals(leg: Leg, center: LngLat, radiusKm: number): [number, number][] {
  const p = legPiece(leg);
  const c = toVec(center);
  const k = Math.cos(kmToRad(radiusKm));
  const inside = (t: number): boolean => dot3(piecePos(p, t), c) >= k;
  if (p.s) return inside(leg.t0) ? [[leg.t0, leg.t1]] : [];
  const roots = arcCircleRoots(p, c, k, leg.t0, leg.t1);
  const cuts = [leg.t0, ...roots.filter((r) => r > leg.t0 && r < leg.t1), leg.t1];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (b <= a) continue;
    if (inside((a + b) / 2)) {
      const lastSeg = out[out.length - 1];
      if (lastSeg && lastSeg[1] === a) lastSeg[1] = b;
      else out.push([a, b]);
    }
  }
  return out;
}
