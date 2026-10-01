/** Vérifications des données de carte générées (data/map, data/basemap). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gridDisk } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  CellsFileSchema,
  DisputedAreaSchema,
  frA,
  frDe,
  NationDefSchema,
  ProvinceDefSchema,
  StraitSchema,
} from '@redline/shared';
import { NATION_ARTICLE } from '../src/articles.js';
import { cellOf, navalCells, seaPath } from '../src/cells.js';
import { SEA_LINKS, VIOLET_HUE_RANGE } from '../src/config.js';
import { hueOf } from '../src/economy.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'data');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as unknown;
const size = (p: string) => statSync(join(ROOT, p)).size;

const nations = NationDefSchema.array().parse(read('map/nations.json'));
const provinces = ProvinceDefSchema.array().parse(read('map/provinces.json'));
const cellsRaw = read('map/cells.json') as { impassable?: string[] };
const cells = CellsFileSchema.parse(cellsRaw);
const straits = StraitSchema.array().parse(read('map/straits.json'));
const disputed = DisputedAreaSchema.array().parse(read('map/disputed.json'));
const geo = read('map/provinces.geojson') as {
  features: { properties: { id: string }; geometry: { type: string } }[];
};

const provById = new Map(provinces.map((p) => [p.id, p]));
const nationById = new Map(nations.map((n) => [n.id, n]));
const cellsOf = new Map<string, string[]>();
for (const [c, id] of Object.entries(cells.cells)) {
  const l = cellsOf.get(id) ?? [];
  l.push(c);
  cellsOf.set(id, l);
}

describe('nations', () => {
  it('identifiants uniques, Gaza / Autorité palestinienne / Israël distincts', () => {
    expect(new Set(nations.map((n) => n.id)).size).toBe(nations.length);
    for (const id of ['gaza', 'pse', 'isr']) expect(nationById.has(id)).toBe(true);
    expect(nations.length).toBeGreaterThan(180);
  });
  it('chaque nation a une capitale existante, à elle, marquée isCapital', () => {
    for (const n of nations) {
      const cap = provById.get(n.capitalProvinceId);
      expect(cap, n.id).toBeDefined();
      expect(cap!.nationId).toBe(n.id);
      expect(cap!.isCapital).toBe(true);
    }
    expect(provinces.filter((p) => p.isCapital).length).toBe(nations.length);
  });
  it('couleurs : jamais de violet, deux voisins jamais de la même couleur', () => {
    for (const n of nations) {
      const h = hueOf(n.color);
      expect(h >= VIOLET_HUE_RANGE[0] && h <= VIOLET_HUE_RANGE[1], `${n.id} ${n.color}`).toBe(
        false,
      );
    }
    for (const p of provinces)
      for (const o of p.neighbors) {
        const a = p.nationId,
          b = provById.get(o)!.nationId;
        if (a !== b)
          expect(nationById.get(a)!.color, `${a}/${b}`).not.toBe(nationById.get(b)!.color);
      }
  });
  it('chaque nation a son article français (donnée du pipeline, élision cohérente)', () => {
    expect(Object.keys(NATION_ARTICLE).sort()).toEqual(nations.map((n) => n.id).sort());
    for (const n of nations) {
      expect(n.article, n.id).toBeDefined();
      expect(n.article, n.id).toBe(NATION_ARTICLE[n.id]);
      // « l' » seulement devant voyelle ou h muet ; jamais « le / la » devant voyelle.
      const vowel = /^[aeiouàâéèêîïôûœ]/i.test(n.name);
      if (n.article === "l'") expect(vowel || /^h/i.test(n.name), n.id).toBe(true);
      if (n.article === 'le' || n.article === 'la') expect(vowel, n.id).toBe(false);
    }
    const de = (id: string) => frDe(nationById.get(id)!.name, nationById.get(id)!.article);
    expect(de('mar')).toBe('du Maroc');
    expect(de('usa')).toBe('des États-Unis');
    expect(de('dza')).toBe("de l'Algérie");
    expect(de('isr')).toBe("d'Israël");
    expect(frA(nationById.get('cub')!.name, nationById.get('cub')!.article)).toBe('à Cuba');
  });
});

describe('provinces', () => {
  it('identifiants <nation>-<n> continus, au moins une province par nation', () => {
    const byNation = new Map<string, number[]>();
    for (const p of provinces) {
      const m = /^(.+)-(\d+)$/.exec(p.id);
      expect(m, p.id).not.toBeNull();
      expect(m![1]).toBe(p.nationId);
      expect(nationById.has(p.nationId)).toBe(true);
      const l = byNation.get(p.nationId) ?? [];
      l.push(Number(m![2]));
      byNation.set(p.nationId, l);
    }
    for (const n of nations) {
      const l = (byNation.get(n.id) ?? []).sort((a, b) => a - b);
      expect(l.length, n.id).toBeGreaterThan(0);
      expect(l).toEqual(l.map((_, i) => i + 1));
    }
    expect(provinces.length).toBeGreaterThanOrEqual(2000);
    expect(provinces.length).toBeLessThanOrEqual(3500);
  });
  it('voisinages symétriques et existants', () => {
    for (const p of provinces)
      for (const o of p.neighbors) {
        expect(provById.has(o), `${p.id} → ${o}`).toBe(true);
        expect(provById.get(o)!.neighbors, `${o} ↛ ${p.id}`).toContain(p.id);
        expect(o).not.toBe(p.id);
      }
  });
  it('revenus raisonnables', () => {
    for (const p of provinces) {
      expect(p.income.money).toBeGreaterThanOrEqual(20);
      expect(p.income.money).toBeLessThanOrEqual(400);
    }
  });
  it('géométrie : une entité par province, mêmes identifiants', () => {
    expect(geo.features.length).toBe(provinces.length);
    expect(new Set(geo.features.map((f) => f.properties.id))).toEqual(new Set(provById.keys()));
  });
});

describe('grille H3', () => {
  it('résolution 4, cellules vers des provinces existantes', () => {
    expect(cells.res).toBe(4);
    for (const id of new Set(Object.values(cells.cells))) expect(provById.has(id), id).toBe(true);
  });
  it('chaque province a au moins une cellule, dont celle de sa ville', () => {
    for (const p of provinces) {
      expect(cellsOf.get(p.id)?.length ?? 0, p.id).toBeGreaterThan(0);
      expect(cells.cells[cellOf(p.cityPoint, 4)], p.id).toBe(p.id);
    }
  });
  it('les micro-États existent (Monaco, Vatican, Gaza…)', () => {
    for (const id of ['mco', 'vat', 'smr', 'lie', 'gaza', 'sgp', 'mlt', 'bhr'])
      expect(cellsOf.get(`${id}-1`)?.length ?? 0, id).toBeGreaterThan(0);
  });
});

describe('détroits', () => {
  const naval = navalCells(
    Object.keys(cells.cells),
    cellsRaw.impassable ?? [],
    straits.flatMap((s) => s.seaCells),
    4,
  );
  it.each(SEA_LINKS.map((l) => [l.name, l] as const))('%s', (_n, l) => {
    expect(seaPath(naval, l.from, l.to, l.maxKm, 4)).toBeGreaterThan(0);
  });
  it('les cellules de détroit forment des chemins contigus', () => {
    for (const s of straits)
      for (let i = 1; i < s.seaCells.length; i++)
        expect(gridDisk(s.seaCells[i - 1]!, 1), s.id).toContain(s.seaCells[i]);
  });
});

describe('zones disputées', () => {
  it('provinces et prétendants existants', () => {
    for (const d of disputed) {
      expect(d.provinceIds.length, d.id).toBeGreaterThan(0);
      for (const id of d.provinceIds) expect(provById.has(id)).toBe(true);
      for (const c of d.claimants) expect(nationById.has(c), c).toBe(true);
    }
  });
});

describe('tailles', () => {
  it('fichiers dans le budget', () => {
    expect(size('map/provinces.geojson')).toBeLessThanOrEqual(6e6);
    expect(size('map/cells.json')).toBeLessThanOrEqual(4e6);
    const base = readdirSync(join(ROOT, 'basemap'))
      .filter((f) => f.endsWith('.geojson'))
      .reduce((s, f) => s + size(`basemap/${f}`), 0);
    expect(base).toBeLessThan(3e6);
  });
});
