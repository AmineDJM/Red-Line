/**
 * Mise à jour incrémentale d'une source GeoJSON : on compare les entités à celles envoyées la fois
 * précédente et on n'envoie au worker de MapLibre que les différences (`updateData` : ajouts,
 * suppressions, nouvelles géométries, propriétés modifiées). Si presque tout change, `setData`
 * reste plus économique. Évite la reconstruction complète des sources à chaque mise à jour.
 *
 * Les entités doivent porter une propriété `id` unique (source déclarée avec `promoteId: 'id'`).
 */
import type { GeoJSONSource, GeoJSONSourceDiff } from 'maplibre-gl';
import type { Feature, Geometry } from 'geojson';

type Props = Record<string, unknown>;

interface Sent {
  geom: string;
  props: Props;
}

export interface SyncStats {
  full: number;
  diff: number;
  skipped: number;
  lastChanged: number;
}

function geomKey(g: Geometry): string {
  if (g.type === 'Point') return `${g.coordinates[0]},${g.coordinates[1]}`;
  return JSON.stringify((g as { coordinates: unknown }).coordinates);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

/** Calcul pur du différentiel (exporté pour les tests). */
export function diffFeatures(
  prev: ReadonlyMap<string, Sent>,
  next: Feature[],
): { diff: GeoJSONSourceDiff; changed: number; state: Map<string, Sent> } {
  const state = new Map<string, Sent>();
  const add: Feature[] = [];
  const update: NonNullable<GeoJSONSourceDiff['update']> = [];
  for (const f of next) {
    const id = String((f.properties as Props | null)?.id ?? '');
    const g = geomKey(f.geometry);
    const props = (f.properties ?? {}) as Props;
    state.set(id, { geom: g, props });
    const old = prev.get(id);
    if (!old) {
      add.push(f);
      continue;
    }
    const changes: { key: string; value: unknown }[] = [];
    const removed: string[] = [];
    for (const k in props)
      if (!sameValue(props[k], old.props[k])) changes.push({ key: k, value: props[k] });
    for (const k in old.props) if (!(k in props)) removed.push(k);
    const geomChanged = g !== old.geom;
    if (geomChanged || changes.length || removed.length) {
      update.push({
        id,
        ...(geomChanged ? { newGeometry: f.geometry } : {}),
        ...(removed.length ? { removeProperties: removed } : {}),
        ...(changes.length ? { addOrUpdateProperties: changes } : {}),
      });
    }
  }
  const remove: string[] = [];
  for (const id of prev.keys()) if (!state.has(id)) remove.push(id);
  const diff: GeoJSONSourceDiff = {};
  if (add.length) diff.add = add;
  if (remove.length) diff.remove = remove;
  if (update.length) diff.update = update;
  return { diff, changed: add.length + remove.length + update.length, state };
}

export class SourceSync {
  private sent = new Map<string, Sent>();
  private primed = false;
  readonly stats: SyncStats = { full: 0, diff: 0, skipped: 0, lastChanged: 0 };

  constructor(private readonly get: () => GeoJSONSource | undefined) {}

  /** Envoie la nouvelle liste d'entités (différentiel si possible). */
  push(features: Feature[]) {
    const src = this.get();
    if (!src) return;
    const { diff, changed, state } = diffFeatures(this.sent, features);
    this.stats.lastChanged = changed;
    if (this.primed && changed === 0) {
      this.stats.skipped++;
      this.sent = state;
      return;
    }
    const total = Math.max(features.length, this.sent.size);
    if (!this.primed || changed > total * 0.6 + 8) {
      void src.setData({ type: 'FeatureCollection', features });
      this.stats.full++;
    } else {
      void src.updateData(diff);
      this.stats.diff++;
    }
    this.sent = state;
    this.primed = true;
  }

  reset() {
    this.sent.clear();
    this.primed = false;
  }
}
