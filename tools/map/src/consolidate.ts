/**
 * Fusion des provinces voisines d'une même nation (étape distincte du pipeline, réglages dans
 * consolidate-config.ts). Entièrement déterministe : aucun hasard, tris à clé totale.
 *
 * Règle (agglomération gloutonne, nation par nation) :
 *  1. Seules les provinces qui partagent une frontière terrestre (arc commun de la topologie) avec
 *     une province du même domaine (territoire principal ou même dépendance) et du même statut
 *     disputé sont fusionnables : jamais à travers une frontière nationale ni la mer. La province
 *     capitale reste telle quelle (keepCapitals).
 *  2. Tant que la nation dépasse sa cible, la paire de voisines de coût minimal est fusionnée :
 *       coût = poids(A) + poids(B)
 *            + pénalité si les régions diffèrent (régions Natural Earth ou REGION_HINTS)
 *            − bonus si les deux sont des parties d'une même unité découpée
 *            − poids × frontière commune / contour de la plus petite des deux (compacité)
 *            + poids × excentricité (distance de la ville principale au membre le plus éloigné,
 *              rapportée au rayon de la province fusionnée, au-delà de 1 : détours routiers),
 *     poids = nombre de provinces d'origine réunies + sizeWeight × taille relative (part de
 *     superficie + part de population de la nation, rapportée à la part typique d'une province
 *     finale) : chaque province d'origine est fusionnée environ une fois avant qu'une paire ne
 *     grossisse (division par deux homogène, du nord peuplé au désert), les plus petites d'abord.
 *  3. Membre dominant : la capitale, sinon le membre de la plus grande ville ; son point de
 *     capture (capitale ou ville la plus peuplée) devient celui de la province fusionnée. Nom : celui
 *     de la capitale ; sinon celui de la région du membre dominant si la province la couvre
 *     entièrement (nations à régions nommées) ; sinon celui de l'unité découpée si toutes ses
 *     parties sont réunies (« Adrar ») ; sinon celui du membre dominant (une unité découpée
 *     répartie entre plusieurs provinces fusionnées y reçoit des directions recalculées : « Gansu
 *     Nord-Ouest », « Gansu Sud-Est »). Jamais « A + B ».
 *  4. Données : superficie, population et rendements additionnés (total national conservé),
 *     bâtiments réunis, côte si un membre est côtier, voisins réunis.
 */
import type { BuildingType, ProvinceDef } from '@redline/shared';
import { CONSOLIDATE, REGION_HINTS } from './consolidate-config.js';
import { REGION_NAMED, REGION_NAME_FR } from './config.js';
import {
  bboxOf,
  haversineKm,
  interiorPoint,
  multiGeom,
  toMulti,
  type BBox,
  type MultiPolygon,
  type PolyGeom,
  type Pos,
} from './geo.js';
import { dedupeNames, directionNames } from './provinces.js';
import type { FeatureCollection } from './sources.js';
import { dissolve, type Adjacency } from './topology.js';

/** Province du pipeline avant fusion (sous-ensemble du `Prov` de build.ts). */
export interface GeoProv {
  id: string;
  key: string;
  nation: string;
  name: string;
  geom: MultiPolygon;
  bbox: BBox;
  area: number;
  center: Pos;
  cityPoint: Pos;
  cityPlace?: { pop: number };
  cityPop: number;
  pop: number;
  isCapital: boolean;
  disputed?: string;
}

/** Métadonnées de la forme d'origine (provinces.ts). */
export interface ShapeMeta {
  domain: string;
  region: string;
  rawName: string;
  baseName?: string;
}

export interface MergeItem {
  id: string;
  nation: string;
  domain: string;
  disputed?: string;
  /** Région de rattachement (indice manuel, sinon Natural Earth), « » si inconnue. */
  region: string;
  /** Unité d'origine avant découpe (clé de groupe admin-1). */
  unit: string;
  rawName: string;
  baseName?: string;
  area: number;
  pop: number;
  /** Point intérieur (lng, lat), pour nommer par direction. */
  center: Pos;
  /** Ville principale (point de capture). */
  city: Pos;
  /** Population de la ville principale. */
  cityPop: number;
  isCapital: boolean;
}

