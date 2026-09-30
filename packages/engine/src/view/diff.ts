import type { PlayerView, UnitView, ViewDiff } from '@redline/shared';

/** Égalité profonde de valeurs JSON (objets, tableaux, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const kb = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

function diffRecord<T>(prev: Record<string, T>, next: Record<string, T>): Record<string, T> | null {
  let out: Record<string, T> | null = null;
  for (const k of Object.keys(next).sort()) {
    if (!deepEqual(prev[k], next[k])) (out ??= {})[k] = next[k]!;
  }
  return out;
}

/**
 * Égalité de deux vues d'unité en ignorant ce qui ne dépend que de l'horloge : `lastSeen` d'une unité
 * observée à l'instant (incertitude nulle des deux côtés, égal au temps de la vue) et `uncertaintyKm`
 * d'un contact perdu dont la dernière observation n'a pas changé (croissance linéaire connue).
 */
export function unitViewEqual(a: UnitView | undefined, b: UnitView | undefined): boolean {
  if (!a || !b) return a === b;
  const live = a.uncertaintyKm === 0 && b.uncertaintyKm === 0;
  const stale = a.uncertaintyKm > 0 && b.uncertaintyKm > 0 && a.lastSeen === b.lastSeen;
  if (live || stale) {
    const { lastSeen: _la, uncertaintyKm: _ua, ...ra } = a;
    const { lastSeen: _lb, uncertaintyKm: _ub, ...rb } = b;
    return deepEqual(ra, rb);
  }
  return deepEqual(a, b);
}

/** Différence entre deux vues successives ; null si rien n'a changé (hors horloge). */
export function diffViewsImpl(prev: PlayerView, next: PlayerView): ViewDiff | null {
  const diff: ViewDiff = { time: next.time };
  let changed = false;
  const nations = diffRecord(prev.nations, next.nations);
  if (nations) {
    diff.nations = nations;
    changed = true;
  }
  const provinces = diffRecord(prev.provinces, next.provinces);
  if (provinces) {
    diff.provinces = provinces;
    changed = true;
  }
  const upsert: UnitView[] = [];
  for (const id of Object.keys(next.units).sort()) {
    if (!unitViewEqual(prev.units[id], next.units[id])) upsert.push(next.units[id]!);
  }
  const remove = Object.keys(prev.units)
    .filter((id) => !(id in next.units))
    .sort();
  if (upsert.length > 0 || remove.length > 0) {
    diff.units = { upsert, remove };
    changed = true;
  }
  if (!deepEqual(prev.economy, next.economy)) {
    diff.economy = next.economy;
    changed = true;
  }
  if (!deepEqual(prev.victory, next.victory)) {
    diff.victory = next.victory;
    changed = true;
  }
  return changed ? diff : null;
}
