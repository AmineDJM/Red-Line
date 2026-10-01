import { describe, expect, it } from 'vitest';
import { BalanceSchema, HOUR, type IntelOpTarget } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { cfg } from '../src/modules/intel/config.js';
import { MILITARY_BUILDINGS } from '../src/modules/intel/provinces.js';
import { ist, type StoredOp } from '../src/modules/intel/state.js';
import { BALANCE, CATALOG, buildMap } from './fixtures.js';
import { BBB2, BBB5 } from './intel-helpers.js';

/**
 * Reconnaissance d'un pays entier : phases successives, capitale et grandes villes d'abord, puis le
 * reste du pays (missions répétées). Monde de test : bbb s'appelle « Espagne » (article « l' »), ses
 * provinces ont un rang de ville et une population ; une province couverte par phase, trois phases.
 */

let cached: World | null = null;
function reconWorld(): World {
  if (cached) return cached;
  const map = buildMap();
  const extra: Record<string, { buildings?: typeof BBB2; cityRank?: number; population?: number }> =
    {
      'bbb-1': { buildings: ['military_base', 'farm'], cityRank: 3, population: 400_000 },
      'bbb-2': { buildings: [...BBB2], cityRank: 1, population: 5_000_000 },
      'bbb-3': { buildings: ['air_base', 'refinery'], cityRank: 4, population: 90_000 },
      'bbb-4': { buildings: ['radar_station'], cityRank: 3, population: 200_000 },
      'bbb-5': { buildings: [...BBB5], cityRank: 2, population: 1_500_000 },
    };
  const provinces = map.provinces.map((p) => ({ ...p, ...extra[p.id] }));
  const nations = map.nations.map((n) =>
    n.id === 'bbb' ? { ...n, name: 'Espagne', article: "l'" as const } : n,
  );
  const balance = BalanceSchema.parse({
    ...BALANCE,
    intel: {
      reconNation: {
        ops: {
          recon_military: { money: 8e6, durationH: 30, baseSuccess: 0.7, exposure: 0.25 },
          recon_economic: { money: 6e6, durationH: 30, baseSuccess: 0.75, exposure: 0.2 },
        },
        waves: 3,
        provincesPerWave: 1,
        levels: 2,
        qualityBonus: 0,
      },
    },
    buildings: { distribute: false },
  });
  cached = buildWorld({ ...map, nations, provinces }, CATALOG, balance);
  return cached;
}

function game(seed = 7): EngineState {
  const s = createGame(reconWorld(), {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
      { nationId: 'ccc', isAi: true },
      { nationId: 'ddd', isAi: true },
    ],
    units: [],
  }) as EngineState;
  for (const n of s.nationIds) s.nations[n]!.money = 1e10;
  return s;
}

/** Lance une mission (issue forcée si demandé) sans avancer le temps. */
function launch(
  s: EngineState,
  op: 'recon_military' | 'recon_economic',
  target: IntelOpTarget,
  outcome: 'success' | 'failure' | 'natural' = 'success',
): StoredOp {
  const r = applyOrder(s, 'aaa', { kind: 'intelOp', op, target });
  if (!r.ok) throw new Error(r.message);
  const ops = ist(s).nations.aaa!.ops;
  const o = ops[ops.length - 1]!;
  if (outcome !== 'natural') o.estimate = outcome === 'success' ? 1 : 0;
  return o;
}

/** Provinces de bbb dont au moins une installation militaire est visible de aaa. */
function milRevealed(s: EngineState): string[] {
  const v = viewFor(s, 'aaa');
  return ['bbb-1', 'bbb-2', 'bbb-3', 'bbb-4', 'bbb-5'].filter((p) =>
    v.provinces[p]!.buildings.some((b) => MILITARY_BUILDINGS.has(b)),
  );
}

