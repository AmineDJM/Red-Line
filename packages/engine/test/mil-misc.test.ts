import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, stats, viewFor } from '../src/index.js';
import { board } from '../src/modules/kit.js';
import { signal } from '../src/modules/registry.js';
import { mil } from '../src/modules/mil/state.js';
import { atWar, sightLevel } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, cityOf } from './fixtures.js';
import {
  MIL_CATALOG,
  captureSignals,
  milMap,
  milSandbox,
  milWorld,
  notesOf,
} from './mil-fixtures.js';

describe('forces spéciales, matériel capturé, piles', () => {
  it('sabotage par forces spéciales : building_hit ou échec, guerre déclarée', () => {
    captureSignals((signals) => {
      const s = milSandbox([{ owner: 'aaa', systemId: 'tst.sf', pos: [4.9, 40] }]);
      const r = applyOrder(s, 'aaa', {
        kind: 'specialOp',
        unitIds: ['u1'],
        provinceId: 'bbb-4',
        mission: 'sabotage',
        building: 'refinery',
      });
      expect(r.ok).toBe(true);
      const notes = advanceTo(s, 12 * HOUR);
      expect(atWar(s, 'aaa', 'bbb')).toBe(true);
      const hit = signals.find((x) => x.name === 'building_hit');
      const failed = notesOf(notes, 'generic').find(
        (n) => n.title === 'Opération spéciale échouée',
      );
      expect(!!hit !== !!failed).toBe(true);
      if (hit)
        expect(hit.data).toMatchObject({
          pid: 'bbb-4',
          building: 'refinery',
          by: 'aaa',
          damage: 0.5,
        });
      // Unité non spéciale : refusé.
      const t = milSandbox([{ owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] }]);
      expect(
        applyOrder(t, 'aaa', {
          kind: 'specialOp',
          unitIds: ['u1'],
          provinceId: 'bbb-4',
          mission: 'raid',
        }).error,
      ).toBe('not_allowed');
    });
  });

  it('prise d’une base aérienne : appareils au sol perdus, une partie capturée, quelques armes récupérées', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: [12.4, 40.05] }, // u1
      { owner: 'bbb', systemId: 'tst.jet', pos: cityOf('bbb-5'), count: 3 }, // u2 : au sol
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') }, // u3 : arsenal adverse
    ]);
    expect(mil(s).ms.u2!.up).toBe(false);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('bbb-5') }).ok).toBe(
      true,
    );
    const notes = advanceTo(s, 6 * HOUR);
    expect(s.provinces['bbb-5']!.owner).toBe('aaa');
    expect(s.units.u2).toBeUndefined();
    const aaa = Object.values(s.units).filter((u) => u.owner === 'aaa');
    expect(aaa.some((u) => u.sys === 'tst.jet' && u.count === 1)).toBe(true);
    expect(aaa.some((u) => u.sys === 'tst.tank')).toBe(true);
    expect(notesOf(notes, 'generic').some((n) => n.category === 'capture')).toBe(true);
  });

  it('scission et fusion de piles', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2'), count: 6 },
    ]);
    s.units.u1!.hp = 45; // 75 %
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: 'u1', count: 2 }).ok).toBe(true);
    const parts = Object.values(s.units).filter((u) => u.owner === 'aaa');
    expect(parts.map((u) => u.count).sort()).toEqual([2, 4]);
    for (const u of parts) expect(u.hp / u.maxHp).toBeCloseTo(0.75, 9);
    expect(applyOrder(s, 'aaa', { kind: 'split', unitId: 'u1', count: 4 }).error).toBe(
      'invalid_target',
    );
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: parts.map((u) => u.id) }).ok).toBe(true);
    const merged = Object.values(s.units).filter((u) => u.owner === 'aaa');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.count).toBe(6);
    expect(merged[0]!.hp).toBeCloseTo(45, 9);
  });
});

