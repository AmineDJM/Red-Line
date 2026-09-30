/** Fond de carte vectoriel : côtes, noms des mers, étiquettes des pays, villes principales. */
import { interiorPoint, round, toMulti, type PolyGeom, type Pos } from './geo.js';
import type { NationInfo, Place } from './provinces.js';
import type { FeatureCollection } from './sources.js';
import { simplifyLines } from './topology.js';

const pt = (p: Pos) => ({ type: 'Point', coordinates: [round(p[0], 3), round(p[1], 3)] });

export async function coastline(fc: FeatureCollection): Promise<string> {
  return simplifyLines(fc, 3000, 0.01);
}

/** Points d'étiquette des étendues marines (nom français quand Natural Earth le fournit). */
export function seas(fc: FeatureCollection): FeatureCollection {
  const out: FeatureCollection = { type: 'FeatureCollection', features: [] };
  const skip = new Set(['river', 'reef']);
  const feats = [...fc.features].sort(
    (a, b) =>
      Number(a.properties.scalerank) - Number(b.properties.scalerank) ||
      String(a.properties.name).localeCompare(String(b.properties.name)),
  );
  for (const f of feats) {
    const p = f.properties;
    const kind = String(p.featurecla ?? '');
    if (skip.has(kind) || !f.geometry) continue;
    const name = String(p.name_fr || p.name || '').trim();
    if (!name) continue;
    const c = interiorPoint(toMulti(f.geometry as PolyGeom));
    out.features.push({
      type: 'Feature',
      properties: {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        name_en: String(p.name_en || p.name || ''),
        kind,
        rank: Number(p.scalerank ?? 5),
        minzoom: Number(p.min_label ?? 3),
      },
      geometry: pt(c),
    });
  }
  return out;
}

/** Étiquettes des pays (nom français ; le client le passe en majuscules). */
export function countries(nations: NationInfo[], fallback: Map<string, Pos>): FeatureCollection {
  const out: FeatureCollection = { type: 'FeatureCollection', features: [] };
  for (const n of [...nations].sort(
    (a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id),
  )) {
    const p = n.label ?? fallback.get(n.id);
    if (!p) continue;
    out.features.push({
      type: 'Feature',
      properties: { id: n.id, name: n.name, rank: n.labelRank, minzoom: n.minLabel },
      geometry: pt(p),
    });
  }
  return out;
}

/** Villes principales : capitales et villes de plus de 100 000 habitants, rang de population. */
export function cities(
  places: Place[],
  nationOf: (p: Place) => string | undefined,
): FeatureCollection {
  const out: FeatureCollection = { type: 'FeatureCollection', features: [] };
  const sel = places
    .filter((p) => p.pop >= 100_000 || p.capital)
    .sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));
  for (const p of sel) {
    out.features.push({
      type: 'Feature',
      properties: {
        name: p.nameFr,
        pop: Math.round(p.pop),
        rank: p.rankMax,
        scalerank: p.scalerank,
        minzoom: p.minZoom,
        capital: p.capital ? 1 : 0,
        nation: nationOf(p) ?? '',
      },
      geometry: pt(p.pos),
    });
  }
  return out;
}
