import { describe, expect, it } from 'vitest';
import { HOUR } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { destroyUnit } from '../src/combat/combat.js';
import { board } from '../src/modules/kit.js';
import { MODULES, signal } from '../src/modules/registry.js';
import type { EngineModule } from '../src/modules/types.js';
import { atWar } from '../src/state/access.js';
import { ecoGame } from './eco-fixtures.js';
import { unitsOf } from './fixtures.js';

describe('marché entre joueurs et livraisons', () => {
  it('offre de ressources : séquestre, achat, convoi sur la carte, arrivée', () => {
    const s = ecoGame();
    const oil0 = s.nations.aaa!.res.oil;
    expect(
      applyOrder(s, 'aaa', {
        kind: 'sellOffer',
        item: { type: 'resource', resource: 'oil', qty: 50 },
        price: 5e6,
        to: null,
      }).ok,
    ).toBe(true);
    expect(s.nations.aaa!.res.oil).toBe(oil0 - 50);
    const offer = viewFor(s, 'bbb').market!.offers[0]!;
    expect(offer).toMatchObject({ seller: 'aaa', price: 5e6 });
    const aaaM = s.nations.aaa!.money;
    const bbbM = s.nations.bbb!.money;
    const bbbOil = s.nations.bbb!.res.oil;
    expect(applyOrder(s, 'bbb', { kind: 'acceptOffer', offerId: offer.id }).ok).toBe(true);
    expect(viewFor(s, 'bbb').economy.detail!.today.marketPurchases).toBe(-5e6);
    expect(viewFor(s, 'aaa').economy.detail!.today.marketSales).toBe(5e6);
    expect(s.nations.aaa!.money).toBe(aaaM + 5e6);
    expect(s.nations.bbb!.money).toBe(bbbM - 5e6);
    const d = viewFor(s, 'bbb').market!.deliveries[0]!;
    expect(d.carrierUnitId).not.toBeNull();
    const carrier = s.units[d.carrierUnitId!]!;
    expect(carrier.sys).toBe('other.supply-convoy');
    expect(s.nations.bbb!.res.oil).toBe(bbbOil);
    // Le convoi traverse ccc sans déclencher de guerre.
    advanceTo(s, (d.eta + s.time) / 2);
    expect(atWar(s, 'aaa', 'ccc')).toBe(false);
    advanceTo(s, d.eta - 1);
    const before = s.nations.bbb!.res.oil;
    const notes = advanceTo(s, d.eta);
    expect(notes.some((n) => n.kind === 'delivery' && n.outcome === 'arrived')).toBe(true);
    expect(s.nations.bbb!.res.oil).toBeCloseTo(before + 50, 9);
    expect(s.units[d.carrierUnitId!]).toBeUndefined();
  });

  it('livraison interceptée : porteur détruit ⇒ livraison perdue', () => {
    const s = ecoGame();
    applyOrder(s, 'aaa', {
      kind: 'transfer',
      to: 'bbb',
      item: { type: 'units', systemId: 'tst.tank', count: 10 },
      covert: false,
    });
    expect(unitsOf(s, 'aaa', 'tst.tank').reduce((a, u) => a + u.count, 0)).toBe(120);
    const d = viewFor(s, 'bbb').market!.deliveries[0]!;
    const notes0 = advanceTo(s, s.time + HOUR);
    expect(notes0.some((n) => n.kind === 'delivery')).toBe(false);
    destroyUnit(s, s.units[d.carrierUnitId!]!, null);
    const notes = advanceTo(s, d.eta + HOUR);
    expect(notes.some((n) => n.kind === 'delivery' && n.outcome === 'intercepted')).toBe(true);
    expect(viewFor(s, 'bbb').market!.deliveries).toHaveLength(0);
    expect(unitsOf(s, 'bbb', 'tst.tank')).toHaveLength(0);
  });

  it('signal delivery_intercepted (émis par mil) : livraison saisie', () => {
    const s = ecoGame();
    applyOrder(s, 'aaa', {
      kind: 'transfer',
      to: 'bbb',
      item: { type: 'resource', resource: 'metals', qty: 20 },
      covert: false,
    });
    const d = viewFor(s, 'bbb').market!.deliveries[0]!;
    signal(s, 'delivery_intercepted', { deliveryId: d.id, by: 'ccc' });
    expect(s.units[d.carrierUnitId!]).toBeUndefined();
    expect(viewFor(s, 'bbb').market!.deliveries).toHaveLength(0);
  });

  it('transfert d’unités : arrivée chez le destinataire ; embargo sauf transfert discret', () => {
    const s = ecoGame();
    board(s).embargoed.bbb = true;
    const order = {
      kind: 'transfer',
      to: 'bbb',
      item: { type: 'units', systemId: 'tst.tank', count: 5 },
      covert: false,
    } as const;
    expect(applyOrder(s, 'aaa', order)).toMatchObject({ ok: false, error: 'locked' });
    expect(applyOrder(s, 'aaa', { ...order, covert: true }).ok).toBe(true);
    const d = viewFor(s, 'bbb').market!.deliveries[0]!;
    expect(d.covert).toBe(true);
    advanceTo(s, d.eta);
    expect(unitsOf(s, 'bbb', 'tst.tank').reduce((a, u) => a + u.count, 0)).toBe(5);
  });

  it('argent et licences : transferts immédiats ; offre annulée ou expirée : séquestre rendu', () => {
    const s = ecoGame();
    const m0 = s.nations.ddd!.money;
    applyOrder(s, 'aaa', {
      kind: 'transfer',
      to: 'ddd',
      item: { type: 'money', amount: 1e8 },
      covert: false,
    });
    expect(s.nations.ddd!.money).toBe(m0 + 1e8);
    applyOrder(s, 'aaa', {
      kind: 'transfer',
      to: 'ddd',
      item: { type: 'licence', systemId: 'us.f-16' },
      covert: false,
    });
    expect(viewFor(s, 'ddd').licences!.map((l) => l.systemId)).toEqual(['us.f-16']);

    const oil0 = s.nations.aaa!.res.oil;
    applyOrder(s, 'aaa', {
      kind: 'sellOffer',
      item: { type: 'resource', resource: 'oil', qty: 30 },
      price: 1,
      to: 'bbb',
    });
    // Réservée à bbb : invisible pour ddd.
    expect(viewFor(s, 'ddd').market!.offers).toHaveLength(0);
    const id = viewFor(s, 'bbb').market!.offers[0]!.id;
    expect(applyOrder(s, 'ddd', { kind: 'acceptOffer', offerId: id }).ok).toBe(false);
    expect(applyOrder(s, 'aaa', { kind: 'cancelOffer', offerId: id }).ok).toBe(true);
    expect(s.nations.aaa!.res.oil).toBe(oil0);
    applyOrder(s, 'aaa', {
      kind: 'sellOffer',
      item: { type: 'resource', resource: 'oil', qty: 30 },
      price: 1,
      to: null,
    });
    advanceTo(s, s.time + 73 * HOUR);
    expect(viewFor(s, 'aaa').market!.offers).toHaveLength(0);
  });

  it('marché noir : détection signalée avec une probabilité (PRNG de la partie)', () => {
    const s = ecoGame();
    const intel = MODULES.find((m) => m.id === 'intel')! as { hooks?: EngineModule['hooks'] };
    const saved = intel.hooks;
    let detected = 0;
    intel.hooks = {
      ...saved,
      onSignal(st, name, data) {
        if (name === 'black_market_detected') detected++;
        saved?.onSignal?.(st, name, data);
      },
    };
    try {
      for (let i = 0; i < 40; i++)
        applyOrder(s, 'aaa', { kind: 'blackMarket', systemId: 'tst.infantry', count: 1 });
    } finally {
      intel.hooks = saved;
    }
    const n = viewFor(s, 'aaa').economy.production.filter(
      (p) => p.source === 'black_market',
    ).length;
    expect(n).toBe(40);
    // detectionChance 0,25 : environ 10 détections sur 40.
    expect(detected).toBeGreaterThan(2);
    expect(detected).toBeLessThan(20);
  });
});
