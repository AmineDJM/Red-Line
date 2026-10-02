import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, HOUR } from '@redline/shared';
import { advanceTo, applyOrder, applySystem, viewFor } from '../src/index.js';
import { roundDamage } from '../src/combat/combat.js';
import { board } from '../src/modules/kit.js';
import { MODULES, modifier, signal } from '../src/modules/registry.js';
import type { EngineModule } from '../src/modules/types.js';
import {
  ECO_BALANCE,
  ECO_BALANCE_DISTRIBUTED,
  ecoGame,
  ecoWorld,
  ecoWorldWith,
} from './eco-fixtures.js';
import { cityOf, unitsOf } from './fixtures.js';

const bstate = (s: ReturnType<typeof ecoGame>, n: string, pid: string, b: string) =>
  viewFor(s, n).provinces[pid]!.buildingState!.find((x) => x.type === b);

describe('bâtiments : santé, niveaux, effets', () => {
  it('bâtiment touché : santé réduite, production refusée puis rétablie après réparation', () => {
    const s = ecoGame();
    const tank = { kind: 'produce', provinceId: 'aaa-2', systemId: 'tst.tank' } as const;
    const notes0 = advanceTo(s, 0);
    void notes0;
    signal(s, 'building_hit', { pid: 'aaa-2', building: 'arms_factory', damage: 1, by: 'bbb' });
    const notes = advanceTo(s, 1);
    expect(notes.find((n) => n.kind === 'building_hit')).toMatchObject({
      provinceId: 'aaa-2',
      building: 'arms_factory',
      health: 0,
    });
    expect(bstate(s, 'aaa', 'aaa-2', 'arms_factory')).toMatchObject({ health: 0, level: 1 });
    // Char non exportable : ni production locale, ni importation.
    expect(applyOrder(s, 'aaa', tank)).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(
      applyOrder(s, 'aaa', { kind: 'repair', provinceId: 'aaa-2', building: 'arms_factory' }).ok,
    ).toBe(true);
    const until = bstate(s, 'aaa', 'aaa-2', 'arms_factory')!.repairUntil!;
    expect(until).toBe(1 + 48 * HOUR);
    advanceTo(s, until);
    expect(bstate(s, 'aaa', 'aaa-2', 'arms_factory')!.health).toBe(1);
    expect(applyOrder(s, 'aaa', tank).ok).toBe(true);
  });

  it('usine endommagée à moitié : production plus lente (× 0,75)', () => {
    const s = ecoGame();
    signal(s, 'sabotage', {
      by: 'bbb',
      victim: 'aaa',
      pid: 'aaa-2',
      building: 'arms_factory',
      damage: 0.5,
    });
    applyOrder(s, 'aaa', { kind: 'produce', provinceId: 'aaa-2', systemId: 'tst.tank' });
    const it0 = viewFor(s, 'aaa').economy.production[0]!;
    // 12 h / (0,75 × centrale voisine de aaa-1 : × 1,2).
    expect(it0.completesAt - it0.startedAt).toBeCloseTo((12 / (0.75 * 1.2)) * HOUR, -2);
  });

  it('raffinerie détruite : le pétrole baisse', () => {
    const s = ecoGame();
    const oil = () => viewFor(s, 'aaa').economy.detail!.resources.oil.production;
    const o0 = oil();
    signal(s, 'building_hit', { pid: 'aaa-1', building: 'refinery', damage: 1, by: 'bbb' });
    expect(oil()).toBeCloseTo(o0 - 20, 9);
  });

  it('la vue publie le devis exact des chantiers (prochain niveau, options de construction)', () => {
    const s = ecoGame();
    const pv = () => viewFor(s, 'aaa').provinces['aaa-3']!;
    const opt = pv().buildOptions!.find((o) => o.type === 'mine')!;
    expect(opt).toMatchObject({ level: 1, cost: 6e7, hours: 240 });
    expect(pv().buildOptions!.some((o) => o.type === 'fortification')).toBe(true);
    const m0 = s.nations.aaa!.money;
    expect(applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }).ok).toBe(
      true,
    );
    expect(m0 - s.nations.aaa!.money).toBeCloseTo(opt.cost, 0);
    expect(pv().buildOptions!.find((o) => o.type === 'mine')!.blocked).toBe('in_progress');
    advanceTo(s, 240 * HOUR);
    const next = pv().buildingState!.find((b) => b.type === 'mine')!.next!;
    expect(next).toMatchObject({ level: 2, cost: 6e7 * 1.6, hours: 240 * 1.25 });
    const m1 = s.nations.aaa!.money;
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' });
    expect(m1 - s.nations.aaa!.money).toBeCloseTo(next.cost, 0);
    const up = pv().buildingState!.find((b) => b.type === 'mine')!.upgradeUntil!;
    expect(up - s.time).toBeCloseTo(next.hours * HOUR, -2);
  });

  it('construction puis amélioration par niveau (coût × 1,6, durée × 1,25)', () => {
    const s = ecoGame();
    const m0 = s.nations.aaa!.money;
    expect(applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }).ok).toBe(
      true,
    );
    expect(s.nations.aaa!.money).toBeCloseTo(m0 - 6e7, 0);
    expect(bstate(s, 'aaa', 'aaa-3', 'mine')).toMatchObject({ level: 0, buildUntil: 240 * HOUR });
    advanceTo(s, 240 * HOUR);
    expect(bstate(s, 'aaa', 'aaa-3', 'mine')).toMatchObject({ level: 1, health: 1 });
    expect(viewFor(s, 'aaa').provinces['aaa-3']!.buildings).toContain('mine');
    const m1 = s.nations.aaa!.money;
    expect(applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }).ok).toBe(
      true,
    );
    expect(s.nations.aaa!.money).toBeCloseTo(m1 - 6e7 * 1.6, 0);
    const up = bstate(s, 'aaa', 'aaa-3', 'mine')!.upgradeUntil!;
    expect(up - s.time).toBeCloseTo(240 * 1.25 * HOUR, -2);
    advanceTo(s, up);
    expect(bstate(s, 'aaa', 'aaa-3', 'mine')!.level).toBe(2);
    // Mine niveau 2 : métaux de la province × (1 + 0,5 × 2).
    const row = viewFor(s, 'aaa').economy.detail!.provinces.find((p) => p.id === 'aaa-3')!;
    expect(row.resources.metals).toBeCloseTo(5 * 2, 9);
    // Accélération d'un chantier (commande système).
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' });
    expect(
      applySystem(s, {
        kind: 'accelerate',
        nationId: 'aaa',
        target: { type: 'build', id: 'aaa-3:mine' },
        hours: 1e4,
      }).ok,
    ).toBe(true);
    advanceTo(s, s.time);
    expect(bstate(s, 'aaa', 'aaa-3', 'mine')!.level).toBe(3);
  });

  it('site de défense aérienne et station radar : exposés au module militaire (board + signaux)', () => {
    const s = ecoGame();
    const mil = MODULES.find((m) => m.id === 'mil')! as { hooks?: EngineModule['hooks'] };
    const saved = mil.hooks;
    const got: [string, Record<string, unknown>][] = [];
    mil.hooks = {
      ...saved,
      onSignal(st, name, data) {
        if (name === 'static_defense' || name === 'radar_station') got.push([name, data]);
        saved?.onSignal?.(st, name, data);
      },
    };
    try {
      applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-2', building: 'air_defense_site' });
      applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-1', building: 'radar_station' });
      advanceTo(s, 240 * HOUR);
      expect(board(s).sites['aaa-2:air_defense_site']).toMatchObject({
        n: 'aaa',
        level: 1,
        h: 1,
        rangeKm: 40,
      });
      expect(board(s).sites['aaa-1:radar_station']).toMatchObject({ n: 'aaa', rangeKm: 150 });
      expect(got.map((g) => g[0]).sort()).toEqual(['radar_station', 'static_defense']);
      signal(s, 'building_hit', {
        pid: 'aaa-2',
        building: 'air_defense_site',
        damage: 0.4,
        by: 'bbb',
      });
      expect(board(s).sites['aaa-2:air_defense_site']!.h).toBeCloseTo(0.6, 9);
      expect(got.at(-1)![1]).toMatchObject({
        nation: 'aaa',
        building: 'air_defense_site',
        level: 1,
      });
    } finally {
      mil.hooks = saved;
    }
  });

  it('explosion nucléaire : bâtiments de la province détruits, voisins endommagés, moral effondré', () => {
    const s = ecoGame();
    signal(s, 'nuclear_detonation', {
      by: 'bbb',
      victim: 'aaa',
      at: cityOf('aaa-2'),
      pid: 'aaa-2',
    });
    for (const b of viewFor(s, 'aaa').provinces['aaa-2']!.buildingState!) expect(b.health).toBe(0);
    expect(bstate(s, 'aaa', 'aaa-1', 'refinery')!.health).toBe(0.5);
    const row = viewFor(s, 'aaa').economy.detail!.provinces.find((p) => p.id === 'aaa-2')!;
    expect(row.morale).toBeLessThan(20);
  });

  it('répartition de départ : bâtiments de ressources selon les rendements (déterministe)', () => {
    const w = ecoWorldWith(ECO_BALANCE_DISTRIBUTED);
    const s = ecoGame({ world: w });
    const st = viewFor(s, 'aaa').provinces['aaa-1']!.buildingState!;
    expect(st.map((b) => b.type)).toEqual(expect.arrayContaining(['oil_field', 'mine']));
    // Capitale : industrie locale.
    expect(viewFor(s, 'aaa').provinces['aaa-2']!.buildings).toContain('local_industry');
    const s2 = ecoGame({ world: w });
    expect(viewFor(s2, 'aaa').provinces).toEqual(viewFor(s, 'aaa').provinces);
    // Sans répartition : bâtiments de la carte seulement.
    expect(viewFor(ecoGame({ world: ecoWorld() }), 'aaa').provinces['aaa-1']!.buildings).toEqual([
      'port',
      'power_plant',
      'refinery',
    ]);
  });

  it('hôpital : les unités à l’arrêt dans la province se rétablissent chaque jour', () => {
    const s = ecoGame({
      units: [{ owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2'), count: 4 }],
    });
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-2', building: 'hospital' });
    advanceTo(s, 168 * HOUR);
    const u = unitsOf(s, 'aaa', 'tst.tank')[0]!;
    u.hp = u.maxHp * 0.5;
    advanceTo(s, 8 * DAY);
    // + 10 % par jour (niveau 1).
    expect(u.hp).toBeCloseTo(u.maxHp * 0.6, 6);
  });
});

