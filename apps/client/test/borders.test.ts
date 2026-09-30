import { describe, expect, it } from 'vitest';
import type { FeatureCollection, Position } from 'geojson';
import { computeBorders } from '../src/map/borders.js';

const square = (
  id: string,
  x: number,
  y: number,
  extra: Position[] = [],
): FeatureCollection['features'][number] => ({
  type: 'Feature',
  properties: { id },
  geometry: {
    type: 'Polygon',
    coordinates: [[[x, y], [x + 1, y], ...extra, [x + 1, y + 1], [x, y + 1], [x, y]]],
  },
});

const totalLength = (fc: ReturnType<typeof computeBorders>['nations']) =>
  fc.features.reduce(
    (s, f) =>
      s +
      f.geometry.coordinates.reduce((t, line) => {
        let l = 0;
        for (let i = 1; i < line.length; i++)
          l += Math.hypot(line[i]![0]! - line[i - 1]![0]!, line[i]![1]! - line[i - 1]![1]!);
        return t + l;
      }, 0),
    0,
  );

describe('frontières calculées depuis la topologie des provinces', () => {
  const geo: FeatureCollection = {
    type: 'FeatureCollection',
    features: [square('a-1', 0, 0), square('a-2', 1, 0), square('b-1', 2, 0)],
  };

  it("n'affiche pas l'arête entre deux provinces du même propriétaire", () => {
    const owners: Record<string, string> = { 'a-1': 'a', 'a-2': 'a', 'b-1': 'b' };
    const r = computeBorders(geo, (id) => owners[id], 'a');
    // Contour total : 3 carrés (périmètre extérieur 8) + arête a|b (1) ; l'arête a-1|a-2 est interne.
    expect(totalLength(r.nations)).toBeCloseTo(9, 6);
    // Contour extérieur du joueur : rectangle 2×1.
    expect(totalLength(r.mine)).toBeCloseTo(6, 6);
  });

  it('suit les changements de propriétaire', () => {
    const owners: Record<string, string> = { 'a-1': 'a', 'a-2': 'b', 'b-1': 'b' };
    const r = computeBorders(geo, (id) => owners[id], 'a');
    expect(totalLength(r.mine)).toBeCloseTo(4, 6);
    expect(totalLength(r.nations)).toBeCloseTo(9, 6);
  });

  it('gère les jonctions en T (sommet présent d’un seul côté)', () => {
    // La province de droite a un sommet supplémentaire au milieu de l'arête commune.
    const left = square('a-1', 0, 0);
    const right: FeatureCollection['features'][number] = {
      type: 'Feature',
      properties: { id: 'a-2' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [1, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 0.5],
            [1, 0],
          ],
        ],
      },
    };
    const r = computeBorders(
      { type: 'FeatureCollection', features: [left, right] },
      () => 'a',
      'a',
    );
    expect(totalLength(r.mine)).toBeCloseTo(6, 6);
  });
});
