import { describe, expect, it } from 'vitest';
import { destination, distanceKm, HOUR, interpolate, type Leg, type LngLat } from '@redline/shared';
import { legZoneIntervals, legPiece, trajectoryPieces } from '../src/geo/sphere.js';
import { nextBandChange } from '../src/geo/crossing.js';
import { coverCap } from '../src/geo/grid.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
import { fromVec } from '@redline/shared';
import { piecePos } from '../src/geo/sphere.js';

const R = 6371.0088;

function inIntervals(iv: [number, number][], t: number): boolean {
  return iv.some(([a, b]) => t >= a && t <= b);
}

function randomLeg(rng: ReturnType<typeof seedRng>, around: LngLat, spreadKm: number): Leg {
  const from = destination(around, nextFloat(rng) * 360, nextFloat(rng) * spreadKm);
  const to = destination(from, nextFloat(rng) * 360, 200 + nextFloat(rng) * 3000);
  return { from, to, t0: 0, t1: 2 * HOUR, medium: 'air' };
}

/** Compare la solution analytique à un échantillonnage brut toutes les secondes. */
function checkAgainstSampling(leg: Leg, center: LngLat, r: number): void {
  const iv = legZoneIntervals(leg, center, r);
  const bounds = iv.flat();
  for (let t = leg.t0; t <= leg.t1; t += 1000) {
    const p = interpolate(leg.from, leg.to, (t - leg.t0) / (leg.t1 - leg.t0));
    const inside = distanceKm(p, center) <= r;
    const near = bounds.some((b) => Math.abs(b - t) <= 1000);
    if (!near) expect(inIntervals(iv, t)).toBe(inside);
  }
}

describe('entrée / sortie exacte de zone circulaire', () => {
  it('correspond à l’échantillonnage brut (latitudes moyennes)', () => {
    const rng = seedRng(7);
    for (let i = 0; i < 30; i++) {
      const leg = randomLeg(rng, [10, 45], 500);
      const mid = interpolate(leg.from, leg.to, nextFloat(rng));
      const center = destination(mid, nextFloat(rng) * 360, nextFloat(rng) * 300);
      checkAgainstSampling(leg, center, 50 + nextFloat(rng) * 400);
    }
  });

  it('près des pôles', () => {
    const rng = seedRng(11);
    for (let i = 0; i < 20; i++) {
      const leg = randomLeg(rng, [nextFloat(rng) * 360 - 180, 88], 300);
      const center: LngLat = [nextFloat(rng) * 360 - 180, 89 - nextFloat(rng) * 3];
      checkAgainstSampling(leg, center, 100 + nextFloat(rng) * 400);
    }
    // Segment passant exactement par le pôle Nord.
    const leg: Leg = { from: [0, 85], to: [180, 85], t0: 0, t1: HOUR, medium: 'air' };
    const iv = legZoneIntervals(leg, [90, 90], 200);
    expect(iv.length).toBe(1);
    checkAgainstSampling(leg, [90, 90], 200);
  });

  it('à travers l’antiméridien', () => {
    const leg: Leg = { from: [175, -10], to: [-170, -5], t0: 0, t1: HOUR, medium: 'air' };
    for (const center of [
      [179.9, -8],
      [-179.5, -7.8],
      [180, -9],
    ] as LngLat[]) {
      checkAgainstSampling(leg, center, 120);
      expect(legZoneIntervals(leg, center, 120).length).toBe(1);
    }
    const rng = seedRng(5);
    for (let i = 0; i < 20; i++) {
      const leg2 = randomLeg(rng, [180, nextFloat(rng) * 60 - 30], 200);
      const center: LngLat = [180 - nextFloat(rng) * 2, nextFloat(rng) * 60 - 30];
      checkAgainstSampling(leg2, center, 300);
    }
  });

  it('segment immobile ou tangent', () => {
    const still: Leg = { from: [2, 48], to: [2, 48], t0: 0, t1: HOUR, medium: 'land' };
    expect(legZoneIntervals(still, [2.1, 48], 20)).toEqual([[0, HOUR]]);
    expect(legZoneIntervals(still, [5, 48], 20)).toEqual([]);
  });
});

