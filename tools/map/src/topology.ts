/** Enveloppes mapshaper : topologie (voisinages par arcs partagés), fusion, découpe, simplification. */
import mapshaper from 'mapshaper';
import { lineLengthKm, type Pos } from './geo.js';
import type { FeatureCollection } from './sources.js';

interface TopoGeometry {
  type: string;
  arcs?: unknown;
  properties?: Record<string, unknown>;
}
interface Topology {
  type: 'Topology';
  arcs: Pos[][];
  objects: Record<string, { type: string; geometries: TopoGeometry[] }>;
}

async function run(cmd: string, inputs: Record<string, unknown>): Promise<Record<string, string>> {
  const out = (await mapshaper.applyCommands(cmd, inputs)) as Record<string, Buffer | string>;
  const res: Record<string, string> = {};
  for (const [k, v] of Object.entries(out)) res[k] = typeof v === 'string' ? v : v.toString('utf8');
  return res;
}

export interface Adjacency {
  /** Longueur de frontière partagée (km), par paire de clés. */
  shared: Map<string, Map<string, number>>;
  /** Longueur de contour non partagée (côte, rive de lac, bord de zone sans propriétaire), en km. */
  exterior: Map<string, number>;
}

function collectArcs(arcs: unknown, acc: Set<number>): void {
  if (typeof arcs === 'number') acc.add(arcs < 0 ? ~arcs : arcs);
  else if (Array.isArray(arcs)) for (const a of arcs) collectArcs(a, acc);
}

/** Construit la topologie d'une couche de polygones (propriété `key`) et en déduit les voisinages. */
export async function adjacency(fc: FeatureCollection, key: string): Promise<Adjacency> {
  const out = await run(`-i in.json snap -o out.json format=topojson no-quantization`, {
    'in.json': fc,
  });
  const topo = JSON.parse(out['out.json']!) as Topology;
  const obj = Object.values(topo.objects)[0]!;
  const users = new Map<number, Set<string>>();
  for (const g of obj.geometries) {
    const k = String(g.properties?.[key]);
    const s = new Set<number>();
    collectArcs(g.arcs, s);
    for (const a of s) {
      let u = users.get(a);
      if (!u) users.set(a, (u = new Set()));
      u.add(k);
    }
  }
  const shared = new Map<string, Map<string, number>>();
  const exterior = new Map<string, number>();
  const add = (a: string, b: string, len: number) => {
    let m = shared.get(a);
    if (!m) shared.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + len);
  };
  for (const [arc, u] of users) {
    const len = lineLengthKm(topo.arcs[arc]!);
    const ks = [...u];
    if (ks.length === 1) exterior.set(ks[0]!, (exterior.get(ks[0]!) ?? 0) + len);
    else for (const a of ks) for (const b of ks) if (a !== b) add(a, b, len);
  }
  return { shared, exterior };
}

/** mapshaper écrit une GeometryCollection quand la couche n'a pas d'attributs. */
function asFC(o: { type: string; features?: unknown; geometries?: unknown[] }): FeatureCollection {
  if (o.type === 'FeatureCollection') return o as FeatureCollection;
  return {
    type: 'FeatureCollection',
    features: ((o.geometries ?? []) as FeatureCollection['features'][number]['geometry'][]).map(
      (g) => ({
        type: 'Feature',
        properties: {},
        geometry: g,
      }),
    ),
  };
}

/** Fusionne les polygones par valeur de `field` (les autres propriétés du premier sont perdues). */
export async function dissolve(fc: FeatureCollection, field: string): Promise<FeatureCollection> {
  const out = await run(`-i in.json snap -dissolve ${field} -o out.json format=geojson`, {
    'in.json': fc,
  });
  return JSON.parse(out['out.json']!) as FeatureCollection;
}

/** Découpe une couche par une couche de polygones de découpe (propriétés conservées). */
export async function clip(
  fc: FeatureCollection,
  clipFc: FeatureCollection,
): Promise<FeatureCollection> {
  const out = await run(`-i in.json snap -clip clip.json -o out.json format=geojson`, {
    'in.json': fc,
    'clip.json': clipFc,
  });
  return asFC(JSON.parse(out['out.json']!));
}

/** Simplifie en préservant la topologie, arrondit les coordonnées. */
export async function simplify(
  fc: FeatureCollection,
  percentage: string,
  precision: number,
): Promise<string> {
  const out = await run(
    `-i in.json snap -simplify ${percentage} keep-shapes -o out.json format=geojson precision=${precision}`,
    { 'in.json': fc },
  );
  return out['out.json']!;
}

/** Simplification d'une couche de lignes (côtes) au pas donné en mètres. */
export async function simplifyLines(
  fc: FeatureCollection,
  intervalM: number,
  precision: number,
): Promise<string> {
  const out = await run(
    `-i in.json -simplify interval=${intervalM} -filter-slivers -o out.json format=geojson precision=${precision}`,
    { 'in.json': fc },
  );
  return out['out.json']!;
}