describe('capteurs, brouillage, satellites, leurres', () => {
  it('brouilleur : repérable quand il émet, invisible éteint', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.jammer', pos: [10, 44] }, // u1 : 150 km de zone d'effet
      { owner: 'bbb', systemId: 'tst.tank', pos: [11, 44] }, // u2 : ≈ 80 km, détection 25 km
    ]);
    advanceTo(s, MINUTE);
    expect(sightLevel(s, 'bbb', 'u1')).toBeGreaterThan(0);
    expect(viewFor(s, 'aaa').units.u1!.jamming).toBe(true);
    expect(applyOrder(s, 'aaa', { kind: 'jam', unitIds: ['u1'], on: false }).ok).toBe(true);
    expect(sightLevel(s, 'bbb', 'u1')).toBe(0);
    expect(viewFor(s, 'aaa').units.u1!.jamming).toBe(false);
    expect(applyOrder(s, 'aaa', { kind: 'jam', unitIds: ['u1'], on: true }).ok).toBe(true);
    expect(sightLevel(s, 'bbb', 'u1')).toBeGreaterThan(0);
  });

  it('cyberattaque contre les radars : portée réduite pendant N heures', () => {
    const s = milSandbox([
      { owner: 'bbb', systemId: 'tst.radar', pos: [13, 47] }, // u1 : 200 km
      { owner: 'aaa', systemId: 'tst.helo', pos: [11, 47] }, // u2 : ≈ 150 km
    ]);
    advanceTo(s, MINUTE);
    expect(sightLevel(s, 'bbb', 'u2')).toBeGreaterThan(0);
    signal(s, 'cyber', { by: 'aaa', victim: 'bbb', kind: 'radar', hours: 2 });
    expect(sightLevel(s, 'bbb', 'u2')).toBe(0);
    advanceTo(s, 2 * HOUR + 2 * MINUTE);
    expect(sightLevel(s, 'bbb', 'u2')).toBeGreaterThan(0);
  });

  it('satellite de reconnaissance : passage sur la zone visée, contacts et imagerie', () => {
    captureSignals((signals) => {
      const s = milSandbox([
        { owner: 'aaa', systemId: 'tst.optsat', pos: cityOf('aaa-2') }, // u1
        { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') }, // u2
      ]);
      expect(s.units.u1!.off).toBe(true);
      expect(
        applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at: cityOf('bbb-2'), radiusKm: 30 })
          .ok,
      ).toBe(true);
      const sat = viewFor(s, 'aaa').satellites!;
      expect(sat).toHaveLength(1);
      expect(sat[0]!.footprint.length).toBeGreaterThan(3);
      advanceTo(s, 7 * HOUR);
      const c = s.know.aaa?.u2;
      expect(c).toBeDefined();
      expect(c!.seen).toBe(false);
      expect(c!.lvl).toBe(3);
      expect(viewFor(s, 'aaa').units.u2?.systemId).toBe('tst.tank');
      const img = signals.find((x) => x.name === 'imagery');
      expect(img?.data).toMatchObject({ nation: 'aaa', kind: 'satellite' });
      expect(img!.data.pids).toContain('bbb-2');
    });
  });

  it('leurres (signal decoys) : semblables pour l’ennemi, marqués pour leur propriétaire, éphémères', () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.radar', pos: [17.5, 45.5] }]);
    signal(s, 'decoys', { by: 'bbb', at: [17.5, 44.5], count: 3, systemId: 'tst.tank', hours: 10 });
    const decoys = Object.values(s.units).filter((u) => u.role === 'decoy');
    expect(decoys).toHaveLength(3);
    advanceTo(s, MINUTE);
    const own = viewFor(s, 'bbb').units[decoys[0]!.id]!;
    expect(own.decoy).toBe(true);
    const enemy = viewFor(s, 'aaa').units[decoys[0]!.id];
    expect(enemy).toBeDefined();
    expect(enemy!.decoy).toBeUndefined();
    advanceTo(s, 11 * HOUR);
    expect(Object.values(s.units).filter((u) => u.role === 'decoy')).toHaveLength(0);
  });

  it('munition rôdeuse : consommée à l’impact comme un missile lent', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.lancet', pos: [7.2, 40], count: 4 }, // u1
      { owner: 'bbb', systemId: 'tst.tank', pos: [7.5, 40] }, // u2 : ≈ 25 km
      { owner: 'aaa', systemId: 'tst.radar', pos: [7.0, 40.2] }, // u3
    ]);
    advanceTo(s, MINUTE);
    const hp = s.units.u2!.hp;
    expect(mil(s).ms.u1).toBeUndefined(); // pas un aéronef à carburant
    const r = applyOrder(s, 'aaa', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'unit', unitId: 'u2' },
      count: 2,
    });
    expect(r.ok).toBe(true);
    expect(s.units.u1!.count).toBe(2);
    const m = Object.values(s.units).find((u) => u.role === 'missile')!;
    expect(mil(s).msl[m.id]!.cls).toBe('drone');
    advanceTo(s, HOUR);
    expect(!s.units.u2 || s.units.u2.hp < hp).toBe(true);
  });
});

