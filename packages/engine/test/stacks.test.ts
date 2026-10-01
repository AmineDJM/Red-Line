import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, HOUR, distanceKm, type LngLat } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import { roundDamage } from '../src/combat/combat.js';
import { breakdown } from '../src/modules/eco/budget.js';
import { sysOf } from '../src/state/access.js';
import { partsOf } from '../src/state/stack.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { ECO_BALANCE, ORBATS, ecoGame, ecoWorldWith } from './eco-fixtures.js';
import { cityOf } from './fixtures.js';
import { milSandbox, milWorld } from './mil-fixtures.js';

/** Loin des villes (pas de bonus de ville), en territoire aaa. */
const P: LngLat = [1.0, 39.0];
const NEAR: LngLat = [1.02, 39.0]; // ≈ 1,7 km

const own = (s: EngineState, n: string): Unit[] =>
  Object.values(s.units)
    .filter((u) => u.owner === n)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** Éléments par système d'une nation (piles mixtes comprises). */
function elements(s: EngineState, n: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of own(s, n))
    for (const p of partsOf(s, u)) out[p.sys.id] = (out[p.sys.id] ?? 0) + p.c;
  return out;
}

/** Pile mixte infanterie (6) + chars (4) fusionnée par ordre, et les mêmes éléments séparés. */
function brigade() {
  const s = milSandbox([
    { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 }, // u1
    { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 }, // u2
    { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 }, // u3 (référence séparée)
    { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 }, // u4 (référence séparée)
    { owner: 'bbb', systemId: 'tst.tank', pos: NEAR, count: 5 }, // u5 : cible blindée
    { owner: 'bbb', systemId: 'tst.infantry', pos: NEAR, count: 9 }, // u6 : cible d'infanterie
  ]);
  expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
  return s;
}

