import { describe, expect, it } from 'vitest';
import { CATEGORIES, type WeaponSystem } from '@redline/shared';
import {
  CATEGORY_GROUPS,
  NAV_CATEGORIES,
  arsenalMatches,
  categoryCounts,
  defaultCategory,
  sectionsOf,
  type ArsenalFilter,
} from '../src/lib/arsenal.js';

const sys = (id: string, name: string, category: string, doctrine = 'us', generation = 4) =>
  ({ id, name, category, doctrine, generation }) as unknown as WeaponSystem;

const systems = [
  sys('us.f35', 'F-35A', 'fighter'),
  sys('us.f22', 'F-22 Raptor', 'fighter', 'us', 5),
  sys('ru.su57', 'Su-57', 'fighter', 'ru', 5),
  sys('us.patriot', 'Patriot PAC-3', 'air_defense'),
  sys('ru.s400', 'S-400 Triumf', 'air_defense', 'ru'),
  sys('us.abrams', 'M1A2 Abrams', 'tank'),
  sys('us.virginia', 'Classe Virginia', 'submarine'),
];

const f = (o: Partial<ArsenalFilter> = {}): ArsenalFilter => ({
  doctrine: 'all',
  category: 'all',
  query: '',
  gen: 0,
  ...o,
});

describe('arsenal : catégories séparées', () => {
  it('chaque catégorie du catalogue a sa place dans la navigation, une seule fois', () => {
    expect([...NAV_CATEGORIES].sort()).toEqual([...CATEGORIES].sort());
    expect(new Set(NAV_CATEGORIES).size).toBe(NAV_CATEGORIES.length);
    expect(CATEGORY_GROUPS.find((g) => g.id === 'defense')?.categories).toContain('air_defense');
  });

  it('une catégorie à la fois, dans la doctrine choisie', () => {
    const list = systems.filter((s) =>
      arsenalMatches(s, f({ doctrine: 'us', category: 'air_defense' })),
    );
    expect(list.map((s) => s.id)).toEqual(['us.patriot']);
  });

  it('compteurs par catégorie (filtres actifs hors catégorie)', () => {
    const c = categoryCounts(systems, f({ doctrine: 'us' }));
    expect(c.all).toBe(5);
    expect(c.fighter).toBe(2);
    expect(c.air_defense).toBe(1);
    expect(c.radar).toBe(0);
    const g5 = categoryCounts(systems, f({ gen: 5 }));
    expect(g5.fighter).toBe(2);
    expect(g5.all).toBe(2);
  });

  it('la recherche reste globale : elle ignore doctrine et catégorie', () => {
    const filter = f({ doctrine: 'us', category: 'tank', query: 's-400' });
    expect(systems.filter((s) => arsenalMatches(s, filter)).map((s) => s.id)).toEqual(['ru.s400']);
    const c = categoryCounts(systems, filter);
    expect(c.air_defense).toBe(1);
    expect(c.all).toBe(1);
  });

  it('catégorie par défaut : la première non vide', () => {
    expect(defaultCategory(categoryCounts(systems, f()))).toBe('fighter');
    expect(defaultCategory(categoryCounts(systems.slice(3), f()))).toBe('tank');
  });

  it('sections dans l’ordre de la navigation', () => {
    const s = sectionsOf([systems[6]!, systems[3]!, systems[0]!]);
    expect(s.map((x) => x.category)).toEqual(['fighter', 'air_defense', 'submarine']);
  });
});
