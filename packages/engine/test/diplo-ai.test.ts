import { describe, expect, it } from 'vitest';
import { DAY, HOUR, destination } from '@redline/shared';
import { advanceTo, applySystem, createGame } from '../src/index.js';
import { transferProvince } from '../src/combat/capture.js';
import { atWar } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { estimateForce, ownForce } from '../src/ai/estimate.js';
import { ownerAt } from '../src/modules/diplo/relations.js';
import { cityOf, testWorld } from './fixtures.js';
import { B, CHARTER, D, ok } from './diplo-helpers.js';

const tanks = (owner: string, at: [number, number], n: number) =>
  Array.from({ length: n }, (_, i) => ({
    owner,
    systemId: 'tst.tank',
    pos: destination(at, (i * 360) / n, 12) as [number, number],
  }));

/** aaa (humain, forte armée) en guerre contre bbb (IA « normal », faible), qui a perdu bbb-4. */
function losingAi(level: 'easy' | 'normal' | 'hard' = 'normal'): EngineState {
  const s = createGame(testWorld(), {
    seed: 5,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: level },
      { nationId: 'ccc', isAi: false },
      { nationId: 'ddd', isAi: false },
    ],
    units: [
      ...tanks('aaa', cityOf('bbb-5'), 6),
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-2') },
    ],
  }) as EngineState;
  ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
  transferProvince(s, 'bbb-4', 'aaa');
  return s;
}