describe('piles mixtes : équivalence avec la somme des éléments', () => {
  it('fusion de matériels différents : effectifs, PV, fiche synthétique', () => {
    const s = brigade();
    const b = s.units.u1!;
    expect(s.units.u2).toBeUndefined();
    expect(b.mix).toEqual([
      { sys: 'tst.infantry', c: 6, m: 60 },
      { sys: 'tst.tank', c: 4, m: 120 },
    ]);
    expect(b.sys).toBe('tst.tank'); // matériel principal : le plus de PV
    expect(b.count).toBe(10);
    expect(b.maxHp).toBe(180);
    expect(b.hp).toBe(180);
    const sys = sysOf(s, b);
    expect(sys.speedKmh).toBe(30); // le plus lent
    expect(sys.detectionRangeKm).toBe(25); // le meilleur capteur
    expect(sys.weaponRangeKm).toEqual({ min: 0, max: 4 });
    expect(sys.canCapture).toBe(true);
    // Moyenne × effectif = somme des éléments.
    expect(sys.damage.armor * b.count).toBeCloseTo(6 * 1 + 4 * 8, 9);
    expect(sys.upkeepPerDay * b.count).toBeCloseTo(10 * 5, 9);
    expect(sys.hp * b.count).toBeCloseTo(180, 9);
    const v = viewFor(s, 'aaa').units.u1!;
    expect(v.parts).toEqual([
      { systemId: 'tst.infantry', count: 6 },
      { systemId: 'tst.tank', count: 4 },
    ]);
    expect(v.systemId).toBe('tst.tank');
  });

  it('dégâts infligés = somme des dégâts des éléments séparés', () => {
    const s = brigade();
    const [stack, inf, tank, tgtArmor, tgtInf] = ['u1', 'u3', 'u4', 'u5', 'u6'].map(
      (id) => s.units[id]!,
    );
    for (const tgt of [tgtArmor!, tgtInf!]) {
      const sum = roundDamage(s, inf!, tgt, 1) + roundDamage(s, tank!, tgt, 1);
      expect(roundDamage(s, stack!, tgt, 1)).toBeCloseTo(sum, 9);
    }
  });

  it('dégâts reçus = moyenne pondérée par les PV des dégâts contre chaque élément', () => {
    const s = brigade();
    const stack = s.units.u1!;
    const att = s.units.u5!; // chars bbb
    const w = { inf: 60 / 180, tank: 120 / 180 };
    const expected =
      w.inf * roundDamage(s, att, s.units.u3!, 1) + w.tank * roundDamage(s, att, s.units.u4!, 1);
    expect(roundDamage(s, att, stack, 1)).toBeCloseTo(expected, 9);
  });

  it('portée par matériel : seuls les éléments à portée tirent', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 }, // u1 : portée 3 km
      { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 4 }, // u2 : 5 à 40 km
      { owner: 'bbb', systemId: 'tst.tank', pos: [1.2, 39.0], count: 5 }, // u3 : ≈ 17 km
    ]);
    const art = roundDamage(s, s.units.u2!, s.units.u3!, 1);
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
    expect(roundDamage(s, s.units.u1!, s.units.u3!, 1)).toBeCloseTo(art, 9);
  });

  it('combat réel : pertes réparties entre matériels, effectif cohérent', () => {
    const s = brigade();
    // Les références séparées s'écartent : seule la pile combat.
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u3', 'u4'], to: [3, 39.5] }).ok).toBe(
      true,
    );
    applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    // Jusqu'à des pertes nettes (la pile n'est pas encore détruite).
    for (let t = 10 * 60_000; t <= 3 * HOUR; t += 10 * 60_000) {
      advanceTo(s, t);
      const u = s.units.u1;
      if (!u || u.hp / u.maxHp < 0.7) break;
    }
    const b = s.units.u1;
    expect(b).toBeDefined();
    expect(b!.hp).toBeLessThan(b!.maxHp);
    const mix = b!.mix!;
    expect(mix.reduce((a, p) => a + p.c, 0)).toBe(b!.count);
    // Santé uniforme : chaque matériel garde ceil(santé × effectif d'origine) éléments.
    const r = b!.hp / b!.maxHp;
    for (const p of mix) {
      const hp = p.sys === 'tst.tank' ? 30 : 10;
      expect(p.c).toBe(Math.ceil((r * p.m) / hp - 1e-9));
    }
    expect(s.units.u5 === undefined || s.units.u5.hp < s.units.u5.maxHp).toBe(true);
  });

  it('entretien journalier = somme des entretiens des éléments', () => {
    const s = ecoGame({
      world: ecoWorldWith(BalanceSchema.parse({ ...ECO_BALANCE, stacks: {} })),
    });
    const before = breakdown(s, 'aaa').upkeepTotal;
    const land = own(s, 'aaa').filter((u) => sysOf(s, u).movement === 'land' && u.mix);
    expect(land.length).toBeGreaterThan(0);
    // Séparer toutes les piles par matériel ne change pas l'entretien.
    for (const u of land)
      expect(applyOrder(s, 'aaa', { kind: 'split', unitId: u.id, mode: 'type' }).ok).toBe(true);
    expect(own(s, 'aaa').every((u) => !u.mix || sysOf(s, u).movement !== 'land')).toBe(true);
    expect(breakdown(s, 'aaa').upkeepTotal).toBeCloseTo(before, 6);
  });
});

