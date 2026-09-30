import { describe, expect, it } from 'vitest';
import { DAY } from '@redline/shared';
import { advanceTo, applyOrder, createGame, viewFor } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { testWorld } from './fixtures.js';
import { modifier, signal } from '../src/modules/registry.js';
import { transferProvince } from '../src/combat/capture.js';
import { atWar } from '../src/state/access.js';
import { cityOf, unitsOf } from './fixtures.js';
import { B, CHARTER, D, diploWorld, game, ok } from './diplo-helpers.js';

describe('diplomatie : stabilité, coups d’État, réfugiés', () => {
  it('facteurs de stabilité, tendance, effet sur la production et les revenus', () => {
    const s = game();
    expect(B(s).stability.aaa).toBe(70);
    expect(modifier(s, 'aaa', 'production.speed')).toBe(1);
    signal(s, 'disinformation', { by: 'bbb', victim: 'aaa', amount: 40 });
    signal(s, 'stability', { nation: 'aaa', delta: -10, reason: 'Mobilisation partielle' });
    expect(B(s).stability.aaa).toBe(20);
    // Stabilité 20 < 40 : production et revenus réduits (0,5 + 0,5 × 20/40 = 0,75).
    expect(modifier(s, 'aaa', 'production.speed')).toBeCloseTo(0.75);
    expect(modifier(s, 'aaa', 'income.money')).toBeCloseTo(0.75);
    const v = viewFor(s, 'aaa').stability!;
    expect(v.value).toBe(20);
    expect(v.trend).toBe(-50);
    expect(v.factors[0]).toEqual({ label: 'Désinformation', delta: -40 });
    expect(viewFor(s, 'bbb').nations.aaa!.stability).toBe(20);
    // Retour au calme progressif.
    advanceTo(s, 3 * DAY);
    expect(B(s).stability.aaa!).toBeGreaterThan(20);
  });

  it('frappe nucléaire : choc pour l’auteur, la victime et le monde', () => {
    const s = game();
    signal(s, 'nuclear_detonation', {
      by: 'aaa',
      victim: 'bbb',
      at: cityOf('bbb-2'),
      pid: 'bbb-2',
    });
    expect(B(s).stability.bbb).toBe(50);
    expect(B(s).stability.aaa).toBe(60);
    expect(B(s).stability.ccc).toBe(68);
    expect(D(s).rep.aaa).toBe(20);
    expect(viewFor(s, 'ccc').news!.some((n) => n.category === 'nuclear')).toBe(true);
  });

  it('coup d’État quand la stabilité s’effondre (la nation change de politique)', () => {
    const w = diploWorld({
      stability: { start: 70, coupThreshold: 15, revoltThreshold: 0, coupChancePerDay: 1 },
    });
    const s = game({
      world: w,
      units: [
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
        { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
      ],
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: false },
        { nationId: 'ccc', isAi: true, aiLevel: 'easy' },
      ],
    });
    ok(s, 'aaa', { kind: 'createAlliance', name: 'Axe', flag: 'X', charter: CHARTER });
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    signal(s, 'stability', { nation: 'aaa', delta: -70, reason: 'Effondrement' });
    const notes = advanceTo(s, DAY);
    const coupNote = notes.find((n) => n.kind === 'generic' && n.category === 'coup');
    expect(coupNote).toBeTruthy();
    expect(D(s).coups.aaa).toBe(DAY);
    expect(B(s).stability.aaa).toBe(40);
    expect(B(s).allianceOf.aaa).toBeUndefined(); // la junte quitte l'alliance
    expect(D(s).proposals['aaa|bbb']).toMatchObject({ from: 'aaa', kind: 'ceasefire' });
    expect(s.nations.aaa!.isPlayer).toBe(true); // réglage par défaut : le joueur garde la main
    expect(viewFor(s, 'bbb').news!.some((n) => n.category === 'coup')).toBe(true);

    // Réglage coupPlayerToAi : la nation passe à l'IA.
    const w2 = diploWorld({
      stability: {
        start: 70,
        coupThreshold: 15,
        revoltThreshold: 0,
        coupChancePerDay: 1,
        coupPlayerToAi: true,
      },
    });
    const t = game({ world: w2 });
    signal(t, 'stability', { nation: 'ddd', delta: -70, reason: 'Effondrement' });
    advanceTo(t, DAY);
    expect(t.nations.ddd!.isAi).toBe(true);
    expect(t.nations.ddd!.isPlayer).toBe(false);
  });

  it('pertes et territoire perdu font baisser la stabilité ; les réfugiés fuient chez les voisins en paix', () => {
    const s = game({
      units: [
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
        { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
      ],
    });
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    const cBefore = B(s).stability.ccc!;
    const aBefore = B(s).stability.aaa!;
    transferProvince(s, 'aaa-1', 'bbb');
    expect(B(s).stability.aaa!).toBe(aBefore - 3);
    expect(B(s).stability.bbb!).toBe(71);
    advanceTo(s, DAY);
    // ccc (voisin de aaa, en paix avec elle) accueille des réfugiés.
    const cv = viewFor(s, 'ccc').stability!;
    expect(cv.factors.some((f) => f.label === 'Réfugiés')).toBe(true);
    expect(B(s).stability.ccc!).toBeLessThan(cBefore);
    expect(viewFor(s, 'ccc').news!.some((n) => n.category === 'refugees')).toBe(true);
    // bbb, en guerre avec aaa, n'en accueille pas.
    expect(viewFor(s, 'bbb').stability!.factors.some((f) => f.label === 'Réfugiés')).toBe(false);
  });

  it('la mobilisation (tableau eco) et les sanctions pèsent chaque jour', () => {
    const s = game();
    B(s).mobilized.aaa = true;
    B(s).sanctions.ccc = 0.6;
    advanceTo(s, DAY);
    expect(B(s).stability.aaa).toBe(69);
    expect(B(s).stability.ccc).toBe(69.5);
    expect(B(s).stability.bbb).toBe(70);
  });

  it('capitale perdue : dépêche et forte baisse ; la guerre est bien active', () => {
    const s = game();
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'ccc' });
    expect(atWar(s, 'aaa', 'ccc')).toBe(true);
    transferProvince(s, 'ccc-1', 'aaa');
    expect(B(s).stability.ccc).toBe(55);
    expect(
      viewFor(s, 'ddd').news!.some(
        (n) => n.category === 'capture' && /capitale/i.test(n.headline + n.body),
      ),
    ).toBe(true);
    expect(applyOrder(s, 'ccc', { kind: 'proposePeace', nationId: 'aaa', type: 'peace' }).ok).toBe(
      true,
    );
    void unitsOf;
  });

  it('victoire : conditions propres à la partie (setup.victory)', () => {
    const s = createGame(testWorld(), {
      seed: 1,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: false },
      ],
      units: [],
      victory: { provinceShare: 0.5, allEnemyCapitals: false },
    }) as EngineState;
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'ccc' });
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'ddd' });
    transferProvince(s, 'ccc-1', 'aaa');
    transferProvince(s, 'ccc-2', 'aaa');
    expect(s.winner).toBeNull(); // 5/11 < 0,5
    transferProvince(s, 'ddd-1', 'aaa');
    expect(s.winner).toBe('aaa'); // 6/11 ≥ 0,5 (l'équilibrage par défaut exigerait 0,7)
  });
});
