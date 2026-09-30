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
import { signal } from '../src/modules/registry.js';
import type { EngineState } from '../src/state/types.js';
import { ecoWorld } from './eco-fixtures.js';
import { cityOf, unitsOf } from './fixtures.js';

type Step = { t: number; run: (s: EngineState) => void };

const order = (n: string, o: Order | ((s: EngineState) => Order)) => (s: EngineState) => {
  applyOrder(s, n, typeof o === 'function' ? o(s) : o);
};

const SCRIPT: Step[] = [
  { t: 1 * HOUR, run: order('aaa', { kind: 'research', nodeId: 'research.aero.gen5' }) },
  {
    t: 2 * HOUR,
    run: order('aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'us.f-16', count: 3 }),
  },
  { t: 3 * HOUR, run: order('aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }) },
  {
    t: 4 * HOUR,
    run: order('aaa', {
      kind: 'sellOffer',
      item: { type: 'resource', resource: 'metals', qty: 20 },
      price: 2e6,
      to: null,
    }),
  },
  {
    t: 5 * HOUR,
    run: (s) => {
      const id = Object.keys((s.mods.eco as { offers: object }).offers).sort()[0];
      if (id) applyOrder(s, 'ddd', { kind: 'acceptOffer', offerId: id });
    },
  },
  {
    t: 6 * HOUR,
    run: order('aaa', {
      kind: 'transfer',
      to: 'ddd',
      item: { type: 'units', systemId: 'tst.tank', count: 7 },
      covert: false,
    }),
  },
  {
    t: 10 * HOUR,
    run: (s) =>
      signal(s, 'building_hit', { pid: 'aaa-1', building: 'refinery', damage: 0.6, by: 'bbb' }),
  },
  {
    t: 11 * HOUR,
    run: order('aaa', { kind: 'repair', provinceId: 'aaa-1', building: 'refinery' }),
  },
  { t: 20 * HOUR, run: order('aaa', { kind: 'mobilize', on: true }) },
  {
    t: 30 * HOUR,
    run: order('aaa', (s) => ({
      kind: 'move',
      unitIds: unitsOf(s, 'aaa', 'tst.infantry')
        .map((u) => u.id)
        .slice(0, 2),
      to: cityOf('bbb-4'),
    })),
  },
  { t: 50 * HOUR, run: order('bbb', { kind: 'blackMarket', systemId: 'us.f-16', count: 2 }) },
];

function newGame(seed: number): EngineState {
  return createGame(ecoWorld(), {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
      { nationId: 'ddd', isAi: false },
    ],
  }) as EngineState;
}

function play(s: EngineState, until: number, from = -1): void {
  for (const step of SCRIPT) {
    if (step.t <= from || step.t > until) continue;
    advanceTo(s, step.t);
    step.run(s);
  }
  advanceTo(s, until);
}

describe('économie réelle : déterminisme', () => {
  it('même graine + mêmes ordres ⇒ même stateHash', () => {
    const a = newGame(11);
    const b = newGame(11);
    expect(stateHash(a)).toBe(stateHash(b));
    play(a, 10 * DAY);
    play(b, 10 * DAY);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(viewFor(a, 'aaa')).toEqual(viewFor(b, 'aaa'));
    // Le scénario a bien eu lieu.
    expect(viewFor(a, 'aaa').research!.done).toContain('research.aero.gen5');
    expect(unitsOf(a, 'ddd', 'tst.tank').reduce((x, u) => x + u.count, 0)).toBe(7);
  });

  it('sérialiser / désérialiser en cours de route puis continuer ⇒ même stateHash', () => {
    const ref = newGame(12);
    play(ref, 4 * DAY);

    const s = newGame(12);
    const mid = 8 * HOUR; // livraisons en route, chantier et recherche en cours
    play(s, mid);
    const bytes = serializeState(s);
    const r = deserializeState(ecoWorld(), bytes) as EngineState;
    expect(stateHash(r)).toBe(stateHash(s));
    expect(viewFor(r, 'aaa')).toEqual(viewFor(s, 'aaa'));
    play(r, 4 * DAY, mid);
    expect(stateHash(r)).toBe(stateHash(ref));
  });
});