describe('IA stratégique', () => {
  it('l’IA qui perd demande un cessez-le-feu, puis la paix est conclue', () => {
    const s = losingAi();
    advanceTo(s, DAY);
    const p = D(s).proposals['aaa|bbb'];
    expect(p).toMatchObject({ from: 'bbb', to: 'aaa' });
    ok(s, 'aaa', { kind: 'answerPeace', nationId: 'bbb', accept: true });
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
  });

  it('l’IA en difficulté accepte la paix proposée par un joueur ; les troupes se retirent', () => {
    const s = losingAi('hard');
    ok(s, 'aaa', { kind: 'proposePeace', nationId: 'bbb', type: 'peace' });
    const notes = advanceTo(s, HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(notes.some((n) => n.kind === 'peace_signed')).toBe(true);
    // Retrait : les chars de aaa quittent le territoire de bbb (droit de passage temporaire).
    expect(
      Object.values(s.units)
        .filter((u) => u.owner === 'aaa')
        .every((u) => u.move !== null),
    ).toBe(true);
    advanceTo(s, 3 * DAY);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    for (const u of Object.values(s.units).filter((x) => x.owner === 'aaa')) {
      expect(u.move).toBeNull();
      expect(ownerAt(s, u.pos)).not.toBe('bbb');
    }
  });

  it('l’IA qui gagne refuse la paix', () => {
    const s = createGame(testWorld(), {
      seed: 5,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      ],
      units: [
        ...tanks('bbb', cityOf('bbb-4'), 8),
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      ],
    }) as EngineState;
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    ok(s, 'aaa', { kind: 'proposePeace', nationId: 'bbb', type: 'peace' });
    advanceTo(s, HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(D(s).proposals['aaa|bbb']).toBeUndefined();
  });

  it('l’IA « hard » déclare la guerre à un voisin faible après sa mise en route', () => {
    const s = createGame(testWorld(), {
      seed: 11,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
        { nationId: 'ccc', isAi: false },
        { nationId: 'ddd', isAi: false },
      ],
      units: [
        ...tanks('bbb', cityOf('bbb-2'), 10),
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      ],
    }) as EngineState;
    advanceTo(s, 3 * DAY - HOUR);
    expect(Object.keys(s.wars)).toHaveLength(0); // mise en route
    advanceTo(s, 25 * DAY);
    const wars = Object.keys(s.wars);
    expect(wars.length).toBeGreaterThan(0);
    expect(wars.every((k) => k.includes('bbb'))).toBe(true);
    expect(Object.values(D(s).aggressor)).toContain('bbb');
  });

  it('l’IA « easy » ne déclare jamais de guerre', () => {
    const s = createGame(testWorld(), {
      seed: 11,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'easy' },
      ],
      units: [...tanks('bbb', cityOf('bbb-2'), 10)],
    }) as EngineState;
    advanceTo(s, 20 * DAY);
    expect(Object.keys(s.wars)).toHaveLength(0);
  });

  it('estimation sans triche : seules les unités vues comptent, sinon hypothèse miroir', () => {
    const s = createGame(testWorld(), {
      seed: 1,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: false },
      ],
      units: [
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
        // Grosse armée de bbb loin de tout observateur de aaa.
        ...tanks('bbb', cityOf('bbb-3'), 12),
      ],
    }) as EngineState;
    const mine = ownForce(s, 'aaa');
    const blind = estimateForce(s, 'aaa', 'bbb', mine, 1);
    expect(blind).toBeCloseTo(5 * mine.perProvince); // 5 provinces × force par province de aaa
    // Les chars s'approchent et sont observés : l'estimation monte.
    for (const u of Object.values(s.units).filter((x) => x.owner === 'bbb')) {
      ok(s, 'bbb', {
        kind: 'move',
        unitIds: [u.id],
        to: destination(cityOf('aaa-3'), 90, 20) as [number, number],
      });
    }
    advanceTo(s, 2 * DAY);
    expect(estimateForce(s, 'aaa', 'bbb', ownForce(s, 'aaa'), 1)).toBeGreaterThan(blind);
  });

  it('Conseil : les IA qui siègent votent selon leurs intérêts', () => {
    const s = createGame(testWorld(), {
      seed: 2,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
        { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
        { nationId: 'ddd', isAi: true, aiLevel: 'easy' },
      ],
      // bbb, forte, refuse la paix ; ccc reste donc en guerre contre elle.
      units: tanks('bbb', cityOf('bbb-2'), 6),
      diplomacy: { rotatingSeats: 3, veto: true },
    }) as EngineState;
    ok(s, 'aaa', { kind: 'createAlliance', name: 'Coalition', flag: 'C', charter: CHARTER });
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'ccc' });
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'economic_sanctions',
      target: { nationId: 'bbb' },
      text: '',
    });
    // Séance d'urgence : le vote s'ouvre tout de suite ; les IA votent à leur prochaine réflexion.
    applySystem(s, { kind: 'worldEvent', event: 'emergency_council' });
    advanceTo(s, HOUR);
    const r = D(s).session.resolutions[0]!;
    expect(D(s).session.members).toEqual(['aaa', 'bbb', 'ccc', 'ddd']);
    expect(r.votes.ccc).toBe('yes'); // en guerre contre la cible
    expect(r.votes.ddd).toBe('abstain');
    expect(r.votes.bbb).toBeUndefined(); // la cible ne vote pas
    ok(s, 'aaa', { kind: 'voteResolution', resolutionId: r.id, vote: 'yes' });
    advanceTo(s, DAY);
    expect(B(s).sanctions.bbb).toBeLessThan(1);
  });

  it('passage de relais : un joueur reprend une IA, puis l’IA reprend sans à-coup', () => {
    const s = createGame(testWorld(), {
      seed: 11,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
      ],
      units: [...tanks('bbb', cityOf('bbb-2'), 10)],
    }) as EngineState;
    advanceTo(s, DAY);
    const mem = () => (s.mods.ai as { mem: Record<string, { calmUntil: number }> }).mem;
    expect(mem().bbb).toBeTruthy();
    expect(applySystem(s, { kind: 'addPlayer', nationId: 'bbb' }).ok).toBe(true);
    advanceTo(s, DAY + HOUR);
    expect(mem().bbb).toBeUndefined();
    expect(applySystem(s, { kind: 'setAi', nationId: 'bbb', isAi: true, aiLevel: 'hard' }).ok).toBe(
      true,
    );
    advanceTo(s, 5 * DAY);
    // Reprise en douceur : pas de décision brutale pendant le délai de transition.
    expect(mem().bbb!.calmUntil).toBeGreaterThan(5 * DAY - 3 * DAY);
    expect(Object.keys(s.wars).every((k) => D(s).since[k]! >= mem().bbb!.calmUntil)).toBe(true);
  });
});
