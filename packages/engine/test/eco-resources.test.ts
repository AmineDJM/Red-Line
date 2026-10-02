import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type MapData, type ProvinceResource } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, viewFor } from '../src/index.js';
import { ecoAiThink } from '../src/modules/eco/ai.js';
import { provinceIncome } from '../src/modules/eco/budget.js';
import { buildRestriction, provinceResources } from '../src/modules/eco/buildings.js';
import { eco } from '../src/modules/eco/state.js';
import {
  ECO_BALANCE,
  ECO_CATALOG,
  ORBATS,
  RESEARCH,
  ecoGame,
  ecoMap,
  ecoWorld,
} from './eco-fixtures.js';

/**
 * Ressources des provinces : aaa-1 pétrole majeur + métaux modestes (secondaires), aaa-2 (capitale)
 * argent seulement (services), aaa-3 grenier agricole ; aaa-3 garde une mine héritée d'une ancienne
 * sauvegarde (bâtiment de la carte) sans avoir de métaux.
 */
const RES: Record<string, ProvinceResource[]> = {
  'aaa-1': [
    { type: 'oil', richness: 3, source: 'data' },
    { type: 'metals', richness: 1, source: 'heuristic' },
  ],
  'aaa-2': [],
  'aaa-3': [{ type: 'food', richness: 2, source: 'data' }],
};

function resMap(extra: Record<string, string[]> = {}): MapData {
  const m = ecoMap();
  return {
    ...m,
    provinces: m.provinces.map((p) => ({
      ...p,
      ...(RES[p.id] ? { resources: RES[p.id] } : {}),
      buildings: [...p.buildings, ...((extra[p.id] ?? []) as typeof p.buildings)],
    })),
  };
}

const resWorld = (extra?: Record<string, string[]>) =>
  buildWorld(resMap(extra), ECO_CATALOG, ECO_BALANCE, {
    research: RESEARCH,
    orbats: { '2025': ORBATS },
  });

const opt = (s: ReturnType<typeof ecoGame>, pid: string, type: string) =>
  viewFor(s, 'aaa').provinces[pid]!.buildOptions!.find((o) => o.type === type)!;

describe('ressources des provinces : constructions permises', () => {
  it('menu Construire : bâtiments d’extraction grisés avec la raison si la ressource manque', () => {
    const s = ecoGame({ world: resWorld() });
    expect(opt(s, 'aaa-3', 'mine').blocked).toBe('no_resource');
    expect(opt(s, 'aaa-3', 'oil_field').blocked).toBe('no_resource');
    expect(opt(s, 'aaa-3', 'farm').blocked).toBeUndefined();
    expect(opt(s, 'aaa-1', 'oil_field').blocked).toBeUndefined();
    expect(opt(s, 'aaa-1', 'mine').blocked).toBeUndefined();
    expect(opt(s, 'aaa-1', 'farm').blocked).toBe('no_resource');
    // Capitale « argent seulement » : aucune extraction, mais industrie, électronique (grande ville),
    // bâtiments militaires et défenses restent permis.
    for (const b of ['oil_field', 'mine', 'farm'])
      expect(opt(s, 'aaa-2', b).blocked, b).toBe('no_resource');
    for (const b of ['local_industry', 'electronics_plant', 'military_base', 'bunker'])
      expect(opt(s, 'aaa-2', b)?.blocked, b).toBeUndefined();
    // Petite ville hors pôle électronique : pas d'usine d'électronique.
    expect(opt(s, 'aaa-3', 'electronics_plant').blocked).toBe('not_urban');
  });

  it('ordre refusé (message clair) sans la ressource, accepté avec', () => {
    const s = ecoGame({ world: resWorld() });
    const m0 = s.nations.aaa!.money;
    const r = applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'oil_field' });
    expect(r).toMatchObject({ ok: false, error: 'resource_required' });
    expect(r.ok ? '' : r.message).toMatch(/Ressource absente/);
    expect(s.nations.aaa!.money).toBe(m0);
    expect(applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'farm' }).ok).toBe(
      true,
    );
    expect(
      applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-1', building: 'oil_field' }).ok,
    ).toBe(true);
  });

  it('compatibilité : un bâtiment déjà présent sans la ressource reste valide et améliorable', () => {
    const s = ecoGame({ world: resWorld({ 'aaa-3': ['mine'] }) });
    expect(viewFor(s, 'aaa').provinces['aaa-3']!.buildings).toContain('mine');
    expect(applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }).ok).toBe(
      true,
    );
    advanceTo(s, 400 * HOUR);
    expect(
      viewFor(s, 'aaa').provinces['aaa-3']!.buildingState!.find((b) => b.type === 'mine')!.level,
    ).toBe(2);
  });

  it('carte sans ressources (ancienne) : aucune restriction d’extraction', () => {
    const s = ecoGame({ world: ecoWorld() });
    expect(opt(s, 'aaa-3', 'mine').blocked).toBeUndefined();
    expect(buildRestriction(ecoWorld(), 'aaa-3', 'oil_field')).toBeNull();
  });
});

