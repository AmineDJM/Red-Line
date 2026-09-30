import { describe, expect, it } from 'vitest';
import { distanceKm, HOUR, type Movement, type UnitView } from '@redline/shared';
import { isMoving, remainingPath, unitHeading, unitPosition } from '../src/map/interpolation.js';

const move: Movement = {
  legs: [
    { from: [0, 0], to: [10, 0], t0: 0, t1: 10 * HOUR, medium: 'land' },
    { from: [10, 0], to: [10, 10], t0: 10 * HOUR, t1: 20 * HOUR, medium: 'land' },
  ],
};
const u = (m?: Movement): UnitView => ({
  id: 'u',
  owner: 'fra',
  level: 'own',
  pos: [5, 5],
  lastSeen: 0,
  uncertaintyKm: 0,
  ...(m ? { move: m } : {}),
});

describe('interpolation des positions', () => {
  it("renvoie la position fixe d'une unité sans trajet", () => {
    expect(unitPosition(u(), 123)).toEqual([5, 5]);
    expect(isMoving(u(), 123)).toBe(false);
  });

  it('interpole au milieu du premier segment (grand cercle sur l’équateur)', () => {
    const p = unitPosition(u(move), 5 * HOUR);
    expect(p[0]).toBeCloseTo(5, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(isMoving(u(move), 5 * HOUR)).toBe(true);
  });

  it('passe au segment suivant et s’arrête à destination', () => {
    const p = unitPosition(u(move), 15 * HOUR);
    expect(p[0]).toBeCloseTo(10, 6);
    expect(p[1]).toBeGreaterThan(4.9);
    expect(p[1]).toBeLessThan(5.1);
    expect(unitPosition(u(move), 30 * HOUR)).toEqual([10, 10]);
    expect(isMoving(u(move), 30 * HOUR)).toBe(false);
  });

  it('avance à vitesse constante (distance proportionnelle au temps)', () => {
    const d1 = distanceKm([0, 0], unitPosition(u(move), 2 * HOUR));
    const d2 = distanceKm([0, 0], unitPosition(u(move), 4 * HOUR));
    expect(d2 / d1).toBeCloseTo(2, 3);
  });

  it('donne le cap courant', () => {
    expect(unitHeading(u(move), 5 * HOUR)).toBeCloseTo(90, 0);
    expect(unitHeading(u(move), 15 * HOUR)).toBeCloseTo(0, 0);
    expect(unitHeading(u(move), 25 * HOUR)).toBeNull();
  });

  it('le trajet restant part de la position courante et finit à destination', () => {
    const path = remainingPath(move, 5 * HOUR);
    expect(path[0]![0]).toBeCloseTo(5, 4);
    const last = path[path.length - 1]!;
    expect(last[0]).toBeCloseTo(10, 6);
    expect(last[1]).toBeCloseTo(10, 6);
  });

  it('déplie les longitudes à travers l’antiméridien', () => {
    const m: Movement = {
      legs: [{ from: [170, 0], to: [-170, 0], t0: 0, t1: HOUR, medium: 'air' }],
    };
    const path = remainingPath(m, 0);
    for (let i = 1; i < path.length; i++)
      expect(Math.abs(path[i]![0] - path[i - 1]![0])).toBeLessThan(10);
  });
});
