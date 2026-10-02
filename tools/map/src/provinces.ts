/**
 * Nations et provinces : unités admin-1 de Natural Earth → regroupement des pays trop découpés →
 * découpe des très grandes unités → provinces avec identifiants stables `<nation>-<n>`.
 */
import { cellToLatLng, polygonToCells } from 'h3-js';
import {
  ADM1_NAME_OVERRIDE,
  CAPITAL_OVERRIDE,
  DISPUTED,
  ENTITY_IDS,
  GROUPING,
  IMPASSABLE_ADM0,
  NATION_ID_OVERRIDE,
  NATION_ISO_OVERRIDE,
  NATION_NAME_OVERRIDE,
  REGION_NAMED,
  REGION_NAME_FR,
  SOV_PRIMARY,
} from './config.js';
import {
  areaKm2,
  bboxOf,
  haversineKm,
  inBBox,
  interiorPoint,
  multiGeom,
  pointInMulti,
  toMulti,
  type BBox,
  type MultiPolygon,
  type PolyGeom,
  type Pos,
} from './geo.js';
import type { Feature, FeatureCollection } from './sources.js';
import { adjacency, clip, dissolve } from './topology.js';

type Props = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Nettoie un nom Natural Earth (« d'Arkhangelsk » → « Arkhangelsk », « la Mecque » → « La Mecque »). */
export function cleanName(s: string): string {
  let n = s.trim();
  n = n.replace(
    /^(Préfecture|préfecture|cité|Cité|Wilaya|wilaya)\s+(de la |de l['’]|du |des |de |d['’])/u,
    '',
  );
  n = n.replace(/^(de la |de l['’]|du |des |de |d['’])/u, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// --------------------------------------------------------------------------------------------
// Nations
// --------------------------------------------------------------------------------------------

export interface NationInfo {
  id: string;
  iso: string;
  name: string;
  kind: 'state' | 'entity';
  primaryAdm0: string;
  pop: number;
  gdp: number; // millions de dollars
  label?: Pos;
  labelRank: number;
  minLabel: number;
}

export interface NationTable {
  nations: Map<string, NationInfo>;
  /** ADM0_A3 → identifiant de nation (hors Palestine, traitée par gu_a3). */
  adm0ToNation: Map<string, string>;
  /** Population par unité admin-0 (clé ADM0_A3, ou GAZ / WEB pour la Palestine). */
  popByKey: Map<string, number>;
  /** Nom français de chaque unité admin-0 (pour nommer les provinces des dépendances). */
  adm0Name: Map<string, string>;
}

export function buildNations(admin0: FeatureCollection, mapUnits: FeatureCollection): NationTable {
  const byAdm0 = new Map<string, Props>();
  for (const f of admin0.features) byAdm0.set(str(f.properties.ADM0_A3), f.properties);
  const idOfPrimary = (a3: string): string => {
    if (NATION_ID_OVERRIDE[a3]) return NATION_ID_OVERRIDE[a3]!;
    const iso = str(byAdm0.get(a3)?.ISO_A3_EH);
    return (iso && iso !== '-99' ? iso : a3).toLowerCase();
  };
  const nations = new Map<string, NationInfo>();
  const adm0ToNation = new Map<string, string>();
  const popByKey = new Map<string, number>();
  const adm0Name = new Map<string, string>();
  const mk = (id: string, primary: string, pp: Props): NationInfo => ({
    id,
    iso: NATION_ISO_OVERRIDE[id] ?? id.toUpperCase(),
    name: NATION_NAME_OVERRIDE[id] ?? (str(pp.NAME_FR) || str(pp.NAME)),
    kind: ENTITY_IDS.has(id) ? 'entity' : 'state',
    primaryAdm0: primary,
    pop: 0,
    gdp: 0,
    label: [Number(pp.LABEL_X), Number(pp.LABEL_Y)],
    labelRank: Number(pp.LABELRANK ?? 5),
    minLabel: Number(pp.MIN_LABEL ?? 5),
  });
  for (const f of admin0.features) {
    const p = f.properties;
    const a3 = str(p.ADM0_A3);
    adm0Name.set(a3, str(p.NAME_FR) || str(p.NAME));
    if (IMPASSABLE_ADM0.has(a3) || a3 === 'PSX') continue;
    const primary = SOV_PRIMARY[str(p.SOV_A3)] ?? a3;
    const id = idOfPrimary(primary);
    adm0ToNation.set(a3, id);
    let n = nations.get(id);
    if (!n) nations.set(id, (n = mk(id, primary, byAdm0.get(primary) ?? p)));
    n.pop += num(p.POP_EST);
    n.gdp += num(p.GDP_MD);
    popByKey.set(a3, num(p.POP_EST));
  }
  // Palestine : deux entités distinctes (Gaza, Cisjordanie) à partir des unités cartographiques.
  for (const f of mapUnits.features) {
    const p = f.properties;
    const gu = str(p.GU_A3);
    if (gu !== 'GAZ' && gu !== 'WEB') continue;
    const id = gu === 'GAZ' ? 'gaza' : 'pse';
    const n = mk(id, 'PSX', p);
    n.kind = 'entity';
    n.pop = num(p.POP_EST);
    n.gdp = num(p.GDP_MD);
    nations.set(id, n);
    popByKey.set(gu, n.pop);
  }
  // Repli : population/PIB nuls (Vatican…) → valeurs minimales.
  for (const n of nations.values()) {
    if (n.pop <= 0) n.pop = 1000;
    if (n.gdp <= 0) n.gdp = Math.max(50, n.pop * 0.01);
    if (!n.label || !Number.isFinite(n.label[0]) || !Number.isFinite(n.label[1])) delete n.label;
  }
  return { nations, adm0ToNation, popByKey, adm0Name };
}

// --------------------------------------------------------------------------------------------
// Villes (Natural Earth populated places)
// --------------------------------------------------------------------------------------------

export interface Place {
  idx: number;
  name: string;
  nameFr: string;
  adm0: string;
  pos: Pos;
  pop: number;
  capital: boolean; // Admin-0 capital
  featurecla: string;
  scalerank: number;
  rankMax: number;
  minZoom: number;
  labelRank: number;
}

export function loadPlaces(fc: FeatureCollection): Place[] {
  return fc.features.map((f, idx) => {
    const p = f.properties;
    const c = (f.geometry?.coordinates ?? [0, 0]) as Pos;
    return {
      idx,
      name: str(p.NAME),
      nameFr: str(p.NAME_FR) || str(p.NAME),
      adm0: str(p.ADM0_A3),
      pos: [Number(c[0]), Number(c[1])],
      pop: num(p.POP_MAX),
      capital: Number(p.ADM0CAP) === 1,
      featurecla: str(p.FEATURECLA),
      scalerank: Number(p.SCALERANK ?? 10),
      rankMax: Number(p.RANK_MAX ?? 0),
      minZoom: Number(p.MIN_ZOOM ?? 10),
      labelRank: Number(p.LABELRANK ?? 10),
    };
  });
}

/** Ville capitale de chaque nation. */
export function nationCapitals(nt: NationTable, places: Place[]): Map<string, Place> {
  const res = new Map<string, Place>();
  for (const n of nt.nations.values()) {
    const override = CAPITAL_OVERRIDE[n.id];
    let cands = override
      ? places.filter((p) => p.name === override && p.adm0 === n.primaryAdm0)
      : places.filter((p) => p.adm0 === n.primaryAdm0 && p.capital);
    if (cands.length === 0 && override) cands = places.filter((p) => p.name === override);
    cands.sort(
      (a, b) =>
        Number(b.featurecla === 'Admin-0 capital') - Number(a.featurecla === 'Admin-0 capital') ||
        b.pop - a.pop,
    );
    if (cands[0]) res.set(n.id, cands[0]);
  }
  return res;
}

// --------------------------------------------------------------------------------------------
// Unités admin-1
// --------------------------------------------------------------------------------------------

export interface Unit {
  uid: string;
  nation: string;
  adm0: string;
  popKey: string;
  name: string;
  /** Nom de la dépendance (Groenland, Hong Kong…) si l'unité n'appartient pas au territoire principal. */
  depName?: string;
  region: string;
  code: string;
  geom: MultiPolygon;
  bbox: BBox;
  area: number;
  center: Pos;
  cityPop: number;
  pop: number; // population estimée
  disputed?: string;
}

export interface UnitsResult {
  units: Unit[];
  impassable: MultiPolygon[];
}

export function buildUnits(
  admin1: FeatureCollection,
  admin0: FeatureCollection,
  nt: NationTable,
  places: Place[],
): UnitsResult {
  const units: Unit[] = [];
  const impassable: MultiPolygon[] = [];
  const seenAdm0 = new Set<string>();
  const disputedOf = (adm0: string, nameEn: string): string | undefined => {
    for (const d of DISPUTED)
      for (const m of d.match)
        if (m.adm0 === adm0 && (!m.names || m.names.includes(nameEn))) return d.id;
    return undefined;
  };
  interface Raw {
    nation: string;
    adm0: string;
    popKey: string;
    name: string;
    nameEn: string;
    region: string;
    code: string;
    geom: MultiPolygon;
  }
  const raws: Raw[] = [];
  for (const f of admin1.features) {
    const p = f.properties;
    const adm0 = str(p.adm0_a3);
    seenAdm0.add(adm0);
    const geom = toMulti(f.geometry as PolyGeom);
    if (IMPASSABLE_ADM0.has(adm0)) {
      impassable.push(geom);
      continue;
    }
    const gu = str(p.gu_a3);
    const popKey = gu === 'GAZ' ? 'GAZ' : gu === 'WEB' || adm0 === 'PSX' ? 'WEB' : adm0;
    const nation = popKey === 'GAZ' ? 'gaza' : popKey === 'WEB' ? 'pse' : nt.adm0ToNation.get(adm0);
    if (!nation) throw new Error(`nation inconnue pour ${adm0} (${str(p.name)})`);
    const nameEn = str(p.name);
    raws.push({
      nation,
      adm0,
      popKey,
      name: ADM1_NAME_OVERRIDE[`${adm0}|${nameEn}`] ?? (str(p.name_fr) || nameEn || str(p.admin)),
      nameEn,
      region: str(p.region),
      code: str(p.adm1_code) || `${adm0}-${raws.length}`,
      geom,
    });
  }
  // Unités admin-0 sans découpage admin-1.
  for (const f of admin0.features) {
    const p = f.properties;
    const adm0 = str(p.ADM0_A3);
    if (seenAdm0.has(adm0)) continue;
    const geom = toMulti(f.geometry as PolyGeom);
    if (IMPASSABLE_ADM0.has(adm0)) {
      impassable.push(geom);
      continue;
    }
    const nation = nt.adm0ToNation.get(adm0);
    if (!nation) continue;
    raws.push({
      nation,
      adm0,
      popKey: adm0,
      name: str(p.NAME_FR) || str(p.NAME),
      nameEn: str(p.NAME),
      region: '',
      code: `${adm0}-0`,
      geom,
    });
  }
  // Noms : les provinces des dépendances portent le nom de la dépendance.
  const perAdm0 = new Map<string, number>();
  for (const r of raws) perAdm0.set(r.adm0, (perAdm0.get(r.adm0) ?? 0) + 1);
  for (const r of raws) {
    if (r.geom.length === 0) continue;
    const primary = nt.nations.get(r.nation)?.primaryAdm0;
    let name = cleanName(r.name);
    let depName: string | undefined;
    if (primary && primary !== r.adm0 && r.adm0 !== 'PSX') {
      depName = cleanName(nt.adm0Name.get(r.adm0) ?? r.adm0);
      name = (perAdm0.get(r.adm0) ?? 1) > 1 && name !== depName ? `${depName} (${name})` : depName;
    }
    const d = disputedOf(r.adm0, r.nameEn);
    units.push({
      uid: `u${units.length}`,
      nation: r.nation,
      adm0: r.adm0,
      popKey: r.popKey,
      name,
      ...(depName ? { depName } : {}),
      region: r.region,
      code: r.code,
      geom: r.geom,
      bbox: bboxOf(r.geom),
      area: areaKm2(r.geom),
      center: interiorPoint(r.geom),
      cityPop: 0,
      pop: 0,
      ...(d ? { disputed: d } : {}),
    });
  }
  // Population : villes contenues, puis répartition de la population de chaque unité admin-0.
  for (const pl of places) {
    for (const u of units) {
      if (!inBBox(pl.pos, u.bbox) || !pointInMulti(pl.pos, u.geom)) continue;
      u.cityPop += pl.pop;
      break;
    }
  }
  const groups = new Map<string, Unit[]>();
  for (const u of units) {
    const l = groups.get(u.popKey) ?? [];
    l.push(u);
    groups.set(u.popKey, l);
  }
  for (const [key, list] of groups) distributePopulation(list, nt.popByKey.get(key) ?? 0);
  return { units, impassable };
}

/** Répartit `total` : 70 % au prorata des villes, 30 % au prorata de la superficie. */
export function distributePopulation<T extends { cityPop: number; area: number; pop: number }>(
  items: T[],
  total: number,
): void {
  const city = items.reduce((s, u) => s + u.cityPop, 0);
  const area = items.reduce((s, u) => s + u.area, 0);
  for (const u of items) {
    const areaShare = area > 0 ? u.area / area : 1 / items.length;
    const share = city > 0 ? 0.7 * (u.cityPop / city) + 0.3 * areaShare : areaShare;
    u.pop = total * share;
  }
}

// --------------------------------------------------------------------------------------------
// Regroupement
// --------------------------------------------------------------------------------------------

interface Group {
  gid: string;
  nation: string;
  members: Unit[];
  area: number;
  pop: number;
  center: Pos;
  regions: Map<string, number>;
  disputed?: string;
}

const mainRegion = (g: Group): string => {
  let best = '';
  let bestA = -1;
  for (const [r, a] of g.regions)
    if (a > bestA) {
      bestA = a;
      best = r;
    }
  return best;
};

export function mergeTarget(area: number, pop: number): number {
  return Math.max(
    1,
    Math.round(
      GROUPING.mergeArea * Math.sqrt(area / 1000) + GROUPING.mergePop * Math.sqrt(pop / 1e6),
    ),
  );
}

/** Regroupe les unités par nation jusqu'à la cible. Renvoie uid → identifiant de groupe. */
export async function mergeUnits(units: Unit[], nt: NationTable): Promise<Map<string, string>> {
  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: units.map((u) => ({
      type: 'Feature',
      properties: { uid: u.uid },
      geometry: multiGeom(u.geom),
    })),
  };
  const adj = await adjacency(fc, 'uid');
  const byNation = new Map<string, Unit[]>();
  for (const u of units) {
    const l = byNation.get(u.nation) ?? [];
    l.push(u);
    byNation.set(u.nation, l);
  }
  const result = new Map<string, string>();
  for (const [nid, list] of [...byNation].sort((a, b) => a[0].localeCompare(b[0]))) {
    const groups = new Map<string, Group>();
    const groupOf = new Map<string, string>();
    for (const u of list) {
      const g: Group = {
        gid: u.uid,
        nation: nid,
        members: [u],
        area: u.area,
        pop: u.pop,
        center: u.center,
        regions: new Map([[u.region, u.area]]),
        ...(u.disputed ? { disputed: u.disputed } : {}),
      };
      groups.set(g.gid, g);
      groupOf.set(u.uid, g.gid);
    }
    const merge = (g: Group, into: Group) => {
      for (const m of g.members) {
        into.members.push(m);
        groupOf.set(m.uid, into.gid);
      }
      into.area += g.area;
      into.pop += g.pop;
      for (const [r, a] of g.regions) into.regions.set(r, (into.regions.get(r) ?? 0) + a);
      groups.delete(g.gid);
    };
    const neighborsOf = (g: Group) => {
      const neigh = new Map<string, number>();
      for (const m of g.members)
        for (const [ou, len] of adj.shared.get(m.uid) ?? []) {
          const og = groupOf.get(ou);
          if (!og || og === g.gid) continue;
          neigh.set(og, (neigh.get(og) ?? 0) + len);
        }
      return neigh;
    };

    // 1. Îlots minuscules et peu peuplés (atolls, récifs…) : rattachés à l'unité notable la plus proche.
    //    On raisonne par composante connexe (un archipel de districts voisins compte comme un tout).
    const comps: Unit[][] = [];
    const seen = new Set<string>();
    for (const u of [...list].sort((a, b) => a.uid.localeCompare(b.uid))) {
      if (seen.has(u.uid)) continue;
      const comp = [u];
      seen.add(u.uid);
      for (let i = 0; i < comp.length; i++)
        for (const [o] of adj.shared.get(comp[i]!.uid) ?? []) {
          const ou = list.find((x) => x.uid === o);
          if (ou && !seen.has(o) && ou.disputed === u.disputed) {
            seen.add(o);
            comp.push(ou);
          }
        }
      comps.push(comp);
    }
    const isTiny = (c: Unit[]) =>
      c.reduce((s, u) => s + u.area, 0) < GROUPING.tinyUnitKm2 &&
      c.reduce((s, u) => s + u.pop, 0) < GROUPING.tinyUnitPop;
    const notable = comps.filter((c) => !isTiny(c)).flat();
    if (notable.length > 0)
      for (const c of comps) {
        if (!isTiny(c)) continue;
        const ref = c[0]!;
        let best: Unit | undefined;
        let bd = Infinity;
        for (const v of notable) {
          if (v.disputed !== ref.disputed) continue;
          const d = haversineKm(ref.center, v.center);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
        if (!best) continue;
        for (const u of c)
          merge(groups.get(groupOf.get(u.uid)!)!, groups.get(groupOf.get(best.uid)!)!);
      }

    // 2. Fusion des plus petites unités jusqu'à la cible, domaine par domaine : le territoire
    //    principal d'une part, chaque dépendance (Hong Kong, Groenland…) d'autre part.
    const domainOf = (g: Group) =>
      [...g.members].sort((a, b) => b.area - a.area || a.uid.localeCompare(b.uid))[0]!.popKey;
    const domains = [...new Set([...groups.values()].map(domainOf))].sort();
    for (const dom of domains) {
      const inDom = () => [...groups.values()].filter((g) => domainOf(g) === dom);
      const start = inDom();
      const totalArea = start.reduce((s, g) => s + g.area, 0) || 1;
      const totalPop = start.reduce((s, g) => s + g.pop, 0) || 1;
      const target = mergeTarget(totalArea, nt.popByKey.get(dom) ?? totalPop);
      const score = (g: Group) => g.area / totalArea + g.pop / totalPop;
      const frozen = new Set<string>();
      const typical = 2 / target;
      for (;;) {
        const cur = inDom();
        if (cur.length <= target) break;
        const g = cur
          .filter((x) => !frozen.has(x.gid))
          .sort((a, b) => score(a) - score(b) || a.gid.localeCompare(b.gid))[0];
        if (!g) break;
        const ok = (h: Group) => h.disputed === g.disputed && domainOf(h) === dom;
        let best: Group | undefined;
        let bestS = Infinity;
        const gr = mainRegion(g);
        for (const [og] of [...neighborsOf(g)].sort((a, b) => a[0].localeCompare(b[0]))) {
          const h = groups.get(og)!;
          if (!ok(h)) continue;
          const hr = mainRegion(h);
          const s = score(h) + (gr && hr && gr !== hr ? GROUPING.regionPenalty * typical : 0);
          if (s < bestS) {
            bestS = s;
            best = h;
          }
        }
        if (!best) {
          // île : rattachement à l'unité la plus proche du même domaine
          const limit = g.area < GROUPING.tinyIslandKm2 ? Infinity : GROUPING.islandMergeKm;
          let bd = Infinity;
          for (const h of groups.values()) {
            if (h === g || !ok(h)) continue;
            const d = haversineKm(g.center, h.center);
            if (d < bd && d <= limit) {
              bd = d;
              best = h;
            }
          }
        }
        if (!best) {
          frozen.add(g.gid);
          continue;
        }
        merge(g, best);
      }
    }
    for (const [uid, gid] of groupOf) result.set(uid, gid);
  }
  return result;
}

// --------------------------------------------------------------------------------------------
// Provinces (après fusion et découpe)
// --------------------------------------------------------------------------------------------

export interface ProvinceShape {
  key: string;
  nation: string;
  name: string;
  geom: MultiPolygon;
  /** Clé de tri stable : plus petit code admin-1 du groupe, puis rang de la partie. */
  sortKey: string;
  pop: number;
  disputed?: string;
  /** Domaine (territoire principal ou dépendance : clé de population admin-0). */
  domain: string;
  /** Région Natural Earth dominante (superficie) des unités membres, ou chaîne vide. */
  region: string;
  /** Nom avant dédoublonnage (« Moscou » pour « Moscou (ville) »). */
  rawName: string;
  /** Nom de l'unité découpée, pour une partie issue d'une découpe (« Adrar » pour « Adrar Nord »). */
  baseName?: string;
}

export async function buildProvinceShapes(
  units: Unit[],
  groupOf: Map<string, string>,
  places: Place[],
): Promise<ProvinceShape[]> {
  const members = new Map<string, Unit[]>();
  for (const u of units) {
    const g = groupOf.get(u.uid)!;
    const l = members.get(g) ?? [];
    l.push(u);
    members.set(g, l);
  }
  // Nom de région : si tous les membres d'un groupe partagent une région, et qu'aucun autre groupe
  // « pur » n'utilise la même région.
  const pureRegionCount = new Map<string, number>();
  for (const list of members.values()) {
    const r = list[0]!.region;
    if (r && list.length >= 2 && list.every((u) => u.region === r)) {
      const k = `${list[0]!.nation}|${r}`;
      pureRegionCount.set(k, (pureRegionCount.get(k) ?? 0) + 1);
    }
  }

  const depSize = new Map<string, number>();
  for (const u of units) if (u.depName) depSize.set(u.depName, (depSize.get(u.depName) ?? 0) + 1);

  // Fusion géométrique
  const multi = [...members.values()].filter((l) => l.length > 1).flat();
  const dissolved = new Map<string, MultiPolygon>();
  if (multi.length) {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: multi.map((u) => ({
        type: 'Feature',
        properties: { gid: groupOf.get(u.uid)! },
        geometry: multiGeom(u.geom),
      })),
    };
    const out = await dissolve(fc, 'gid');
    for (const f of out.features)
      dissolved.set(String(f.properties.gid), toMulti(f.geometry as PolyGeom));
  }

  const shapes: ProvinceShape[] = [];
  for (const [gid, list] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => b.pop - a.pop || a.code.localeCompare(b.code));
    const nation = list[0]!.nation;
    const geom = list.length === 1 ? list[0]!.geom : (dissolved.get(gid) ?? []);
    let name = list[0]!.name;
    const reg = list[0]!.region;
    if (
      list.length >= 2 &&
      reg &&
      REGION_NAMED.has(nation) &&
      list.every((u) => u.region === reg) &&
      pureRegionCount.get(`${nation}|${reg}`) === 1
    )
      name = REGION_NAME_FR[`${nation}|${reg}`] ?? reg;
    const dep = list[0]!.depName;
    if (dep && list.every((u) => u.depName === dep) && depSize.get(dep) === list.length) name = dep;
    const sortKey = list.map((u) => u.code).sort()[0]!;
    const area = list.reduce((s, u) => s + u.area, 0);
    const pop = list.reduce((s, u) => s + u.pop, 0);
    const k =
      area < GROUPING.splitMinAreaKm2
        ? 1
        : Math.min(
            GROUPING.splitMax,
            Math.round(Math.sqrt(area / GROUPING.splitAreaKm2) + pop / GROUPING.splitPop),
          );
    const regionArea = new Map<string, number>();
    for (const u of list) regionArea.set(u.region, (regionArea.get(u.region) ?? 0) + u.area);
    const region = [...regionArea].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const base: ProvinceShape = {
      key: gid,
      nation,
      name,
      geom,
      sortKey,
      pop,
      ...(list[0]!.disputed ? { disputed: list[0]!.disputed } : {}),
      domain: list[0]!.popKey,
      region,
      rawName: name,
    };
    if (k < 2 || geom.length === 0) {
      shapes.push(base);
      continue;
    }
    const parts = await splitShape(base, k);
    if (parts.length > 1) {
      // population des parties : villes contenues et superficie
      const items = parts.map((p) => {
        const bb = bboxOf(p.geom);
        let cityPop = 0;
        for (const pl of places)
          if (inBBox(pl.pos, bb) && pointInMulti(pl.pos, p.geom)) cityPop += pl.pop;
        return { cityPop, area: areaKm2(p.geom), pop: 0 };
      });
      distributePopulation(items, pop);
      parts.forEach((p, i) => (p.pop = items[i]!.pop));
    }
    shapes.push(...parts);
  }
  dedupeNames(shapes);
  return shapes;
}

/** Noms en double dans une même nation (ex. Moscou ville / oblast) : suffixe « (ville) » ou numéro. */
export function dedupeNames<T extends { nation: string; name: string; geom: MultiPolygon }>(
  shapes: T[],
): void {
  const byName = new Map<string, T[]>();
  for (const s of shapes) {
    const k = `${s.nation}|${s.name}`;
    const l = byName.get(k) ?? [];
    l.push(s);
    byName.set(k, l);
  }
  for (const l of byName.values()) {
    if (l.length < 2) continue;
    const sized = l.map((s) => ({ s, a: areaKm2(s.geom) })).sort((a, b) => b.a - a.a);
    sized.forEach(({ s, a }, i) => {
      if (i === 0) return;
      s.name = a < 5000 && i === sized.length - 1 ? `${s.name} (ville)` : `${s.name} ${i + 1}`;
    });
  }
}

// ---------- Découpe (k-moyennes + Voronoï, découpe exacte par mapshaper) ----------

function clipHalf(poly: Pos[], nx: number, ny: number, c: number): Pos[] {
  const out: Pos[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

const DIRS = ['Est', 'Nord-Est', 'Nord', 'Nord-Ouest', 'Ouest', 'Sud-Ouest', 'Sud', 'Sud-Est'];

/** Nomme les parties par direction, sans doublon (affectation gloutonne au coût minimal). */
export function directionNames(centers: Pos[]): string[] {
  const gc: Pos = [
    centers.reduce((s, c) => s + c[0], 0) / centers.length,
    centers.reduce((s, c) => s + c[1], 0) / centers.length,
  ];
  const kx = Math.cos((gc[1] * Math.PI) / 180);
  const vec = centers.map((c) => [(c[0] - gc[0]) * kx, c[1] - gc[1]] as Pos);
  const spread = vec.reduce((s, v) => s + Math.hypot(v[0], v[1]), 0) / vec.length || 1;
  const pairs: { i: number; label: string; cost: number }[] = [];
  vec.forEach((v, i) => {
    const ang = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
    DIRS.forEach((d, j) => {
      let diff = Math.abs(ang - j * 45) % 360;
      if (diff > 180) diff = 360 - diff;
      pairs.push({ i, label: d, cost: diff / 45 });
    });
    pairs.push({ i, label: 'Centre', cost: (2.5 * Math.hypot(v[0], v[1])) / spread });
  });
  pairs.sort((a, b) => a.cost - b.cost || a.i - b.i || a.label.localeCompare(b.label));
  const names: (string | undefined)[] = Array.from({ length: centers.length }, () => undefined);
  const used = new Set<string>();
  for (const p of pairs) {
    if (names[p.i] || used.has(p.label)) continue;
    names[p.i] = p.label;
    used.add(p.label);
  }
  return names.map((n, i) => n ?? `${i + 1}`);
}

async function splitShape(shape: ProvinceShape, k: number): Promise<ProvinceShape[]> {
  const bb = bboxOf(shape.geom);
  const wraps = bb[2] - bb[0] > 180;
  const sh = (x: number) => (wraps && x < 0 ? x + 360 : x);
  // points échantillons : centres des cellules H3 de résolution 5
  const pts: Pos[] = [];
  for (const poly of shape.geom) {
    try {
      for (const c of polygonToCells(poly as number[][][], 5, true)) {
        const [lat, lng] = cellToLatLng(c);
        pts.push([sh(lng), lat]);
      }
    } catch {
      /* polygone dégénéré */
    }
  }
  if (pts.length < k * 4) return [shape];
  pts.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  const P = pts.map((p) => [p[0] * kx, p[1]] as Pos);
  // initialisation déterministe : point le plus au nord, puis le plus éloigné des graines
  const seeds: Pos[] = [P[0]!];
  const dmin = P.map((p) => (p[0] - P[0]![0]) ** 2 + (p[1] - P[0]![1]) ** 2);
  while (seeds.length < k) {
    let bi = 0;
    for (let i = 1; i < P.length; i++) if (dmin[i]! > dmin[bi]!) bi = i;
    const s = P[bi]!;
    seeds.push(s);
    for (let i = 0; i < P.length; i++)
      dmin[i] = Math.min(dmin[i]!, (P[i]![0] - s[0]) ** 2 + (P[i]![1] - s[1]) ** 2);
  }
  for (let it = 0; it < 40; it++) {
    const sx = new Float64Array(k),
      sy = new Float64Array(k),
      cnt = new Float64Array(k);
    for (const p of P) {
      let bj = 0,
        bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (p[0] - seeds[j]![0]) ** 2 + (p[1] - seeds[j]![1]) ** 2;
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      sx[bj] = sx[bj]! + p[0];
      sy[bj] = sy[bj]! + p[1];
      cnt[bj] = cnt[bj]! + 1;
    }
    for (let j = 0; j < k; j++) if (cnt[j]! > 0) seeds[j] = [sx[j]! / cnt[j]!, sy[j]! / cnt[j]!];
  }
  // cellules de Voronoï (demi-plans) dans l'espace projeté, puis retour en lng/lat
  let sMin = Infinity,
    sMax = -Infinity;
  for (const poly of shape.geom)
    for (const [x] of poly[0] ?? []) {
      const v = sh(x);
      if (v < sMin) sMin = v;
      if (v > sMax) sMax = v;
    }
  const minX = sMin * kx - 5,
    maxX = sMax * kx + 5;
  const box: Pos[] = [
    [minX, bb[1] - 2],
    [maxX, bb[1] - 2],
    [maxX, bb[3] + 2],
    [minX, bb[3] + 2],
  ];
  const parts: { geom: MultiPolygon; c: Pos }[] = [];
  for (let i = 0; i < k; i++) {
    let cell = box;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const si = seeds[i]!,
        sj = seeds[j]!;
      const nx = sj[0] - si[0],
        ny = sj[1] - si[1];
      cell = clipHalf(cell, nx, ny, nx * ((si[0] + sj[0]) / 2) + ny * ((si[1] + sj[1]) / 2));
    }
    if (cell.length < 3) continue;
    const ll: Pos[] = cell.map((p) => [p[0] / kx, p[1]]);
    const polys: MultiPolygon = [];
    const close = (r: Pos[]): Pos[] => [...r, r[0]!];
    if (!wraps) polys.push([close(ll)]);
    else {
      const west = clipHalf(ll, 1, 0, 180).map((p) => [Math.max(-180, p[0]), p[1]] as Pos);
      const east = clipHalf(ll, -1, 0, -180).map((p) => [Math.max(-180, p[0] - 360), p[1]] as Pos);
      if (west.length >= 3) polys.push([close(west)]);
      if (east.length >= 3) polys.push([close(east)]);
    }
    const clipped = await clip(
      {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { k: 1 }, geometry: multiGeom(shape.geom) }],
      },
      {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { k: 1 }, geometry: multiGeom(polys) }],
      },
    );
    const geom: MultiPolygon = clipped.features.flatMap((f: Feature) =>
      toMulti(f.geometry as PolyGeom),
    );
    if (geom.length === 0) continue;
    const c = seeds[i]!;
    const cx = c[0] / kx;
    parts.push({ geom, c: [wraps && cx > 180 ? cx - 360 : cx, c[1]] });
  }
  if (parts.length <= 1) return [shape];
  // ordre : nord → sud, puis ouest → est ; noms par direction
  parts.sort((a, b) => b.c[1] - a.c[1] || a.c[0] - b.c[0]);
  const labels = directionNames(parts.map((p) => [sh(p.c[0]), p.c[1]]));
  return parts.map((p, idx) => ({
    ...shape,
    key: `${shape.key}#${idx}`,
    geom: p.geom,
    name: `${shape.name} ${labels[idx]}`,
    rawName: `${shape.name} ${labels[idx]}`,
    baseName: shape.name,
    sortKey: `${shape.sortKey}#${String(idx).padStart(2, '0')}`,
  }));
}
