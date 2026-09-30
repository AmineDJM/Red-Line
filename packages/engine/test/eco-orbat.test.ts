import { describe, expect, it } from 'vitest';
import { BalanceSchema, OrbatSchema, distanceKm } from '@redline/shared';
import { viewFor } from '../src/index.js';
import { wi } from '../src/state/world.js';
import { ECO_BALANCE, ORBATS, ecoGame, ecoWorldWith } from './eco-fixtures.js';
import { cityOf, unitsOf } from './fixtures.js';

const provinceOf = (s: ReturnType<typeof ecoGame>, pos: [number, number]) => {
  const w = wi(s.world);
  return w.nav.cellProv.get(w.nav.cellAt(pos));
};

describe('forces de départ réelles (ORBAT)', () => {
  it('inventaire → piles : comptes exacts, tailles plafonnées par catégorie', () => {
    const s = ecoGame();
    const inv = ORBATS[0]!.inventory;
    for (const it of inv) {
      const piles = unitsOf(s, 'aaa', it.systemId);
      if (it.systemId === 'xx.absent') {
        expect(piles).toHaveLength(0);
        continue;
      }
      expect(piles.reduce((a, u) => a + u.count, 0)).toBe(it.count);
    }
    expect(
      unitsOf(s, 'aaa', 'ru.su-57')
        .map((u) => u.count)
        .sort((a, b) => b - a),
    ).toEqual([14]);
    expect(
      unitsOf(s, 'aaa', 'us.f-16')
        .map((u) => u.count)
        .sort((a, b) => b - a),
    ).toEqual([17, 17, 16]);
    expect(
      unitsOf(s, 'aaa', 'tst.tank')
        .map((u) => u.count)
        .sort((a, b) => b - a),
    ).toEqual([44, 43, 43]);
    expect(
      unitsOf(s, 'aaa', 'tst.infantry')
        .map((u) => u.count)
        .sort((a, b) => b - a),
    ).toEqual([9, 8, 8]);
    expect(
      unitsOf(s, 'aaa', 'tst.frigate')
        .map((u) => u.count)
        .sort((a, b) => b - a),
    ).toEqual([3, 2]);
    // bbb : 10 bataillons, 3 chasseurs.
    expect(unitsOf(s, 'bbb').reduce((a, u) => a + u.count, 0)).toBe(13);
  });

  it('placement : aéronefs sur les bases aériennes, navires en mer devant les ports', () => {
    const s = ecoGame();
    const w = wi(s.world);
    for (const u of unitsOf(s, 'aaa', 'us.f-16')) {
      expect(['aaa-2', 'aaa-3']).toContain(provinceOf(s, u.pos));
    }
    for (const u of unitsOf(s, 'aaa', 'tst.frigate')) {
      expect(u.pos).toEqual(w.seaSpawn.get('aaa-1'));
    }
    for (const u of unitsOf(s, 'aaa', 'tst.tank')) {
      expect(provinceOf(s, u.pos)?.startsWith('aaa-')).toBe(true);
    }
    // Défense aérienne : d'abord la capitale.
    const sam = unitsOf(s, 'aaa', 'tst.sam')[0]!;
    expect(distanceKm(sam.pos, cityOf('aaa-2'))).toBeLessThan(10);
  });

  it('sans ORBAT : armée de départ de la phase 1 (repli)', () => {
    const s = ecoGame();
    // ccc est un joueur (actif) : startingArmy du fichier d'équilibrage de test.
    expect(unitsOf(s, 'ccc', 'tst.infantry').length).toBe(2);
    expect(unitsOf(s, 'ccc', 'tst.tank').length).toBe(1);
  });

  it('plafond de piles par nation : les piles grossissent, le total reste exact', () => {
    const bal = BalanceSchema.parse({
      ...ECO_BALANCE,
      startingForces: { maxStacksPerNation: 6 },
    });
    const big = OrbatSchema.parse({
      nationId: 'aaa',
      year: 2025,
      doctrine: 'ru',
      defenseBudgetUsd: 1e9,
      inventory: [
        { systemId: 'tst.tank', count: 600 },
        { systemId: 'tst.infantry', count: 120 },
      ],
    });
    const s = ecoGame({ world: ecoWorldWith(bal, [big, ...ORBATS.slice(1)]) });
    const piles = unitsOf(s, 'aaa');
    expect(piles.length).toBeLessThanOrEqual(6);
    expect(unitsOf(s, 'aaa', 'tst.tank').reduce((a, u) => a + u.count, 0)).toBe(600);
    expect(unitsOf(s, 'aaa', 'tst.infantry').reduce((a, u) => a + u.count, 0)).toBe(120);
  });

  it('recherches et licences de départ = ORBAT', () => {
    const s = ecoGame();
    const v = viewFor(s, 'aaa');
    expect(v.research!.done).toEqual(['research.aero.gen4', 'research.aero.gen4plus']);
    // ccc (sans ORBAT) : technologies de base (rang 0).
    expect(viewFor(s, 'ccc').research!.done).toEqual(['research.industry.l1']);
  });
});
