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
import { cityOf } from './fixtures.js';
import { milWorld } from './mil-fixtures.js';

/**
 * Scénario militaire complet : patrouilles, ravitailleur, porte-avions, salves et interceptions,
 * opération combinée, général délégué, blocus, satellite, cyberattaque, leurres, IA en guerre.
 */
function newGame(seed: number): EngineState {
  return createGame(milWorld(), {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
    ],
    units: [
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2'), count: 2 }, // u1
      { owner: 'aaa', systemId: 'tst.tanker', pos: cityOf('aaa-2') }, // u2
      { owner: 'aaa', systemId: 'tst.cruise', pos: cityOf('aaa-1'), count: 12 }, // u3
      { owner: 'aaa', systemId: 'tst.carrier', pos: [7.5, 44] }, // u4
      { owner: 'aaa', systemId: 'tst.navyjet', pos: [7.5, 44], count: 2 }, // u5
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] }, // u6
      { owner: 'aaa', systemId: 'tst.tank', pos: [2.5, 44] }, // u7
      { owner: 'aaa', systemId: 'tst.destroyer', pos: [9, 43.5] }, // u8
      { owner: 'aaa', systemId: 'tst.optsat', pos: cityOf('aaa-2') }, // u9
      { owner: 'bbb', systemId: 'tst.patriot', pos: [7.3, 40] }, // u10
      { owner: 'bbb', systemId: 'tst.jet', pos: cityOf('bbb-2'), count: 2 }, // u11
      { owner: 'bbb', systemId: 'tst.cruise', pos: cityOf('bbb-2'), count: 8 }, // u12
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') }, // u13
      { owner: 'bbb', systemId: 'tst.sub', pos: [12, 44] }, // u14
      { owner: 'bbb', systemId: 'tst.radar', pos: [9, 40.5] }, // u15
      { owner: 'ccc', systemId: 'tst.sam', pos: cityOf('ccc-1') }, // u16
    ],
  }) as EngineState;
}

type Step = { t: number; run: (s: EngineState) => void };

const order = (n: string, o: Order) => (s: EngineState) => void applyOrder(s, n, o);

const SCRIPT: Step[] = [
  {
    t: 10 * 60_000,
    run: order('aaa', { kind: 'patrol', unitIds: ['u2'], at: [6, 44], radiusKm: 50 }),
  },
  {
    t: 20 * 60_000,
    run: order('aaa', { kind: 'patrol', unitIds: ['u1'], at: [8, 43], radiusKm: 150 }),
  },
  { t: 30 * 60_000, run: order('aaa', { kind: 'move', unitIds: ['u6'], to: [5.3, 40] }) },
  {
    t: HOUR,
    run: order('aaa', {
      kind: 'operation',
      name: 'Aube',
      hHour: 3 * HOUR,
      steps: [
        {
          offsetMin: -30,
          order: { kind: 'patrol', unitIds: ['u5'], at: [9, 42.5], radiusKm: 100 },
        },
        {
          offsetMin: 0,
          order: {
            kind: 'strike',
            unitIds: ['u3'],
            target: { type: 'building', provinceId: 'bbb-4', building: 'arms_factory' },
            count: 6,
          },
        },
        {
          offsetMin: 20,
          order: { kind: 'blockade', unitIds: ['u8'], target: { provinceId: 'bbb-4' } },
        },
      ],
    }),
  },
  {
    t: 90 * 60_000,
    run: (s) => {
      const g = viewFor(s, 'aaa').generals![0]!.id;
      applyOrder(s, 'aaa', { kind: 'appointGeneral', generalId: g, unitIds: ['u7'] });
      applyOrder(s, 'aaa', {
        kind: 'delegate',
        generalId: g,
        directive: 'defend',
        area: [2.5, 44],
      });
    },
  },
  {
    t: 2 * HOUR,
    run: order('aaa', { kind: 'patrol', unitIds: ['u9'], at: cityOf('bbb-2'), radiusKm: 30 }),
  },
  {
    t: 5 * HOUR,
    run: (s) => signal(s, 'cyber', { by: 'aaa', victim: 'bbb', kind: 'radar', hours: 3 }),
  },
  {
    t: 6 * HOUR,
    run: (s) =>
      signal(s, 'decoys', { by: 'bbb', at: cityOf('bbb-5'), count: 2, systemId: 'tst.tank' }),
  },
  {
    t: 9 * HOUR,
    run: order('aaa', {
      kind: 'strike',
      unitIds: ['u3'],
      target: { type: 'point', at: cityOf('bbb-4') },
    }),
  },
  { t: 20 * HOUR, run: order('aaa', { kind: 'rtb', unitIds: ['u1', 'u5'] }) },
  { t: 30 * HOUR, run: order('aaa', { kind: 'split', unitId: 'u1', count: 1 }) },
];

function play(s: EngineState, until: number, from = 0): void {
  for (const step of SCRIPT) {
    if (step.t <= from || step.t > until) continue;
    advanceTo(s, step.t);
    step.run(s);
  }
  advanceTo(s, until);
}

describe('déterminisme du module militaire', () => {
  it('même graine ⇒ même empreinte ; il s’est passé quelque chose', () => {
    const a = newGame(11);
    const b = newGame(11);
    play(a, 2 * DAY);
    play(b, 2 * DAY);
    expect(stateHash(a)).toBe(stateHash(b));
    const m = a.mods.mil as { battles: object; stats: Record<string, { missiles: number }> };
    expect(Object.keys(m.battles).length).toBeGreaterThan(0);
    expect(m.stats.aaa!.missiles).toBeGreaterThan(0);
  });

  it('reprise après sérialisation à plusieurs instants ⇒ même empreinte', () => {
    const ref = newGame(12);
    play(ref, 2 * DAY);
    let s = newGame(12);
    let prev = 0;
    for (const cut of [
      25 * 60_000,
      3 * HOUR + 1,
      3 * HOUR + 10 * 60_000,
      9 * HOUR + 7,
      26 * HOUR,
    ]) {
      play(s, cut, prev);
      const bytes = serializeState(s);
      const r = deserializeState(milWorld(), bytes) as EngineState;
      expect(stateHash(r)).toBe(stateHash(s));
      expect(viewFor(r, 'aaa')).toEqual(viewFor(s, 'aaa'));
      s = r;
      prev = cut;
    }
    play(s, 2 * DAY, prev);
    expect(stateHash(s)).toBe(stateHash(ref));
  });
});