export interface MergeGroup {
  /** Membres, dans l'ordre des anciens identifiants. */
  members: string[];
  name: string;
  /** Membre dominant (capitale, sinon plus grande ville) : nom et point de capture. */
  lead: string;
}

export type ConsolidateConfig = typeof CONSOLIDATE;

const BUILDING_ORDER: BuildingType[] = [
  'refinery',
  'power_plant',
  'port',
  'air_base',
  'military_base',
  'arms_factory',
  'research_center',
];
const INCOME_KEYS = ['money', 'oil', 'metals', 'electronics', 'food'] as const;

export function cmpId(a: string, b: string): number {
  const ia = a.lastIndexOf('-');
  const ib = b.lastIndexOf('-');
  const na = a.slice(0, ia);
  const nb = b.slice(0, ib);
  return na < nb ? -1 : na > nb ? 1 : Number(a.slice(ia + 1)) - Number(b.slice(ib + 1));
}

/** Cible de provinces fusionnables d'une nation (n : total de la nation, m : fusionnables). */
export function mergeTargetOf(n: number, m: number, cfg: ConsolidateConfig = CONSOLIDATE): number {
  if (n <= cfg.keepUpTo || m < 2) return m;
  // Plancher : la nation garde au moins keepUpTo provinces, provinces figées comprises.
  const floor = cfg.keepUpTo - (n - m);
  return Math.min(m, Math.max(1, floor, Math.round(m * cfg.ratio)));
}

/** Région de rattachement d'une province : indice manuel (REGION_HINTS) sinon Natural Earth. */
export function regionOf(nation: string, meta: ShapeMeta): string {
  const h = REGION_HINTS[nation];
  if (h)
    for (const [label, names] of Object.entries(h.regions))
      if (names.includes(meta.rawName) || (meta.baseName && names.includes(meta.baseName)))
        return label;
  return meta.region;
}

/** Noms de REGION_HINTS sans province correspondante (faute de frappe, nom Natural Earth changé). */
export function unknownHints(metas: { nation: string; meta: ShapeMeta }[]): string[] {
  const known = new Set<string>();
  for (const { nation, meta } of metas) {
    known.add(`${nation}:${meta.rawName}`);
    if (meta.baseName) known.add(`${nation}:${meta.baseName}`);
  }
  const out: string[] = [];
  for (const [nation, h] of Object.entries(REGION_HINTS))
    for (const names of Object.values(h.regions))
      for (const n of names) if (!known.has(`${nation}:${n}`)) out.push(`${nation}:${n}`);
  return out;
}

interface Group {
  key: string;
  members: MergeItem[];
  area: number;
  pop: number;
  regions: Map<string, number>;
  units: Set<string>;
  /** Frontière commune (km) avec les groupes fusionnables voisins. */
  neigh: Map<string, number>;
  /** Contour total (km) : côtes et toutes frontières, étrangères comprises. */
  perim: number;
}

