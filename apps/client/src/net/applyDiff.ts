import type { PlayerView, UnitView, ViewDiff } from '@redline/shared';

/**
 * Applique un diff à une vue, sans muter l'entrée (les parties inchangées sont partagées,
 * ce qui permet aux abonnés de comparer par référence).
 * Contrat (view.ts) : les champs absents n'ont pas changé ; `units.upsert` remplace l'unité entière ;
 * `nations` et `provinces` remplacent les entrées listées.
 */
export function applyDiff(view: PlayerView, diff: ViewDiff): PlayerView {
  const next: PlayerView = { ...view, time: Math.max(view.time, diff.time) };
  if (diff.nations) next.nations = { ...view.nations, ...diff.nations };
  if (diff.provinces) next.provinces = { ...view.provinces, ...diff.provinces };
  if (diff.units && (diff.units.upsert.length || diff.units.remove.length)) {
    const units: Record<string, UnitView> = { ...view.units };
    for (const id of diff.units.remove) delete units[id];
    for (const u of diff.units.upsert) units[u.id] = u;
    next.units = units;
  }
  if (diff.economy) next.economy = diff.economy;
  if (diff.victory) next.victory = diff.victory;
  return next;
}

/** Ensemble des identifiants d'unités touchées par un diff (pour les mises à jour ciblées). */
export function touchedUnits(diff: ViewDiff): Set<string> {
  const s = new Set<string>();
  diff.units?.upsert.forEach((u) => s.add(u.id));
  diff.units?.remove.forEach((id) => s.add(id));
  return s;
}
