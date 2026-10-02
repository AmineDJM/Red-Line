/**
 * Fusion des provinces (src/consolidate.ts) : règle sur un cas synthétique, puis carte générée
 * comparée à la carte d'avant la fusion (data/map/archive/1, épinglée par les parties anciennes).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CellsFileSchema,
  NationDefSchema,
  ProvinceDefSchema,
  type ProvinceDef,
} from '@redline/shared';
import { cellOf } from '../src/cells.js';
import { CONSOLIDATE } from '../src/consolidate-config.js';
import { mergeTargetOf, planMerges, type MergeItem } from '../src/consolidate.js';
import type { Adjacency } from '../src/topology.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'data', 'map');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as unknown;

// ——— Cas synthétique ———

function item(id: string, over: Partial<MergeItem> = {}): MergeItem {
  return {
    id,
    nation: id.slice(0, id.lastIndexOf('-')),
    domain: 'main',
    region: '',
    unit: id,
    rawName: `P${id}`,
    area: 1000,
    pop: 1e5,
    center: [0, 0],
    city: [0, 0],
    cityPop: 1000,
    isCapital: false,
    ...over,
  };
}
/** Frontières communes (km) d'une liste de paires. */
function adjOf(pairs: [string, string, number?][]): Adjacency {
  const shared = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, l: number) => {
    const m = shared.get(a) ?? new Map<string, number>();
    m.set(b, l);
    shared.set(a, m);
  };
  for (const [a, b, l = 10] of pairs) {
    add(a, b, l);
    add(b, a, l);
  }
  return { shared, exterior: new Map() };
}

describe('fusion : règle', () => {
  // aaa : chaîne de 10 provinces ; bbb : 3 provinces (petite nation) ; aaa-11 : île ;
  // aaa-10 touche bbb-1 (frontière nationale).
  const items = [
    ...Array.from({ length: 10 }, (_, i) =>
      item(`aaa-${i + 1}`, { isCapital: i === 4, cityPop: i === 4 ? 9e6 : 1000 + i }),
    ),
    item('aaa-11'),
    item('bbb-1'),
    item('bbb-2'),
    item('bbb-3'),
  ];
  const pairs: [string, string][] = [];
  for (let i = 1; i < 10; i++) pairs.push([`aaa-${i}`, `aaa-${i + 1}`]);
  pairs.push(['aaa-10', 'bbb-1'], ['bbb-1', 'bbb-2'], ['bbb-2', 'bbb-3']);
  const adj = adjOf(pairs);
  const plan = planMerges(items, adj);
  const groupOf = new Map(plan.flatMap((g) => g.members.map((m) => [m, g] as const)));

  it('cible : moitié environ, petites nations inchangées, plancher keepUpTo', () => {
    expect(mergeTargetOf(3, 3)).toBe(3);
    expect(mergeTargetOf(CONSOLIDATE.keepUpTo, CONSOLIDATE.keepUpTo)).toBe(CONSOLIDATE.keepUpTo);
    expect(mergeTargetOf(6, 6)).toBe(CONSOLIDATE.keepUpTo);
    expect(mergeTargetOf(6, 5)).toBe(CONSOLIDATE.keepUpTo - 1); // capitale ou île figée
    expect(mergeTargetOf(100, 100)).toBe(Math.round(100 * CONSOLIDATE.ratio));
    expect(mergeTargetOf(100, 90)).toBe(Math.round(90 * CONSOLIDATE.ratio));
    // aaa : 9 fusionnables (hors capitale et île) → round(9 × ratio) ou keepUpTo, plus la capitale
    // et l'île isolée, inchangées ; bbb : inchangée.
    const aaa = plan.filter((g) => g.members[0]!.startsWith('aaa'));
    expect(aaa.length).toBe(mergeTargetOf(11, 9) + 2);
    expect(plan.filter((g) => g.members[0]!.startsWith('bbb')).length).toBe(3);
  });

  it('jamais à travers une frontière nationale ni la mer ; provinces contiguës', () => {
    for (const g of plan) {
      expect(new Set(g.members.map((m) => m.slice(0, 3))).size).toBe(1);
      // contiguïté : chaque membre touche un autre membre du groupe
      if (g.members.length > 1)
        for (const m of g.members)
          expect(
            g.members.some((o) => o !== m && adj.shared.get(m)?.has(o)),
            m,
          ).toBe(true);
    }
    expect(groupOf.get('aaa-11')!.members).toEqual(['aaa-11']);
  });

  it('la province capitale reste telle quelle', () => {
    const g = groupOf.get('aaa-5')!;
    expect(g.members).toEqual(['aaa-5']);
    expect(g.name).toBe('Paaa-5');
    const off = planMerges(items, adj, { ...CONSOLIDATE, keepCapitals: false });
    const h = off.find((x) => x.members.includes('aaa-5'))!;
    expect(h.lead).toBe('aaa-5'); // fusionnée : la capitale reste le membre dominant
    expect(h.name).toBe('Paaa-5');
  });

  it('statut disputé et domaines (dépendances) jamais mélangés', () => {
    const its = [
      item('ccc-1'),
      item('ccc-2', { disputed: 'zone' }),
      item('ccc-3', { domain: 'dep' }),
      item('ccc-4'),
      item('ccc-5'),
      item('ccc-6'),
    ];
    const p = planMerges(
      its,
      adjOf([
        ['ccc-1', 'ccc-2'],
        ['ccc-2', 'ccc-3'],
        ['ccc-3', 'ccc-4'],
        ['ccc-4', 'ccc-5'],
        ['ccc-5', 'ccc-6'],
        ['ccc-1', 'ccc-4'],
      ]),
    );
    for (const g of p) {
      const ms = its.filter((i) => g.members.includes(i.id));
      expect(new Set(ms.map((m) => `${m.domain}|${m.disputed ?? ''}`)).size).toBe(1);
    }
  });

  it('déterministe et désactivable', () => {
    expect(planMerges(items, adj)).toEqual(plan);
    const off = planMerges(items, adj, { ...CONSOLIDATE, enabled: false });
    expect(off.length).toBe(items.length);
  });

  it('parties d’une unité découpée réunies : nom de l’unité', () => {
    const its = [1, 2, 3, 4, 5, 6].map((i) =>
      item(`ddd-${i}`, {
        unit: i <= 2 ? 'u1' : `u${i}`,
        rawName: i === 1 ? 'Adrar Nord' : i === 2 ? 'Adrar Sud' : `P${i}`,
        ...(i <= 2 ? { baseName: 'Adrar' } : {}),
        cityPop: i === 1 ? 5000 : 10,
      }),
    );
    const p = planMerges(
      its,
      adjOf([
        ['ddd-1', 'ddd-2'],
        ['ddd-2', 'ddd-3'],
        ['ddd-3', 'ddd-4'],
        ['ddd-4', 'ddd-5'],
        ['ddd-5', 'ddd-6'],
      ]),
    );
    const g = p.find((x) => x.members.includes('ddd-1'))!;
    expect(g.members).toEqual(['ddd-1', 'ddd-2']);
    expect(g.name).toBe('Adrar');
  });
});

