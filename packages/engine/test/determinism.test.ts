import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf, testWorld, unitsOf } from './fixtures.js';

type Script = { t: number; nation: string; order: (s: EngineState) => Order | null }[];

function newGame(seed: number): EngineState {
  return createGame(testWorld(), {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      { nationId: 'ccc', isAi: true, aiLevel: 'easy' },
    ],
  }) as EngineState;
}

const ids = (s: EngineState, n: string, sys?: string) => unitsOf(s, n, sys).map((u) => u.id);

const SCRIPT: Script = [
  {
    t: 1 * HOUR,
    nation: 'aaa',
    order: (s) => ({ kind: 'move', unitIds: ids(s, 'aaa', 'tst.infantry'), to: cityOf('bbb-4') }),
  },
  {
    t: 2 * HOUR,
    nation: 'aaa',
    order: (s) => ({ kind: 'move', unitIds: ids(s, 'aaa', 'tst.tank'), to: [8.4, 40.6] }),
  },
  {
    t: 5 * HOUR,
    nation: 'aaa',
    order: () => ({ kind: 'produce', provinceId: 'aaa-1', systemId: 'tst.infantry' }),
  },
  {
    t: 20 * HOUR,
    nation: 'aaa',
    order: (s) => ({ kind: 'move', unitIds: ids(s, 'aaa', 'tst.fighter'), to: [9, 41] }),
  },
  {
    t: 30 * HOUR,
    nation: 'aaa',
    order: (s) => ({ kind: 'stance', unitIds: ids(s, 'aaa'), stance: 'aggressive' }),
  },
  {
    t: 40 * HOUR,
    nation: 'aaa',
    order: (s) => ({ kind: 'move', unitIds: ids(s, 'aaa', 'tst.infantry'), to: cityOf('bbb-5') }),
  },
];

function play(s: EngineState, until: number, from = 0, onStep?: (t: number) => void): void {
  for (const step of SCRIPT) {
    if (step.t <= from || step.t > until) continue;
    advanceTo(s, step.t);
    const o = step.order(s);
    if (o) applyOrder(s, step.nation, o);
    onStep?.(step.t);
  }
  advanceTo(s, until);
}

describe('déterminisme', () => {
  it('même graine + mêmes ordres ⇒ même stateHash', () => {
    const a = newGame(77);
    const b = newGame(77);
    expect(stateHash(a)).toBe(stateHash(b));
    play(a, 3 * DAY);
    play(b, 3 * DAY);
    expect(stateHash(a)).toBe(stateHash(b));
    // Il s'est passé quelque chose (guerre, combats, IA).
    expect(Object.keys(a.wars).length).toBeGreaterThan(0);
    const c = newGame(78);
    play(c, 3 * DAY);
    expect(stateHash(c)).not.toBe(stateHash(a));
  });

  it('sérialiser / désérialiser en cours de partie puis continuer ⇒ même stateHash', () => {
    const ref = newGame(5);
    play(ref, 3 * DAY);

    const s = newGame(5);
    const cut = 25 * HOUR + 1234;
    play(s, cut);
    const bytes = serializeState(s);
    const restored = deserializeState(testWorld(), bytes) as EngineState;
    expect(stateHash(restored)).toBe(stateHash(s));
    expect(viewFor(restored, 'aaa')).toEqual(viewFor(s, 'aaa'));
    play(restored, 3 * DAY, cut);
    expect(stateHash(restored)).toBe(stateHash(ref));
  });

  it('plusieurs coupures successives', () => {
    const ref = newGame(9);
    play(ref, 2 * DAY);
    let s = newGame(9);
    let prev = 0;
    for (const cut of [3 * HOUR + 7, 21 * HOUR, 31 * HOUR + 1, 47 * HOUR]) {
      play(s, cut, prev);
      s = deserializeState(testWorld(), serializeState(s)) as EngineState;
      prev = cut;
    }
    play(s, 2 * DAY, prev);
    expect(stateHash(s)).toBe(stateHash(ref));
  });
});

describe('IA', () => {
  it('garnison : produit en paix, défend et contre-attaque', () => {
    const s = newGame(3);
    advanceTo(s, 2 * DAY);
    // bbb (IA) a produit au moins une unité défensive en temps de paix.
    const produced = Object.values(s.units).filter((u) => u.owner === 'bbb').length;
    expect(produced).toBeGreaterThan(4);
    // aaa prend bbb-4.
    applyOrder(s, 'aaa', {
      kind: 'move',
      unitIds: ids(s, 'aaa', 'tst.infantry'),
      to: cityOf('bbb-4'),
    });
    const orders: string[] = [];
    for (let t = 2 * DAY; t <= 6 * DAY; t += HOUR) {
      advanceTo(s, t);
      for (const u of unitsOf(s, 'bbb')) if (u.move || u.target) orders.push(u.id);
    }
    expect(orders.length).toBeGreaterThan(0);
  });
  it("'hard' : attaque les provinces voisines faibles d'un ennemi en guerre, sans ouvrir d'autre front", () => {
    const s = newGame(11);
    // aaa entre en bbb-4 avec une seule infanterie : guerre aaa–bbb.
    const inf = ids(s, 'aaa', 'tst.infantry')[0]!;
    applyOrder(s, 'aaa', { kind: 'move', unitIds: [inf], to: [5.4, 41.9] });
    advanceTo(s, DAY);
    expect(Object.keys(s.wars)).toEqual(['aaa|bbb']);
    let offensive = false;
    for (let t = DAY; t <= 6 * DAY && !offensive; t += 2 * HOUR) {
      advanceTo(s, t);
      offensive =
        ['aaa-1', 'aaa-2', 'aaa-3'].some((p) => s.provinces[p]!.owner === 'bbb') ||
        unitsOf(s, 'bbb').some((u) => {
          const legs = u.move?.legs;
          const dest = legs?.[legs.length - 1]?.to;
          return !!dest && dest[0] < 5;
        });
    }
    expect(offensive).toBe(true);
    // Aucune guerre avec les neutres (l'IA évite leurs territoires).
    expect(Object.keys(s.wars)).toEqual(['aaa|bbb']);
  });
});
