import { EARTH_RADIUS_KM, type LngLat } from '@redline/shared';
import { piecePos, type Piece } from './sphere.js';
import { fromVec } from '@redline/shared';

/**
 * Index spatial grossier : bandes de latitude de 2°, découpées en cases d'environ 2° × cos(lat)
 * de longitude (≈ 220 km de côté partout, antiméridien et pôles gérés). Les zones et les trajets
 * s'enregistrent dans les cases qu'ils touchent ; seules les paires qui partagent une case sont testées.
 */
const BAND_DEG = 2;
const BANDS = 180 / BAND_DEG;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const lngCounts: number[] = [];
for (let b = 0; b < BANDS; b++) {
  const lat0 = -90 + b * BAND_DEG;
  const lat1 = lat0 + BAND_DEG;
  const eq = lat0 <= 0 && lat1 >= 0 ? 0 : Math.min(Math.abs(lat0), Math.abs(lat1));
  lngCounts.push(Math.max(1, Math.floor((360 / BAND_DEG) * Math.cos(eq * RAD))));
}

function bandOf(lat: number): number {
  return Math.max(0, Math.min(BANDS - 1, Math.floor((lat + 90) / BAND_DEG)));
}

function lngIndex(band: number, lng: number): number {
  const n = lngCounts[band]!;
  const x = (((lng + 180) % 360) + 360) % 360;
  return Math.min(n - 1, Math.floor((x / 360) * n));
}

/** Case contenant un point. */
export function pointCell(p: LngLat): number {
  const b = bandOf(p[1]);
  return b * 1000 + lngIndex(b, p[0]);
}

/** Cases couvrant entièrement la calotte de centre `c` et de rayon `rKm` (boîte englobante exacte). */
export function coverCap(c: LngLat, rKm: number, out: Set<number>): void {
  const r = rKm / EARTH_RADIUS_KM;
  const lat = c[1];
  const rDeg = r * DEG;
  const latMin = lat - rDeg;
  const latMax = lat + rDeg;
  const b0 = bandOf(latMin);
  const b1 = bandOf(latMax);
  const polar = latMax >= 90 || latMin <= -90 || r >= Math.PI / 2;
  let dLng = 180;
  if (!polar) {
    const s = Math.sin(r) / Math.cos(lat * RAD);
    dLng = s >= 1 ? 180 : Math.asin(s) * DEG;
  }
  for (let b = b0; b <= b1; b++) {
    const n = lngCounts[b]!;
    if (dLng >= 180 || n === 1 || 2 * dLng >= 360 - 720 / n) {
      for (let j = 0; j < n; j++) out.add(b * 1000 + j);
      continue;
    }
    const j0 = lngIndex(b, c[0] - dLng);
    const j1 = lngIndex(b, c[0] + dLng);
    let j = j0;
    for (let guard = 0; guard <= n; guard++) {
      out.add(b * 1000 + j);
      if (j === j1) break;
      j = (j + 1) % n;
    }
  }
}

/** Pas d'échantillonnage le long d'un trajet pour l'index (km). */
const SWEEP_STEP_KM = 60;

/**
 * Cases balayées par une trajectoire à partir de `from`, élargie d'un rayon `rKm`.
 * Le morceau final (immobile) est inclus : la couverture vaut pour tout le futur.
 */
export function sweepCells(pieces: Piece[], from: number, rKm: number): number[] {
  const out = new Set<number>();
  for (const p of pieces) {
    if (p.t1 < from) continue;
    if (p.s) {
      coverCap(fromVec(p.v), rKm + 0.5, out);
      continue;
    }
    const tStart = Math.max(p.t0, from);
    const th0 = p.w * (tStart - p.t0);
    const lenRad = p.len - th0;
    const lenKm = lenRad * EARTH_RADIUS_KM;
    const n = Math.max(1, Math.ceil(lenKm / SWEEP_STEP_KM));
    const stepT = (p.t1 - tStart) / n;
    const pad = rKm + SWEEP_STEP_KM / 2 + 1;
    for (let i = 0; i <= n; i++) coverCap(fromVec(piecePos(p, tStart + i * stepT)), pad, out);
  }
  return [...out].sort((a, b) => a - b);
}

/** Grille : case → ensemble d'entités (identifiants d'unités ou « p:<province> »). */
export class SpatialGrid {
  private readonly cells = new Map<number, Set<string>>();

  add(id: string, cells: readonly number[]): void {
    for (const c of cells) {
      let set = this.cells.get(c);
      if (!set) {
        set = new Set();
        this.cells.set(c, set);
      }
      set.add(id);
    }
  }

  remove(id: string, cells: readonly number[]): void {
    for (const c of cells) {
      const set = this.cells.get(c);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.cells.delete(c);
    }
  }

  collect(cells: readonly number[], out: Set<string>): void {
    for (const c of cells) {
      const set = this.cells.get(c);
      if (set) for (const id of set) out.add(id);
    }
  }
}
