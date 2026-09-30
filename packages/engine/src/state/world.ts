import {
  distanceKm,
  toVec,
  type Balance,
  type LngLat,
  type MapData,
  type NationDef,
  type NationId,
  type ProvinceDef,
  type ProvinceId,
  type Vec3,
  type WeaponSystem,
} from '@redline/shared';
import type { World } from '../api.js';
import { NavGraph } from '../nav/graph.js';

/** Rayon autour du point de ville dans lequel une unité capture la province (km). */
export const CAPTURE_RADIUS_KM = 5;

export interface WorldInternal {
  nav: NavGraph;
  provById: Map<ProvinceId, ProvinceDef>;
  nationById: Map<NationId, NationDef>;
  provIds: ProvinceId[];
  nationIds: NationId[];
  /** Provinces de chaque nation au départ (triées). */
  provsByNation: Map<NationId, ProvinceId[]>;
  cityVec: Map<ProvinceId, Vec3>;
  /** Point de mise à l'eau le plus proche de la ville (navires), null si enclavée. */
  seaSpawn: Map<ProvinceId, LngLat | null>;
  /** Rayon de la zone fixe d'une province (détection, ville, contact terrestre), km. */
  provZoneKm: number;
  /** Identifiants du catalogue triés. */
  systemIds: string[];
}

export function wi(world: World): WorldInternal {
  return world.internal as WorldInternal;
}

export function buildWorld(map: MapData, catalog: WeaponSystem[], balance: Balance): World {
  const cellProv = new Map<string, ProvinceId>();
  for (const cell of Object.keys(map.cells.cells).sort()) cellProv.set(cell, map.cells.cells[cell]!);
  const strait = new Set<string>();
  for (const s of map.straits) for (const c of s.seaCells) strait.add(c);
  const nav = new NavGraph(map.cells.res, cellProv, strait);

  const provById = new Map<ProvinceId, ProvinceDef>();
  for (const p of map.provinces) provById.set(p.id, p);
  const nationById = new Map<NationId, NationDef>();
  for (const n of map.nations) nationById.set(n.id, n);
  const provIds = [...provById.keys()].sort();
  const nationIds = [...nationById.keys()].sort();
  const provsByNation = new Map<NationId, ProvinceId[]>();
  for (const id of provIds) {
    const p = provById.get(id)!;
    let list = provsByNation.get(p.nationId);
    if (!list) provsByNation.set(p.nationId, (list = []));
    list.push(id);
  }
  const cityVec = new Map<ProvinceId, Vec3>();
  const seaSpawn = new Map<ProvinceId, LngLat | null>();
  for (const id of provIds) {
    const p = provById.get(id)!;
    cityVec.set(id, toVec(p.cityPoint));
  }
  for (const [id, pt] of findSeaSpawns(nav, provById)) seaSpawn.set(id, pt);
  const catalogMap = new Map<string, WeaponSystem>();
  for (const s of catalog) catalogMap.set(s.id, s);
  const internal: WorldInternal = {
    nav,
    provById,
    nationById,
    provIds,
    nationIds,
    provsByNation,
    cityVec,
    seaSpawn,
    provZoneKm: Math.max(
      balance.sensors.provinceDetectionKm,
      CAPTURE_RADIUS_KM,
      balance.combat.groundContactKm,
    ),
    systemIds: [...catalogMap.keys()].sort(),
  };
  return { map, catalog: catalogMap, balance, internal };
}

/**
 * Point de mise à l'eau de chaque province côtière : la cellule marine voisine d'une de ses cellules
 * terrestres, la plus proche du point de ville. Null si la province n'a pas de côte.
 */
function findSeaSpawns(
  nav: NavGraph,
  provById: Map<ProvinceId, ProvinceDef>,
): Map<ProvinceId, LngLat | null> {
  const best = new Map<ProvinceId, { d: number; p: LngLat }>();
  for (const [cell, pid] of nav.cellProv) {
    const def = provById.get(pid);
    if (!def) continue;
    for (const nb of nav.neighbors(nav.node(cell))) {
      if (nav.land[nb] === 1) continue;
      const p = nav.center(nb);
      const d = distanceKm(p, def.cityPoint);
      const cur = best.get(pid);
      if (!cur || d < cur.d || (d === cur.d && (p[0] < cur.p[0] || (p[0] === cur.p[0] && p[1] < cur.p[1])))) {
        best.set(pid, { d, p });
      }
    }
  }
  const out = new Map<ProvinceId, LngLat | null>();
  for (const pid of [...provById.keys()].sort()) out.set(pid, best.get(pid)?.p ?? null);
  return out;
}