describe('logistique, fortifications, bunkers', () => {
  it('ravitaillement coupé loin des provinces amies : dégâts réduits (× 0,35)', () => {
    const s = ecoGame({
      units: [
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') },
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('bbb-1') },
        { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') },
      ],
    });
    advanceTo(s, DAY);
    const [home, far] = unitsOf(s, 'aaa', 'tst.tank').sort((a, b) => a.pos[0] - b.pos[0]);
    const tgt = unitsOf(s, 'bbb', 'tst.tank')[0]!;
    const v = viewFor(s, 'aaa');
    expect(v.units[home!.id]!.supply).toBe('supplied');
    expect(v.units[far!.id]!.supply).toBe('cut');
    expect(roundDamage(s, far!, tgt, 1) / roundDamage(s, home!, tgt, 1)).toBeCloseTo(0.35, 9);
  });

  it('dépôt avancé : les unités à portée sont de nouveau ravitaillées', () => {
    const s = ecoGame({
      units: [{ owner: 'aaa', systemId: 'tst.tank', pos: [7, 48] }],
    });
    advanceTo(s, DAY);
    const u = unitsOf(s, 'aaa', 'tst.tank')[0]!;
    expect(viewFor(s, 'aaa').units[u.id]!.supply).toBe('limited');
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'forward_base' });
    advanceTo(s, 2 * DAY);
    expect(viewFor(s, 'aaa').logistics!.depots).toHaveLength(1);
    expect(viewFor(s, 'aaa').units[u.id]!.supply).toBe('supplied');
  });

  it('fortification et bunkers : blindage du défenseur à l’arrêt chez lui', () => {
    const s = ecoGame({
      units: [
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') },
        { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') },
      ],
    });
    const def = unitsOf(s, 'aaa', 'tst.tank')[0]!;
    const att = unitsOf(s, 'bbb', 'tst.tank')[0]!;
    const d0 = roundDamage(s, att, def, 1);
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-2', building: 'fortification' });
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-2', building: 'bunker' });
    advanceTo(s, 96 * HOUR);
    expect(viewFor(s, 'aaa').provinces['aaa-2']!.fortification).toMatchObject({ level: 1 });
    // Fortification 1 (× 1,2) et bunker 1 (× 1,25).
    expect(d0 / roundDamage(s, att, def, 1)).toBeCloseTo(1.2 * 1.25, 9);
  });
});

