import type { NationId, ProvinceId, UnitId } from '@redline/shared';
import { SpatialGrid } from '../geo/grid.js';
import type { Piece } from '../geo/sphere.js';

/**
 * Index dérivés de l'état, jamais sérialisés : ils sont reconstruits à la désérialisation.
 * Toute itération sur ces structures qui influence le résultat est faite dans l'ordre trié.
 */
export interface Runtime {
  /** Trajets balayés par les unités (rayon nul). */
  bodies: SpatialGrid;
  /** Zones (détection, armes) des unités et des provinces. */
  zones: SpatialGrid;
  reg: Map<UnitId, { body: number[]; zone: number[] }>;
  /** Entité ('u…' ou 'p:<province>') → clés des paires vivantes. */
  pairsOf: Map<string, Set<string>>;
  byNation: Map<NationId, Set<UnitId>>;
  /** Cible → unités qui la poursuivent. */
  chasers: Map<UnitId, Set<UnitId>>;
  /** Nation → nations avec qui elle est en guerre. */
  enemies: Map<NationId, Set<NationId>>;
  /** Nation → provinces possédées. */
  provsOf: Map<NationId, Set<ProvinceId>>;
  /** Cache de trajets de surface (résultat identique bit à bit à un calcul frais). */
  planMemo: Map<string, unknown>;
  /** Cache des morceaux de trajectoire par unité (invalidé à chaque changement de trajet). */
  geom: Map<UnitId, Piece[]>;
  dirtyCombat: Set<UnitId>;
  dirtyCapture: Set<ProvinceId>;
  /** Pas de notifications (création de partie). */
  silent: boolean;
  /** Nation → unités capables de brouiller (ew.jamming > 0). */
  jammers: Map<NationId, Set<UnitId>>;
}

export function emptyRuntime(): Runtime {
  return {
    bodies: new SpatialGrid(),
    zones: new SpatialGrid(),
    reg: new Map(),
    pairsOf: new Map(),
    byNation: new Map(),
    chasers: new Map(),
    enemies: new Map(),
    provsOf: new Map(),
    planMemo: new Map(),
    geom: new Map(),
    dirtyCombat: new Set(),
    dirtyCapture: new Set(),
    silent: false,
    jammers: new Map(),
  };
}

export function addToIndex<K, V>(map: Map<K, Set<V>>, k: K, v: V): void {
  let set = map.get(k);
  if (!set) map.set(k, (set = new Set()));
  set.add(v);
}

export function removeFromIndex<K, V>(map: Map<K, Set<V>>, k: K, v: V): void {
  const set = map.get(k);
  if (!set) return;
  set.delete(v);
  if (set.size === 0) map.delete(k);
}
