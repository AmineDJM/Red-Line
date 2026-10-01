import { afterEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, type Order } from '@redline/shared';
import { advanceTo, applyOrder, applySystem, createGame } from '../src/index.js';
import { transferProvince } from '../src/combat/capture.js';
import { atWar } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { setAiTracer } from '../src/ai/trace.js';
import { aiReserve } from '../src/ai/money.js';
import { budgetDay } from '../src/modules/eco/budget.js';
import { D } from './diplo-helpers.js';
import { ecoGame } from './eco-fixtures.js';
import { cityOf, testWorld, unitsOf } from './fixtures.js';

/** Ordres donnés par l'IA d'une nation (traceur de diagnostic), réussis ou non. */
function record(n: string) {
  const log: { t: number; o: Order; ok: boolean; money: number; eta: number[] }[] = [];
  setAiTracer((st, who, o, r) => {
    if (who !== n) return;
    // Arrivées prévues des unités d'un ordre de déplacement.
    const eta =
      o.kind === 'move'
        ? (o as { unitIds: string[] }).unitIds.map((id) => {
            const legs = st.units[id]?.move?.legs;
            return legs?.length ? legs[legs.length - 1]!.t1 : st.time;
          })
        : [];
    log.push({ t: st.time, o: o as Order, ok: r.ok, money: st.nations[who]!.money, eta });
  });
  return log;
}

afterEach(() => setAiTracer(null));

type Spec = { owner: string; systemId: string; pos: [number, number] };
const at = (owner: string, systemId: string, pos: [number, number], n = 1): Spec[] =>
  Array.from({ length: n }, (_, i) => ({
    owner,
    systemId,
    pos: [pos[0] + i * 0.02, pos[1]] as [number, number],
  }));

/** aaa (humain, passif) contre bbb (IA du niveau donné) ; ccc et ddd humains (aucune IA tierce). */
function duel(units: Spec[], level: 'easy' | 'normal' | 'hard' = 'normal'): EngineState {
  const s = createGame(testWorld(), {
    seed: 3,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: level },
      { nationId: 'ccc', isAi: false },
      { nationId: 'ddd', isAi: false },
    ],
    units,
  }) as EngineState;
  return s;
}

describe('IA tactique', { timeout: 60_000 }, () => {
  it('défend sa capitale : la garnison reste, les renforts accourent, la ville tient', () => {
    const cap = cityOf('bbb-2');
    const s = duel([
      ...at('bbb', 'tst.infantry', cap),
      ...at('bbb', 'tst.tank', cityOf('bbb-1'), 3),
      // Colonne blindée ennemie à ~45 km au nord de la capitale (vue par la couverture de la province).
      ...at('aaa', 'tst.tank', [cap[0], cap[1] + 0.4], 2),
    ]);
    const log = record('bbb');
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
    advanceTo(s, 12 * HOUR);
    // Les chars du sud sont engagés (renfort de la capitale ou attaque de la colonne), en groupe.
    const moved = log.filter((x) => x.ok && (x.o.kind === 'move' || x.o.kind === 'attack'));
    expect(moved.length).toBeGreaterThan(0);
    expect(Math.max(...moved.map((x) => (x.o as { unitIds: string[] }).unitIds.length))).toBe(
      Math.min(3, Math.max(...moved.map((x) => (x.o as { unitIds: string[] }).unitIds.length))),
    );
    // La garnison (infanterie) n'a pas quitté la capitale.
    const inf = unitsOf(s, 'bbb', 'tst.infantry')[0]!;
    expect(inf.move).toBeNull();
    expect(inf.target).toBeNull();
    advanceTo(s, 2 * DAY);
    expect(s.provinces['bbb-2']!.owner).toBe('bbb');
  });

  it('contre-attaque en groupe pour reprendre une province perdue', () => {
    const s = duel([
      ...at('bbb', 'tst.infantry', cityOf('bbb-2')),
      ...at('bbb', 'tst.tank', cityOf('bbb-5'), 3),
      ...at('bbb', 'tst.infantry', cityOf('bbb-5'), 2),
      ...at('aaa', 'tst.infantry', cityOf('aaa-2')),
    ]);
    const log = record('bbb');
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
    transferProvince(s, 'bbb-4', 'aaa');
    advanceTo(s, 12 * HOUR);
    const city = cityOf('bbb-4');
    const toCity = log.filter(
      (x) =>
        x.ok &&
        x.o.kind === 'move' &&
        Math.abs(x.o.to[0] - city[0]) < 0.01 &&
        Math.abs(x.o.to[1] - city[1]) < 0.01,
    );
    expect(toCity.length).toBeGreaterThan(0);
    // Jamais une unité seule : au moins deux unités, parties en vagues échelonnées qui arrivent
    // ensemble (moins d'une heure d'écart entre les arrivées prévues).
    expect(
      new Set(toCity.flatMap((x) => (x.o as { unitIds: string[] }).unitIds)).size,
    ).toBeGreaterThan(1);
    const etas = toCity.flatMap((x) => x.eta);
    expect(Math.max(...etas) - Math.min(...etas)).toBeLessThanOrEqual(HOUR);
    advanceTo(s, 3 * DAY);
    expect(s.provinces['bbb-4']!.owner).toBe('bbb');
  });

  it("n'envoie pas ses unités au casse-pipe contre une ville solidement tenue", () => {
    const city = cityOf('bbb-4');
    const s = duel([
      ...at('bbb', 'tst.infantry', cityOf('bbb-2')),
      // Deux infanteries en observation à ~14 km de la ville perdue, qui voient les défenseurs.
      ...at('bbb', 'tst.infantry', [city[0] + 0.15, city[1] + 0.05], 2),
      ...at('aaa', 'tst.tank', city, 8),
    ]);
    const log = record('bbb');
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
    transferProvince(s, 'bbb-4', 'aaa');
    advanceTo(s, DAY);
    const toCity = log.filter(
      (x) =>
        x.o.kind === 'move' &&
        Math.abs(x.o.to[0] - city[0]) < 0.01 &&
        Math.abs(x.o.to[1] - city[1]) < 0.01,
    );
    expect(toCity).toHaveLength(0);
  });

  it('aucun ordre refusé par le moteur pendant une guerre', () => {
    const s = createGame(testWorld(), {
      seed: 7,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
        { nationId: 'ccc', isAi: true, aiLevel: 'normal' },
      ],
    }) as EngineState;
    const refused: string[] = [];
    setAiTracer((_st, n, o, r) => {
      if (!r.ok) refused.push(`${n} ${o.kind} ${r.error}`);
    });
    const inf = unitsOf(s, 'aaa', 'tst.infantry').map((u) => u.id);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: inf, to: cityOf('bbb-4') });
    advanceTo(s, 3 * DAY);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(refused).toEqual([]);
  });
});

