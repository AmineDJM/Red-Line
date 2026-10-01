import { describe, expect, it } from 'vitest';
import { DAY, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { modifier } from '../src/modules/registry.js';
import { declareWar } from '../src/state/war.js';
import { eco } from '../src/modules/eco/state.js';
import { B, D, game, ok } from './diplo-helpers.js';
import { ecoGame } from './eco-fixtures.js';

const policy = (p: Extract<Order, { kind: 'domesticPolicy' }>['policy'], on = true): Order => ({
  kind: 'domesticPolicy',
  policy: p,
  on,
});

describe('gestion intérieure : politiques', () => {
  it('activation, effets chiffrés sur les modificateurs, délai, exclusions', () => {
    const s = game();
    expect(modifier(s, 'aaa', 'income.money')).toBe(1);
    ok(s, 'aaa', policy('war_economy'));
    expect(modifier(s, 'aaa', 'production.speed')).toBeCloseTo(1.25);
    expect(modifier(s, 'aaa', 'income.money')).toBeCloseTo(0.95);
    expect(modifier(s, 'bbb', 'production.speed')).toBe(1);
    ok(s, 'aaa', policy('conscription'));
    expect(modifier(s, 'aaa', 'production.speed.infantry')).toBeCloseTo(1.5);
    expect(modifier(s, 'aaa', 'upkeep')).toBeCloseTo(0.95);
    expect(modifier(s, 'aaa', 'income.money')).toBeCloseTo(0.95 * 0.95);
    // Déjà active / délai minimal avant de la suspendre.
    expect(applyOrder(s, 'aaa', policy('war_economy')).ok).toBe(false);
    expect(applyOrder(s, 'aaa', policy('war_economy', false)).error).toBe('cooldown');
    advanceTo(s, 2 * DAY + 1);
    ok(s, 'aaa', policy('war_economy', false));
    expect(modifier(s, 'aaa', 'production.speed')).toBe(1);
    // Austérité et relance s'excluent.
    ok(s, 'aaa', policy('austerity'));
    expect(modifier(s, 'aaa', 'upkeep')).toBeCloseTo(0.95 * 0.9);
    ok(s, 'aaa', policy('stimulus'));
    const v = viewFor(s, 'aaa').domestic!;
    expect(v.policies.filter((p) => p.active).map((p) => p.id)).toEqual([
      'conscription',
      'stimulus',
    ]);
    expect(v.policies.find((p) => p.id === 'austerity')!.changeableAt).toBe(s.time + 2 * DAY);
    expect(v.totals.income).toBeCloseTo(0.95 * 0.9, 1);
    expect(modifier(s, 'aaa', 'upkeep')).toBeCloseTo(0.95);
  });

  it('stabilité par jour (loi martiale +, effort de guerre −) et risque de troubles', () => {
    const s = game();
    const f0 = modifier(s, 'aaa', 'unrest.risk');
    ok(s, 'aaa', policy('martial_law'));
    ok(s, 'bbb', policy('war_economy'));
    B(s).stability.aaa = 40;
    B(s).stability.bbb = 70;
    advanceTo(s, DAY + 1);
    // Loi martiale : +1,2/jour (plus le retour au calme) ; effort de guerre : −0,6/jour.
    expect(B(s).stability.aaa!).toBeGreaterThanOrEqual(41.2);
    expect(B(s).stability.bbb!).toBeCloseTo(69.4, 1);
    expect(viewFor(s, 'bbb').stability!.factors).toContainEqual({
      label: 'Politiques intérieures',
      delta: expect.any(Number),
    });
    expect(modifier(s, 'aaa', 'unrest.risk')).toBeCloseTo(f0 * 0.4, 5);
  });

  it('moral visé décalé par les politiques (économie réelle) et moyenne publiée', () => {
    const s = ecoGame();
    ok(s, 'aaa', { kind: 'domesticPolicy', policy: 'martial_law', on: true });
    expect(B(s).moraleShift).toEqual({ aaa: -10 });
    advanceTo(s, 6 * DAY + 1);
    const m = eco(s).morale;
    const own = Object.keys(s.provinces).filter((p) => s.provinces[p]!.owner === 'aaa');
    // Le moral descend de 2 points par jour vers 70 − 10.
    for (const p of own) expect(m[p]).toBeCloseTo(60, 5);
    expect(B(s).moraleAvg!.aaa).toBeCloseTo(60, 5);
    expect(B(s).moraleAvg!.bbb).toBeUndefined();
    expect(viewFor(s, 'aaa').domestic!.morale).toBeCloseTo(60, 5);
  });
});

describe('gestion intérieure : soutien à la guerre', () => {
  it('agresseur et agressé, pertes, lassitude de guerre selon le soutien', () => {
    const s = game();
    declareWar(s, 'aaa', 'bbb');
    expect(D(s).aggressor['aaa|bbb']).toBe('aaa');
    advanceTo(s, 3 * DAY + 1);
    const va = viewFor(s, 'aaa').domestic!;
    const vb = viewFor(s, 'bbb').domestic!;
    expect(va.warSupportTarget).toBe(50);
    expect(vb.warSupportTarget).toBe(75);
    expect(va.warSupport).toBe(54);
    expect(vb.warSupport).toBe(66);
    // Propagande : soutien visé + 15.
    ok(s, 'aaa', policy('propaganda'));
    expect(viewFor(s, 'aaa').domestic!.warSupportTarget).toBe(65);
    // Soutien effondré : lassitude de guerre doublée.
    D(s).dom!.aaa!.ws = 20;
    expect(viewFor(s, 'aaa').domestic!.wearinessFactor).toBe(2);
    D(s).dom!.aaa!.ws = 90;
    expect(viewFor(s, 'aaa').domestic!.wearinessFactor).toBeCloseTo(0.6);
  });
});

describe('gestion intérieure : événements', () => {
  it('stabilité et moral bas : manifestations, émeutes, grèves ; déterministes', () => {
    const run = () => {
      const s = game({ seed: 5 });
      for (let d = 0; d < 30; d++) {
        B(s).stability.aaa = 18;
        (B(s).moraleAvg ??= {}).aaa = 20;
        advanceTo(s, (d + 1) * DAY + 1);
      }
      return s;
    };
    const s = run();
    const v = viewFor(s, 'aaa').domestic!;
    const kinds = new Set(v.events.map((e) => e.kind));
    expect(kinds.has('riot') || kinds.has('protest')).toBe(true);
    expect(kinds.has('strike')).toBe(true);
    expect(v.events[0]!.time).toBeGreaterThanOrEqual(v.events.at(-1)!.time);
    expect(v.events.every((e) => e.title && e.text)).toBe(true);
    // Une nation calme n'a aucun événement.
    expect(viewFor(s, 'bbb').domestic!.events).toEqual([]);
    expect(stateHash(run())).toBe(stateHash(s));
  });

  it('grève : production ralentie pendant la durée prévue', () => {
    const s = game();
    ok(s, 'aaa', policy('austerity'));
    D(s).dom!.aaa!.strike = s.time + 48 * 3_600_000;
    expect(modifier(s, 'aaa', 'production.speed')).toBeCloseTo(0.8);
    expect(viewFor(s, 'aaa').domestic!.strikeUntil).toBe(s.time + 48 * 3_600_000);
    advanceTo(s, 3 * DAY);
    expect(modifier(s, 'aaa', 'production.speed')).toBe(1);
  });

  it('risque par province : agitation, occupation, classement', () => {
    const s = game();
    D(s).unrest['aaa-3'] = 40;
    const v = viewFor(s, 'aaa').domestic!;
    expect(v.provinces[0]).toMatchObject({ id: 'aaa-3', unrest: 40 });
    expect(v.provinces[0]!.risk).toBeGreaterThan(v.provinces[1]!.risk);
    expect(v.unrestRisk).toBeGreaterThan(0);
  });
});

describe('gestion intérieure : sauvegarde et rejeu', () => {
  it('sérialisation, ancienne sauvegarde sans section, rejeu des ordres', () => {
    const orders: [number, string, Order][] = [
      [0, 'aaa', policy('propaganda')],
      [DAY, 'bbb', policy('martial_law')],
      [2 * DAY, 'aaa', policy('conscription')],
      [5 * DAY, 'bbb', policy('martial_law', false)],
    ];
    const play = (): EngineState => {
      const s = game({ seed: 11 });
      for (const [t, n, o] of orders) {
        advanceTo(s, t);
        ok(s, n, o);
      }
      advanceTo(s, 8 * DAY);
      return s;
    };
    const a = play();
    const b = play();
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(a.world, serializeState(a)) as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    expect(viewFor(c, 'aaa').domestic).toEqual(viewFor(a, 'aaa').domestic);
    advanceTo(a, 12 * DAY);
    advanceTo(c, 12 * DAY);
    expect(stateHash(c)).toBe(stateHash(a));

    // Sauvegarde antérieure : aucune section intérieure, valeurs par défaut.
    const old = game({ seed: 11 });
    delete D(old).dom;
    const r = deserializeState(old.world, serializeState(old)) as EngineState;
    const v = viewFor(r, 'aaa').domestic!;
    expect(v.policies.every((p) => !p.active)).toBe(true);
    expect(v.warSupport).toBe(60);
    ok(r, 'aaa', policy('stimulus'));
    expect(modifier(r, 'aaa', 'income.money')).toBeCloseTo(0.9);
  });

  it('IA : effort de guerre en guerre, levé à la paix', () => {
    const s = game({
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'ccc', isAi: true },
      ],
    });
    s.nations.ccc!.active = true;
    declareWar(s, 'aaa', 'ccc');
    advanceTo(s, DAY + 1);
    expect(viewFor(s, 'ccc').domestic!.policies.find((p) => p.id === 'war_economy')!.active).toBe(
      true,
    );
  });
});
