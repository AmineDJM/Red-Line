import { describe, expect, it } from 'vitest';
import { HOUR } from '@redline/shared';
import { advanceTo, applyOrder, applySystem, viewFor } from '../src/index.js';
import { board } from '../src/modules/kit.js';
import { modifier, signal } from '../src/modules/registry.js';
import { ecoGame } from './eco-fixtures.js';
import { unitsOf } from './fixtures.js';

describe('recherche et « posséder ≠ produire »', () => {
  it('Su-57 possédés mais non productibles sans research.aero.gen5, puis productibles', () => {
    const s = ecoGame();
    expect(unitsOf(s, 'aaa', 'ru.su-57').reduce((a, u) => a + u.count, 0)).toBe(14);
    const su57 = { kind: 'produce', provinceId: 'aaa-2', systemId: 'ru.su-57' } as const;
    expect(applyOrder(s, 'aaa', su57)).toMatchObject({ ok: false, error: 'research_required' });

    // gen5 exige gen4plus (acquis) ; coût 1 Md$ et 10 électronique.
    const money0 = s.nations.aaa!.money;
    expect(applyOrder(s, 'aaa', { kind: 'research', nodeId: 'research.aero.gen5' }).ok).toBe(true);
    expect(s.nations.aaa!.money).toBeCloseTo(money0 - 1e9, 0);
    const v = viewFor(s, 'aaa');
    expect(v.research!.current!.id).toBe('research.aero.gen5');
    // Centre de recherche (0,15) alimenté par la centrale voisine (× 1,15) → vitesse 1,1725.
    const done = v.research!.current!.completesAt;
    expect(done).toBeCloseTo((240 / 1.1725) * HOUR, -3);
    advanceTo(s, done - 1);
    expect(applyOrder(s, 'aaa', su57).ok).toBe(false);
    const notes = advanceTo(s, done);
    expect(
      notes.some((n) => n.kind === 'research_complete' && n.nodeId === 'research.aero.gen5'),
    ).toBe(true);
    expect(viewFor(s, 'aaa').research!.done).toContain('research.aero.gen5');
    // Effet du nœud : dégâts × 1,1.
    expect(modifier(s, 'aaa', 'combat.damage')).toBeCloseTo(1.1, 9);
    expect(applyOrder(s, 'aaa', { ...su57, count: 2 }).ok).toBe(true);
    const item = viewFor(s, 'aaa').economy.production.at(-1)!;
    expect(item).toMatchObject({ systemId: 'ru.su-57', count: 2, source: 'factory' });
  });

  it('prérequis manquant, file d’attente, annulation et remboursement', () => {
    const s = ecoGame();
    // bbb n'a rien : gen4plus exige gen4.
    expect(
      applyOrder(s, 'bbb', { kind: 'research', nodeId: 'research.aero.gen4plus' }),
    ).toMatchObject({ ok: false, error: 'research_required' });
    const m0 = s.nations.bbb!.money;
    expect(applyOrder(s, 'bbb', { kind: 'research', nodeId: 'research.aero.gen4' }).ok).toBe(true);
    // gen4plus peut être mis en file derrière gen4.
    expect(applyOrder(s, 'bbb', { kind: 'research', nodeId: 'research.aero.gen4plus' }).ok).toBe(
      true,
    );
    expect(viewFor(s, 'bbb').research!.queue).toEqual(['research.aero.gen4plus']);
    expect(s.nations.bbb!.money).toBeCloseTo(m0 - 2e8, 0);
    // Annuler la recherche en cours : 50 % remboursés ; la file démarre gen4plus… qui n'a plus son
    // prérequis : elle est retirée et remboursée en totalité.
    expect(applyOrder(s, 'bbb', { kind: 'cancelResearch', nodeId: 'research.aero.gen4' }).ok).toBe(
      true,
    );
    expect(s.nations.bbb!.money).toBeCloseTo(m0 - 0.5e8, 0);
    expect(viewFor(s, 'bbb').research!.current).toBeNull();
    expect(viewFor(s, 'bbb').research!.queue).toEqual([]);
  });

  it('ère du scénario : les nœuds postérieurs sont exclus', () => {
    const s = ecoGame();
    expect(
      applyOrder(s, 'aaa', { kind: 'research', nodeId: 'research.future.laser' }),
    ).toMatchObject({ ok: false, error: 'invalid_target' });
    const s2 = ecoGame({ year: 2045 });
    expect(applyOrder(s2, 'aaa', { kind: 'research', nodeId: 'research.future.laser' }).ok).toBe(
      true,
    );
  });

  it('accélération (commande système) et vol de recherche (signal)', () => {
    const s = ecoGame();
    applyOrder(s, 'bbb', { kind: 'research', nodeId: 'research.aero.gen4' });
    const t0 = viewFor(s, 'bbb').research!.current!.completesAt;
    expect(
      applySystem(s, {
        kind: 'accelerate',
        nationId: 'bbb',
        target: { type: 'research', id: 'research.aero.gen4' },
        hours: 10,
      }).ok,
    ).toBe(true);
    expect(viewFor(s, 'bbb').research!.current!.completesAt).toBe(t0 - 10 * HOUR);
    advanceTo(s, t0 - 10 * HOUR);
    expect(viewFor(s, 'bbb').research!.done).toContain('research.aero.gen4');
    // Vol : accordé immédiatement.
    signal(s, 'research_stolen', { by: 'bbb', victim: 'aaa', nodeId: 'research.aero.gen5' });
    expect(viewFor(s, 'bbb').research!.done).toContain('research.aero.gen5');
  });
});

