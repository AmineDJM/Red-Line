import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  applySystem,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf } from './fixtures.js';
import { CHARTER, diploWorld, mapWithDisputed } from './diplo-helpers.js';

const world: World = diploWorld(
  { stability: { start: 60, coupThreshold: 15, revoltThreshold: 30, armedUprisingChance: 0.5 } },
  mapWithDisputed({
    provinceIds: ['bbb-4', 'aaa-1'],
    claimants: ['aaa', 'bbb'],
    tension: 80,
    revoltRate: 0.5,
  }),
);

function newGame(seed: number): EngineState {
  return createGame(world, {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
    ],
    speed: 2,
  }) as EngineState;
}

type Step =
  { t: number; n: string; o: Order } | { t: number; sys: Parameters<typeof applySystem>[1] };

const SCRIPT: Step[] = [
  { t: HOUR, n: 'aaa', o: { kind: 'createAlliance', name: 'Ligue', flag: 'L', charter: CHARTER } },
  { t: 2 * HOUR, n: 'aaa', o: { kind: 'inviteToAlliance', nationId: 'ddd' } },
  { t: 3 * HOUR, n: 'aaa', o: { kind: 'fundRebels', provinceId: 'bbb-4', amount: 300 } },
  { t: 5 * HOUR, n: 'aaa', o: { kind: 'hireMercenaries', provinceId: 'aaa-2', count: 2 } },
  { t: 6 * HOUR, n: 'aaa', o: { kind: 'courtNeutral', nationId: 'ddd', aid: 200 } },
  {
    t: 8 * HOUR,
    n: 'aaa',
    o: { kind: 'proposeResolution', type: 'condemnation', target: { nationId: 'bbb' }, text: '' },
  },
  { t: 1 * DAY, n: 'aaa', o: { kind: 'declareWar', nationId: 'bbb' } },
  { t: 1 * DAY + HOUR, sys: { kind: 'worldEvent', event: 'oil_crisis', params: { days: 3 } } },
  { t: 2 * DAY, sys: { kind: 'worldEvent', event: 'emergency_council' } },
  { t: 3 * DAY, n: 'aaa', o: { kind: 'proposePeace', nationId: 'bbb', type: 'ceasefire' } },
  { t: 6 * DAY, n: 'aaa', o: { kind: 'move', unitIds: [], to: cityOf('ccc-1') } },
];

function play(s: EngineState, from: number, to: number): void {
  for (const st of SCRIPT) {
    if (st.t < from || st.t >= to) continue;
    advanceTo(s, st.t);
    if ('sys' in st) applySystem(s, st.sys);
    else if (st.o.kind === 'move') {
      const ids = Object.values(s.units)
        .filter((u) => u.owner === 'aaa')
        .map((u) => u.id)
        .sort();
      if (ids.length > 0) applyOrder(s, st.n, { ...st.o, unitIds: ids });
    } else applyOrder(s, st.n, st.o);
  }
  advanceTo(s, to);
}

describe('diplomatie : déterminisme et sérialisation', () => {
  it('même graine + mêmes ordres ⇒ même état ; sauvegarde / reprise identique', () => {
    const a = newGame(21);
    play(a, 0, 12 * DAY);
    const b = newGame(21);
    play(b, 0, 12 * DAY);
    expect(stateHash(b)).toBe(stateHash(a));

    const c = newGame(21);
    play(c, 0, 5 * DAY);
    const restored = deserializeState(world, serializeState(c)) as EngineState;
    play(restored, 5 * DAY, 12 * DAY);
    expect(stateHash(restored)).toBe(stateHash(a));
    expect(viewFor(restored, 'aaa')).toEqual(viewFor(a, 'aaa'));

    // Le module a bien travaillé (actualité, Conseil, zones disputées).
    const v = viewFor(a, 'aaa');
    expect(v.news!.length).toBeGreaterThan(3);
    expect(v.diplomacy!.disputed[0]!.id).toBe('zone');
    expect(v.council!.members.length).toBeGreaterThan(0);
  });

  it('état du module sérialisable (aucune fonction, aucun Infinity non maîtrisé)', () => {
    const s = newGame(4);
    play(s, 0, 4 * DAY);
    const d = s.mods.diplo;
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});
