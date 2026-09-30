import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import { advanceTo, applyOrder, createGame, viewFor } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { latLngToCell } from 'h3-js';
import { BALANCE, CATALOG, RES, cityOf, sandbox, testWorld, unitsOf } from './fixtures.js';

describe('économie et production', () => {
  it('tick journalier : revenus des provinces × multiplicateur − entretien', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') },
    ]);
    const before = s.nations.aaa!.money;
    const v = viewFor(s, 'aaa');
    expect(v.economy.incomePerDay.money).toBe(3 * 100 - 5 - 5);
    expect(v.economy.incomePerDay.oil).toBe(15);
    advanceTo(s, DAY - 1);
    expect(s.nations.aaa!.money).toBe(before);
    advanceTo(s, DAY);
    expect(s.nations.aaa!.money).toBe(before + 300 - 10);
    expect(s.nations.aaa!.res.oil).toBe(100 + 15);
    advanceTo(s, 3 * DAY);
    expect(s.nations.aaa!.money).toBe(before + 3 * 290);
  });

  it('production : coût débité, unité créée au point de ville après buildTimeH', () => {
    const s = sandbox([]);
    const tank = CATALOG.find((x) => x.id === 'tst.tank')!;
    const r = applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'tst.tank' });
    expect(r.ok).toBe(true);
    expect(s.nations.aaa!.money).toBe(BALANCE.economy.startingMoney - tank.cost.money);
    expect(s.nations.aaa!.res.oil).toBe(100 - 10);
    expect(viewFor(s, 'aaa').economy.production).toHaveLength(1);
    let notes = advanceTo(s, tank.buildTimeH * HOUR - 1);
    expect(unitsOf(s, 'aaa')).toHaveLength(0);
    notes = advanceTo(s, tank.buildTimeH * HOUR);
    const done = notes.find((n) => n.kind === 'production_complete');
    expect(done).toMatchObject({ systemId: 'tst.tank' });
    const u = unitsOf(s, 'aaa', 'tst.tank')[0]!;
    expect(u.pos).toEqual(cityOf('aaa-2'));
    expect(u.count).toBe(tank.unitSize);
    expect(viewFor(s, 'aaa').economy.production).toHaveLength(0);
  });

  it("refus : fonds insuffisants, province d'autrui, système inconnu, navire enclavé", () => {
    const s = sandbox([]);
    s.nations.aaa!.money = 50;
    expect(
      applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'tst.tank' }),
    ).toMatchObject({
      ok: false,
      error: 'insufficient_funds',
    });
    s.nations.aaa!.money = 5000;
    s.nations.aaa!.res.metals = 0;
    expect(
      applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'tst.tank' }),
    ).toMatchObject({
      error: 'insufficient_funds',
    });
    expect(
      applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'bbb-2', systemId: 'tst.infantry' }),
    ).toMatchObject({
      error: 'not_owner',
    });
    expect(
      applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'xx.nope' }),
    ).toMatchObject({
      error: 'invalid_target',
    });
    expect(s.nations.aaa!.money).toBe(5000);
  });

  it('navire produit sur la côte (point de mise à l’eau)', () => {
    const s = sandbox([]);
    s.nations.bbb!.res.metals = 100;
    expect(
      applyOrder(s, 'bbb', { kind: 'produce', provinceId: 'bbb-2', systemId: 'tst.frigate' }).ok,
    ).toBe(true);
    advanceTo(s, 13 * HOUR);
    const f = unitsOf(s, 'bbb', 'tst.frigate')[0]!;
    expect(f).toBeDefined();
    // Posé sur une cellule marine voisine de la côte de la province.
    const cell = latLngToCell(f.pos[1], f.pos[0], RES);
    expect(s.world.map.cells.cells[cell]).toBeUndefined();
    expect(applyOrder(s, 'bbb', { kind: 'move', unitIds: [f.id], to: [22, 40] }).ok).toBe(true);
  });

  it('création de partie : armées de départ, garnisons, argent de départ', () => {
    const s = createGame(testWorld(), {
      seed: 1,
      players: [{ nationId: 'aaa', isAi: false }],
    }) as EngineState;
    const army = BALANCE.startingArmy.reduce((a, b) => a + b.count, 0);
    const garrison = BALANCE.garrisonArmy.reduce((a, b) => a + b.count, 0);
    expect(unitsOf(s, 'aaa')).toHaveLength(army);
    expect(unitsOf(s, 'bbb')).toHaveLength(garrison);
    expect(s.nations.aaa!.money).toBe(BALANCE.economy.startingMoney);
    expect(s.nations.aaa!.isPlayer).toBe(true);
    expect(s.nations.bbb!.isAi).toBe(true);
    // Répartis autour de la capitale et de quelques provinces, sur leur territoire.
    const cells = s.world.map.cells.cells;
    for (const u of unitsOf(s, 'aaa')) {
      expect(cells[latLngToCell(u.pos[1], u.pos[0], RES)]?.startsWith('aaa-')).toBe(true);
    }
    const sites = new Set(
      unitsOf(s, 'aaa').map((u) => cells[latLngToCell(u.pos[1], u.pos[0], RES)]),
    );
    expect(sites.size).toBeGreaterThan(1);
    expect(Object.keys(s.wars)).toHaveLength(0);
  });
});