describe('ressources des provinces : rendement, revenus, IA, rejeu', () => {
  it('rendement selon la richesse : principale majeure > secondaire modeste', () => {
    const s = ecoGame({ world: resWorld() });
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-1', building: 'oil_field' });
    applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-1', building: 'mine' });
    advanceTo(s, 241 * HOUR);
    const y = provinceResources(s, 'aaa-1');
    // Raffinerie (20) + pétrole 5 + 5 × 0,5 × 1,25 (richesse 3, principale) ; métaux 5 + 5 × 0,5 ×
    // 0,8 × 0,7 (richesse 1, secondaire).
    expect(y.oil).toBeCloseTo(20 + 5 + 5 * 0.5 * 1.25, 9);
    expect(y.metals).toBeCloseTo(5 + 5 * 0.5 * 0.8 * 0.7, 9);
    // Sans données de ressources : facteur 1.
    const s0 = ecoGame({ world: ecoWorld() });
    applyOrder(s0, 'aaa', { kind: 'build', provinceId: 'aaa-1', building: 'oil_field' });
    advanceTo(s0, 241 * HOUR);
    expect(provinceResources(s0, 'aaa-1').oil).toBeCloseTo(20 + 5 + 5 * 0.5, 9);
  });

  it('province « argent seulement » : bonus de services sur le revenu (+10 %)', () => {
    const a = provinceIncome(ecoGame({ world: resWorld() }), 'aaa-2');
    const b = provinceIncome(ecoGame({ world: ecoWorld() }), 'aaa-2');
    expect(b).toBeGreaterThan(0);
    expect(a / b).toBeCloseTo(1.1, 9);
    // Une province à ressources n'a pas le bonus.
    expect(provinceIncome(ecoGame({ world: resWorld() }), 'aaa-1')).toBeCloseTo(
      provinceIncome(ecoGame({ world: ecoWorld() }), 'aaa-1'),
      9,
    );
  });

  it('IA économique : investit là où la ressource est la plus riche, jamais sans ressource', () => {
    const s = ecoGame({ world: resWorld() });
    s.nations.aaa!.money = 1e13;
    ecoAiThink(s, 'aaa');
    const jobs = Object.values(eco(s).jobs).filter((j) => j.n === 'aaa');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ pid: 'aaa-1', kind: 'oil_field' });
    // Plusieurs tours : jamais un bâtiment interdit.
    for (let d = 1; d <= 40; d++) {
      advanceTo(s, d * 10 * DAY);
      s.nations.aaa!.money = 1e13;
      ecoAiThink(s, 'aaa');
    }
    for (const pid of ['aaa-1', 'aaa-2', 'aaa-3'])
      for (const b of viewFor(s, 'aaa').provinces[pid]!.buildings)
        expect(buildRestriction(s.world, pid, b), `${pid} ${b}`).toBeNull();
    expect(viewFor(s, 'aaa').provinces['aaa-3']!.buildings).toContain('farm');
    expect(viewFor(s, 'aaa').provinces['aaa-2']!.buildings).toContain('local_industry');
  });

  it('déterministe : même partie, mêmes ordres ⇒ même état', () => {
    const run = () => {
      const s = ecoGame({ world: resWorld() });
      applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' });
      applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'farm' });
      s.nations.bbb!.money = 1e13;
      ecoAiThink(s, 'bbb');
      advanceTo(s, 30 * DAY);
      return JSON.stringify({ a: viewFor(s, 'aaa'), m: s.nations, e: eco(s) });
    };
    expect(run()).toBe(run());
  });
});
