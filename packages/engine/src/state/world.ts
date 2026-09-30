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
import { gridDisk, latLngToCell } from 'h3-js';
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
    seaSpawn.set(id, findSeaSpawn(nav, p.cityPoint));
  }
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

function findSeaSpawn(nav: NavGraph, city: LngLat): LngLat | null {
  const cell = latLngToCell(city[1], city[0], nav.res);
  for (let k = 1; k <= 4; k++) {
    let best: LngLat | null = null;
    let bestD = Infinity;
    for (const c of gridDisk(cell, k).sort()) {
      if (nav.isLandCell(c)) continue;
      const p = nav.center(nav.node(c));
      const d = distanceKm(p, city);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) return best;
  }
  return null;
}
