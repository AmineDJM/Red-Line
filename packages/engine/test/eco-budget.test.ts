import { describe, expect, it } from 'vitest';
import { DAY } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { transferProvince } from '../src/combat/capture.js';
import { board } from '../src/modules/kit.js';
import { signal } from '../src/modules/registry.js';
import { ecoGame, ecoWorld, upkeepOf } from './eco-fixtures.js';

const BD_AAA = 36.5e9 / 365; // 1e8 $ par jour
const BD_BBB = 73e9 / 365; // 2e8 $ par jour

describe('économie réelle : budget en dollars', () => {
  it('rapport de chargement : système d’ORBAT absent du catalogue signalé, sans exception', () => {
    const w = ecoWorld();
    expect(w.loadWarnings?.some((m) => m.includes('xx.absent'))).toBe(true);
  });

  it('argent de départ = 30 jours de budget ; revenu = budget quotidien − entretien', () => {
    const s = ecoGame();
    expect(s.nations.aaa!.money).toBeCloseTo(30 * BD_AAA, 0);
    expect(s.nations.bbb!.money).toBeCloseTo(30 * BD_BBB, 0);
    const v = viewFor(s, 'aaa');
    const upkeep = upkeepOf(s, 'aaa');
    expect(upkeep).toBeGreaterThan(0);
    expect(v.economy.incomePerDay.money).toBeCloseTo(BD_AAA - upkeep, 0);
    const before = s.nations.aaa!.money;
    advanceTo(s, DAY);
    expect(s.nations.aaa!.money).toBeCloseTo(before + BD_AAA - upkeep, 0);
  });

  it('sans ORBAT : repli sur l’ancien calcul (revenus des provinces)', () => {
    const s = ecoGame();
    // ccc n'a pas d'ORBAT : 2 provinces × 100 × incomeMultiplier (1), entretien en dollars par élément.
    const v = viewFor(s, 'ccc');
    expect(v.economy.incomePerDay.money).toBeCloseTo(200 - upkeepOf(s, 'ccc'), 6);
    expect(s.nations.ccc!.money).toBe(2000);
  });

  it('part provinciale au prorata de income.money : conquérir rapporte, perdre coûte', () => {
    const s = ecoGame();
    const inc = (n: string) => viewFor(s, n).economy.incomePerDay.money + upkeepOf(s, n);
    const aaa0 = inc('aaa');
    const bbb0 = inc('bbb');
    // aaa-1 : 100 sur 500 de income.money de aaa → 0,5 × 1e8 × 0,2 = 1e7 $ par jour, que le
    // conquérant touche au moral d'occupation (30 → revenu × 0,8).
    transferProvince(s, 'aaa-1', 'bbb');
    expect(inc('aaa')).toBeCloseTo(aaa0 - 1e7, 0);
    expect(inc('bbb')).toBeCloseTo(bbb0 + 0.8e7, 0);
    // Libérée : le moral remonte de 2 points par jour ; à 50, la province rapporte de nouveau tout.
    transferProvince(s, 'aaa-1', 'aaa');
    expect(inc('aaa')).toBeCloseTo(aaa0 - 0.2e7, 0);
    advanceTo(s, 10 * DAY);
    expect(viewFor(s, 'aaa').economy.detail!.provinces.find((p) => p.id === 'aaa-1')!.morale).toBe(
      50,
    );
    expect(inc('aaa')).toBeCloseTo(aaa0, 0);
  });

  it('nation vaincue : la part nationale est perdue, les provinces rapportent au vainqueur', () => {
    const s = ecoGame();
    const inc = (n: string) => viewFor(s, n).economy.incomePerDay.money + upkeepOf(s, n);
    const bbb0 = inc('bbb');
    transferProvince(s, 'ddd-1', 'bbb');
    expect(s.nations.ddd!.alive).toBe(false);
    // ddd : budget 1e7 $/j, part provinciale 0,5 → la province rapporte 5e6 $/j (× 0,8 : occupation).
    expect(inc('bbb')).toBeCloseTo(bbb0 + 4e6, 0);
    const before = s.nations.ddd!.money;
    advanceTo(s, DAY);
    expect(s.nations.ddd!.money).toBe(before);
  });

  it('sanctions : la part commerciale (30 %) est réduite', () => {
    const s = ecoGame();
    const inc = () => viewFor(s, 'aaa').economy.incomePerDay.money + upkeepOf(s, 'aaa');
    board(s).sanctions.aaa = 0;
    expect(inc()).toBeCloseTo(BD_AAA * 0.7, 0);
    board(s).sanctions.aaa = 0.5;
    expect(inc()).toBeCloseTo(BD_AAA * 0.85, 0);
  });

  it('blocus des ports : commerce maritime coupé', () => {
    const s = ecoGame();
    const inc = () => viewFor(s, 'aaa').economy.incomePerDay.money + upkeepOf(s, 'aaa');
    // Seul port de aaa : aaa-1 → la part commerciale (30 %) disparaît sous blocus.
    signal(s, 'blockade', { by: 'bbb', pid: 'aaa-1', on: true });
    expect(inc()).toBeCloseTo(BD_AAA * 0.7, 0);
    expect(viewFor(s, 'aaa').provinces['aaa-1']!.blockaded).toBe(true);
    signal(s, 'blockade', { by: 'bbb', pid: 'aaa-1', on: false });
    expect(inc()).toBeCloseTo(BD_AAA, 0);
  });

  it('mobilisation : infanterie supplémentaire, revenu réduit, démobilisation après le délai', () => {
    const s = ecoGame();
    const n0 = Object.values(s.units).filter((u) => u.owner === 'aaa').length;
    expect(applyOrder(s, 'aaa', { kind: 'mobilize', on: true }).ok).toBe(true);
    const n1 = Object.values(s.units).filter((u) => u.owner === 'aaa').length;
    expect(n1 - n0).toBe(3); // 1 bataillon par province
    expect(board(s).mobilized.aaa).toBe(true);
    const v = viewFor(s, 'aaa');
    expect(v.nations.aaa!.mobilized).toBe(true);
    expect(v.logistics?.mobilized).toBe(true);
    expect(v.economy.incomePerDay.money + upkeepOf(s, 'aaa')).toBeCloseTo(BD_AAA * 0.75, 0);
    expect(applyOrder(s, 'aaa', { kind: 'mobilize', on: false })).toMatchObject({
      ok: false,
      error: 'cooldown',
    });
    advanceTo(s, 3 * DAY);
    expect(applyOrder(s, 'aaa', { kind: 'mobilize', on: false }).ok).toBe(true);
    expect(board(s).mobilized.aaa).toBeUndefined();
  });
});
