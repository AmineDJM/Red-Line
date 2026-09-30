import { describe, expect, it } from 'vitest';
import type { PlayerView, UnitView, ViewDiff } from '@redline/shared';
import { applyDiff, touchedUnits } from '../src/net/applyDiff.js';

const unit = (id: string, extra: Partial<UnitView> = {}): UnitView => ({
  id,
  owner: 'fra',
  level: 'own',
  pos: [2, 48],
  lastSeen: 0,
  uncertaintyKm: 0,
  ...extra,
});

function baseView(): PlayerView {
  return {
    time: 1000,
    me: 'fra',
    nations: {
      fra: {
        id: 'fra',
        name: 'France',
        color: '#123456',
        isAi: false,
        isPlayer: true,
        alive: true,
        provinceCount: 2,
      },
      deu: {
        id: 'deu',
        name: 'Allemagne',
        color: '#654321',
        isAi: true,
        isPlayer: false,
        alive: true,
        provinceCount: 1,
      },
    },
    provinces: {
      'fra-1': { id: 'fra-1', owner: 'fra', buildings: [] },
      'fra-2': { id: 'fra-2', owner: 'fra', buildings: ['port'] },
    },
    units: { u1: unit('u1'), u2: unit('u2') },
    economy: {
      money: 100,
      resources: { oil: 1, metals: 2, electronics: 3, food: 4 },
      incomePerDay: { money: 10 },
      production: [],
    },
    victory: { provinceShareTarget: 0.6, leader: null, winner: null },
  };
}

describe('applyDiff', () => {
  it('ajoute, remplace et retire des unités', () => {
    const v = baseView();
    const diff: ViewDiff = {
      time: 2000,
      units: {
        upsert: [unit('u2', { pos: [3, 49], status: 'moving' }), unit('u3')],
        remove: ['u1'],
      },
    };
    const next = applyDiff(v, diff);
    expect(Object.keys(next.units).sort()).toEqual(['u2', 'u3']);
    expect(next.units.u2!.pos).toEqual([3, 49]);
    expect(next.units.u2!.status).toBe('moving');
    expect(next.time).toBe(2000);
  });

  it("ne mute pas la vue d'origine et partage les parties inchangées", () => {
    const v = baseView();
    const snapshot = JSON.stringify(v);
    const next = applyDiff(v, { time: 1500, economy: { ...v.economy, money: 50 } });
    expect(JSON.stringify(v)).toBe(snapshot);
    expect(next.units).toBe(v.units);
    expect(next.provinces).toBe(v.provinces);
    expect(next.nations).toBe(v.nations);
    expect(next.economy.money).toBe(50);
  });

  it('fusionne nations et provinces entrée par entrée', () => {
    const v = baseView();
    const next = applyDiff(v, {
      time: 1200,
      provinces: { 'fra-2': { id: 'fra-2', owner: 'deu', buildings: ['port'], capture: null } },
      nations: { deu: { ...v.nations.deu!, provinceCount: 2 } },
    });
    expect(next.provinces['fra-1']).toBe(v.provinces['fra-1']);
    expect(next.provinces['fra-2']!.owner).toBe('deu');
    expect(next.nations.deu!.provinceCount).toBe(2);
    expect(next.nations.fra).toBe(v.nations.fra);
  });

  it('remplace victoire et garde un temps monotone', () => {
    const v = baseView();
    const next = applyDiff(v, {
      time: 500,
      victory: { provinceShareTarget: 0.6, leader: 'fra', winner: 'fra' },
    });
    expect(next.victory.winner).toBe('fra');
    expect(next.time).toBe(1000);
  });

  it('un diff vide ne recrée pas les unités', () => {
    const v = baseView();
    const next = applyDiff(v, { time: 1100, units: { upsert: [], remove: [] } });
    expect(next.units).toBe(v.units);
  });

  it('liste les unités touchées', () => {
    expect(
      [...touchedUnits({ time: 0, units: { upsert: [unit('a')], remove: ['b'] } })].sort(),
    ).toEqual(['a', 'b']);
  });
});
