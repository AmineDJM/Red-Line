/**
 * Frontières calculées à partir de la topologie des provinces : une arête partagée par deux provinces
 * de propriétaires différents (ou non partagée : côte) est une frontière nationale. Les arêtes du
 * territoire du joueur donnent le halo violet. Suppose des sommets partagés exactement entre provinces
 * voisines (topologie issue de mapshaper) ; sinon, les arêtes non appariées sont traitées comme des côtes.
 */
import type { Feature, FeatureCollection, MultiLineString, Position } from 'geojson';

type Owner = string | undefined;

export interface BorderResult {
  /** Frontières entre nations différentes et côtes. */
  nations: FeatureCollection<MultiLineString>;
  /** Contour extérieur du territoire du joueur. */
  mine: FeatureCollection<MultiLineString>;
}

const key = (p: Position) => `${p[0]!.toFixed(4)},${p[1]!.toFixed(4)}`;

interface EdgeInfo {
  a: Position;
  b: Position;
  owners: Owner[];
}

function rings(f: Feature): Position[][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

/** Arêtes indexées par paire de sommets non orientée, avec les propriétaires des provinces adjacentes. */
export function buildEdgeIndex(geo: FeatureCollection, ownerOf: (provinceId: string) => Owner): Map<string, EdgeInfo> {
  const edges = new Map<string, EdgeInfo>();
  for (const f of geo.features) {
    const id = String(f.properties?.id ?? f.id ?? '');
    const owner = ownerOf(id);
    for (const ring of rings(f)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const e = edges.get(k);
        if (e) e.owners.push(owner);
        else edges.set(k, { a, b, owners: [owner] });
      }
    }
  }
  return edges;
}

/** Fusionne des segments en polylignes (moins de sommets à envoyer au GPU). */
function chain(segs: [Position, Position][]): Position[][] {
  const byStart = new Map<string, number[]>();
  segs.forEach(([a], i) => {
    const k = key(a);
    const l = byStart.get(k);
    if (l) l.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Uint8Array(segs.length);
  const lines: Position[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: Position[] = [segs[i]![0], segs[i]![1]];
    for (;;) {
      const nextIdx = byStart.get(key(line[line.length - 1]!))?.find((j) => !used[j]);
      if (nextIdx === undefined) break;
      used[nextIdx] = 1;
      line.push(segs[nextIdx]![1]);
    }
    lines.push(line);
  }
  return lines;
}

export function computeBorders(geo: FeatureCollection, ownerOf: (provinceId: string) => Owner, me: string | null): BorderResult {
  const edges = buildEdgeIndex(geo, ownerOf);
  const nationSegs: [Position, Position][] = [];
  const mineSegs: [Position, Position][] = [];
  for (const e of edges.values()) {
    const [o1, o2] = e.owners;
    const shared = e.owners.length >= 2;
    if (!shared || o1 !== o2) nationSegs.push([e.a, e.b]);
    if (me) {
      const mineCount = e.owners.filter((o) => o === me).length;
      if (mineCount === 1 && (!shared || o1 !== o2)) mineSegs.push([e.a, e.b]);
    }
  }
  const fc = (segs: [Position, Position][]): FeatureCollection<MultiLineString> => ({
    type: 'FeatureCollection',
    features: segs.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: chain(segs) } }] : [],
  });
  return { nations: fc(nationSegs), mine: fc(mineSegs) };
}
