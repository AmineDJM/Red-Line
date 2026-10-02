/**
 * Menu de pile : au clic (ou au toucher) sur un endroit où se trouvent plusieurs unités, liste
 * ancrée qui permet de choisir précisément quoi sélectionner (une, plusieurs, tout, par famille :
 * terre, air, mer, défense aérienne, missiles), puis de donner l'ordre. Unités étrangères listées à
 * part (inspection, cible d'attaque si une sélection existe).
 *
 * Logique pure (lignes, filtres, sélection) testée dans test/map.stack.test.ts ; état partagé
 * entre la carte (qui l'ouvre) et le composant d'interface (shell/StackMenu.tsx) dans `useStackMenu`.
 */
import { create } from 'zustand';
import type {
  GameTime,
  LngLat,
  NationId,
  NationView,
  SystemId,
  UnitId,
  UnitStatus,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import { glyphFor, type GlyphId } from './glyphs.js';
import { relationOf, type Rel } from './palette.js';
import { UNIT_CATS, unitCat, type UnitCat } from './unitCat.js';

export interface StackRow {
  id: UnitId;
  name: string;
  systemId: SystemId | null;
  glyph: GlyphId;
  owner: NationId;
  rel: Rel;
  /** Unité commandable par le joueur. */
  own: boolean;
  cat: UnitCat;
  count: number | undefined;
  hp: number | undefined;
  status: UnitStatus | undefined;
  /** Arrivée prévue (temps de jeu) si en mouvement. */
  eta: GameTime | null;
  /** Missile en vol (jamais sélectionnable). */
  missile: boolean;
}

export interface StackCtx {
  me: NationId | null;
  nations: Record<NationId, NationView>;
  catalog: Record<SystemId, WeaponSystem>;
  t: GameTime;
  /** Libellé d'un contact non identifié. */
  unknown: string;
}

const REL_ORDER: Record<Rel, number> = { own: 0, ally: 1, neutral: 2, enemy: 3 };
const CAT_ORDER = Object.fromEntries(UNIT_CATS.map((c, i) => [c, i])) as Record<UnitCat, number>;

/** Lignes du menu : forces du joueur d'abord, puis par famille, nom, effectif. */
export function stackRows(units: Iterable<UnitView>, ctx: StackCtx): StackRow[] {
  const rows: StackRow[] = [];
  for (const u of units) {
    if (u.status === 'destroyed') continue;
    const sys = u.systemId && u.level !== 'detected' ? ctx.catalog[u.systemId] : undefined;
    const legs = u.move?.legs;
    const end = legs?.length ? legs[legs.length - 1]!.t1 : null;
    rows.push({
      id: u.id,
      name: sys?.name ?? ctx.unknown,
      systemId: sys ? sys.id : null,
      glyph: sys ? glyphFor(sys) : 'unknown',
      owner: u.owner,
      rel: relationOf(u.owner, ctx.me, ctx.nations),
      own: u.level === 'own',
      cat: unitCat(sys),
      count: u.count,
      hp: u.hpRatio,
      status: u.status,
      eta: end !== null && end > ctx.t ? end : null,
      missile: !!u.missile,
    });
  }
  return rows.sort(
    (a, b) =>
      REL_ORDER[a.rel] - REL_ORDER[b.rel] ||
      (a.own === b.own ? 0 : a.own ? -1 : 1) ||
      CAT_ORDER[a.cat] - CAT_ORDER[b.cat] ||
      a.name.localeCompare(b.name, 'fr') ||
      (b.count ?? 0) - (a.count ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** Lignes sélectionnables (unités du joueur, hors missiles en vol). */
export function selectableIds(rows: readonly StackRow[]): UnitId[] {
  return rows.filter((r) => r.own && !r.missile).map((r) => r.id);
}

/** Effectifs par famille parmi les lignes (familles absentes omises), dans l'ordre d'affichage. */
export function catCounts(rows: readonly StackRow[]): { cat: UnitCat; n: number }[] {
  const n = new Map<UnitCat, number>();
  for (const r of rows) n.set(r.cat, (n.get(r.cat) ?? 0) + 1);
  return UNIT_CATS.filter((c) => n.has(c)).map((cat) => ({ cat, n: n.get(cat)! }));
}

export function filterRows(rows: readonly StackRow[], cat: UnitCat | 'all'): StackRow[] {
  return cat === 'all' ? [...rows] : rows.filter((r) => r.cat === cat);
}

/** Coche ou décoche une unité (sélectionnable seulement). */
export function togglePicked(rows: readonly StackRow[], picked: readonly UnitId[], id: UnitId) {
  if (!selectableIds(rows).includes(id)) return [...picked];
  return picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
}

/**
 * « Tout sélectionner » (dans le filtre courant) : tout coche, ou tout décoche si tout l'était
 * déjà. Les choix hors du filtre sont conservés.
 */
export function toggleAll(
  rows: readonly StackRow[],
  picked: readonly UnitId[],
  cat: UnitCat | 'all' = 'all',
): UnitId[] {
  const ids = selectableIds(filterRows(rows, cat));
  const all = ids.length > 0 && ids.every((id) => picked.includes(id));
  if (all) return picked.filter((id) => !ids.includes(id));
  return [...new Set([...picked, ...ids])];
}

/** Ne garder que les unités d'une famille (raccourci « seulement l'air », etc.). */
export function onlyCat(rows: readonly StackRow[], cat: UnitCat): UnitId[] {
  return selectableIds(rows.filter((r) => r.cat === cat));
}

/** Résumé d'un choix : nombre d'unités et effectif cumulé. */
export function pickedSummary(rows: readonly StackRow[], picked: readonly UnitId[]) {
  let count = 0;
  let n = 0;
  for (const r of rows)
    if (picked.includes(r.id)) {
      n++;
      count += r.count ?? 0;
    }
  return { units: n, count };
}

// ——— État partagé ———

export interface StackMenuOpen {
  ids: UnitId[];
  /** Unités voisines (autres nations au même endroit), listées à part. */
  near: UnitId[];
  /** Position du clic (px, repère du conteneur de la carte). */
  x: number;
  y: number;
  at: LngLat;
  /** Étalement de la pile (km) : au-delà d'un seuil, « zoomer » est proposé. */
  spreadKm: number;
  /** Ouverture par le toucher (présentation en feuille). */
  touch: boolean;
}

export interface StackMenuStore {
  open: StackMenuOpen | null;
  picked: UnitId[];
  filter: UnitCat | 'all';
  show(o: StackMenuOpen, picked: UnitId[]): void;
  close(): void;
  setPicked(ids: UnitId[]): void;
  setFilter(f: UnitCat | 'all'): void;
}

export const useStackMenu = create<StackMenuStore>((set) => ({
  open: null,
  picked: [],
  filter: 'all',
  show(o, picked) {
    set({ open: o, picked, filter: 'all' });
  },
  close() {
    set({ open: null, picked: [] });
  },
  setPicked(ids) {
    set({ picked: ids });
  },
  setFilter(f) {
    set({ filter: f });
  },
}));