describe('licences et importations', () => {
  it('licence : débloque la production sans la recherche, avec remise', () => {
    const s = ecoGame();
    const su57 = { kind: 'produce', provinceId: 'bbb-2', systemId: 'ru.su-57' } as const;
    expect(applyOrder(s, 'bbb', su57)).toMatchObject({ ok: false, error: 'research_required' });
    const m0 = s.nations.bbb!.money;
    expect(applyOrder(s, 'bbb', { kind: 'buyLicence', systemId: 'ru.su-57' }).ok).toBe(true);
    expect(s.nations.bbb!.money).toBeCloseTo(m0 - 40e6 * 20, 0);
    expect(viewFor(s, 'bbb').licences!.map((l) => l.systemId)).toEqual(['ru.su-57']);
    const m1 = s.nations.bbb!.money;
    expect(applyOrder(s, 'bbb', su57).ok).toBe(true);
    expect(s.nations.bbb!.money).toBeCloseTo(m1 - 40e6 * 0.7, 0);
    // Bâtiment requis : pas de base aérienne à bbb-1.
    expect(applyOrder(s, 'bbb', { ...su57, provinceId: 'bbb-1' })).toMatchObject({
      ok: false,
      error: 'not_allowed',
    });
  });

  it('importation : système exportable non productible → achat au catalogue (× 1,3), puis embargo', () => {
    const s = ecoGame();
    const f16 = { kind: 'produce', provinceId: 'bbb-2', systemId: 'us.f-16', count: 2 } as const;
    const m0 = s.nations.bbb!.money;
    expect(applyOrder(s, 'bbb', f16).ok).toBe(true);
    expect(s.nations.bbb!.money).toBeCloseTo(m0 - 2 * 30e6 * 1.3, 0);
    const item = viewFor(s, 'bbb').economy.production[0]!;
    expect(item).toMatchObject({ source: 'import', count: 2 });
    // Série de 2 : 36 h × 1,25 + 72 h de livraison.
    expect(item.completesAt).toBeCloseTo((36 * 1.25 + 72) * HOUR, -2);
    const notes = advanceTo(s, item.completesAt);
    expect(notes.some((n) => n.kind === 'production_complete')).toBe(true);
    expect(unitsOf(s, 'bbb', 'us.f-16').reduce((a, u) => a + u.count, 0)).toBe(2);

    // Embargo (tableau partagé, écrit par diplo) : importation refusée, marché noir possible.
    board(s).embargoed.bbb = true;
    expect(applyOrder(s, 'bbb', f16)).toMatchObject({ ok: false, error: 'locked' });
    expect(applyOrder(s, 'bbb', { kind: 'buyLicence', systemId: 'us.f-16' })).toMatchObject({
      ok: false,
      error: 'locked',
    });
    const m1 = s.nations.bbb!.money;
    expect(applyOrder(s, 'bbb', { kind: 'blackMarket', systemId: 'us.f-16', count: 1 }).ok).toBe(
      true,
    );
    expect(s.nations.bbb!.money).toBeCloseTo(m1 - 30e6 * 2.5, 0);
    expect(viewFor(s, 'bbb').economy.production.at(-1)!.source).toBe('black_market');
    expect(viewFor(s, 'bbb').nations.bbb!.embargoed).toBe(true);
  });

  it('nucléaire : jamais importable, même marqué exportable', () => {
    const s = ecoGame();
    expect(
      applyOrder(s, 'bbb', { kind: 'produce', provinceId: 'bbb-2', systemId: 'tst.icbm' }),
    ).toMatchObject({ ok: false, error: 'research_required' });
    expect(applyOrder(s, 'bbb', { kind: 'blackMarket', systemId: 'tst.icbm', count: 1 }).ok).toBe(
      false,
    );
    expect(applyOrder(s, 'bbb', { kind: 'buyLicence', systemId: 'tst.icbm' }).ok).toBe(false);
  });

  it('annulation d’une production : remboursement partiel', () => {
    const s = ecoGame();
    const m0 = s.nations.aaa!.money;
    applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'us.f-16', count: 3 });
    const id = viewFor(s, 'aaa').economy.production[0]!.id;
    expect(s.nations.aaa!.money).toBeCloseTo(m0 - 90e6, 0);
    expect(applyOrder(s, 'aaa', { kind: 'cancelProduction', productionId: id }).ok).toBe(true);
    expect(s.nations.aaa!.money).toBeCloseTo(m0 - 45e6, 0);
    expect(viewFor(s, 'aaa').economy.production).toHaveLength(0);
  });
});
