/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadNet, RoutesFileSchema, distanceKm, type RoutesFile } from '@redline/shared';
import {
  kmPerPx,
  magnetKm,
  roadPath,
  roadPathMs,
  roadsGeoJSON,
  snapToRoads,
} from '../src/map/routes.js';

/**
 * Petit réseau : deux villes reliées par une route passant par un point de passage, un centre ; une
 * île séparée avec un port, reliée par la mer au port de la ville B.
 *
 *   A (0,0) ── pass (0.5,0) ── B (1,0, port) ── centre (1,0.6)        île : P (3,0, port) ── C (3.5,0)
 */
const FILE: RoutesFile = {
  version: 1,
  nodes: [
    { id: 'c:aaa-1', kind: 'city', pos: [0, 0], province: 'aaa-1' },
    { id: 'b:aaa-1|bbb-1', kind: 'pass', pos: [0.5, 0], province: 'aaa-1' },
    { id: 'c:bbb-1', kind: 'city', pos: [1, 0], province: 'bbb-1', port: true },
    { id: 'k:bbb-1', kind: 'center', pos: [1, 0.6], province: 'bbb-1' },
    { id: 'p:ccc-1', kind: 'port', pos: [3, 0], province: 'ccc-1', port: true },
    { id: 'c:ccc-1', kind: 'city', pos: [3.5, 0], province: 'ccc-1' },
  ],
  edges: [
    { a: 0, b: 1, pts: [[0.25, 0.02]] },
    { a: 1, b: 2, pts: [] },
    { a: 2, b: 3, pts: [[1.1, 0.3]] },
    { a: 4, b: 5, pts: [] },
  ],
};
const net = new RoadNet(RoutesFileSchema.parse(FILE));

describe('accrochage aux routes', () => {
  it('ville dans l’aimant des villes, même si une route est plus proche', () => {
    const s = snapToRoads(net, [0.05, 0.03], { cityKm: 10, nodeKm: 2 })!;
    expect(s.kind).toBe('city');
    expect(s.pos).toEqual([0, 0]);
  });

  it('nœud dans l’aimant des nœuds, sinon point de la route le plus proche', () => {
    const n = snapToRoads(net, [0.5, 0.01], { cityKm: 1, nodeKm: 3 })!;
    expect(n.kind).toBe('pass');
    const r = snapToRoads(net, [0.75, 0.1], { cityKm: 1, nodeKm: 1 })!;
    expect(r.kind).toBe('road');
    expect(r.pos[1]).toBeCloseTo(0, 6);
    expect(r.pos[0]).toBeCloseTo(0.75, 3);
  });

  it('point trop loin du réseau : refusé', () => {
    expect(snapToRoads(net, [0.5, 2], { cityKm: 1, nodeKm: 1, maxKm: 60 })).toBeNull();
    expect(snapToRoads(net, [0.5, 0.4], { cityKm: 1, nodeKm: 1, maxKm: 60 })).not.toBeNull();
  });

  it('aimant en pixels : plus large au zoom monde qu’au zoom ville', () => {
    expect(kmPerPx(0, 0)).toBeCloseTo(78.27, 1);
    const far = magnetKm(45, 3, 'mouse');
    const near = magnetKm(45, 9, 'mouse');
    expect(far.cityKm).toBeGreaterThan(near.cityKm * 60);
    expect(magnetKm(45, 9, 'touch').cityKm).toBeGreaterThan(near.cityKm);
  });
});

describe('aperçu du trajet', () => {
  it('le long des routes, depuis la position de l’unité', () => {
    const p = roadPath(net, [0, 0], [1, 0.6])!;
    expect(p.pts[0]).toEqual([0, 0]);
    expect(p.pts[p.pts.length - 1]).toEqual([1, 0.6]);
    expect(p.pts).toContainEqual([0.25, 0.02]);
    expect(p.pts).toContainEqual([1.1, 0.3]);
    expect(p.seaKm).toBe(0);
    expect(p.km).toBeGreaterThan(distanceKm([0, 0], [1, 0.6]));
    expect(roadPathMs(p, 100)).toBeCloseTo((p.km / 100) * 3_600_000, 0);
  });

  it('autre masse continentale : route, traversée de port à port, route', () => {
    const p = roadPath(net, [0, 0], [3.5, 0])!;
    expect(p.seaKm).toBeCloseTo(distanceKm([1, 0], [3, 0]), 6);
    expect(p.pts).toContainEqual([1, 0]);
    expect(p.pts).toContainEqual([3, 0]);
    expect(p.pts[p.pts.length - 1]).toEqual([3.5, 0]);
    // Traversée plus lente, embarquement et débarquement.
    expect(roadPathMs(p, 100, 0.5, 60)).toBeGreaterThan(roadPathMs({ ...p, seaKm: 0 }, 100));
  });

  it('GeoJSON : un tracé par arête, nœuds hors villes', () => {
    const g = roadsGeoJSON(net);
    expect(g.lines.features).toHaveLength(4);
    expect(g.lines.features[0]!.geometry.coordinates).toEqual([
      [0, 0],
      [0.25, 0.02],
      [0.5, 0],
    ]);
    expect(g.nodes.features.map((f) => f.properties!.kind).sort()).toEqual([
      'center',
      'pass',
      'port',
    ]);
  });
});

describe('vraies données', () => {
  const file = join(import.meta.dirname, '../../../data/map/routes.json');
  const real = new RoadNet(RoutesFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
  const provinces = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../data/map/provinces.json'), 'utf8'),
  ) as {
    id: string;
    cityName?: string;
    cityPoint: [number, number];
    isCapital: boolean;
    nationId: string;
  }[];
  const brussels = provinces.find((p) => p.nationId === 'bel' && p.isCapital)!;

  it('clic à 3 km de Bruxelles (zoom 12) : accroché à la ville (capture)', () => {
    const at: [number, number] = [brussels.cityPoint[0] + 0.03, brussels.cityPoint[1] + 0.015];
    const s = snapToRoads(real, at, magnetKm(at[1], 12, 'mouse'))!;
    expect(s.kind).toBe('city');
    expect(s.pos).toEqual(brussels.cityPoint);
  });

  it('Paris → Bruxelles : trajet routier plausible', () => {
    const paris = provinces.find((p) => p.cityName === 'Paris')!.cityPoint;
    const p = roadPath(real, paris, brussels.cityPoint)!;
    const gc = distanceKm(paris, brussels.cityPoint);
    expect(p.seaKm).toBe(0);
    expect(p.km).toBeGreaterThan(gc);
    expect(p.km).toBeLessThan(gc * 1.6);
  });
});