describe('ordres de piles : split et merge', () => {
  it('diviser en deux, détacher N, détacher par matériel, séparer par type ; PV conservés', () => {
    const s = brigade();
    const b = s.units.u1!;
    b.hp = 135; // 75 %
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: 'u1', mode: 'half' }).ok).toBe(true);
    const half = own(s, 'aaa').find((u) => !['u1', 'u3', 'u4'].includes(u.id))!;
    expect(half.count + s.units.u1!.count).toBe(10);
    expect(half.count).toBe(5);
    expect(half.hp + s.units.u1!.hp).toBeCloseTo(135, 9);
    expect(half.hp / half.maxHp).toBeCloseTo(0.75, 9);
    expect(half.mix!.map((p) => p.c)).toEqual([3, 2]);
    // Détacher des éléments précis : 2 chars de la moitié restante.
    expect(
      applyOrder(s, 'aaa', {
        kind: 'split',
        unitId: 'u1',
        parts: [{ systemId: 'tst.tank', count: 2 }],
      }).ok,
    ).toBe(true);
    expect(s.units.u1!.mix).toBeUndefined(); // il ne reste que l'infanterie
    expect(s.units.u1!.sys).toBe('tst.infantry');
    expect(s.units.u1!.count).toBe(3);
    // Détacher N éléments d'une pile mixte : au prorata.
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: half.id, count: 1 }).ok).toBe(true);
    expect(half.count).toBe(4);
    // Séparer par type.
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: half.id, mode: 'type' }).ok).toBe(true);
    expect(half.mix).toBeUndefined();
    const total = own(s, 'aaa').reduce((a, u) => a + u.hp, 0);
    expect(total).toBeCloseTo(135 + 60 + 120, 6);
    expect(elements(s, 'aaa')).toEqual({ 'tst.infantry': 12, 'tst.tank': 8 });
  });

  it('refus : effectif, matériel absent, un seul matériel, modes combinés', () => {
    const s = brigade();
    const split = (o: object) =>
      applyOrder(s, 'aaa', { kind: 'split', unitId: 'u1', ...o } as never).error;
    expect(split({ count: 10 })).toBe('invalid_target');
    expect(split({ parts: [{ systemId: 'tst.helo', count: 1 }] })).toBe('invalid_target');
    expect(split({ parts: [{ systemId: 'tst.tank', count: 5 }] })).toBe('invalid_target');
    expect(split({})).toBe('invalid_target');
    expect(split({ count: 1, mode: 'half' })).toBe('invalid_target');
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: 'u3', mode: 'type' }).error).toBe(
      'invalid_target',
    );
    expect(applyOrder(s, 'bbb', { kind: 'split', unitId: 'u1', mode: 'half' }).error).toBe(
      'not_owner',
    );
  });

  it('fusion refusée : domaines différents, munitions, distance, mouvement', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 2 }, // u1
      { owner: 'aaa', systemId: 'tst.fighter', pos: P, count: 2 }, // u2
      { owner: 'aaa', systemId: 'tst.cruise', pos: P, count: 2 }, // u3 : munitions
      { owner: 'aaa', systemId: 'tst.infantry', pos: [1.5, 39], count: 2 }, // u4 : ≈ 43 km
      { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 2 }, // u5
      { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 2 }, // u6
    ]);
    const merge = (ids: string[]) => applyOrder(s, 'aaa', { kind: 'merge', unitIds: ids }).error;
    expect(merge(['u1', 'u2'])).toBe('invalid_target');
    expect(merge(['u1', 'u3'])).toBe('invalid_target');
    expect(merge(['u1', 'u4'])).toBe('out_of_range');
    expect(merge(['u1'])).toBe('invalid_target');
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u6'], to: [2, 39] }).ok).toBe(true);
    expect(merge(['u1', 'u6'])).toBe('not_allowed');
    // Infanterie + chars : même classe (terrestre).
    expect(merge(['u1', 'u5'])).toBeUndefined();
  });

  it('rejeu : mêmes ordres ⇒ même empreinte ; reprise après sérialisation identique', () => {
    const play = (s: EngineState, until: number) => {
      const script: [number, () => void][] = [
        [HOUR, () => void applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] })],
        [2 * HOUR, () => void applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' })],
        [3 * HOUR, () => void applyOrder(s, 'aaa', { kind: 'split', unitId: 'u1', mode: 'half' })],
        [
          4 * HOUR,
          () => void applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('bbb-4') }),
        ],
      ];
      for (const [t, f] of script) {
        if (t <= s.time || t > until) continue;
        advanceTo(s, t);
        f();
      }
      advanceTo(s, until);
    };
    const setup = () =>
      milSandbox([
        { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 },
        { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 },
        { owner: 'bbb', systemId: 'tst.tank', pos: [1.3, 39.0], count: 3 },
      ]);
    const a = setup();
    const b = setup();
    play(a, DAY);
    play(b, DAY);
    expect(stateHash(a)).toBe(stateHash(b));
    // Reprise au milieu (pile mixte en mémoire) : même état final.
    const c = setup();
    play(c, 3 * HOUR + 30 * 60_000);
    expect(c.units.u1!.mix).toBeDefined();
    const r = deserializeState(milWorld(), serializeState(c)) as EngineState;
    expect(stateHash(r)).toBe(stateHash(c));
    expect(viewFor(r, 'aaa')).toEqual(viewFor(c, 'aaa'));
    play(r, DAY);
    expect(stateHash(r)).toBe(stateHash(a));
  });

  it('migration : une sauvegarde sans piles mixtes se recharge et accepte split / merge', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 },
      { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 },
    ]);
    const bytes = serializeState(s);
    const r = deserializeState(milWorld(), bytes) as EngineState;
    expect(Object.values(r.units).every((u) => u.mix === undefined)).toBe(true);
    expect(applyOrder(r, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
    expect(applyOrder(r, 'aaa', { kind: 'split', unitId: 'u1', count: 2 }).ok).toBe(true);
    expect(elements(r, 'aaa')).toEqual({ 'tst.infantry': 6, 'tst.tank': 4 });
  });
});

