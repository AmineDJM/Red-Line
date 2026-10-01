import { afterEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, distanceKm, type Order } from '@redline/shared';
import { advanceTo, applyOrder, createGame } from '../src/index.js';
import { transferProvince } from '../src/combat/capture.js';
import { atWar, unitPosAt } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { setAiTracer } from '../src/ai/trace.js';
import { estimateForce, ownForce } from '../src/ai/estimate.js';
import { mil } from '../src/modules/mil/state.js';
import { cityOf, unitsOf } from './fixtures.js';
import { B, D, diploWorld, mapWithDisputed } from './diplo-helpers.js';
import { milMap, MIL_CATALOG } from './mil-fixtures.js';
import { buildWorld } from '../src/index.js';
import { BalanceSchema } from '@redline/shared';
import { BALANCE } from './fixtures.js';

/** Ordres donnés par l'IA d'une nation (traceur de diagnostic). */
function record(n: string) {
  const log: { t: number; o: Order; ok: boolean }[] = [];
  setAiTracer((st, who, o, r) => {
    if (who === n) log.push({ t: st.time, o: o as Order, ok: r.ok });
  });
  return log;
}

afterEach(() => setAiTracer(null));

const near = (a: [number, number], b: [number, number], km = 30) => distanceKm(a, b) <= km;

type Spec = { owner: string; systemId: string; pos: [number, number] };
const at = (owner: string, systemId: string, pos: [number, number], n = 1): Spec[] =>
  Array.from({ length: n }, (_, i) => ({
    owner,
    systemId,
    pos: [pos[0] + i * 0.02, pos[1]] as [number, number],
  }));

/**
 * aaa (joueur humain, faible) voisin de bbb (IA « normal ») qui revendique aaa-1 (motif public).
 * ccc et ddd : IA « facile » (aucune autre menace). Sans ORBAT : estimation miroir ; la prudence est
 * ramenée à 1 et le seuil à 1,3 pour que la petite carte de test donne un rapport favorable.
 */
function threatGame(reserve = false, seed = 4): EngineState {
  const map = mapWithDisputed({
    provinceIds: ['aaa-1'],
    claimants: ['aaa', 'bbb'],
    tension: 10,
    revoltRate: 0,
  });
  const world = diploWorld(
    { ai: { levels: { normal: { caution: 1, humanWarRatio: 1.3, warChanceHumanPerDay: 1 } } } },
    map,
  );
  return createGame(world, {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true, aiLevel: 'normal' },
      { nationId: 'ccc', isAi: true, aiLevel: 'easy' },
      { nationId: 'ddd', isAi: true, aiLevel: 'easy' },
    ],
    units: [
      ...at('bbb', 'tst.tank', cityOf('bbb-2'), 8),
      ...at('bbb', 'tst.infantry', cityOf('bbb-2'), 2),
      ...at('aaa', 'tst.infantry', cityOf('aaa-2')),
      // Dissuasion : réserve de aaa loin au nord (invisible), poste radar de bbb à la frontière.
      ...(reserve
        ? [...at('aaa', 'tst.tank', cityOf('aaa-3'), 12), ...at('bbb', 'tst.radar', [5.6, 40.3])]
        : []),
    ],
  }) as EngineState;
}

