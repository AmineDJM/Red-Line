/**
 * Arsenal : catégories séparées (navigation), filtres et compteurs. Fonctions pures, testées
 * (test/arsenal.test.ts). La recherche textuelle est globale : elle ignore doctrine et catégorie.
 */
import type { Category, Doctrine, WeaponSystem } from '@redline/shared';
import { norm } from './commands.js';

export type CategoryGroupId = 'air' | 'land' | 'defense' | 'strike' | 'sea' | 'support';

/** Catégories regroupées par milieu, dans l'ordre de la navigation. */
export const CATEGORY_GROUPS: { id: CategoryGroupId; categories: Category[] }[] = [
  { id: 'air', categories: ['fighter', 'bomber', 'air_support', 'helicopter', 'drone'] },
  { id: 'land', categories: ['tank', 'ifv', 'artillery', 'infantry'] },
  { id: 'defense', categories: ['air_defense', 'radar'] },
  { id: 'strike', categories: ['strike_missile', 'nuclear', 'space'] },
  { id: 'sea', categories: ['surface_ship', 'submarine'] },
  { id: 'support', categories: ['logistics'] },
];

export const NAV_CATEGORIES: Category[] = CATEGORY_GROUPS.flatMap((g) => g.categories);

export type CategoryFilter = Category | 'all';

export interface ArsenalFilter {
  doctrine: Doctrine | 'all';
  category: CategoryFilter;
  /** Recherche (nom ou identifiant) : non vide, elle porte sur tout l'arsenal. */
  query: string;
  /** Génération (0 = toutes). */
  gen: number;
  /** Filtres complémentaires (productible, importable, possédé). */
  extra?: (s: WeaponSystem) => boolean;
}

/** Vrai si une recherche textuelle est en cours (portée globale). */
export function isSearching(f: Pick<ArsenalFilter, 'query'>): boolean {
  return norm(f.query).length > 0;
}

/** Le système passe-t-il les filtres ? `ignoreCategory` : pour les compteurs de la navigation. */
export function arsenalMatches(s: WeaponSystem, f: ArsenalFilter, ignoreCategory = false): boolean {
  if (f.gen && s.generation !== f.gen) return false;
  if (f.extra && !f.extra(s)) return false;
  const q = norm(f.query);
  if (q) return norm(s.name).includes(q) || s.id.includes(q);
  if (f.doctrine !== 'all' && s.doctrine !== f.doctrine) return false;
  return ignoreCategory || f.category === 'all' || s.category === f.category;
}

/** Nombre de systèmes par catégorie (et `all`), avec les filtres actifs hors catégorie. */
export function categoryCounts(
  systems: WeaponSystem[],
  f: ArsenalFilter,
): Record<CategoryFilter, number> {
  const out = { all: 0 } as Record<CategoryFilter, number>;
  for (const c of NAV_CATEGORIES) out[c] = 0;
  for (const s of systems) {
    if (!arsenalMatches(s, f, true)) continue;
    out.all++;
    out[s.category] = (out[s.category] ?? 0) + 1;
  }
  return out;
}

/** Première catégorie non vide (catégorie par défaut quand aucune n'est mémorisée). */
export function defaultCategory(counts: Record<CategoryFilter, number>): Category {
  return NAV_CATEGORIES.find((c) => (counts[c] ?? 0) > 0) ?? NAV_CATEGORIES[0]!;
}

/** Sections affichées : une par catégorie présente dans la liste (ordre de la navigation). */
export function sectionsOf(list: WeaponSystem[]): { category: Category; items: WeaponSystem[] }[] {
  const by = new Map<Category, WeaponSystem[]>();
  for (const s of list) {
    const l = by.get(s.category) ?? [];
    l.push(s);
    by.set(s.category, l);
  }
  const order = (c: Category) => {
    const i = NAV_CATEGORIES.indexOf(c);
    return i < 0 ? NAV_CATEGORIES.length : i;
  };
  return [...by.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([category, items]) => ({ category, items }));
}

const KEY = (mode: string) => `rl.arsenal.category.${mode}`;

/** Catégorie mémorisée (par usage : production, catalogue, inventaire). */
export function readCategory(mode: string): CategoryFilter | null {
  try {
    const v = localStorage.getItem(KEY(mode));
    return v === 'all' || NAV_CATEGORIES.includes(v as Category) ? (v as CategoryFilter) : null;
  } catch {
    return null;
  }
}

export function writeCategory(mode: string, c: CategoryFilter): void {
  try {
    localStorage.setItem(KEY(mode), c);
  } catch {
    /* stockage indisponible */
  }
}
