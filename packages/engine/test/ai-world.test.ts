import { describe, expect, it } from 'vitest';
import { AiBalanceSchema, DAY, HOUR, destination } from '@redline/shared';
import { advanceTo, createGame, stateHash } from '../src/index.js';
import { atWar } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { activeAiWars } from '../src/ai/world.js';
import { ds } from '../src/modules/diplo/state.js';
import { cityOf, worldWith } from './fixtures.js';

/**
 * Monde vivant : les IA se font la guerre entre elles d'après les rivalités et les blocs des données
 * (ai.world), avec un plafond de guerres simultanées, et finissent leurs guerres (capitulation,
 * enlisement). Monde synthétique de fixtures.ts : aaa (3 provinces), bbb (5), ccc (2), ddd (île).
 */

const tanks = (owner: string, at: [number, number], n: number) =>
  Array.from({ length: n }, (_, i) => ({
    owner,
    systemId: 'tst.tank',
    pos: destination(at, (i * 360) / n, 10) as [number, number],
  }));

/** Section ai.world telle qu'écrite dans les données (valeurs par défaut complétées par le schéma). */
type WorldInput = Record<string, unknown>;

function game(world: WorldInput, seed = 7, level: 'easy' | 'normal' | 'hard' = 'normal') {
  const ai = AiBalanceSchema.parse({
    world: {
      levels: { [level]: { fromDays: 0, rivalryChancePerDay: 1, maxWars: 1 } },
      ...world,
    },
  });
  const w = worldWith({ ai } as never);
  return createGame(w, {
    seed,
    players: ['aaa', 'bbb', 'ccc', 'ddd'].map((n) => ({
      nationId: n,
      isAi: true,
      aiLevel: level,
    })),
    units: [
      ...tanks('bbb', cityOf('bbb-4'), 8),
      ...tanks('bbb', cityOf('bbb-2'), 3),
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
      { owner: 'ccc', systemId: 'tst.infantry', pos: cityOf('ccc-1') },
      { owner: 'ddd', systemId: 'tst.infantry', pos: cityOf('ddd-1') },
    ],
  }) as EngineState;
}

const RIVALS = {
  rivalries: [{ a: 'bbb', b: 'aaa', weight: 1, motive: 'la vallée disputée', initiator: 'a' }],
  // aaa et ccc dans un même bloc : jamais de guerre de choix entre eux.
  blocs: [{ id: 'nord', name: 'Pacte du Nord', members: ['aaa', 'ccc'], restraint: 1 }],
};

describe('monde vivant : guerres entre IA', { timeout: 120_000 }, () => {
  it('une rivalité des données dégénère en guerre entre IA, motif public dans la dépêche', () => {
    const s = game(RIVALS);
    let warAt = -1;
    for (let t = 2 * HOUR; t <= 3 * DAY && warAt < 0; t += 2 * HOUR) {
      advanceTo(s, t);
      if (atWar(s, 'bbb', 'aaa')) warAt = t;
    }
    expect(warAt).toBeGreaterThan(0);
    expect(ds(s).aggressor['aaa|bbb']).toBe('bbb');
    const war = ds(s).news.find((n) => n.category === 'war' && n.nations.includes('aaa'));
    expect(war?.body).toContain('Agresseur désigné : Nation BBB');
    expect(war?.body).toContain('Motif invoqué : la vallée disputée.');
    // Le bloc retient ccc : il ne profite pas de la faiblesse de son partenaire aaa.
    advanceTo(s, 6 * DAY);
    expect(atWar(s, 'ccc', 'aaa')).toBe(false);
  });

  it('sans rivalité ni motif, le monde « normal » reste en paix ; intensité nulle : monde figé', () => {
    const calm = game({ blocs: RIVALS.blocs });
    advanceTo(calm, 5 * DAY);
    expect(Object.keys(calm.wars)).toEqual([]);
    const frozen = game({ ...RIVALS, intensity: 0 });
    advanceTo(frozen, 5 * DAY);
    expect(Object.keys(frozen.wars)).toEqual([]);
  });

  it('pas de guerre mondiale : plafond de guerres simultanées entre IA', () => {
    const s = game({
      rivalries: [
        { a: 'bbb', b: 'aaa', weight: 1, initiator: 'a' },
        { a: 'bbb', b: 'ccc', weight: 1, initiator: 'a' },
        { a: 'aaa', b: 'ccc', weight: 1 },
      ],
      levels: { normal: { fromDays: 0, rivalryChancePerDay: 1, maxWars: 2, maxActiveWars: 1 } },
    });
    let peak = 0;
    for (let t = 6 * HOUR; t <= 5 * DAY; t += 6 * HOUR) {
      advanceTo(s, t);
      peak = Math.max(peak, activeAiWars(s));
    }
    expect(peak).toBe(1);
  });

  it('la guerre se termine : la victime capitule, le vainqueur garde ses conquêtes ; déterministe', () => {
    const run = () => {
      const s = game(RIVALS, 11);
      advanceTo(s, 14 * DAY);
      return s;
    };
    const s = run();
    const d = ds(s);
    const declared = d.news.some((n) => n.category === 'war' && n.nations.includes('aaa'));
    expect(declared).toBe(true);
    const ended = d.news.find(
      (n) => n.category === 'peace' && n.nations.includes('aaa') && n.nations.includes('bbb'),
    );
    expect(ended).toBeDefined();
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    // Conquêtes réelles : des provinces d'aaa restent à bbb après la paix.
    const kept = ['aaa-1', 'aaa-2', 'aaa-3'].filter((p) => s.provinces[p]!.owner === 'bbb');
    expect(kept.length).toBeGreaterThan(0);
    expect(stateHash(run())).toBe(stateHash(s));
  });
});
