import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DAY, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  createGame,
  deserializeState,
  nextEventTime,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { isValid } from '../src/sim/settle.js';
import { sightLevel } from '../src/state/access.js';
import { CATALOG, PROVINCES, testWorld } from './fixtures.js';

const NATIONS = ['aaa', 'bbb', 'ccc', 'ddd'];

const orderArb = fc.record({
  kind: fc.constantFrom('move', 'move', 'move', 'attack', 'attack', 'stop', 'stance', 'produce'),
  nation: fc.nat(3),
  picks: fc.array(fc.nat(50), { minLength: 1, maxLength: 3 }),
  lng: fc.double({ min: -3, max: 29, noNaN: true }),
  lat: fc.double({ min: 35, max: 53, noNaN: true }),
  target: fc.nat(200),
  stance: fc.constantFrom('hold', 'defend', 'aggressive'),
  sys: fc.nat(CATALOG.length - 1),
  prov: fc.nat(PROVINCES.length - 1),
});
type OrderSpec = typeof orderArb extends fc.Arbitrary<infer T> ? T : never;

function toOrder(s: EngineState, spec: OrderSpec): { nation: string; order: Order } | null {
  const nation = NATIONS[spec.nation]!;
  const mine = Object.keys(s.units)
    .filter((id) => s.units[id]!.owner === nation)
    .sort();
  const unitIds = [...new Set(spec.picks.map((p) => mine[p % Math.max(1, mine.length)]!))].filter(Boolean);
  switch (spec.kind) {
    case 'move':
      return unitIds.length ? { nation, order: { kind: 'move', unitIds, to: [spec.lng, spec.lat] } } : null;
    case 'attack': {
      const known = Object.keys(s.know[nation] ?? {}).sort();
      const targetId = known[spec.target % Math.max(1, known.length)] ?? 'u1';
      return unitIds.length ? { nation, order: { kind: 'attack', unitIds, targetId } } : null;
    }
    case 'stop':
      return unitIds.length ? { nation, order: { kind: 'stop', unitIds } } : null;
    case 'stance':
      return unitIds.length
        ? { nation, order: { kind: 'stance', unitIds, stance: spec.stance as 'hold' } }
        : null;
    case 'produce':
      return {
        nation,
        order: { kind: 'produce', provinceId: PROVINCES[spec.prov]!.id, systemId: CATALOG[spec.sys]!.id },
      };
  }
  return null;
}

function checkNumbers(v: unknown, path: string): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`nombre invalide en ${path}: ${v}`);
  } else if (Array.isArray(v)) v.forEach((x, i) => checkNumbers(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) checkNumbers(x, `${path}.${k}`);
}

function checkInvariants(s: EngineState): void {
  checkNumbers(
    { u: s.units, n: s.nations, p: s.pairs, k: s.know, q: s.queue, sight: s.sight, t: s.time },
    'state',
  );
  let total = 0;
  for (const n of s.nationIds) total += s.nations[n]!.provinceCount;
  expect(total).toBe(s.totalProvinces);
  for (const u of Object.values(s.units)) {
    expect(u.hp).toBeGreaterThan(0);
    expect(u.count).toBeGreaterThanOrEqual(1);
  }
  for (const key of Object.keys(s.pairs)) {
    const h = key.indexOf('#');
    if (h >= 0) {
      expect(s.provinces[key.slice(0, h)]).toBeDefined();
      expect(s.units[key.slice(h + 1)]).toBeDefined();
    } else {
      const [a, b] = key.split('|');
      expect(s.units[a!]).toBeDefined();
      expect(s.units[b!]).toBeDefined();
    }
  }
  for (const byN of Object.values(s.sight)) {
    for (const c of Object.values(byN)) for (const x of c) expect(x).toBeGreaterThanOrEqual(0);
  }
  const next = nextEventTime(s);
  expect(next).not.toBeNull();
  expect(next!).toBeGreaterThanOrEqual(s.time);
  expect(isValid(s, s.queue[0]!)).toBe(true);
  // Aucune fuite : toute unité étrangère visible correspond à un contact, observée à l'instant
  // seulement si un capteur la voit, avec au plus les champs de son niveau.
  const rank = { detected: 1, identified: 2, precise: 3 } as const;
  for (const n of NATIONS) {
    const v = viewFor(s, n);
    for (const u of Object.values(v.units)) {
      if (u.owner === n) {
        expect(u.level).toBe('own');
        continue;
      }
      expect(u.level).not.toBe('own');
      const c = s.know[n]?.[u.id];
      expect(c).toBeDefined();
      const lvl = rank[u.level as keyof typeof rank];
      if (u.uncertaintyKm === 0 && u.lastSeen === s.time) {
        expect(sightLevel(s, n, u.id)).toBe(lvl);
        expect(u.move?.legs.length ?? 0).toBeLessThanOrEqual(1);
      }
      if (lvl < 2) expect(u.systemId).toBeUndefined();
      if (lvl < 3) expect(u.count ?? u.hpRatio ?? u.status).toBeUndefined();
      expect(u.stance ?? u.xp ?? u.targetId).toBeUndefined();
    }
    for (const id of Object.keys(s.units)) {
      if (s.units[id]!.owner !== n && !s.know[n]?.[id]) expect(v.units[id]).toBeUndefined();
    }
  }
}

describe('fuzz', () => {
  it('30 jours d’ordres aléatoires et d’IA : ni exception ni NaN', () => {
    const world = testWorld();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(orderArb, { minLength: 30, maxLength: 80 }),
        (seed, specs) => {
          const s = createGame(world, {
            seed,
            players: [
              { nationId: 'aaa', isAi: false },
              { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
              { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
            ],
          }) as EngineState;
          const end = 30 * DAY;
          const step = end / (specs.length + 1);
          specs.forEach((spec, i) => {
            advanceTo(s, Math.floor((i + 1) * step));
            const o = toOrder(s, spec);
            if (o) {
              const r = applyOrder(s, o.nation, o.order);
              if (!r.ok) expect(r.error).toBeDefined();
            }
            if (i % 10 === 0) checkInvariants(s);
          });
          // Coupure en cours de route : même empreinte.
          const copy = deserializeState(world, serializeState(s)) as EngineState;
          expect(stateHash(copy)).toBe(stateHash(s));
          advanceTo(s, end);
          advanceTo(copy, end);
          expect(stateHash(copy)).toBe(stateHash(s));
          checkInvariants(s);
        },
      ),
      { numRuns: 6, seed: 20260930 },
    );
  });
});