function mainRegion(g: Group): string {
  let best = '';
  let bestA = -1;
  for (const [r, a] of [...g.regions].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
    if (a > bestA) {
      bestA = a;
      best = r;
    }
  return best;
}

/** Plan de fusion : groupes de provinces (anciens identifiants) de chaque nation. */
export function planMerges(
  items: MergeItem[],
  adj: Adjacency,
  cfg: ConsolidateConfig = CONSOLIDATE,
): MergeGroup[] {
  const byNation = new Map<string, MergeItem[]>();
  for (const it of items) {
    const l = byNation.get(it.nation) ?? [];
    l.push(it);
    byNation.set(it.nation, l);
  }
  const out: MergeGroup[] = [];
  for (const [nation, raw] of [...byNation].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const list = [...raw].sort((a, b) => cmpId(a.id, b.id));
    const byId = new Map(list.map((it) => [it.id, it]));
    const eligible = (a: MergeItem, b: MergeItem) =>
      a.domain === b.domain &&
      (a.disputed ?? '') === (b.disputed ?? '') &&
      !(cfg.keepCapitals && (a.isCapital || b.isCapital));
    const landNeighbors = (it: MergeItem): [MergeItem, number][] =>
      [...(adj.shared.get(it.id) ?? [])]
        .filter(([o, len]) => len > 0 && byId.has(o) && eligible(it, byId.get(o)!))
        .map(([o, len]) => [byId.get(o)!, len] as [MergeItem, number])
        .sort((a, b) => cmpId(a[0].id, b[0].id));
    const mergeable = cfg.enabled ? list.filter((it) => landNeighbors(it).length > 0) : [];
    const target = mergeTargetOf(list.length, mergeable.length, cfg);
    const groups = new Map<string, Group>();
    const groupOf = new Map<string, string>();
    for (const it of list) {
      let perim = adj.exterior.get(it.id) ?? 0;
      for (const [, len] of adj.shared.get(it.id) ?? []) perim += len;
      groups.set(it.id, {
        key: it.id,
        members: [it],
        area: it.area,
        pop: it.pop,
        regions: new Map([[it.region, it.area]]),
        units: new Set([it.unit]),
        neigh: new Map(landNeighbors(it).map(([o, len]) => [o.id, len])),
        perim,
      });
      groupOf.set(it.id, it.id);
    }
    const totalArea = mergeable.reduce((s, it) => s + it.area, 0) || 1;
    const totalPop = mergeable.reduce((s, it) => s + it.pop, 0) || 1;
    const typical = 2 / Math.max(1, target);
    const score = (g: Group) =>
      g.members.length + (cfg.sizeWeight * (g.area / totalArea + g.pop / totalPop)) / typical;
    let count = mergeable.length;
    const pairCost = (g: Group, h: Group, len: number): number => {
      const gr = mainRegion(g);
      const hr = mainRegion(h);
      let cost = score(g) + score(h);
      if (gr && hr && gr !== hr) cost += cfg.regionPenalty;
      if ([...g.units].some((u) => h.units.has(u))) cost -= cfg.sameUnitBonus;
      cost -= (cfg.compactWeight * len) / Math.max(1e-9, Math.min(g.perim, h.perim));
      // Excentricité : ville principale (point de capture, nœud du réseau de routes) loin d'une
      // partie de la province fusionnée → détours pour la traverser.
      const ms = [...g.members, ...h.members];
      const lead = ms.reduce((a, b) => (b.cityPop > a.cityPop ? b : a));
      const r = Math.sqrt(ms.reduce((s, m) => s + m.area, 0) / Math.PI);
      const ecc = Math.max(...ms.map((m) => haversineKm(lead.city, m.center))) / Math.max(1, r);
      cost += cfg.eccentricityWeight * Math.max(0, ecc - 1);
      return cost;
    };
    while (count > target) {
      // Paire de voisines au coût minimal (clé totale : coût, puis identifiants).
      let g: Group | undefined;
      let best: Group | undefined;
      let bestCost = Infinity;
      for (const a of [...groups.values()].sort((x, y) => cmpId(x.key, y.key)))
        for (const [hk, len] of a.neigh) {
          if (cmpId(a.key, hk) > 0) continue; // chaque paire une fois
          const b = groups.get(hk)!;
          const cost = pairCost(a, b, len);
          if (
            cost < bestCost - 1e-12 ||
            (Math.abs(cost - bestCost) <= 1e-12 &&
              best &&
              g &&
              (cmpId(a.key, g.key) || cmpId(b.key, best.key)) < 0)
          ) {
            bestCost = cost;
            g = a;
            best = b;
          }
        }
      if (!g || !best) break;
      // Le groupe qui survit garde la plus petite clé (ancien identifiant le plus bas).
      const [keep, gone] = cmpId(g.key, best.key) < 0 ? [g, best] : [best, g];
      const shared = keep.neigh.get(gone.key) ?? 0;
      for (const m of gone.members) {
        keep.members.push(m);
        groupOf.set(m.id, keep.key);
      }
      keep.members.sort((a, b) => cmpId(a.id, b.id));
      keep.area += gone.area;
      keep.pop += gone.pop;
      for (const [r, a] of gone.regions) keep.regions.set(r, (keep.regions.get(r) ?? 0) + a);
      for (const u of gone.units) keep.units.add(u);
      keep.perim += gone.perim - 2 * shared;
      keep.neigh.delete(gone.key);
      for (const [o, len] of gone.neigh) {
        if (o === keep.key) continue;
        keep.neigh.set(o, (keep.neigh.get(o) ?? 0) + len);
        const og = groups.get(o)!;
        og.neigh.delete(gone.key);
        og.neigh.set(keep.key, (og.neigh.get(keep.key) ?? 0) + len);
      }
      groups.delete(gone.key);
      count--;
    }

    // Noms
    const hint = REGION_HINTS[nation];
    const regionNamed = REGION_NAMED.has(nation) || !!hint?.name;
    const regionCount = new Map<string, number>();
    const unitCount = new Map<string, number>();
    for (const it of list) {
      regionCount.set(it.region, (regionCount.get(it.region) ?? 0) + 1);
      unitCount.set(it.unit, (unitCount.get(it.unit) ?? 0) + 1);
    }
    const named: { g: Group; lead: MergeItem; name: string }[] = [];
    for (const g of [...groups.values()].sort((a, b) => cmpId(a.key, b.key))) {
      const lead = [...g.members].sort(
        (a, b) =>
          Number(b.isCapital) - Number(a.isCapital) ||
          b.cityPop - a.cityPop ||
          b.pop - a.pop ||
          cmpId(a.id, b.id),
      )[0]!;
      let name = lead.rawName;
      const r = lead.region;
      const inGroup = (pred: (m: MergeItem) => boolean) => g.members.filter(pred).length;
      if (g.members.length >= 2) {
        // Région du membre dominant, entièrement couverte par la province fusionnée (la capitale
        // garde son nom, sauf région nommée par REGION_HINTS : « Rabat-Salé-Kénitra »).
        if (
          regionNamed &&
          r &&
          (!lead.isCapital || hint?.name) &&
          inGroup((m) => m.region === r) === regionCount.get(r)
        )
          name = hint?.name ? r : (REGION_NAME_FR[`${nation}|${r}`] ?? r);
        // Toutes les parties d'une unité découpée réunies : son nom d'origine.
        else if (
          !lead.isCapital &&
          lead.baseName &&
          inGroup((m) => m.unit === lead.unit) === unitCount.get(lead.unit)
        )
          name = lead.baseName;
      }
      named.push({ g, lead, name });
    }
    // Unité découpée répartie entre plusieurs provinces fusionnées qui portent encore le nom d'une
    // de ses parties : directions recalculées entre elles (« Gansu Nord-Ouest » + « Gansu Sud-Est »).
    const byUnit = new Map<string, typeof named>();
    for (const x of named)
      if (x.lead.baseName && x.name === x.lead.rawName)
        byUnit.set(x.lead.unit, [...(byUnit.get(x.lead.unit) ?? []), x]);
    for (const list of byUnit.values()) {
      if (list.length < 2 || list.every((x) => x.g.members.length < 2)) continue;
      const centers = list.map((x) => groupCenter(x.g.members));
      const labels = directionNames(centers);
      list.forEach((x, i) => (x.name = `${x.lead.baseName} ${labels[i]}`));
    }
    for (const { g, lead, name } of named)
      out.push({ members: g.members.map((m) => m.id), name, lead: lead.id });
  }
  return out;
}

/** Centre (moyenne pondérée par la superficie) des centres des membres, antiméridien compris. */
function groupCenter(members: MergeItem[]): Pos {
  const wraps = members.some((m) => m.center[0] > 90) && members.some((m) => m.center[0] < -90);
  const sh = (x: number) => (wraps && x < 0 ? x + 360 : x);
  const a = members.reduce((s, m) => s + m.area, 0) || 1;
  return [
    members.reduce((s, m) => s + sh(m.center[0]) * m.area, 0) / a,
    members.reduce((s, m) => s + m.center[1] * m.area, 0) / a,
  ];
}

export interface Consolidated<P extends GeoProv> {
  provs: P[];
  defs: ProvinceDef[];
  /** Ancien identifiant → nouvel identifiant. */
  idMap: Map<string, string>;
  /** « nation:ancien nom » → nouvel identifiant (anciens noms disparus seulement). */
  aliases: Record<string, string>;
}

/** Applique un plan : géométries fusionnées, nouveaux identifiants, données additionnées. */
export async function applyMerges<P extends GeoProv>(
  provs: P[],
  defs: ProvinceDef[],
  plan: MergeGroup[],
): Promise<Consolidated<P>> {
  const provById = new Map(provs.map((p) => [p.id, p]));
  const defById = new Map(defs.map((d) => [d.id, d]));
  // Géométries des provinces fusionnées (mapshaper, contours partagés supprimés).
  const multi = plan.filter((g) => g.members.length > 1);
  const dissolved = new Map<string, MultiPolygon>();
  if (multi.length > 0) {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: multi.flatMap((g) =>
        g.members.map((id) => ({
          type: 'Feature' as const,
          properties: { gid: g.members[0]! },
          geometry: multiGeom(provById.get(id)!.geom),
        })),
      ),
    };
    for (const f of (await dissolve(fc, 'gid')).features)
      dissolved.set(String(f.properties.gid), toMulti(f.geometry as PolyGeom));
  }
  // Nouveaux identifiants : par nation, dans l'ordre du plus petit ancien identifiant.
  const sorted = [...plan].sort((a, b) => cmpId(a.members[0]!, b.members[0]!));
  const idMap = new Map<string, string>();
  const counter = new Map<string, number>();
  const newIdOf = new Map<MergeGroup, string>();
  for (const g of sorted) {
    const nation = provById.get(g.members[0]!)!.nation;
    const k = (counter.get(nation) ?? 0) + 1;
    counter.set(nation, k);
    const id = `${nation}-${k}`;
    newIdOf.set(g, id);
    for (const m of g.members) idMap.set(m, id);
  }
  const out: P[] = [];
  const groupOfNew = new Map<string, MergeGroup>();
  for (const g of sorted) {
    const id = newIdOf.get(g)!;
    groupOfNew.set(id, g);
    const ms = g.members.map((m) => provById.get(m)!);
    const lead = provById.get(g.lead)!;
    if (ms.length === 1) {
      out.push({ ...lead, id, name: g.name });
      continue;
    }
    const geom = dissolved.get(g.members[0]!);
    if (!geom || geom.length === 0)
      throw new Error(`fusion sans géométrie : ${g.members.join(',')}`);
    out.push({
      ...lead,
      id,
      key: ms[0]!.key,
      name: g.name,
      geom,
      bbox: bboxOf(geom),
      area: ms.reduce((s, p) => s + p.area, 0),
      center: interiorPoint(geom),
      cityPoint: lead.cityPoint,
      cityPop: ms.reduce((s, p) => s + p.cityPop, 0),
      pop: ms.reduce((s, p) => s + p.pop, 0),
      isCapital: ms.some((p) => p.isCapital),
    });
  }
  dedupeNames(out);

  const outDefs: ProvinceDef[] = out.map((p) => {
    const g = groupOfNew.get(p.id)!;
    const ds = g.members.map((m) => defById.get(m)!);
    const neighbors = [
      ...new Set(
        ds.flatMap((d) => d.neighbors.map((o) => idMap.get(o)!)).filter((o) => o !== p.id),
      ),
    ].sort(cmpId);
    if (ds.length === 1) return { ...ds[0]!, id: p.id, name: p.name, neighbors };
    const income = {} as ProvinceDef['income'];
    for (const k of INCOME_KEYS) {
      const v = ds.reduce((s, d) => s + (d.income[k] ?? 0), 0);
      if (k === 'money' || v > 0) income[k] = v;
    }
    const has = new Set(ds.flatMap((d) => d.buildings));
    const buildings = [
      ...BUILDING_ORDER.filter((b) => has.has(b)),
      ...[...has].filter((b) => !BUILDING_ORDER.includes(b)).sort(),
    ];
    return {
      id: p.id,
      name: p.name,
      nationId: p.nation,
      centroid: p.center,
      cityPoint: p.cityPoint,
      isCapital: p.isCapital,
      coastal: ds.some((d) => d.coastal),
      income,
      buildings,
      neighbors,
      areaKm2: Math.round(p.area),
    };
  });

  // Anciens noms disparus → nouvelle province (désignations par nom, ex. resources-data.ts).
  const names = new Set(out.map((p) => `${p.nation}:${p.name}`));
  const aliases: Record<string, string> = {};
  for (const p of [...provs].sort((a, b) => cmpId(a.id, b.id))) {
    const k = `${p.nation}:${p.name}`;
    if (!names.has(k) && !(k in aliases)) aliases[k] = idMap.get(p.id)!;
  }
  return { provs: out, defs: outDefs, idMap, aliases };
}
