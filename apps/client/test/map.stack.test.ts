import { describe, expect, it } from 'vitest';
import { HOUR, type NationView, type UnitView, type WeaponSystem } from '@redline/shared';
import {
  catCounts,
  filterRows,
  onlyCat,
  pickedSummary,
  selectableIds,
  stackRows,
  toggleAll,
  togglePicked,
  useStackMenu,
} from '../src/map/stackMenu.js';
import { CityIndex, unitCat } from '../src/map/unitCat.js';

const nation = (id: string, relation?: NationView['relation']): NationView => ({
  id,
  name: id.toUpperCase(),
  color: '#336699',
  isAi: true,
  isPlayer: false,
  alive: true,
  provinceCount: 1,
  ...(relation ? { relation } : {}),
});
const nations = { fra: nation('fra'), deu: nation('deu', 'ally'), rus: nation('rus', 'war') };
const sys = (id: string, name: string, category: string, movement = 'land'): WeaponSystem =>
  ({ id, name, category, movement, icon: category }) as unknown as WeaponSystem;
const catalog = {
  leclerc: sys('leclerc', 'Leclerc', 'tank'),
  vbci: sys('vbci', 'VBCI', 'ifv'),
  rafale: sys('rafale', 'Rafale', 'fighter', 'air'),
  samp: sys('samp', 'SAMP/T', 'air_defense'),
  fremm: sys('fremm', 'FREMM', 'surface_ship', 'sea'),
  scalp: sys('scalp', 'SCALP', 'strike_missile', 'air'),
  t90: sys('t90', 'T-90', 'tank'),
};
const unit = (id: string, over: Partial<UnitView> = {}): UnitView => ({
  id,
  owner: 'fra',
  level: 'own',
  pos: [2, 48],
  lastSeen: 0,
  uncertaintyKm: 0,
  systemId: 'leclerc',
  count: 10,
  hpRatio: 0.8,
  status: 'idle',
  ...over,
});
const ctx = { me: 'fra', nations, catalog, t: HOUR, unknown: 'Contact non identifié' };

const units = [
  unit('a', { systemId: 'rafale', count: 4 }),
  unit('b', { systemId: 'leclerc', count: 20 }),
  unit('c', { systemId: 'samp', count: 2 }),
  unit('d', { systemId: 'vbci', count: 12, status: 'combat' }),
  unit('e', {
    systemId: 'scalp',
    count: 2,
    missile: { target: { type: 'point', at: [3, 48] }, impactAt: 2 * HOUR },
  }),
  unit('f', { owner: 'rus', level: 'identified', systemId: 't90', count: undefined }),
  unit('g', { owner: 'deu', level: 'precise', systemId: 'leclerc', count: 8 }),
  unit('h', { owner: 'rus', level: 'detected', systemId: undefined }),
];

describe('menu de pile : familles', () => {
  it('classe les systèmes en terre, air, mer, DCA, missiles', () => {
    expect(unitCat(catalog.leclerc)).toBe('land');
    expect(unitCat(catalog.rafale)).toBe('air');
    expect(unitCat(catalog.fremm)).toBe('sea');
    expect(unitCat(catalog.samp)).toBe('ad');
    expect(unitCat(catalog.scalp)).toBe('missile');
    expect(unitCat(undefined)).toBe('other');
  });
});

describe('menu de pile : lignes', () => {
  const rows = stackRows(units, ctx);

  it('ses forces d’abord (par famille), puis alliés, puis ennemis ; contact inconnu nommé', () => {
    expect(rows.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c', 'e', 'g', 'f', 'h']);
    expect(rows.find((r) => r.id === 'h')!.name).toBe('Contact non identifié');
    expect(rows.find((r) => r.id === 'h')!.glyph).toBe('unknown');
    expect(rows.find((r) => r.id === 'f')!.rel).toBe('enemy');
    expect(rows.find((r) => r.id === 'g')!.rel).toBe('ally');
    expect(rows.find((r) => r.id === 'd')!.status).toBe('combat');
  });

  it('seules les unités du joueur hors missiles en vol sont sélectionnables', () => {
    expect(selectableIds(rows).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(togglePicked(rows, [], 'f')).toEqual([]);
    expect(togglePicked(rows, [], 'e')).toEqual([]);
    expect(togglePicked(rows, ['a'], 'b')).toEqual(['a', 'b']);
    expect(togglePicked(rows, ['a', 'b'], 'a')).toEqual(['b']);
  });

  it('effectifs par famille, dans l’ordre d’affichage', () => {
    const own = rows.filter((r) => r.own);
    expect(catCounts(own)).toEqual([
      { cat: 'land', n: 2 },
      { cat: 'air', n: 1 },
      { cat: 'ad', n: 1 },
      { cat: 'missile', n: 1 },
    ]);
    expect(filterRows(own, 'land').map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('« tout sélectionner » : tout coche puis tout décoche, dans le filtre courant', () => {
    const all = toggleAll(rows, []);
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(toggleAll(rows, all)).toEqual([]);
    // Filtre « terre » : n'ajoute que la terre, garde le reste du choix.
    const land = toggleAll(rows, ['a'], 'land');
    expect(land.sort()).toEqual(['a', 'b', 'd']);
    expect(toggleAll(rows, land, 'land')).toEqual(['a']);
    expect(onlyCat(rows, 'air')).toEqual(['a']);
  });

  it('résumé du choix : unités et effectif cumulé', () => {
    expect(pickedSummary(rows, ['a', 'b'])).toEqual({ units: 2, count: 24 });
    expect(pickedSummary(rows, [])).toEqual({ units: 0, count: 0 });
  });
});

describe('menu de pile : état partagé', () => {
  it('ouverture avec pré-sélection, filtre remis à « tout », fermeture', () => {
    const s = useStackMenu.getState();
    s.setFilter('air');
    s.show({ ids: ['a', 'b'], near: ['f'], x: 10, y: 20, at: [2, 48], spreadKm: 0, touch: false }, [
      'a',
      'b',
    ]);
    expect(useStackMenu.getState().open?.ids).toEqual(['a', 'b']);
    expect(useStackMenu.getState().picked).toEqual(['a', 'b']);
    expect(useStackMenu.getState().filter).toBe('all');
    useStackMenu.getState().close();
    expect(useStackMenu.getState().open).toBeNull();
    expect(useStackMenu.getState().picked).toEqual([]);
  });
});

describe('retranchement', () => {
  it('ville tenue par la nation à portée de contact seulement', () => {
    const defs = [
      { id: 'p1', cityPoint: [2, 48] },
      { id: 'p2', cityPoint: [2.5, 48] },
    ] as unknown as import('@redline/shared').ProvinceDef[];
    const idx = new CityIndex(defs);
    const provinces = {
      p1: { id: 'p1', owner: 'fra', buildings: [] },
      p2: { id: 'p2', owner: 'rus', buildings: [] },
    };
    expect(idx.ownCityNear([2.01, 48], 'fra', provinces, 5)).toBe('p1');
    expect(idx.ownCityNear([2.2, 48], 'fra', provinces, 5)).toBeNull();
    expect(idx.ownCityNear([2.5, 48.01], 'fra', provinces, 5)).toBeNull();
    expect(idx.ownCityNear([2.5, 48.01], 'rus', provinces, 5)).toBe('p2');
  });
});
