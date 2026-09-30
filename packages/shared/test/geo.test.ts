import { describe, expect, it } from 'vitest';
import { destination, distanceKm, geodesicCircle, interpolate, positionAt } from '../src/geo.js';
import type { LngLat, Movement } from '../src/index.js';

const paris: LngLat = [2.3522, 48.8566];
const algiers: LngLat = [3.0588, 36.7538];

describe('geo', () => {
  it('distance Paris–Alger ≈ 1 350 km', () => {
    expect(distanceKm(paris, algiers)).toBeGreaterThan(1330);
    expect(distanceKm(paris, algiers)).toBeLessThan(1370);
  });

  it('interpolation : extrémités et milieu équidistant', () => {
    expect(distanceKm(interpolate(paris, algiers, 0), paris)).toBeLessThan(1e-6);
    expect(distanceKm(interpolate(paris, algiers, 1), algiers)).toBeLessThan(1e-6);
    const mid = interpolate(paris, algiers, 0.5);
    expect(Math.abs(distanceKm(mid, paris) - distanceKm(mid, algiers))).toBeLessThan(1e-6);
  });

  it('destination inverse de distance', () => {
    const p = destination(paris, 137, 800);
    expect(distanceKm(paris, p)).toBeCloseTo(800, 6);
  });

  it('positionAt interpole dans le temps', () => {
    const move: Movement = {
      legs: [{ from: paris, to: algiers, t0: 1000, t1: 3000, medium: 'air' }],
    };
    expect(positionAt(move, 0)).toEqual(paris);
    expect(positionAt(move, 5000)).toEqual(algiers);
    const half = positionAt(move, 2000);
    expect(distanceKm(half, paris)).toBeCloseTo(distanceKm(paris, algiers) / 2, 6);
  });

  it('cercle géodésique fermé à rayon constant', () => {
    const ring = geodesicCircle(algiers, 1000, 32);
    expect(ring.length).toBe(33);
    for (const p of ring)
      expect(distanceKm(algiers, [((p[0] + 540) % 360) - 180, p[1]])).toBeCloseTo(1000, 3);
  });
});