describe('cessez-le-feu, zones d’exclusion aérienne, sites de défense', () => {
  it('cessez-le-feu : plus de tirs ni de frappes entre les deux nations', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.5, 40.0] },
      { owner: 'aaa', systemId: 'tst.cruise', pos: cityOf('aaa-1'), count: 2 },
    ]);
    applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    advanceTo(s, 15 * MINUTE);
    board(s).ceasefires['aaa|bbb'] = 10 * DAY;
    advanceTo(s, 2 * HOUR);
    const hp = s.units.u2?.hp;
    advanceTo(s, 6 * HOUR);
    expect(s.units.u2?.hp).toBe(hp);
    expect(
      applyOrder(s, 'aaa', {
        kind: 'strike',
        unitIds: ['u3'],
        target: { type: 'building', provinceId: 'bbb-4', building: 'refinery' },
      }).error,
    ).toBe('locked');
  });

  it('zone d’exclusion aérienne : un aéronef étranger y est engagé sans déclaration de guerre', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.sam', pos: cityOf('aaa-2') }, // u1
      { owner: 'ccc', systemId: 'tst.helo', pos: [2.8, 44.1] }, // u2 : en vol stationnaire au-dessus d'aaa-2
    ]);
    advanceTo(s, 30 * MINUTE);
    expect(s.units.u2!.hp).toBe(s.units.u2!.maxHp);
    board(s).noFly['aaa-2'] = true; // résolution du Conseil (diplo)
    advanceTo(s, 3 * HOUR);
    const u2 = s.units.u2;
    expect(!u2 || u2.hp < u2.maxHp).toBe(true);
    expect(atWar(s, 'aaa', 'ccc')).toBe(false);
    expect(viewFor(s, 'aaa').provinces['aaa-2']!.noFlyZone).toBe(true);
  });

  it('sites de défense publiés par eco : unités fixes, niveau, santé, retrait', () => {
    const s = milSandbox([]);
    signal(s, 'static_defense', {
      nation: 'aaa',
      pid: 'aaa-2',
      building: 'air_defense_site',
      level: 2,
      health: 1,
      at: cityOf('aaa-2'),
      rangeKm: 90,
    });
    const id = mil(s).fixed['aaa-2:air_defense_site']!;
    const u = s.units[id]!;
    expect(u.owner).toBe('aaa');
    expect(u.count).toBe(2);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: [id], to: cityOf('aaa-1') }).error).toBe(
      'not_allowed',
    );
    signal(s, 'static_defense', {
      nation: 'aaa',
      pid: 'aaa-2',
      building: 'air_defense_site',
      level: 3,
      health: 0.5,
      rangeKm: 120,
    });
    expect(s.units[id]!.count).toBe(3);
    expect(s.units[id]!.hp / s.units[id]!.maxHp).toBeCloseTo(0.5, 9);
    expect(mil(s).siteRange[id]).toBe(120);
    signal(s, 'static_defense', {
      nation: 'aaa',
      pid: 'aaa-2',
      building: 'air_defense_site',
      level: 3,
      health: 0,
    });
    expect(s.units[id]).toBeUndefined();
    expect(mil(s).fixed['aaa-2:air_defense_site']).toBeUndefined();
  });
});

describe('statistiques et IA de combat', () => {
  it('stats : éliminations, pertes, victimes, meilleures unités', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.5, 40.0] },
    ]);
    applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    advanceTo(s, 6 * HOUR);
    const st = stats(s);
    expect(st.nations.aaa!.kills).toBeGreaterThan(0);
    expect(st.nations.bbb!.losses).toBe(st.nations.aaa!.kills);
    expect(st.nations.bbb!.casualties).toBe(st.nations.bbb!.losses * 600);
    expect(st.nations.aaa!.bestUnits[0]).toEqual({
      systemId: 'tst.tank',
      kills: st.nations.aaa!.kills,
    });
  });

  /** Hélicoptère ennemi vu à ~900 km de la capitale de bbb (IA 'hard'), sur la petite carte de test. */
  const capGame = (capAlertKm?: number) =>
    createGame(
      capAlertKm
        ? buildWorld(
            milMap(),
            MIL_CATALOG,
            BalanceSchema.parse({ ...BALANCE, ai: { tactical: { capAlertKm } } }),
          )
        : milWorld(),
      {
        seed: 3,
        players: [
          { nationId: 'aaa', isAi: false },
          { nationId: 'bbb', isAi: true, aiLevel: 'hard' },
        ],
        units: [
          { owner: 'bbb', systemId: 'tst.jet', pos: cityOf('bbb-2'), count: 2 },
          { owner: 'bbb', systemId: 'tst.cruise', pos: cityOf('bbb-2'), count: 10 },
          { owner: 'bbb', systemId: 'tst.radar', pos: [9, 40.5] },
          { owner: 'aaa', systemId: 'tst.helo', pos: [4.9, 40.5] }, // u4 : menace aérienne
        ],
      },
    ) as EngineState;

  it('IA en guerre : menace aérienne lointaine, pas de patrouille de chasse inutile', () => {
    const s = capGame();
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u4'], to: [8, 40.5] });
    advanceTo(s, 2 * HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(mil(s).ms.u1!.mis).toBe('none');
  });

  it('IA en guerre : patrouille de chasse au-dessus de la capitale et salve de missiles', () => {
    // Rayon d'alerte élargi : sur la petite carte de test, la menace est à ~900 km de la capitale.
    const s = capGame(1200);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u4'], to: [8, 40.5] });
    advanceTo(s, 2 * HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(mil(s).ms.u1!.mis === 'patrol' || mil(s).ms.u1!.mis === 'rtb').toBe(true);
    expect(mil(s).stats.bbb?.missiles ?? 0).toBeGreaterThan(0);
    expect(board(s).nuclearAuth.bbb).toBeUndefined();
  });
});