describe('IA économique', { timeout: 60_000 }, () => {
  it('ne dépense pas sa réserve en guerre ; dépense quand la trésorerie le permet', () => {
    const play = (money: (s: EngineState) => number) => {
      const s = ecoGame({
        players: [
          { nationId: 'aaa', isAi: false },
          { nationId: 'bbb', isAi: true, aiLevel: 'normal' },
          { nationId: 'ccc', isAi: false },
          { nationId: 'ddd', isAi: false },
        ],
      });
      expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
      const target = money(s);
      applySystem(s, { kind: 'grant', nationId: 'bbb', money: target - s.nations.bbb!.money });
      const log = record('bbb');
      advanceTo(s, 12 * HOUR);
      setAiTracer(null);
      const spend = log.filter(
        (x) => x.ok && (x.o.kind === 'produce' || x.o.kind === 'research' || x.o.kind === 'build'),
      );
      return { s, spend };
    };
    // Trésorerie sous la réserve de guerre (cinq jours de budget) : aucune dépense.
    const poor = play((s) => budgetDay(s, 'bbb') * 2);
    expect(poor.spend).toHaveLength(0);
    expect(poor.s.nations.bbb!.money).toBeGreaterThan(0);
    // Trésorerie confortable : production et recherche, chacune en gardant la réserve.
    const rich = play((s) => budgetDay(s, 'bbb') * 60);
    expect(rich.spend.length).toBeGreaterThan(0);
    for (const x of rich.spend)
      expect(x.money).toBeGreaterThanOrEqual(aiReserve(rich.s, 'bbb', true) * 0.9);
  });
});

describe('IA : niveaux et diplomatie', { timeout: 60_000 }, () => {
  it('le niveau choisi pour la partie s’applique à toutes les IA (joueurs porteurs du niveau)', () => {
    const s = createGame(testWorld(), {
      seed: 1,
      players: [{ nationId: 'aaa', isAi: false, aiLevel: 'hard' }],
    }) as EngineState;
    expect(s.nations.bbb!.aiLevel).toBe('hard');
    expect(s.nations.ccc!.aiLevel).toBe('hard');
    const t = createGame(testWorld(), {
      seed: 1,
      players: [{ nationId: 'aaa', isAi: false }],
    }) as EngineState;
    expect(t.nations.bbb!.aiLevel).toBe('normal');
  });

  it('guerre sans front (pays lointain, rien pris ni perdu) : l’IA propose une paix blanche', () => {
    // ddd (île, IA) n'a aucune frontière avec aaa ; elle est bien plus forte, elle ne « perd » pas.
    const s = createGame(testWorld(), {
      seed: 2,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: false },
        { nationId: 'ccc', isAi: false },
        { nationId: 'ddd', isAi: true, aiLevel: 'normal' },
      ],
      units: [
        ...at('ddd', 'tst.tank', cityOf('ddd-1'), 6),
        ...at('aaa', 'tst.infantry', cityOf('aaa-2')),
      ],
    }) as EngineState;
    // aaa réduite à une province : à forces égales selon l'estimation de ddd (elle ne « perd » pas).
    transferProvince(s, 'aaa-1', 'bbb');
    transferProvince(s, 'aaa-3', 'bbb');
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'ddd' }).ok).toBe(true);
    advanceTo(s, 2 * DAY);
    expect(D(s).proposals['aaa|ddd']).toBeUndefined();
    advanceTo(s, 5 * DAY);
    expect(D(s).proposals['aaa|ddd']).toMatchObject({ from: 'ddd', to: 'aaa', kind: 'peace' });
  });
});
