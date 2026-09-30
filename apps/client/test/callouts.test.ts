import { describe, expect, it } from 'vitest';
import { CANDIDATE_COUNT, candidateGeometry, placeCallouts, rectsOverlap, type CalloutInput, type Rect } from '../src/map/callouts.js';

/** PRNG déterministe pour des jeux d'essai reproductibles. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bounds: Rect = { x: 0, y: 0, w: 1440, h: 900 };

function randomItems(n: number, seed: number): CalloutInput[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    anchor: { x: 60 + r() * 1320, y: 60 + r() * 780 },
    w: 70 + r() * 90,
    h: 20 + Math.floor(r() * 4) * 15,
    priority: Math.floor(r() * 100),
  }));
}

describe('placement anti-collision des étiquettes', () => {
  it('ne produit jamais de chevauchement et reste dans les limites', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const placed = placeCallouts(randomItems(40, seed), { bounds });
      for (let i = 0; i < placed.length; i++) {
        const a = placed[i]!.rect;
        expect(a.x).toBeGreaterThanOrEqual(bounds.x);
        expect(a.y).toBeGreaterThanOrEqual(bounds.y);
        expect(a.x + a.w).toBeLessThanOrEqual(bounds.x + bounds.w);
        expect(a.y + a.h).toBeLessThanOrEqual(bounds.y + bounds.h);
        for (let j = i + 1; j < placed.length; j++) expect(rectsOverlap(a, placed[j]!.rect)).toBe(false);
      }
    }
  });

  it('ne recouvre pas les ancres (icônes) ni les obstacles', () => {
    const items = randomItems(30, 7);
    const obstacle: Rect = { x: 0, y: 700, w: 400, h: 200 };
    const placed = placeCallouts(items, { bounds, obstacles: [obstacle], anchorBox: 24 });
    for (const p of placed) {
      expect(rectsOverlap(p.rect, obstacle)).toBe(false);
      for (const c of items) {
        const box = { x: c.anchor.x - 12, y: c.anchor.y - 12, w: 24, h: 24 };
        expect(rectsOverlap(p.rect, box)).toBe(false);
      }
    }
  });

  it('place en priorité les éléments les plus importants et respecte le maximum', () => {
    const items = randomItems(60, 3);
    const placed = placeCallouts(items, { bounds, max: 10 });
    expect(placed.length).toBeLessThanOrEqual(10);
    const top = [...items].sort((a, b) => b.priority - a.priority)[0]!;
    expect(placed.some((p) => p.id === top.id)).toBe(true);
  });

  it('le filet est coudé : ancre → coude en diagonale → attache horizontale sur le bord', () => {
    const c: CalloutInput = { id: 'x', anchor: { x: 500, y: 500 }, w: 100, h: 30, priority: 1 };
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      const { rect, leader } = candidateGeometry(c, i);
      const [a, e, t] = leader;
      expect(a).toEqual(c.anchor);
      expect(e.x).not.toBe(a.x);
      expect(e.y).not.toBe(a.y);
      expect(t.y).toBe(e.y);
      expect(t.x === rect.x || t.x === rect.x + rect.w).toBe(true);
    }
  });

  it('est déterministe et garde la position précédente si elle reste valide', () => {
    const items = randomItems(20, 11);
    const a = placeCallouts(items, { bounds });
    const b = placeCallouts(items, { bounds });
    expect(b).toEqual(a);
    const previous = new Map(a.map((p) => [p.id, (p.candidate + 5) % CANDIDATE_COUNT]));
    const c = placeCallouts(items.slice(0, 1), { bounds, previous });
    const want = previous.get(items[0]!.id)!;
    const g = candidateGeometry(items[0]!, want);
    const inBounds = g.rect.x >= 0 && g.rect.y >= 0 && g.rect.x + g.rect.w <= bounds.w && g.rect.y + g.rect.h <= bounds.h;
    if (inBounds) expect(c[0]!.candidate).toBe(want);
  });

  it('évite les segments de trajectoire', () => {
    const c: CalloutInput = { id: 'x', anchor: { x: 500, y: 500 }, w: 100, h: 30, priority: 1 };
    const segment: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 420, y: 430 },
      { x: 700, y: 430 },
    ];
    const [p] = placeCallouts([c], { bounds, avoidSegments: [segment] });
    expect(p).toBeDefined();
    const r = p!.rect;
    const crosses = r.y < 430 && r.y + r.h > 430 && r.x < 700 && r.x + r.w > 420;
    expect(crosses).toBe(false);
  });

  it('omet les ancres hors écran', () => {
    const placed = placeCallouts([{ id: 'out', anchor: { x: -100, y: 50 }, w: 80, h: 20, priority: 5 }], { bounds });
    expect(placed).toHaveLength(0);
  });
});