describe('renseignement : reconnaissance d’un pays entier', () => {
  it('cible nation : coût et durée de reconNation, phases visibles dans la vue', () => {
    const s = game();
    const money = s.nations.aaa!.money;
    const o = launch(s, 'recon_military', { nationId: 'bbb' });
    const c = cfg(s).reconNation.ops.recon_military;
    expect(s.nations.aaa!.money).toBe(money - c.money);
    expect(o.completesAt - o.startedAt).toBe(30 * HOUR);
    expect(o.target).toEqual({ nationId: 'bbb' });
    const ov = viewFor(s, 'aaa').intel!.operations.find((x) => x.id === o.id)!;
    expect(ov.recon).toEqual({ waves: 3, done: 0, ok: 0, provinces: 0 });
    // La cible province reste possible, au coût d'une mission ciblée.
    const before = s.nations.aaa!.money;
    launch(s, 'recon_economic', { provinceId: 'bbb-3' });
    expect(s.nations.aaa!.money).toBe(before - cfg(s).ops.recon_economic.money);
    // Sa propre nation : refusée.
    expect(
      applyOrder(s, 'aaa', { kind: 'intelOp', op: 'recon_military', target: { nationId: 'aaa' } })
        .ok,
    ).toBe(false);
  });

  it('révélation progressive : capitale, grandes villes, puis le reste au fil des missions', () => {
    const s = game();
    const o = launch(s, 'recon_military', { nationId: 'bbb' });
    // Seule la frontière (bbb-4, aperçu) peut montrer quelque chose avant la première phase.
    expect(milRevealed(s).filter((p) => p !== 'bbb-4')).toEqual([]);
    const t0 = o.startedAt;
    // Phase 1 (10 h) : la capitale.
    advanceTo(s, t0 + 10 * HOUR);
    let pv = viewFor(s, 'aaa').provinces['bbb-2']!;
    expect(pv.intel).toMatchObject({ m: 2, e: 0, military: true, economic: false });
    expect(pv.buildings.length).toBeGreaterThan(0);
    expect(pv.buildings.every((b) => MILITARY_BUILDINGS.has(b))).toBe(true);
    expect(viewFor(s, 'aaa').provinces['bbb-5']!.intel!.m).toBe(0);
    let ov = viewFor(s, 'aaa').intel!.operations.find((x) => x.id === o.id)!;
    expect(ov.status).toBe('running');
    expect(ov.recon).toEqual({ waves: 3, done: 1, ok: 1, provinces: 1 });
    // Phase 2 : la grande ville (rang 2).
    advanceTo(s, t0 + 20 * HOUR);
    expect(viewFor(s, 'aaa').provinces['bbb-5']!.intel!.m).toBe(2);
    expect(viewFor(s, 'aaa').provinces['bbb-1']!.intel!.m).toBe(0);
    // Phase 3 (fin) : rang 3, la plus peuplée (bbb-1 avant bbb-4).
    advanceTo(s, o.completesAt);
    expect(viewFor(s, 'aaa').provinces['bbb-1']!.intel!.m).toBe(2);
    ov = viewFor(s, 'aaa').intel!.operations.find((x) => x.id === o.id)!;
    expect(ov.status).toBe('success');
    expect(ov.recon).toEqual({ waves: 3, done: 3, ok: 3, provinces: 3 });

    // Rapport final : clair, avec l'article du pays.
    const rep = viewFor(s, 'aaa').intel!.reports.find((r) =>
      r.title.startsWith('Reconnaissance militaire'),
    )!;
    expect(rep.title).toBe('Reconnaissance militaire — Espagne');
    expect(rep.subject).toEqual({ nationId: 'bbb' });
    expect(rep.body).toContain(
      "Mission menée sur le territoire de l'Espagne : 3 phases sur 3 abouties.",
    );
    expect(rep.body).toContain(
      'Provinces couvertes (3) : Province bbb-2, Province bbb-5, Province bbb-1.',
    );
    expect(rep.body).toContain('Province bbb-2 : base navale, station radar.');
    expect(rep.body).toContain("Connaissance militaire de l'Espagne : 3 provinces révélées sur 5.");
    expect(rep.body).toContain(
      'Une nouvelle mission étendra la reconnaissance aux 2 autres provinces.',
    );
    expect(rep.reliability).toMatch(/[A-F]/);
    expect(rep.credibility).toBeGreaterThanOrEqual(1);
    expect(rep.actions[0]).toEqual({ kind: 'open_province', provinceId: 'bbb-2' });

    // Mission suivante : le reste du pays (bbb-4 puis bbb-3), puis la connaissance complète.
    const o2 = launch(s, 'recon_military', { nationId: 'bbb' });
    advanceTo(s, o2.completesAt);
    const v = viewFor(s, 'aaa');
    expect(v.provinces['bbb-4']!.intel!.m).toBe(3); // aperçu (1) + 2
    expect(v.provinces['bbb-3']!.intel!.m).toBe(2);
    expect(v.provinces['bbb-2']!.intel!.m).toBe(3); // troisième phase : on complète la capitale
    expect(milRevealed(s).length).toBeGreaterThanOrEqual(4);
    // L'axe économique n'a pas bougé.
    for (const p of ['bbb-1', 'bbb-2', 'bbb-3', 'bbb-5']) expect(v.provinces[p]!.intel!.e).toBe(0);
    const rep2 = v.intel!.reports.find((r) => r.title.startsWith('Reconnaissance militaire'))!;
    expect(rep2.body).toContain(
      "Connaissance militaire de l'Espagne : 5 provinces révélées sur 5.",
    );
    expect(rep2.body).toContain(
      "Territoire de l'Espagne entièrement reconnu (installations militaires).",
    );
  });

  it('reconnaissance économique : installations économiques seulement', () => {
    const s = game();
    const o = launch(s, 'recon_economic', { nationId: 'bbb' });
    advanceTo(s, o.completesAt);
    const pv = viewFor(s, 'aaa').provinces['bbb-2']!;
    expect(pv.intel).toMatchObject({ e: 2, m: 0 });
    expect(pv.buildings.some((b) => MILITARY_BUILDINGS.has(b))).toBe(false);
    const rep = viewFor(s, 'aaa').intel!.reports[0]!;
    expect(rep.title).toBe('Reconnaissance économique — Espagne');
    expect(rep.body).toContain(
      "Connaissance économique de l'Espagne : 3 provinces révélées sur 5.",
    );
  });

  it('échec : aucune phase aboutie, rien de révélé, rapport d’échec ou de compromission', () => {
    const s = game();
    const o = launch(s, 'recon_military', { nationId: 'bbb' }, 'failure');
    advanceTo(s, o.completesAt);
    expect(milRevealed(s).filter((p) => p !== 'bbb-4')).toEqual([]);
    expect(viewFor(s, 'aaa').provinces['bbb-2']!.intel!.m).toBe(0);
    expect(['failed', 'compromised']).toContain(o.status);
    const rep = viewFor(s, 'aaa').intel!.reports[0]!;
    expect(rep.title).toMatch(/^Reconnaissance militaire — (échec|compromise)$/);
    if (o.status === 'compromised') {
      expect(rep.body).toContain("Mission repérée par les services de l'Espagne");
      // La victime en est informée (attribution SIGINT).
      expect(viewFor(s, 'bbb').intel!.reports.some((r) => r.title.includes('attribuée'))).toBe(
        true,
      );
    } else expect(rep.body).toContain("Aucune des 3 phases de la mission n'a abouti.");
  });

  it('mission repérée en cours de route : interrompue, phases suivantes sans effet', () => {
    // Graine cherchée : une phase manquée puis repérée avant la fin.
    let found = false;
    for (let seed = 1; seed < 400 && !found; seed++) {
      const s = game(seed);
      const o = launch(s, 'recon_military', { nationId: 'bbb' }, 'failure');
      advanceTo(s, o.startedAt + 10 * HOUR);
      if (o.status !== 'compromised') continue;
      found = true;
      advanceTo(s, o.completesAt + HOUR);
      expect(o.rn!.w).toBe(1);
      expect(viewFor(s, 'aaa').intel!.departments.find((d) => d.id === 'military')!.running).toBe(
        0,
      );
    }
    expect(found).toBe(true);
  });

  it('déterminisme : rejeu identique et reprise après sérialisation en pleine mission', () => {
    const run = (seed: number) => {
      const s = game(seed);
      const o = launch(s, 'recon_military', { nationId: 'bbb' }, 'natural');
      advanceTo(s, o.startedAt + 15 * HOUR);
      return s;
    };
    const a = run(21);
    const b = run(21);
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(reconWorld(), serializeState(a)) as unknown as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    for (const s of [a, c]) advanceTo(s, s.time + 40 * HOUR);
    expect(stateHash(c)).toBe(stateHash(a));
    expect(JSON.stringify(viewFor(c, 'aaa').provinces)).toBe(
      JSON.stringify(viewFor(a, 'aaa').provinces),
    );
    const op = ist(c).nations.aaa!.ops[0]!;
    expect(op.status).not.toBe('running');
    expect(op.rn!.w).toBeGreaterThanOrEqual(1);
  });

  it('sauvegarde antérieure aux phases : la mission sur une nation garde l’ancien déroulement', () => {
    const s = game();
    const o = launch(s, 'recon_military', { nationId: 'bbb' });
    delete o.rn; // mission lancée par une version sans phases : événements de phase ignorés
    advanceTo(s, o.completesAt);
    expect(o.status).toBe('success');
    const v = viewFor(s, 'aaa');
    // +1 niveau sur reconProvinces provinces (5 ici) : toutes les provinces de bbb progressent.
    expect(v.provinces['bbb-2']!.intel!.m).toBe(1);
    expect(v.provinces['bbb-3']!.intel!.m).toBe(1);
  });
});
