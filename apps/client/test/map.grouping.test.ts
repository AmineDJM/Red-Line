import { describe, expect, it } from 'vitest';
import type { LngLat } from '@redline/shared';
import { groupItems, lodFactor, pionScale, worldPx, type GroupItem } from '../src/map/grouping.js';
import { PION_H, PION_W } from '../src/map/pions.js';

const item = (id: string, pos: LngLat, key = 'fra', priority = 1): GroupItem => ({
  id,
  pos,
  key,
  priority,
});

const opts = (zoom: number) => ({ zoom, w: PION_W, h: PION_H });

describe('regroupement des pions', () => {
  it('projette en pixels monde Mercator', () => {
    expect(worldPx([0, 0], 0)).toEqual([256, 256]);
    const [x] = worldPx([180, 0], 1);
    expect(x).toBeCloseTo(1024);
  });

  it("l'échelle du pion croît avec le zoom et le seuil se resserre (monde → ville)", () => {
    expect(pionScale(1)).toBeLessThan(pionScale(5));
    expect(pionScale(5)).toBeLessThan(pionScale(10));
    expect(lodFactor(2)).toBeGreaterThan(lodFactor(4.5));
    expect(lodFactor(4.5)).toBeGreaterThanOrEqual(lodFactor(8));
  });

  it("empile les unités superposées d'une même nation, pas celles qui sont éloignées", () => {
    const g = groupItems(
      [item('a', [2, 48]), item('b', [2.001, 48.001]), item('c', [10, 40])],
      opts(8),
    );
    expect(g).toHaveLength(2);
    const stack = g.find((x) => x.members.length === 2)!;
    expect(stack.members.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it("regroupe davantage à l'échelle du monde qu'à l'échelle de la ville", () => {
    const pts = Array.from({ length: 20 }, (_, i) => item(`u${i}`, [2 + i * 0.4, 48]));
    const world = groupItems(pts, opts(2));
    const city = groupItems(pts, opts(8));
    expect(world.length).toBeLessThan(city.length);
    expect(city).toHaveLength(20);
  });

  it('ne fusionne jamais deux nations : les piles superposées sont écartées côte à côte', () => {
    const g = groupItems([item('a', [2, 48], 'fra', 10), item('b', [2, 48], 'deu', 1)], opts(7));
    expect(g).toHaveLength(2);
    const [fa, fb] = [g.find((x) => x.id === 'a')!, g.find((x) => x.id === 'b')!];
    // Les forces prioritaires à gauche, écart d'au moins une largeur de pion.
    expect(fa.off[0]).toBeLessThan(fb.off[0]);
    expect(fb.off[0] - fa.off[0]).toBeGreaterThanOrEqual(PION_W);
  });

  it('le chef de pile est le plus prioritaire (position et pictogramme stables)', () => {
    const g = groupItems([item('a', [2, 48], 'fra', 1), item('b', [2, 48], 'fra', 5)], opts(8));
    expect(g).toHaveLength(1);
    expect(g[0]!.leader.id).toBe('b');
  });

  it('reste rapide : 2 000 unités en quelques millisecondes', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pts = Array.from({ length: 2000 }, (_, i) =>
      item(`u${i}`, [-10 + rnd() * 40, 30 + rnd() * 25], `n${i % 12}`, rnd()),
    );
    groupItems(pts, opts(4));
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) groupItems(pts, opts(4 + k * 0.5));
    // Budget large : la machine d'intégration est partagée (≈ 10 ms mesurés à vide).
    expect((performance.now() - t0) / 5).toBeLessThan(120);
  });
});
