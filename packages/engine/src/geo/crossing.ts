import type { Vec3 } from '@redline/shared';
import {
  arcCircleRoots,
  dot3,
  pieceIndexAt,
  piecePos,
  type ArcPiece,
  type Piece,
} from './sphere.js';

/**
 * Recherche du prochain instant où la distance entre deux trajectoires franchit un des seuils.
 *
 * Les seuils sont donnés par leur cosinus (cos(r/R)), rangés par rayon croissant. La « bande » à
 * l'instant t est le nombre de seuils tels que p_A(t)·p_B(t) ≥ cos(r/R), c'est-à-dire d ≤ r.
 *
 * - Une trajectoire immobile et un arc : racines exactes de A cos θ + B sin θ = k.
 * - Deux arcs : découpage en fenêtres courtes, recherche du rapprochement maximal par section dorée,
 *   puis dichotomie de part et d'autre (précision 1 ms de jeu).
 *
 * Le résultat t vérifie bande(t) ≠ bande(tStart) et t ≥ tStart + 1 ms (progression garantie).
 */

/** Précision des dichotomies, en ms de jeu. */
const EPS_MS = 1;
/** Déplacement angulaire cumulé maximal par fenêtre pour deux arcs (≈ 190 km). */
const CHUNK_RAD = 0.03;

function bandOf(dot: number, cosThr: readonly number[]): number {
  let n = 0;
  for (const c of cosThr) if (dot >= c) n++;
  return n;
}

function dotGlobal(A: Piece[], B: Piece[], t: number): number {
  return dot3(piecePos(A[pieceIndexAt(A, t)]!, t), piecePos(B[pieceIndexAt(B, t)]!, t));
}

export function bandAt(A: Piece[], B: Piece[], cosThr: readonly number[], t: number): number {
  return bandOf(dotGlobal(A, B, t), cosThr);
}

export function dotAt(A: Piece[], B: Piece[], t: number): number {
  return dotGlobal(A, B, t);
}

/** Dichotomie : side(lo) ≠ side(hi), renvoie le plus petit hi (à EPS près) du côté de side(hi). */
function bisect(f: (t: number) => boolean, lo: number, hi: number): number {
  const sLo = f(lo);
  while (hi - lo > EPS_MS) {
    const mid = (lo + hi) / 2;
    if (f(mid) === sLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function nextBandChange(
  A: Piece[],
  B: Piece[],
  cosThr: readonly number[],
  tStart: number,
): number | null {
  if (cosThr.length === 0) return null;
  const b0 = bandAt(A, B, cosThr, tStart);
  const minT = tStart + EPS_MS;
  let ia = pieceIndexAt(A, tStart);
  let ib = pieceIndexAt(B, tStart);
  let s = tStart;
  const angles = cosThr.map((c) => Math.acos(Math.max(-1, Math.min(1, c))));

  for (;;) {
    const pa = A[ia]!;
    const pb = B[ib]!;
    const e = Math.min(pa.t1, pb.t1);
    if (e > s) {
      const found = scanInterval(A, B, pa, pb, s, e, cosThr, angles, b0, minT);
      if (found !== null) return found;
    }
    if (e === Infinity) return null;
    s = Math.max(s, e);
    if (pa.t1 <= e && ia + 1 < A.length) ia++;
    if (pb.t1 <= e && ib + 1 < B.length) ib++;
    if (A[ia]!.t1 <= s && B[ib]!.t1 <= s) return null; // garde-fou
  }
}

function scanInterval(
  A: Piece[],
  B: Piece[],
  pa: Piece,
  pb: Piece,
  s: number,
  e: number,
  cosThr: readonly number[],
  angles: readonly number[],
  b0: number,
  minT: number,
): number | null {
  if (pa.s && pb.s) return null; // distance constante
  const local = (t: number): number => dot3(piecePos(pa, t), piecePos(pb, t));
  const cands: number[] = [];

  const refine = (k: number, lo: number, hi: number): void => {
    lo = Math.max(lo, s);
    hi = Math.min(hi, e);
    if (!(hi > lo)) return;
    const side = (t: number): boolean => local(t) >= k;
    if (side(lo) === side(hi)) return;
    cands.push(bisect(side, lo, hi));
  };

  if (pa.s || pb.s) {
    // Arc contre point fixe : solution analytique.
    const arc = (pa.s ? pb : pa) as ArcPiece;
    const c: Vec3 = pa.s ? pa.v : (pb as { v: Vec3 }).v;
    for (const k of cosThr) {
      for (const r of arcCircleRoots(arc, c, k, s, e)) refine(k, r - 2, r + 2);
    }
    const found = pickFirst(A, B, cands, cosThr, b0, minT);
    if (found !== null) return found;
  } else {
    // Deux arcs : fenêtres courtes, rapprochement maximal (section dorée) puis dichotomies.
    const wSum = pa.w + pb.w;
    const chunk = wSum > 0 ? CHUNK_RAD / wSum : e - s;
    for (let c0 = s; c0 < e;) {
      const c1 = Math.min(e, c0 + chunk);
      const d0 = local(c0);
      const a0 = Math.acos(Math.max(-1, Math.min(1, d0)));
      const reach = wSum * (c1 - c0);
      let relevant = false;
      for (const th of angles) {
        if (th >= a0 - reach - 1e-12 && th <= a0 + reach + 1e-12) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        const tm = goldenMax(local, c0, c1);
        const dm = local(tm);
        const d1 = local(c1);
        for (const k of cosThr) {
          if (d0 >= k !== dm >= k) refine(k, c0, tm);
          if (dm >= k !== d1 >= k) refine(k, tm, c1);
        }
        const found = pickFirst(A, B, cands, cosThr, b0, minT);
        if (found !== null) return found;
        cands.length = 0;
      }
      c0 = c1;
    }
  }

  // Filet de sécurité : si la bande a changé sans racine détectée (tangence numérique).
  if (e !== Infinity && e >= minT) {
    const be = bandOf(local(e), cosThr);
    if (be !== b0) {
      const t = bisect((x) => bandOf(local(x), cosThr) !== b0, Math.max(s, minT - EPS_MS), e);
      const tt = Math.max(t, minT);
      if (bandAt(A, B, cosThr, tt) !== b0) return tt;
    }
  }
  return null;
}

function pickFirst(
  A: Piece[],
  B: Piece[],
  cands: number[],
  cosThr: readonly number[],
  b0: number,
  minT: number,
): number | null {
  if (cands.length === 0) return null;
  cands.sort((x, y) => x - y);
  for (const c of cands) {
    const t = Math.max(c, minT);
    if (bandAt(A, B, cosThr, t) !== b0) return t;
  }
  return null;
}

const GR = (Math.sqrt(5) - 1) / 2;

/** Maximum d'une fonction supposée unimodale sur [a, b] (section dorée, précision 1 ms). */
function goldenMax(f: (t: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  let x1 = b - GR * (b - a);
  let x2 = a + GR * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  while (b - a > EPS_MS) {
    if (f1 >= f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - GR * (b - a);
      f1 = f(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + GR * (b - a);
      f2 = f(x2);
    }
  }
  const m = (a + b) / 2;
  const fm = f(m);
  const flo = f(lo);
  const fhi = f(hi);
  if (flo > fm && flo >= fhi) return lo;
  if (fhi > fm) return hi;
  return m;
}
