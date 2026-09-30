/**
 * Pipeline de la carte de jeu Red Line (Natural Earth, domaine public).
 *   pnpm --filter @redline/tools-map build
 * Sorties : data/map/{nations.json, provinces.json, provinces.geojson, cells.json, straits.json,
 * disputed.json} et data/basemap/*.geojson.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridDisk } from 'h3-js';
import prettier from 'prettier';
import {
  CellsFileSchema,
  DisputedAreaSchema,
  NationDefSchema,
  ProvinceDefSchema,
  StraitSchema,
  type DisputedArea,
  type NationDef,
  type ProvinceDef,
  type Strait,
} from '@redline/shared';
import * as basemap from './basemap.js';
import {
  allCells,
  cellCenter,
  cellOf,
  cellsInMulti,
  componentSizes,
  navalCells,
  nudgeInto,
  pathCells,
  seaPath,
} from './cells.js';
import { DISPUTED, H3_RES, NE_FILES, SEA_LINKS, SIMPLIFY, STRAITS } from './config.js';
import { buildings, colorNations, income, type EcoInput } from './economy.js';
import {
  areaKm2,
  bboxOf,
  haversineKm,
  inBBox,
  interiorPoint,
  multiGeom,
  pointInMulti,
  round,
  type BBox,
  type MultiPolygon,
  type Pos,
} from './geo.js';
import {
  buildNations,
  buildProvinceShapes,
  buildUnits,
  loadPlaces,
  mergeUnits,
  nationCapitals,
  type Place,
} from './provinces.js';
import { loadNE, REPO_DIR, type FeatureCollection } from './sources.js';
import { adjacency, simplify } from './topology.js';

const MAP_DIR = join(REPO_DIR, 'data', 'map');
const BASEMAP_DIR = join(REPO_DIR, 'data', 'basemap');
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);

interface Prov {
  id: string;
  key: string;
  nation: string;
  name: string;
  geom: MultiPolygon;
  bbox: BBox;
  area: number;
  center: Pos;
  cityPoint: Pos;
  cityPlace?: Place;
  cityPop: number;
  pop: number;
  isCapital: boolean;
  disputed?: string;
}

async function writeJson(file: string, data: unknown, pretty: boolean): Promise<number> {
  let text = JSON.stringify(data);
  if (pretty) text = await prettier.format(text, { parser: 'json', printWidth: 100 });
  else text += '\n';
  writeFileSync(file, text);
  return Buffer.byteLength(text);
}

async function main() {
  mkdirSync(MAP_DIR, { recursive: true });
  mkdirSync(BASEMAP_DIR, { recursive: true });

  log('Sources Natural Earth');
  const admin0 = await loadNE(NE_FILES.admin0);
  const mapUnits = await loadNE('ne_10m_admin_0_map_units');
  const admin1 = await loadNE(NE_FILES.admin1);
  const placesFc = await loadNE(NE_FILES.places);
  const marine = await loadNE(NE_FILES.marine);
  const coast = await loadNE(NE_FILES.coastline);

  const nt = buildNations(admin0, mapUnits);
  const places = loadPlaces(placesFc);
  log(`Nations : ${nt.nations.size}`);

  const { units, impassable } = buildUnits(admin1, admin0, nt, places);
  log(`Unités admin-1 : ${units.length}`);
  const groupOf = await mergeUnits(units, nt);
  log(`Groupes après fusion : ${new Set(groupOf.values()).size}`);
  const shapes = await buildProvinceShapes(units, groupOf, places);
  log(`Provinces après découpe : ${shapes.length}`);

  // ---- Identifiants stables ----
  const byNation = new Map<string, typeof shapes>();
  for (const s of shapes) {
    const l = byNation.get(s.nation) ?? [];
    l.push(s);
    byNation.set(s.nation, l);
  }
  const provs: Prov[] = [];
  for (const [nation, list] of [...byNation].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    list.forEach((s, i) => {
      provs.push({
        id: `${nation}-${i + 1}`,
        key: s.key,
        nation,
        name: s.name,
        geom: s.geom,
        bbox: bboxOf(s.geom),
        area: areaKm2(s.geom),
        center: interiorPoint(s.geom),
        cityPoint: [0, 0],
        cityPop: 0,
        pop: s.pop,
        isCapital: false,
        ...(s.disputed ? { disputed: s.disputed } : {}),
      });
    });
  }
  const provById = new Map(provs.map((p) => [p.id, p]));

  // ---- Villes, population, capitales ----
  const placeProv = new Map<number, Prov>();
  for (const pl of places) {
    for (const p of provs) {
      if (!inBBox(pl.pos, p.bbox) || !pointInMulti(pl.pos, p.geom)) continue;
      placeProv.set(pl.idx, p);
      p.cityPop += pl.pop;
      if (!p.cityPlace || pl.pop > p.cityPlace.pop) p.cityPlace = pl;
      break;
    }
  }
  const capitals = nationCapitals(nt, places);
  const provsOf = new Map<string, Prov[]>();
  for (const p of provs) {
    const l = provsOf.get(p.nation) ?? [];
    l.push(p);
    provsOf.set(p.nation, l);
  }
  for (const n of [...nt.nations.keys()])
    if (!provsOf.has(n)) {
      console.warn(`  nation sans province retirée : ${n}`);
      nt.nations.delete(n);
    }
  const capitalOf = new Map<string, Prov>();
  for (const [nid, list] of provsOf) {
    const cap = capitals.get(nid);
    let prov: Prov | undefined;
    if (cap) {
      const inside = placeProv.get(cap.idx);
      prov =
        inside && inside.nation === nid
          ? inside
          : [...list].sort(
              (a, b) => haversineKm(a.center, cap.pos) - haversineKm(b.center, cap.pos),
            )[0];
    }
    prov ??= [...list].sort((a, b) => b.pop - a.pop)[0]!;
    prov.isCapital = true;
    capitalOf.set(nid, prov);
    if (cap && placeProv.get(cap.idx) === prov) {
      prov.cityPlace = cap;
    } else if (!cap) console.warn(`  capitale introuvable pour ${nid}, province la plus peuplée`);
  }
  for (const p of provs)
    p.cityPoint = p.cityPlace
      ? [round(p.cityPlace.pos[0], 4), round(p.cityPlace.pos[1], 4)]
      : p.center;
  log('Villes et capitales');

  // ---- Grille H3 ----
  const cellProv = new Map<string, string>();
  const provCells = new Map<string, Set<string>>();
  for (const p of provs) provCells.set(p.id, new Set());
  const setCell = (c: string, id: string) => {
    const prev = cellProv.get(c);
    if (prev) provCells.get(prev)!.delete(c);
    cellProv.set(c, id);
    provCells.get(id)!.add(c);
  };
  for (const p of [...provs].sort((a, b) => b.area - a.area || a.id.localeCompare(b.id)))
    for (const c of cellsInMulti(p.geom, H3_RES)) setCell(c, p.id);
  const impassableCells = new Set<string>();
  for (const g of impassable)
    for (const c of cellsInMulti(g, H3_RES)) if (!cellProv.has(c)) impassableCells.add(c);
  // chaque province possède la cellule de sa ville (les plus petites d'abord)
  const cityClaim = new Map<string, string>();
  let nudged = 0;
  for (const p of [...provs].sort((a, b) => a.area - b.area || a.id.localeCompare(b.id))) {
    let c = cellOf(p.cityPoint, H3_RES);
    if (cityClaim.has(c)) {
      // cellule déjà prise par la ville d'une province plus petite : on déplace le point
      const own = [...provCells.get(p.id)!].filter((x) => !cityClaim.has(x));
      let target: string | undefined = own.sort(
        (a, b) =>
          haversineKm(cellCenter(a), p.cityPoint) - haversineKm(cellCenter(b), p.cityPoint) ||
          a.localeCompare(b),
      )[0];
      for (let k = 1; !target && k < 6; k++)
        target = gridDisk(c, k)
          .filter((x) => !cityClaim.has(x))
          .sort(
            (a, b) =>
              haversineKm(cellCenter(a), p.cityPoint) - haversineKm(cellCenter(b), p.cityPoint) ||
              a.localeCompare(b),
          )[0];
      c = target!;
      p.cityPoint = nudgeInto(p.cityPoint, c, H3_RES);
      nudged++;
    }
    cityClaim.set(c, p.id);
    impassableCells.delete(c);
    setCell(c, p.id);
  }
  log(
    `Cellules terrestres : ${cellProv.size}, infranchissables : ${impassableCells.size}, villes déplacées : ${nudged}`,
  );

  // ---- Détroits et grille navale ----
  const straits: Strait[] = STRAITS.map((s) => ({
    id: s.id,
    name: s.name,
    seaCells: pathCells(s.path, H3_RES),
  }));
  const straitCells = straits.flatMap((s) => s.seaCells);
  const naval = navalCells(cellProv.keys(), impassableCells, straitCells, H3_RES);
  const comp = componentSizes(naval);
  for (const l of SEA_LINKS) {
    const d = seaPath(naval, l.from, l.to, l.maxKm, H3_RES);
    log(
      `  mer ${l.name} : ${d >= 0 ? `${d} cellules` : d === -2 ? 'POINT EN TERRE' : 'NON CONNECTÉ'}`,
    );
  }

  // ---- Voisinages, côtes ----
  const provFc: FeatureCollection = {
    type: 'FeatureCollection',
    features: provs.map((p) => ({
      type: 'Feature',
      properties: { id: p.id },
      geometry: multiGeom(p.geom),
    })),
  };
  const adj = await adjacency(provFc, 'id');
  const neighbors = new Map<string, Set<string>>();
  for (const p of provs) neighbors.set(p.id, new Set());
  for (const [a, m] of adj.shared) for (const [b, len] of m) if (len > 0) neighbors.get(a)!.add(b);
  for (const [c, id] of cellProv)
    for (const n of gridDisk(c, 1)) {
      const o = cellProv.get(n);
      if (o && o !== id) {
        neighbors.get(id)!.add(o);
        neighbors.get(o)!.add(id);
      }
    }
  const coastal = new Map<string, boolean>();
  for (const p of provs) {
    let sea = false;
    for (const c of provCells.get(p.id)!) {
      for (const n of gridDisk(c, 1)) if (naval.has(n) && (comp.get(n) ?? 0) >= 150) sea = true;
      if (sea) break;
    }
    coastal.set(p.id, sea && (adj.exterior.get(p.id) ?? 0) > 0.5);
  }
  log('Voisinages et côtes');

  // ---- Économie, bâtiments ----
  const provDefs: ProvinceDef[] = [];
  const gdpOf = (p: Prov) => {
    const n = nt.nations.get(p.nation)!;
    return (n.gdp * p.pop) / n.pop;
  };
  const rankOf = new Map<string, number>();
  for (const list of provsOf.values())
    [...list]
      .sort((a, b) => gdpOf(b) - gdpOf(a) || a.id.localeCompare(b.id))
      .forEach((p, i) => rankOf.set(p.id, i));
  for (const p of provs) {
    const n = nt.nations.get(p.nation)!;
    const nb = [...neighbors.get(p.id)!].sort((a, b) => cmpId(a, b));
    const eco: EcoInput = {
      id: p.id,
      nation: p.nation,
      area: p.area,
      pop: p.pop,
      gdp: gdpOf(p),
      gdpPerCap: (n.gdp * 1e6) / n.pop,
      lat: p.center[1],
      coastal: coastal.get(p.id)!,
      hasCity: !!p.cityPlace,
      isCapital: p.isCapital,
      borderForeign: [...(adj.shared.get(p.id)?.keys() ?? [])].some(
        (o) => provById.get(o)!.nation !== p.nation,
      ),
    };
    const inc = income(eco);
    provDefs.push({
      id: p.id,
      name: p.name,
      nationId: p.nation,
      centroid: p.center,
      cityPoint: p.cityPoint,
      isCapital: p.isCapital,
      coastal: eco.coastal,
      income: inc,
      buildings: buildings(eco, inc, rankOf.get(p.id)!, provsOf.get(p.nation)!.length),
      neighbors: nb,
      areaKm2: Math.round(p.area),
    });
  }

  // ---- Nations et couleurs ----
  const nationNb = new Map<string, Set<string>>();
  for (const n of nt.nations.keys()) nationNb.set(n, new Set());
  const link = (a: string, b: string) => {
    if (a === b) return;
    nationNb.get(a)!.add(b);
    nationNb.get(b)!.add(a);
  };
  for (const p of provDefs) for (const o of p.neighbors) link(p.nationId, provById.get(o)!.nation);
  // proximité maritime (≈ 3 cellules, 130 km) : voisins visuels à distinguer aussi
  for (const [c, id] of cellProv)
    for (const n of gridDisk(c, 3)) {
      const o = cellProv.get(n);
      if (o) link(provById.get(id)!.nation, provById.get(o)!.nation);
    }
  const colors = colorNations([...nt.nations.keys()], nationNb);
  const nations: NationDef[] = [...nt.nations.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      iso: n.iso,
      name: n.name,
      kind: n.kind,
      color: colors.get(n.id)!,
      capitalProvinceId: capitalOf.get(n.id)!.id,
    }));

  // ---- Zones disputées ----
  const disputed: DisputedArea[] = DISPUTED.map((d) => ({
    id: d.id,
    name: d.name,
    provinceIds: provs.filter((p) => p.disputed === d.id).map((p) => p.id),
    claimants: d.claimants,
    tension: d.tension,
    revoltRate: d.revoltRate,
  }));

  // ---- Validation zod ----
  const nationsOut = nations.map((n) => NationDefSchema.parse(n));
  const provsOut = provDefs.map((p) => ProvinceDefSchema.parse(p));
  const cellsSorted = [...cellProv].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const cellsOut = {
    ...CellsFileSchema.parse({ res: H3_RES, cells: Object.fromEntries(cellsSorted) }),
    /** Extension : cellules terrestres sans propriétaire (Antarctique…), infranchissables. */
    impassable: [...impassableCells].sort(),
  };
  const straitsOut = straits.map((s) => StraitSchema.parse(s));
  const disputedOut = disputed.map((d) => DisputedAreaSchema.parse(d));

  // ---- Écriture ----
  const sizes: [string, number][] = [];
  const w = async (dir: string, name: string, data: unknown, pretty: boolean) =>
    sizes.push([name, await writeJson(join(dir, name), data, pretty)]);
  await w(MAP_DIR, 'nations.json', nationsOut, true);
  await w(MAP_DIR, 'provinces.json', provsOut, true);
  await w(MAP_DIR, 'cells.json', cellsOut, false);
  await w(MAP_DIR, 'straits.json', straitsOut, true);
  await w(MAP_DIR, 'disputed.json', disputedOut, true);
  const simplified = await simplify(provFc, SIMPLIFY.percentage, SIMPLIFY.precision);
  writeFileSync(join(MAP_DIR, 'provinces.geojson'), simplified);
  sizes.push(['provinces.geojson', Buffer.byteLength(simplified)]);
  log('Carte écrite');

  // ---- Fond de carte ----
  const coastText = await basemap.coastline(coast);
  writeFileSync(join(BASEMAP_DIR, 'coastline.geojson'), coastText);
  sizes.push(['basemap/coastline.geojson', Buffer.byteLength(coastText)]);
  const nationOfPlace = (pl: Place) => placeProv.get(pl.idx)?.nation;
  const fallback = new Map([...capitalOf].map(([n, p]) => [n, p.center]));
  for (const [name, fc] of [
    ['seas.geojson', basemap.seas(marine)],
    ['countries.geojson', basemap.countries([...nt.nations.values()], fallback)],
    ['cities.geojson', basemap.cities(places, nationOfPlace)],
  ] as const)
    await w(BASEMAP_DIR, name, fc, false);
  log('Fond de carte écrit');

  // ---- Bilan ----
  const cnt = new Map<string, number>();
  for (const p of provsOut) cnt.set(p.nationId, (cnt.get(p.nationId) ?? 0) + 1);
  const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(
    `\nNations : ${nationsOut.length}  Provinces : ${provsOut.length}  Cellules : ${cellProv.size}`,
  );
  console.log(`Plus découpées : ${top.map(([n, c]) => `${n} ${c}`).join(', ')}`);
  const money = provsOut.map((p) => p.income.money).sort((a, b) => a - b);
  console.log(
    `Argent/jour : min ${money[0]} médiane ${money[money.length >> 1]} max ${money[money.length - 1]}`,
  );
  for (const [n, s] of sizes) console.log(`  ${n.padEnd(28)} ${(s / 1e6).toFixed(2)} Mo`);
  void allCells;
}

function cmpId(a: string, b: string): number {
  const [na, ia] = splitId(a);
  const [nb, ib] = splitId(b);
  return na < nb ? -1 : na > nb ? 1 : ia - ib;
}
function splitId(id: string): [string, number] {
  const i = id.lastIndexOf('-');
  return [id.slice(0, i), Number(id.slice(i + 1))];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
