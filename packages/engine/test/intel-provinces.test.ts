import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type BuildingType, type PlayerView } from '@redline/shared';
import { advanceTo, viewFor } from '../src/index.js';
import { board } from '../src/modules/kit.js';
import { signal } from '../src/modules/registry.js';
import { intelModule } from '../src/modules/intel/index.js';
import { MILITARY_BUILDINGS, filterProvinces } from '../src/modules/intel/provinces.js';
import { cityOf } from './fixtures.js';
import { BBB2, BBB5, intelGame, runOp } from './intel-helpers.js';

const MIL2 = BBB2.filter((b) => MILITARY_BUILDINGS.has(b));
const ECO2 = BBB2.filter((b) => !MILITARY_BUILDINGS.has(b));

describe('renseignement : connaissance progressive des provinces étrangères', () => {
  it('au départ : ses provinces et celles des alliés connues, frontière aperçue, le reste inconnu', () => {
    const s = intelGame();
    board(s).allianceOf.aaa = 'al1';
    board(s).allianceOf.ccc = 'al1';
    const v = viewFor(s, 'aaa');
    // Ses provinces et celles d'un allié : aucune restriction.
    expect(v.provinces['aaa-2']!.intel).toBeUndefined();
    expect(v.provinces['aaa-2']!.buildings).toEqual(['military_base']);
    expect(v.provinces['ccc-1']!.intel).toBeUndefined();
    expect(v.provinces['ccc-1']!.buildings).toEqual(['military_base']);
    // Province lointaine : rien.
    expect(v.provinces['bbb-2']!.intel).toMatchObject({
      level: 0,
      economic: false,
      military: false,
    });
    expect(v.provinces['bbb-2']!.buildings).toEqual([]);
    // Province limitrophe (bbb-4 touche aaa-1) : aperçu.
    expect(v.provinces['bbb-4']!.intel).toMatchObject({ level: 1, economic: true, military: true });
    // Le propriétaire, lui, voit tout.
    // L'ordre des bâtiments dépend du module eco (tri) : comparaison d'ensembles.
    expect([...viewFor(s, 'bbb').provinces['bbb-2']!.buildings].sort()).toEqual([...BBB2].sort());
  });

  it('missions ciblées : les installations militaires apparaissent progressivement, pas les économiques', () => {
    const s = intelGame();
    const seen: BuildingType[][] = [];
    for (let i = 0; i < 2; i++) {
      runOp(s, 'aaa', 'recon_military', { provinceId: 'bbb-2' });
      seen.push(viewFor(s, 'aaa').provinces['bbb-2']!.buildings);
    }
    const [first, second] = seen;
    // +2 niveaux puis 3 (maximum) : sous-ensemble croissant, complet à la fin.
    for (const b of first!) expect(second).toContain(b);
    expect([...second!].sort()).toEqual([...MIL2].sort());
    const pv = viewFor(s, 'aaa').provinces['bbb-2']!;
    expect(pv.intel).toMatchObject({ level: 3, military: true, economic: false });
    for (const b of ECO2) expect(pv.buildings).not.toContain(b);
    // Chaque découverte est annoncée par un rapport.
    const reps = viewFor(s, 'aaa').intel!.reports.filter((r) =>
      r.title.startsWith('Reconnaissance militaire'),
    );
    expect(reps).toHaveLength(2);
    expect(reps.map((r) => r.body).join('\n')).toContain('silo de missiles');
    expect(reps[0]!.subject).toMatchObject({ nationId: 'bbb', provinceId: 'bbb-2' });

    // Mission économique sur la nation entière : +1 niveau sur plusieurs provinces.
    runOp(s, 'aaa', 'recon_economic', { nationId: 'bbb' });
    const v = viewFor(s, 'aaa');
    expect(v.provinces['bbb-2']!.intel!.economic).toBe(true);
    expect(v.provinces['bbb-5']!.intel!.economic).toBe(true);
    // Les autres nations n'en profitent pas.
    expect(viewFor(s, 'ccc').provinces['bbb-2']!.buildings).toEqual([]);
  });

  it('signal imagery : la zone est révélée (satellite), rapport de découverte', () => {
    const s = intelGame();
    advanceTo(s, 3 * HOUR);
    signal(s, 'imagery', {
      nation: 'aaa',
      at: cityOf('bbb-5'),
      radiusKm: 30,
      kind: 'satellite',
    });
    const pv = viewFor(s, 'aaa').provinces['bbb-5']!;
    expect(pv.intel!.level).toBeGreaterThanOrEqual(1);
    expect(pv.intel!.updatedAt).toBe(3 * HOUR);
    // Deux passages de plus : tout est connu.
    signal(s, 'imagery', { nation: 'aaa', pids: ['bbb-5'], kind: 'satellite' });
    signal(s, 'imagery', { nation: 'aaa', pids: ['bbb-5'], kind: 'satellite' });
    expect([...viewFor(s, 'aaa').provinces['bbb-5']!.buildings].sort()).toEqual([...BBB5].sort());
    const reps = viewFor(s, 'aaa').intel!.reports.filter((r) => r.title.startsWith('Imagerie'));
    expect(reps.length).toBeGreaterThanOrEqual(1);
    expect(reps[0]!.kind).toBe('order_of_battle');
    // Un radar ne révèle que le militaire.
    signal(s, 'imagery', { nation: 'aaa', pids: ['bbb-2'], kind: 'radar' });
    expect(viewFor(s, 'aaa').provinces['bbb-2']!.intel).toMatchObject({
      economic: false,
      military: true,
    });
    // Imagerie de sa propre province : sans effet.
    signal(s, 'imagery', { nation: 'aaa', pids: ['aaa-1'], kind: 'satellite' });
    expect(viewFor(s, 'aaa').provinces['aaa-1']!.intel).toBeUndefined();
  });

  it("l'information vieillit : date figée, état des bâtiments masqué au-delà de provinceStaleH", () => {
    const s = intelGame();
    runOp(s, 'aaa', 'recon_military', { provinceId: 'bbb-2' });
    const t0 = s.time;
    const fake = (): PlayerView =>
      ({
        provinces: {
          'bbb-2': {
            id: 'bbb-2',
            owner: 'bbb',
            buildings: [...BBB2],
            buildingState: BBB2.map((type) => ({ type, health: 0.5 })),
          },
        },
      }) as unknown as PlayerView;
    let v = fake();
    filterProvinces(s, 'aaa', v);
    const pv = v.provinces['bbb-2']!;
    expect(pv.buildingState!.map((b) => b.type)).toEqual(pv.buildings);
    expect(pv.intel!.updatedAt).toBe(t0);

    advanceTo(s, t0 + 4 * DAY);
    v = fake();
    filterProvinces(s, 'aaa', v);
    expect(v.provinces['bbb-2']!.buildingState).toBeUndefined();
    expect(v.provinces['bbb-2']!.intel!.updatedAt).toBe(t0);
    // La frontière, observée en continu, est datée du jour.
    expect(viewFor(s, 'aaa').provinces['bbb-4']!.intel!.updatedAt).toBe(4 * DAY);
  });

  it('agents implantés : révèlent chaque jour un peu plus du pays hôte', () => {
    const s = intelGame();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb' });
    const level = () =>
      ['bbb-1', 'bbb-2', 'bbb-3', 'bbb-4', 'bbb-5']
        .map((p) => viewFor(s, 'aaa').provinces[p]!.intel!)
        .reduce((a, k) => a + (k.economic ? 1 : 0) + (k.military ? 1 : 0) + k.level, 0);
    const before = level();
    advanceTo(s, s.time + 3 * DAY);
    expect(level()).toBeGreaterThan(before);
  });

  it("province conquise : l'ancien propriétaire garde une connaissance complète datée", () => {
    const s = intelGame();
    // Crochet appelé par le cœur à la capture ; la province passe ensuite à ccc (propriétaire étranger).
    intelModule.hooks!.onProvinceCaptured!(s, 'bbb-2', 'bbb', 'aaa');
    s.provinces['bbb-2']!.owner = 'ccc';
    const pv = viewFor(s, 'bbb').provinces['bbb-2']!;
    expect(pv.intel).toMatchObject({ level: 3, economic: true, military: true, updatedAt: 0 });
    expect([...pv.buildings].sort()).toEqual([...BBB2].sort());
  });
});
