import { distanceKm, type LngLat, type NationId, type ProvinceId } from '@redline/shared';
import type { World } from '../api.js';
import { coverCap, pointCell } from '../geo/grid.js';
import type { EngineState } from './types.js';
import { wi } from './world.js';

/**
 * Index spatial (statique, par monde) des points de ville des provinces, pour les recherches de
 * « ville la plus proche » qui parcouraient toutes les provinces (≈ 2 600) à chaque appel.
 *
 * Résultat identique au parcours complet : même fonction de distance avec les mêmes arguments
 * (distanceKm(ville, point)), même départage (première province dans l'ordre trié des identifiants
 * parmi les distances exactement égales). La recherche s'élargit par rayons croissants ; un résultat
 * n'est retenu que s'il est à plus d'1 km à l'intérieur de la zone couverte (aucune ville hors zone ne
 * peut être plus proche ni à égalité).
 */
interface CityIndex {
  /** Case de la grille → provinces (dans l'ordre trié des identifiants). */
  cells: Map<number, ProvinceId[]>;
  /** Rang de chaque province dans l'ordre trié (départage). */
  rank: Map<ProvinceId, number>;
}

const indexes = new WeakMap<World, CityIndex>();

function cityIndex(world: World): CityIndex {
  let idx = indexes.get(world);
  if (idx) return idx;
  const w = wi(world);
  const cells = new Map<number, ProvinceId[]>();
  const rank = new Map<ProvinceId, number>();
  w.provIds.forEach((pid, i) => {
    rank.set(pid, i);
    const c = pointCell(w.provById.get(pid)!.cityPoint);
    let list = cells.get(c);
    if (!list) cells.set(c, (list = []));
    list.push(pid);
  });
  idx = { cells, rank };
  indexes.set(world, idx);
  return idx;
}

/** Rayons de recherche successifs (km) ; le dernier couvre toute la sphère. */
const RADII = [400, 1600, 6000, 25_000];

/**
 * Province acceptée dont la ville est la plus proche de `at` (distanceKm(ville, at)), ou null.
 * Départage : première dans l'ordre trié des identifiants.
 */
export function nearestCity(
  world: World,
  at: LngLat,
  accept: (pid: ProvinceId) => boolean,
): { pid: ProvinceId; d: number } | null {
  const idx = cityIndex(world);
  const w = wi(world);
  const cells = new Set<number>();
  const seen = new Set<ProvinceId>();
  let best: ProvinceId | null = null;
  let bestD = Infinity;
  for (let k = 0; k < RADII.length; k++) {
    const R = RADII[k]!;
    const last = k === RADII.length - 1;
    coverCap(at, R, cells);
    for (const c of cells) {
      const list = idx.cells.get(c);
      if (!list) continue;
      for (const pid of list) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        if (!accept(pid)) continue;
        const d = distanceKm(w.provById.get(pid)!.cityPoint, at);
        if (
          d < bestD ||
          (d === bestD && best !== null && idx.rank.get(pid)! < idx.rank.get(best)!)
        ) {
          bestD = d;
          best = pid;
        }
      }
    }
    if (last || (best !== null && bestD < R - 1)) break;
  }
  return best === null ? null : { pid: best, d: bestD };
}

/** En dessous de ce nombre de provinces, le parcours direct est plus rapide que l'index. */
const DIRECT_SCAN_MAX = 48;

/**
 * Une ville possédée par `n` est-elle à ≤ rKm de `p` (distanceKm(ville, p) ≤ rKm) ? Équivaut exactement
 * à « distance à la ville possédée la plus proche ≤ rKm », sans calculer ce minimum.
 */
export function ownCityWithin(state: EngineState, n: NationId, p: LngLat, rKm: number): boolean {
  const own = state.rt.provsOf.get(n);
  if (!own || own.size === 0) return false;
  const w = wi(state.world);
  if (own.size <= DIRECT_SCAN_MAX) {
    for (const pid of own) if (distanceKm(w.provById.get(pid)!.cityPoint, p) <= rKm) return true;
    return false;
  }
  if (!(rKm >= 0)) return false;
  if (rKm === Infinity) return true;
  const idx = cityIndex(state.world);
  const cells = new Set<number>();
  coverCap(p, rKm + 1, cells);
  for (const c of cells) {
    const list = idx.cells.get(c);
    if (!list) continue;
    for (const pid of list) {
      if (state.provinces[pid]?.owner !== n) continue;
      if (distanceKm(w.provById.get(pid)!.cityPoint, p) <= rKm) return true;
    }
  }
  return false;
}