describe('tableau de bord économique', () => {
  it('revenus détaillés, entretien par catégorie, ressources, prévisions, provinces', () => {
    const s = ecoGame();
    const d = viewFor(s, 'aaa').economy.detail!;
    expect(d.budgetUsdPerYear).toBe(36.5e9);
    expect(d.income.national).toBeCloseTo(0.5e8, 0);
    expect(d.income.provincial).toBeCloseTo(0.5e8, 0);
    expect(d.income.total).toBeCloseTo(1e8, 0);
    expect(Object.keys(d.upkeep).sort()).toEqual(
      ['air_defense', 'fighter', 'infantry', 'surface_ship', 'tank'].sort(),
    );
    expect(d.forecast.money7d).toBeCloseTo(s.nations.aaa!.money + 7 * (1e8 - d.upkeepTotal), -2);
    expect(d.provinces.map((p) => p.id)).toEqual(['aaa-1', 'aaa-2', 'aaa-3']);
    // Consommation : 25 bataillons × 0,02 nourriture ; (130 chars + 13 SAM) × 0,005
    // + 64 avions × 0,03 + 5 navires × 0,1 pétrole.
    expect(d.resources.food.consumption).toBeCloseTo(0.5, 6);
    expect(d.resources.oil.consumption).toBeCloseTo(143 * 0.005 + 64 * 0.03 + 5 * 0.1, 1);
  });

  it('pénurie : stock épuisé ⇒ production ralentie, moral en baisse ; grand livre des 24 h', () => {
    // La carte de test ne produit pas de nourriture ; 25 bataillons en consomment 0,5 par jour.
    // Plancher national coupé (il assurerait 2 unités par jour) : on observe la pénurie elle-même.
    const noFloor = BalanceSchema.parse({
      ...ECO_BALANCE,
      resources: { nationalFloor: { economyShare: 0, minPerDay: {} } },
    });
    const s = ecoGame({ world: ecoWorldWith(noFloor) });
    s.nations.aaa!.res.food = 0.2;
    advanceTo(s, DAY);
    const d = viewFor(s, 'aaa').economy.detail!;
    expect(d.resources.food).toMatchObject({ stock: 0, shortage: true });
    expect(d.resources.oil.shortage).toBe(false);
    expect(modifier(s, 'aaa', 'production.speed')).toBeCloseTo(0.5, 9);
    expect(d.provinces[0]!.morale).toBe(65);
    expect(d.lastDay.budgetNational).toBeCloseTo(0.5e8, 0);
    expect(d.lastDay.upkeep).toBeLessThan(0);
    expect(d.lastDay.other).toBeUndefined();
    // Un transfert d'argent reçu hors grand livre spécifique apparaît dans « other » ou « transfersIn ».
    applyOrder(s, 'bbb', {
      kind: 'transfer',
      to: 'aaa',
      item: { type: 'money', amount: 1e6 },
      covert: false,
    });
    s.nations.aaa!.money -= 123; // dépense inconnue du module (ex. renseignement)
    advanceTo(s, 2 * DAY);
    const d2 = viewFor(s, 'aaa').economy.detail!;
    expect(d2.lastDay.transfersIn).toBe(1e6);
    expect(d2.lastDay.other).toBeCloseTo(-123, 3);
    expect(d2.tradeBalance).toBe(1e6);
  });
});