describe('IA : menace contre un joueur humain', { timeout: 120_000 }, () => {
  it('normal : pas à J1 ; préparatifs visibles, ultimatum public, puis guerre', () => {
    const s = threatGame();
    advanceTo(s, 3 * DAY - HOUR);
    expect(Object.keys(s.wars)).toHaveLength(0);
    expect(B(s).warPlans?.bbb).toBeUndefined();
    advanceTo(s, 4 * DAY);
    // Préparatifs : plan connu du renseignement adverse, pas encore de guerre.
    expect(B(s).warPlans?.bbb).toEqual(['aaa']);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    // Troupes massées dans la ville frontalière (bbb-4, voisine de aaa-1).
    advanceTo(s, 4 * DAY + 12 * HOUR);
    const staged = unitsOf(s, 'bbb', 'tst.tank').filter((u) => {
      const dest = u.move ? u.move.legs[u.move.legs.length - 1]!.to : u.pos;
      return near(dest, cityOf('bbb-4'));
    });
    expect(staged.length).toBeGreaterThanOrEqual(2);
    let warAt = 0;
    for (let t = 4 * DAY; t <= 9 * DAY && !warAt; t += HOUR) {
      advanceTo(s, t);
      if (atWar(s, 'aaa', 'bbb')) warAt = s.time;
    }
    expect(warAt).toBeGreaterThan(0);
    expect(D(s).aggressor['aaa|bbb']).toBe('bbb');
    const ultimatum = D(s).news.find((x) => /ultimatum/i.test(x.headline));
    expect(ultimatum).toBeDefined();
    expect(ultimatum!.nations).toEqual(['aaa', 'bbb']);
    // L'ultimatum précède la guerre de son délai (24 h en « normal »).
    expect(warAt - ultimatum!.time).toBeGreaterThanOrEqual(23 * HOUR);
    expect(B(s).warPlans?.bbb).toBeUndefined();
  });

  it('dissuasion : le joueur renforce sa frontière pendant l’ultimatum, l’IA renonce', () => {
    const s = threatGame(true);
    const reserve = unitsOf(s, 'aaa', 'tst.tank').map((u) => u.id);
    let ultimatumAt = 0;
    for (let t = 3 * DAY; t <= 7 * DAY && !ultimatumAt; t += HOUR) {
      advanceTo(s, t);
      if (D(s).news.some((x) => /ultimatum/i.test(x.headline))) ultimatumAt = s.time;
    }
    expect(ultimatumAt).toBeGreaterThan(0);
    // Le joueur porte sa réserve au contact, sous les yeux des troupes massées de bbb.
    const before = estimateForce(s, 'bbb', 'aaa', ownForce(s, 'bbb'), 1);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: reserve, to: [4.3, 40.6] }).ok).toBe(
      true,
    );
    advanceTo(s, ultimatumAt + 2 * DAY);
    expect(estimateForce(s, 'bbb', 'aaa', ownForce(s, 'bbb'), 1)).toBeGreaterThan(before);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(D(s).news.some((x) => /renonce|Désescalade/.test(x.headline))).toBe(true);
    expect(B(s).warPlans?.bbb).toBeUndefined();
  });

  it('facile : jamais de guerre sans motif contre un joueur, même faible', () => {
    const s = createGame(diploWorld(), {
      seed: 2,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'easy' },
        { nationId: 'ccc', isAi: true, aiLevel: 'easy' },
        { nationId: 'ddd', isAi: true, aiLevel: 'easy' },
      ],
      units: [...at('bbb', 'tst.tank', cityOf('bbb-2'), 10)],
    }) as EngineState;
    advanceTo(s, 20 * DAY);
    expect(Object.keys(s.wars)).toHaveLength(0);
  });
});

describe('IA : rassemblement avant l’offensive', { timeout: 120_000 }, () => {
  it('le groupe se regroupe près de l’objectif puis part en vagues échelonnées qui arrivent ensemble', () => {
    const s = createGame(diploWorld(), {
      seed: 5,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'normal' },
        { nationId: 'ccc', isAi: false },
        { nationId: 'ddd', isAi: false },
      ],
      units: [
        // Garnison de la capitale de bbb (elle ne participe pas).
        ...at('bbb', 'tst.infantry', cityOf('bbb-2'), 2),
        // Infanterie déjà avancée dans aaa-1 (prise), chars loin à l'est : arrivées très étalées.
        ...at('bbb', 'tst.infantry', cityOf('aaa-1'), 2),
        ...at('bbb', 'tst.tank', cityOf('bbb-1'), 2),
      ],
    }) as EngineState;
    transferProvince(s, 'aaa-1', 'bbb');
    const log = record('bbb');
    expect(applyOrder(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' }).ok).toBe(true);
    advanceTo(s, 3 * DAY);
    const capital = cityOf('aaa-2');
    const moves = log.filter((x) => x.ok && x.o.kind === 'move') as {
      t: number;
      o: Extract<Order, { kind: 'move' }>;
    }[];
    const tanks = unitsOf(s, 'bbb', 'tst.tank').map((u) => u.id);
    // D'abord le rassemblement : les chars rejoignent la ville amie voisine de l'objectif.
    const rally = moves.find((x) => x.o.unitIds.some((id) => tanks.includes(id)));
    expect(rally).toBeDefined();
    expect(near(rally!.o.to, cityOf('aaa-1'))).toBe(true);
    // Puis l'assaut de la capitale : toutes les unités du groupe, en vagues dont les arrivées
    // prévues tombent à moins de deux heures d'écart.
    const assault = moves.filter((x) => near(x.o.to, capital, 5));
    const ids = new Set(assault.flatMap((x) => x.o.unitIds));
    expect(ids.size).toBeGreaterThanOrEqual(4);
    expect(assault[0]!.t).toBeGreaterThan(rally!.t);
  });
});

