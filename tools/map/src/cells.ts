/** Grille H3 : affectation des cellules terrestres aux provinces, cellules infranchissables, mer. */
import {
  cellToChildren,
  cellToLatLng,
  getRes0Cells,
  gridDisk,
  gridPathCells,
  latLngToCell,
  polygonToCells,
} from 'h3-js';
import { bboxOf, haversineKm, pointInMulti, round, type MultiPolygon, type Pos } from './geo.js';

let ALL: string[] | undefined;
/** Toutes les cellules de la résolution donnée, triées. */
export function allCells(res: number): string[] {
  if (ALL && res === 4) return ALL;
  const out: string[] = [];
  for (const r0 of getRes0Cells()) out.push(...cellToChildren(r0, res));
  out.sort();
  if (res === 4) ALL = out;
  return out;
}

export function cellCenter(c: string): Pos {
  const [lat, lng] = cellToLatLng(c);
  return [lng, lat];
}

export function cellOf(p: Pos, res: number): string {
  return latLngToCell(p[1], p[0], res);
}

/** Cellules dont le centre est dans le multipolygone (gère les parties très larges par test direct). */
export function cellsInMulti(mp: MultiPolygon, res: number): string[] {
  const out: string[] = [];
  for (const poly of mp) {
    const bb = bboxOf([poly]);
    if (bb[2] - bb[0] < 180) {
      try {
        out.push(...polygonToCells(poly as number[][][], res, true));
      } catch {
        /* polygone dégénéré */
      }
    } else {
      for (const c of allCells(res)) {
        const p = cellCenter(c);
        if (p[1] < bb[1] || p[1] > bb[3]) continue;
        if (pointInMulti(p, [poly])) out.push(c);
      }
    }
  }
  return out;
}

/**
 * Déplace un point vers le centre de la cellule cible jusqu'à y entrer (avec une petite marge),
 * pour que la cellule du point soit bien celle de la province.
 */
export function nudgeInto(p: Pos, cell: string, res: number): Pos {
  const c = cellCenter(cell);
  if (cellOf(p, res) === cell) return p;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const q: Pos = [p[0] + (c[0] - p[0]) * m, p[1] + (c[1] - p[1]) * m];
    if (cellOf(q, res) === cell) hi = m;
    else lo = m;
  }
  const t = Math.min(1, hi + 0.25 * (1 - hi));
  const q: Pos = [round(p[0] + (c[0] - p[0]) * t, 4), round(p[1] + (c[1] - p[1]) * t, 4)];
  return cellOf(q, res) === cell ? q : [round(c[0], 4), round(c[1], 4)];
}

/** Cellules d'un tracé de détroit (chemin de cellules contiguës entre les points du tracé). */
export function pathCells(path: Pos[], res: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < path.length; i++) {
    const a = cellOf(path[i - 1]!, res);
    const b = cellOf(path[i]!, res);
    for (const c of gridPathCells(a, b))
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
  }
  return out;
}

/** Grille navale : cellules hors terre et hors zones infranchissables, plus les cellules des détroits. */
export function navalCells(
  land: Iterable<string>,
  impassable: Iterable<string>,
  straitCells: Iterable<string>,
  res: number,
): Set<string> {
  const blocked = new Set<string>(land);
  for (const c of impassable) blocked.add(c);
  const naval = new Set<string>();
  for (const c of allCells(res)) if (!blocked.has(c)) naval.add(c);
  for (const c of straitCells) naval.add(c);
  return naval;
}

/** Composantes connexes de la grille navale : cellule → taille de sa composante. */
export function componentSizes(naval: Set<string>): Map<string, number> {
  const size = new Map<string, number>();
  const seen = new Set<string>();
  for (const start of naval) {
    if (seen.has(start)) continue;
    const comp: string[] = [start];
    seen.add(start);
    for (let i = 0; i < comp.length; i++)
      for (const n of gridDisk(comp[i]!, 1))
        if (naval.has(n) && !seen.has(n)) {
          seen.add(n);
          comp.push(n);
        }
    for (const c of comp) size.set(c, comp.length);
  }
  return size;
}

/**
 * Les deux points sont-ils reliés par la grille navale, en restant à moins de `maxKm`
 * de l'un des deux points ? Renvoie la longueur du chemin en cellules, ou -1.
 */
export function seaPath(
  naval: Set<string>,
  from: Pos,
  to: Pos,
  maxKm: number,
  res: number,
): number {
  const a = cellOf(from, res);
  const b = cellOf(to, res);
  if (!naval.has(a) || !naval.has(b)) return -2;
  const dist = new Map<string, number>([[a, 0]]);
  const queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    if (c === b) return dist.get(c)!;
    for (const n of gridDisk(c, 1)) {
      if (dist.has(n) || !naval.has(n)) continue;
      const p = cellCenter(n);
      if (Math.min(haversineKm(p, from), haversineKm(p, to)) > maxKm) continue;
      dist.set(n, dist.get(c)! + 1);
      queue.push(n);
    }
  }
  return -1;
}
