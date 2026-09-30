import { describe, expect, it } from 'vitest';
import { heapPop, heapPush } from '../src/queue/heap.js';
import type { GameEvent } from '../src/queue/events.js';
import { nextFloat, nextInt, nextU32, seedRng } from '../src/rng/rng.js';
import { fnv1a64 } from '../src/state/serialize.js';

describe('file d’événements', () => {
  it('ordre total (temps, priorité, séquence)', () => {
    const rng = seedRng(1);
    const heap: GameEvent[] = [];
    for (let s = 1; s <= 2000; s++) {
      heapPush(heap, { k: 'day', t: nextInt(rng, 50), p: nextInt(rng, 4), s });
    }
    const out: GameEvent[] = [];
    for (let e = heapPop(heap); e; e = heapPop(heap)) out.push(e);
    expect(out.length).toBe(2000);
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const ok = a.t < b.t || (a.t === b.t && (a.p < b.p || (a.p === b.p && a.s < b.s)));
      expect(ok).toBe(true);
    }
  });

  it('même contenu inséré dans un ordre différent ⇒ même ordre de sortie', () => {
    const evs: GameEvent[] = [];
    for (let s = 1; s <= 300; s++) evs.push({ k: 'ai', t: (s * 7919) % 50, p: s % 3, s });
    const h1: GameEvent[] = [];
    const h2: GameEvent[] = [];
    evs.forEach((e) => heapPush(h1, e));
    [...evs].reverse().forEach((e) => heapPush(h2, e));
    const drain = (h: GameEvent[]) => {
      const o: number[] = [];
      for (let e = heapPop(h); e; e = heapPop(h)) o.push(e.s);
      return o;
    };
    expect(drain(h1)).toEqual(drain(h2));
  });
});

describe('PRNG', () => {
  it('déterministe et bien réparti', () => {
    const a = seedRng(123);
    const b = seedRng(123);
    const c = seedRng(124);
    const xa = Array.from({ length: 10 }, () => nextU32(a));
    const xb = Array.from({ length: 10 }, () => nextU32(b));
    const xc = Array.from({ length: 10 }, () => nextU32(c));
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
    const r = seedRng(5);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const f = nextFloat(r);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      sum += f;
    }
    expect(Math.abs(sum / 10000 - 0.5)).toBeLessThan(0.02);
  });
});

describe('FNV-1a 64', () => {
  it('égal à la référence BigInt', () => {
    const ref = (bytes: Uint8Array): string => {
      let h = 0xcbf29ce484222325n;
      for (const b of bytes) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return h.toString(16).padStart(16, '0');
    };
    const rng = seedRng(9);
    for (const n of [0, 1, 7, 100, 4096]) {
      const bytes = new Uint8Array(n).map(() => nextInt(rng, 256));
      expect(fnv1a64(bytes)).toBe(ref(bytes));
    }
    expect(fnv1a64(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
  });
});
