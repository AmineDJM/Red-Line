import { VIEW_SECTIONS, type PlayerView, type UnitView, type ViewDiff } from '@redline/shared';

/**
 * Applique un diff à une vue, sans muter l'entrée (les parties inchangées sont partagées,
 * ce qui permet aux abonnés de comparer par référence).
 * Contrat (view.ts) : les champs absents n'ont pas changé ; `units.upsert` remplace l'unité entière ;
 * `nations` et `provinces` remplacent les entrées listées ; les autres sections (économie, recherche,
 * renseignement…) sont remplacées en bloc.
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
  // Sections des phases 2+ (recherche, marché, renseignement…) : remplacées en bloc.
  const src = diff as unknown as Record<string, unknown>;
  const dst = next as unknown as Record<string, unknown>;
  for (const k of VIEW_SECTIONS) {
    if (k === 'nations' || k === 'provinces') continue;
    if (src[k] !== undefined) dst[k] = src[k];
  }
  return next;
}

/** Ensemble des identifiants d'unités touchées par un diff (pour les mises à jour ciblées). */
export function touchedUnits(diff: ViewDiff): Set<string> {
  const s = new Set<string>();
  diff.units?.upsert.forEach((u) => s.add(u.id));
  diff.units?.remove.forEach((id) => s.add(id));
  return s;
}