describe('croisement de deux mobiles (fenêtre commune, précision ≤ 1 s)', () => {
  function bruteFirst(a: Leg, b: Leg, r: number, from: number): number | null {
    const pa = trajectoryPieces(a.from, { legs: [a] });
    const pb = trajectoryPieces(b.from, { legs: [b] });
    const at = (ps: ReturnType<typeof trajectoryPieces>, t: number): LngLat => {
      const p = ps.find((x) => t >= x.t0 && t < x.t1) ?? ps[ps.length - 1]!;
      return fromVec(piecePos(p, t));
    };
    const inside0 = distanceKm(at(pa, from), at(pb, from)) <= r;
    for (let t = from; t <= Math.max(a.t1, b.t1) + 1000; t += 250) {
      if ((distanceKm(at(pa, t), at(pb, t)) <= r) !== inside0) return t;
    }
    return null;
  }

  it('trouve l’entrée dans la portée à 1 s près', () => {
    const rng = seedRng(99);
    let found = 0;
    for (let i = 0; i < 40; i++) {
      const meet = destination([12, 44], nextFloat(rng) * 360, nextFloat(rng) * 200);
      const tMeet = HOUR * (0.5 + nextFloat(rng));
      const sa = 300 + nextFloat(rng) * 1500;
      const sb = 300 + nextFloat(rng) * 1500;
      const ha = nextFloat(rng) * 360;
      const hb = nextFloat(rng) * 360;
      // Deux trajectoires qui passent à proximité du même point au même moment.
      const a: Leg = {
        from: destination(meet, ha + 180, (sa * tMeet) / HOUR),
        to: destination(meet, ha, sa),
        t0: 0,
        t1: tMeet + HOUR,
        medium: 'air',
      };
      const bOff = destination(meet, nextFloat(rng) * 360, nextFloat(rng) * 60);
      const b: Leg = {
        from: destination(bOff, hb + 180, (sb * tMeet) / HOUR),
        to: destination(bOff, hb, sb),
        t0: 0,
        t1: tMeet + HOUR,
        medium: 'air',
      };
      const r = 40 + nextFloat(rng) * 60;
      const A = trajectoryPieces(a.from, { legs: [a] });
      const B = trajectoryPieces(b.from, { legs: [b] });
      const t = nextBandChange(A, B, [Math.cos(r / R)], 0);
      const brute = bruteFirst(a, b, r, 0);
      if (brute === null) {
        expect(t).toBeNull();
      } else {
        found++;
        expect(t).not.toBeNull();
        expect(Math.abs(t! - brute)).toBeLessThanOrEqual(1250);
      }
    }
    expect(found).toBeGreaterThan(10);
  });

  it('pas d’événement en double : chaque changement progresse', () => {
    const a: Leg = { from: [0, 44], to: [10, 44], t0: 0, t1: 2 * HOUR, medium: 'air' };
    const b: Leg = { from: [10, 44.2], to: [0, 44.2], t0: 0, t1: 2 * HOUR, medium: 'air' };
    const A = trajectoryPieces(a.from, { legs: [a] });
    const B = trajectoryPieces(b.from, { legs: [b] });
    const thr = [50, 100, 200].map((r) => Math.cos(r / R));
    const times: number[] = [];
    let t = 0;
    for (;;) {
      const n = nextBandChange(A, B, thr, t);
      if (n === null) break;
      expect(n).toBeGreaterThan(t);
      times.push(n);
      t = n;
    }
    expect(times.length).toBe(6); // entre dans 200, 100, 50 puis ressort
    expect(Math.abs(times[2]! + times[3]! - 2 * HOUR)).toBeLessThan(2000); // symétrie autour du croisement
  });

  it('arc contre point fixe : même instant que la solution analytique de zone', () => {
    const leg: Leg = { from: [0, 44], to: [8, 45], t0: 1000, t1: 1000 + 3 * HOUR, medium: 'land' };
    const center: LngLat = [4, 44.6];
    const A = trajectoryPieces(leg.from, { legs: [leg] });
    const B = trajectoryPieces(center, null);
    const t = nextBandChange(A, B, [Math.cos(80 / R)], 0)!;
    const iv = legZoneIntervals(leg, center, 80);
    expect(Math.abs(t - iv[0]![0])).toBeLessThanOrEqual(1);
    void legPiece;
  });
});

describe('index spatial', () => {
  it('la couverture d’une calotte contient tous ses points (pôles, antiméridien)', () => {
    const rng = seedRng(3);
    const cellOf = (p: LngLat): number => {
      const s = new Set<number>();
      coverCap(p, 0, s);
      return [...s][0]!;
    };
    for (const c of [
      [10, 45],
      [179.5, 10],
      [-179.9, -60],
      [0, 88.5],
      [45, -89],
    ] as LngLat[]) {
      for (const r of [5, 80, 400]) {
        const cells = new Set<number>();
        coverCap(c, r, cells);
        for (let i = 0; i < 300; i++) {
          const p = destination(c, nextFloat(rng) * 360, nextFloat(rng) * r);
          expect(cells.has(cellOf(p))).toBe(true);
        }
      }
    }
  });
});