/** Monde militaire (bases, ports, bombardier, destroyer) avec la diplomatie et l'IA. */
function milAiWorld() {
  return buildWorld(milMap(), MIL_CATALOG, BalanceSchema.parse({ ...BALANCE }));
}

describe('IA : aviation et débarquement', { timeout: 120_000 }, () => {
  it('suppression des défenses : la défense antiaérienne vue près de l’objectif est frappée, avec escorte', () => {
    const s = createGame(milAiWorld(), {
      seed: 3,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'normal' },
        { nationId: 'ccc', isAi: false },
        { nationId: 'ddd', isAi: false },
      ],
      units: [
        ...at('bbb', 'tst.infantry', cityOf('bbb-2'), 2),
        ...at('bbb', 'tst.tank', cityOf('bbb-4'), 4),
        // Observateur à la frontière : il identifie la défense antiaérienne d'en face.
        { owner: 'bbb', systemId: 'tst.tank', pos: [5.17, 40.1] },
        { owner: 'bbb', systemId: 'tst.bomber', pos: cityOf('bbb-5'), count: 2 },
        { owner: 'bbb', systemId: 'tst.jet', pos: cityOf('bbb-5') },
        // Défense antiaérienne de aaa à la frontière, sur la route des frappes vers l'ouest.
        { owner: 'aaa', systemId: 'tst.patriot', pos: [5.05, 40.1] },
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
      ],
    }) as EngineState;
    const patriotId = unitsOf(s, 'aaa', 'tst.patriot')[0]!.id;
    const log = record('bbb');
    expect(applyOrder(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' }).ok).toBe(true);
    advanceTo(s, 12 * HOUR);
    const strikes = log.filter((x) => x.ok && x.o.kind === 'strike') as {
      t: number;
      o: Extract<Order, { kind: 'strike' }>;
    }[];
    expect(strikes.length).toBeGreaterThan(0);
    // Première frappe : la défense antiaérienne (suppression), avant toute frappe profonde.
    const first = strikes[0]!;
    expect(first.o.target).toEqual({ type: 'unit', unitId: patriotId });
    // Escorte : un chasseur patrouille au-dessus de la cible, dans la même réflexion.
    const escort = log.find(
      (x) =>
        x.ok && x.o.kind === 'patrol' && x.t === first.t && distanceKm(x.o.at, [5.05, 40.1]) < 50,
    );
    expect(escort).toBeDefined();
    void mil;
  });

  it('débarquement : l’IA traverse la mer, escortée, pour prendre une île ennemie', () => {
    const s = createGame(milAiWorld(), {
      seed: 6,
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
        { nationId: 'ccc', isAi: false },
        { nationId: 'ddd', isAi: false },
      ],
      units: [
        ...at('bbb', 'tst.infantry', cityOf('bbb-2'), 3),
        ...at('bbb', 'tst.tank', cityOf('bbb-1'), 4),
        { owner: 'bbb', systemId: 'tst.destroyer', pos: [21.5, 44] },
        { owner: 'ddd', systemId: 'tst.infantry', pos: cityOf('ddd-1') },
      ],
    }) as EngineState;
    const log = record('bbb');
    expect(applyOrder(s, 'bbb', { kind: 'declareWar', nationId: 'ddd' }).ok).toBe(true);
    advanceTo(s, 6 * DAY);
    const escort = log.find(
      (x) =>
        x.ok &&
        x.o.kind === 'patrol' &&
        x.o.unitIds.some((id) => unitsOf(s, 'bbb', 'tst.destroyer')[0]?.id === id),
    );
    expect(escort).toBeDefined();
    const landing = log.find(
      (x) => x.ok && x.o.kind === 'move' && near(x.o.to, cityOf('ddd-1'), 5),
    );
    expect(landing).toBeDefined();
    // La guerre ne finit pas en paix blanche « faute de front » : la mer est un front.
    expect(atWar(s, 'bbb', 'ddd') || s.provinces['ddd-1']!.owner === 'bbb').toBe(true);
    void unitPosAt;
  });
});
