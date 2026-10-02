/** Ressources des provinces (data/map/provinces.json, champ `resources`) et pipeline associé. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProvinceDefSchema, RESOURCES, type ProvinceDef } from '@redline/shared';
import { RESOURCE_ZONES } from '../src/resources-data.js';
import {
  MICRO_STATE_KM2,
  assignResources,
  fallbackProvince,
  heuristicDeposits,
  reshapeIncome,
  resolveRef,
  type Deposit,
} from '../src/resources.js';

const FILE = join(import.meta.dirname, '..', '..', '..', 'data', 'map', 'provinces.json');
const provinces = ProvinceDefSchema.array().parse(JSON.parse(readFileSync(FILE, 'utf8')));
const find = (nation: string, name: string): ProvinceDef => {
  const p = resolveRef(`${nation}:${name}`, provinces)[0];
  if (!p) throw new Error(`${nation}:${name}`);
  return p;
};
const kinds = (p: ProvinceDef) => p.resources!.map((d) => `${d.type}${d.richness}`);

describe('ressources des provinces', () => {
  it('couverture : chaque province a ses ressources (0 à 2), principale d’abord', () => {
    for (const p of provinces) {
      expect(p.resources, p.id).toBeDefined();
      expect(p.resources!.length, p.id).toBeLessThanOrEqual(2);
      if (p.resources!.length === 2) expect(p.resources![0]!.type).not.toBe(p.resources![1]!.type);
    }
    const none = provinces.filter((p) => p.resources!.length === 0).length;
    // « Parfois rien, juste l'argent » : une minorité, mais pas une exception.
    expect(none / provinces.length).toBeGreaterThan(0.08);
    expect(none / provinces.length).toBeLessThan(0.35);
  });

  it('données sourcées : chaque province désignée existe, chaque zone touche une province', () => {
    for (const z of RESOURCE_ZONES) {
      for (const ref of z.provinces ?? []) expect(resolveRef(ref, provinces), ref).not.toEqual([]);
      expect(z.source.length, z.id).toBeGreaterThan(0);
    }
    expect(new Set(RESOURCE_ZONES.map((z) => z.id)).size).toBe(RESOURCE_ZONES.length);
  });

  it('reproductible : le fichier correspond exactement au pipeline (ressources et rendements)', () => {
    const deposits = assignResources(provinces);
    for (const p of provinces)
      expect(
        p.resources!.map((d) => ({ ...d })),
        p.id,
      ).toEqual(deposits.get(p.id));
    const incomes = reshapeIncome(provinces, deposits);
    for (const p of provinces) expect(p.income, p.id).toEqual(incomes.get(p.id));
  });

  it('rendements cohérents : une province ne produit que ses ressources', () => {
    for (const p of provinces)
      for (const r of RESOURCES) {
        const has = p.resources!.some((d) => d.type === r);
        expect((p.income[r] ?? 0) > 0, `${p.id} ${r}`).toBe(has);
      }
  });

  it('exemples réels : Alger sans pétrole, Sahara pétrolier, Pilbara, Katanga, Ruhr, Beauce…', () => {
    const alger = find('dza', 'Alger');
    expect(alger.isCapital).toBe(true);
    expect(alger.resources).toEqual([]);
    expect(alger.income.oil).toBeUndefined();
    expect(kinds(find('dza', 'Ouargla Nord-Est'))).toContain('oil3');
    expect(kinds(find('dza', 'Laghouat'))).toContain('oil3'); // Hassi R'Mel
    expect(kinds(find('aus', 'Australie-Occidentale Nord'))).toContain('metals3'); // Pilbara
    expect(kinds(find('cod', 'Katanga Sud-Est'))).toContain('metals3');
    expect(kinds(find('chl', 'Antofagasta'))).toContain('metals3');
    expect(kinds(find('rus', 'Khantys-Mansis Est'))).toContain('oil3');
    expect(kinds(find('usa', 'Texas Ouest'))).toContain('oil3'); // Permien
    expect(kinds(find('can', 'Alberta Nord'))).toContain('oil3');
    expect(kinds(find('nor', 'Rogaland'))).toContain('oil3');
    expect(kinds(find('nga', 'Rivers'))).toContain('oil3');
    expect(kinds(find('fra', 'Seine-et-Marne'))).toContain('food3'); // Beauce et Brie
    expect(kinds(find('ind', 'Pendjab Nord'))).toContain('food3');
    expect(kinds(find('ukr', 'Poltava'))).toContain('food3');
    expect(kinds(find('chn', 'Hong Kong (Yuen Long)'))).toContain('electronics3'); // Shenzhen
    expect(kinds(find('deu', 'Bavière Sud'))).toContain('electronics3');
    expect(kinds(find('deu', 'Rhénanie-du-Nord-Westphalie'))).toContain('electronics2'); // Ruhr
    expect(kinds(find('jpn', 'Kumamoto'))).toContain('electronics2'); // Kyūshū
    // Grandes capitales de services : argent seulement.
    for (const [n, c] of [
      ['fra', 'Paris'],
      ['gbr', 'Londres'],
      ['jpn', 'Tokyo'],
      ['egy', 'Le Caire'],
    ] as const)
      expect(find(n, c).resources, c).toEqual([]);
  });

  it('pas de gisement inventé dans une capitale (sauf désignation sourcée ou repli national)', () => {
    const explicit = new Set(
      RESOURCE_ZONES.flatMap((z) =>
        (z.provinces ?? []).flatMap((r) => resolveRef(r, provinces)),
      ).map((p) => p.id),
    );
    // Repli national : la capitale n'est retenue que pour une nation d'une seule province.
    const single = (p: ProvinceDef) => provinces.filter((x) => x.nationId === p.nationId).length;
    for (const p of provinces.filter((x) => x.isCapital))
      if (!explicit.has(p.id) && single(p) > 1) expect(p.resources, p.id).toEqual([]);
    expect(kinds(find('are', 'Abou Dabi'))).toContain('oil3');
  });

  it('aucune nation sans ressource : seuls les micro-États restent « argent seulement »', () => {
    const byNation = new Map<string, ProvinceDef[]>();
    for (const p of provinces) byNation.set(p.nationId, [...(byNation.get(p.nationId) ?? []), p]);
    const empty: string[] = [];
    for (const [n, list] of byNation) {
      if (list.some((p) => p.resources!.length > 0)) continue;
      empty.push(n);
      const area = list.reduce((s, p) => s + p.areaKm2, 0);
      expect(area, n).toBeLessThan(MICRO_STATE_KM2);
    }
    expect(empty.sort()).toEqual(['mco', 'smr', 'tuv', 'vat']);
    // Repli : nourriture modeste dans la plus grande province hors capitale.
    expect(kinds(find('sol', 'Somaliland Est'))).toEqual(['food1']);
    expect(find('sol', 'Somaliland Ouest').resources).toEqual([]);
    expect(kinds(find('and', 'Andorre-la-Vieille'))).toEqual(['food1']);
    expect(find('and', 'Andorre-la-Vieille').income.food).toBeGreaterThan(0);
  });

  it('pays réputés sans ressource : petites productions réelles sourcées', () => {
    expect(kinds(find('jpn', 'Niigata'))).toEqual(['food2', 'oil1']); // Minami-Nagaoka
    expect(kinds(find('jpn', 'Kumamoto'))).toEqual(['electronics2', 'metals1']); // Hishikari
    expect(kinds(find('sau', 'Qasim'))).toEqual(['food1']);
    expect(kinds(find('deu', 'Schleswig-Holstein'))).toContain('oil1'); // Mittelplate
    expect(kinds(find('nru', 'Anibare'))).toEqual(['metals1']); // phosphates
    expect(kinds(find('mlt', 'La Valette'))).toEqual(['electronics1']);
  });

  it('repli national : plus grande province hors capitale, aucun pour un micro-État', () => {
    const p = (id: string, areaKm2: number, isCapital = false) => ({
      id,
      name: id,
      nationId: 'x',
      centroid: [0, 0] as [number, number],
      cityPoint: [0, 0] as [number, number],
      isCapital,
      areaKm2,
      income: { money: 1 },
    });
    expect(fallbackProvince([p('x-1', 5000, true), p('x-2', 800), p('x-3', 1200)])!.id).toBe('x-3');
    expect(fallbackProvince([p('x-1', 450, true)])!.id).toBe('x-1');
    expect(fallbackProvince([p('x-1', 60, true)])).toBeNull();
    expect(fallbackProvince([])).toBeNull();
    // Idempotence : la répartition ne dépend que des données d'entrée.
    const a = assignResources(provinces);
    const b = assignResources(provinces);
    expect([...a]).toEqual([...b]);
  });

  it('heuristiques séparées : capitale, métropole, désert, grand Nord, campagne', () => {
    const base = {
      id: 'x-1',
      name: 'X',
      nationId: 'x',
      isCapital: false,
      income: { money: 50 },
      cityRank: 4,
      population: 500_000,
    };
    const at = (lng: number, lat: number, extra: object = {}): Deposit[] =>
      heuristicDeposits({
        ...base,
        centroid: [lng, lat],
        cityPoint: [lng, lat],
        areaKm2: 40_000,
        ...extra,
      });
    expect(at(2, 47, { isCapital: true })).toEqual([]);
    expect(at(2, 47, { cityRank: 2, population: 9e6 })).toEqual([]);
    expect(at(5, 25)).toEqual([]); // Sahara
    expect(at(30, 70).map((d) => d.type)).toEqual([]); // petite province arctique
    expect(at(30, 62).map((d) => d.type)).toEqual(['metals', 'food']);
    expect(at(2, 47).map((d) => d.type)).toEqual(['food']);
    expect(at(-110, 45).map((d) => d.type)).toEqual(['food', 'metals']); // Rocheuses
    for (const d of at(2, 47)) expect(d).toMatchObject({ richness: 1, source: 'heuristic' });
  });
});