// ——— Carte générée ———

const nations = NationDefSchema.array().parse(read('nations.json'));
const provinces = ProvinceDefSchema.array().parse(read('provinces.json'));
const cells = CellsFileSchema.parse(read('cells.json'));
const old = ProvinceDefSchema.array().parse(read('archive/1/provinces.json'));
const oldCells = CellsFileSchema.parse(read('archive/1/cells.json'));
const oldNations = NationDefSchema.array().parse(read('archive/1/nations.json'));
const aliases = read('aliases.json') as Record<string, string>;
const provById = new Map(provinces.map((p) => [p.id, p]));
const count = (list: ProvinceDef[]) => {
  const m = new Map<string, number>();
  for (const p of list) m.set(p.nationId, (m.get(p.nationId) ?? 0) + 1);
  return m;
};
const before = count(old);
const after = count(provinces);

/** Province fusionnée de chaque ancienne province (par ses cellules : la fusion est une union). */
const oldToNew = new Map<string, Set<string>>();
for (const [c, id] of Object.entries(oldCells.cells)) {
  const s = oldToNew.get(id) ?? new Set<string>();
  s.add(cells.cells[c]!);
  oldToNew.set(id, s);
}

describe('fusion : carte générée (comparée à data/map/archive/1)', () => {
  it('environ deux fois moins de provinces', () => {
    expect(old.length).toBe(2567);
    expect(provinces.length / old.length).toBeGreaterThan(0.45);
    expect(provinces.length / old.length).toBeLessThan(0.55);
    // nations très découpées : divisées par deux ou un peu plus, hors provinces figées (capitale,
    // îles et territoires sans voisine de la même nation)
    const oldById = new Map(old.map((p) => [p.id, p]));
    for (const [n, c] of before) {
      if (c < 20) continue;
      const frozen = old.filter(
        (p) =>
          p.nationId === n &&
          (p.isCapital || !p.neighbors.some((o) => oldById.get(o)!.nationId === n)),
      ).length;
      // (marge : îles voisines par la grille mais sans frontière terrestre, jamais fusionnées)
      expect(after.get(n)!, n).toBeLessThanOrEqual(frozen + Math.ceil((c - frozen) * 0.55));
    }
    expect(after.get('dza')!).toBeLessThanOrEqual(21);
    expect(after.get('mar')!).toBeLessThanOrEqual(8);
  });

  it('petites nations (≤ keepUpTo provinces) inchangées', () => {
    for (const [n, c] of before) if (c <= CONSOLIDATE.keepUpTo) expect(after.get(n), n).toBe(c);
    expect(nations.map((n) => n.id)).toEqual(oldNations.map((n) => n.id));
  });

  it('chaque ancienne province est entière dans une seule province de sa nation', () => {
    for (const p of old) {
      const s = oldToNew.get(p.id)!;
      expect(s.size, p.id).toBe(1);
      const np = provById.get([...s][0]!)!;
      expect(np.nationId, p.id).toBe(p.nationId);
    }
  });

  it('provinces fusionnées d’un seul tenant (voisines dans l’ancienne carte)', () => {
    const members = new Map<string, string[]>();
    for (const p of old) {
      const id = [...oldToNew.get(p.id)!][0]!;
      members.set(id, [...(members.get(id) ?? []), p.id]);
    }
    const oldById = new Map(old.map((p) => [p.id, p]));
    for (const [id, ms] of members) {
      const seen = new Set([ms[0]!]);
      const stack = [ms[0]!];
      while (stack.length) {
        for (const o of oldById.get(stack.pop()!)!.neighbors)
          if (ms.includes(o) && !seen.has(o)) {
            seen.add(o);
            stack.push(o);
          }
      }
      expect(seen.size, id).toBe(ms.length);
    }
  });

  it('la capitale reste identifiable : la ville capitale est le point de capture', () => {
    const oldById = new Map(old.map((p) => [p.id, p]));
    for (const n of nations) {
      const cap = provById.get(n.capitalProvinceId)!;
      const oldCap = oldById.get(oldNations.find((o) => o.id === n.id)!.capitalProvinceId)!;
      expect(cap.isCapital).toBe(true);
      expect(cap.cityPoint, n.id).toEqual(oldCap.cityPoint);
      expect(cells.cells[cellOf(oldCap.cityPoint, 4)], n.id).toBe(cap.id);
    }
  });

  it('noms lisibles et uniques par nation, jamais « A + B »', () => {
    const seen = new Set<string>();
    for (const p of provinces) {
      const k = `${p.nationId}|${p.name}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
      expect(p.name).not.toMatch(/\+|,/);
      expect(p.name.length, p.name).toBeLessThanOrEqual(64);
    }
  });

  it('revenus en argent additionnés : total national conservé', () => {
    const money = (list: ProvinceDef[]) => {
      const m = new Map<string, number>();
      for (const p of list) m.set(p.nationId, (m.get(p.nationId) ?? 0) + p.income.money);
      return m;
    };
    const a = money(old);
    const b = money(provinces);
    for (const [n, v] of a) expect(b.get(n), n).toBe(v);
    // province par province : somme exacte de ses anciennes provinces
    const sum = new Map<string, number>();
    for (const p of old) {
      const id = [...oldToNew.get(p.id)!][0]!;
      sum.set(id, (sum.get(id) ?? 0) + p.income.money);
    }
    for (const p of provinces) expect(p.income.money, p.id).toBe(sum.get(p.id));
  });

  it('bâtiments de départ : réunion de ceux des anciennes provinces', () => {
    const union = new Map<string, Set<string>>();
    for (const p of old) {
      const id = [...oldToNew.get(p.id)!][0]!;
      const s = union.get(id) ?? new Set<string>();
      for (const b of p.buildings) s.add(b);
      union.set(id, s);
    }
    for (const p of provinces) expect(new Set(p.buildings), p.id).toEqual(union.get(p.id));
  });

  it('anciens noms (aliases.json) → province existante de la même nation', () => {
    expect(Object.keys(aliases).length).toBeGreaterThan(500);
    for (const [k, id] of Object.entries(aliases)) {
      const p = provById.get(id);
      expect(p, k).toBeDefined();
      expect(k.startsWith(`${p!.nationId}:`), k).toBe(true);
      expect(
        provinces.some((q) => `${q.nationId}:${q.name}` === k),
        k,
      ).toBe(false);
    }
  });
});