describe('regroupement des forces de départ', () => {
  const grouped = () => ecoWorldWith(BalanceSchema.parse({ ...ECO_BALANCE, stacks: {} }));

  it('ORBAT : moins de piles, éléments exacts par système, déterministe', () => {
    const flat = ecoGame();
    const s = ecoGame({ world: grouped() });
    expect(own(s, 'aaa').length).toBeLessThan(own(flat, 'aaa').length);
    expect(own(s, 'aaa').some((u) => u.mix)).toBe(true);
    for (const n of ['aaa', 'bbb', 'ddd']) expect(elements(s, n)).toEqual(elements(flat, n));
    const inv = ORBATS[0]!.inventory.filter((i) => i.systemId !== 'xx.absent');
    for (const it of inv) expect(elements(s, 'aaa')[it.systemId]).toBe(it.count);
    // Infanterie et chars ensemble ; défense aérienne et navires à part.
    const land = own(s, 'aaa').filter((u) => u.mix?.some((p) => p.sys === 'tst.infantry'));
    expect(land.length).toBeGreaterThan(0);
    for (const u of land) expect(u.mix!.map((p) => p.sys)).toEqual(['tst.infantry', 'tst.tank']);
    // La première brigade tient la capitale (aaa-2).
    expect(land.some((u) => distanceKm(u.pos, cityOf('aaa-2')) < 10)).toBe(true);
    const again = ecoGame({ world: grouped() });
    expect(stateHash(again)).toBe(stateHash(s));
  });

  it('armée de repli (sans ORBAT) : une pile mixte par groupe, mêmes éléments', () => {
    const flat = ecoGame();
    const s = ecoGame({ world: grouped() });
    expect(elements(s, 'ccc')).toEqual(elements(flat, 'ccc'));
    expect(own(s, 'ccc').length).toBeLessThan(own(flat, 'ccc').length);
  });

  it('regroupement désactivé : piles d’un seul matériel (comportement d’origine)', () => {
    const s = createGame(ecoWorldWith(), {
      seed: 1,
      players: [{ nationId: 'aaa', isAi: false }],
    }) as EngineState;
    expect(Object.values(s.units).every((u) => !u.mix)).toBe(true);
  });
});
