import { cellToChildren, cellToLatLng, cellToParent, getRes0Cells, gridDisk } from 'h3-js';
import { distanceKm, type LngLat, type MapData, type ProvinceDef } from '@redline/shared';

/**
 * Carte synthétique à l'échelle du monde (H3 résolution 4) : des « continents » en calottes
 * sphériques ; une province par cellule H3 de résolution 2 (≈ 1 800), une nation par cellule de
 * résolution 1 (≈ 250). Sert aux mesures de performance, indépendamment de la vraie carte.
 */
const CONTINENTS: { c: LngLat; r: number }[] = [
  { c: [-100, 45], r: 3300 },
  { c: [-60, -15], r: 2900 },
  { c: [20, 5], r: 3600 },
  { c: [85, 45], r: 4000 },
  { c: [20, 52], r: 1800 },
  { c: [135, -25], r: 2100 },
  { c: [140, 60], r: 1500 },
];

function isLand(p: LngLat): boolean {
  return CONTINENTS.some((k) => distanceKm(p, k.c) < k.r);
}

export function worldScaleMap(): MapData {
  const cells: Record<string, string> = {};
  const provCells = new Map<string, { cells: string[]; center: LngLat }>(); // res2 → cellules terrestres
  const res2All = getRes0Cells().flatMap((c) => cellToChildren(c, 2)).sort();
  for (const p2 of res2All) {
    const land: string[] = [];
    for (const c of cellToChildren(p2, 4)) {
      const [lat, lng] = cellToLatLng(c);
      if (isLand([lng, lat])) land.push(c);
    }
    if (land.length === 0) continue;
    const [lat, lng] = cellToLatLng(p2);
    provCells.set(p2, { cells: land.sort(), center: [lng, lat] });
  }
  // Nations : parent de résolution 1.
  const byNation = new Map<string, string[]>();
  for (const p2 of [...provCells.keys()].sort()) {
    const p1 = cellToParent(p2, 1);
    if (!byNation.has(p1)) byNation.set(p1, []);
    byNation.get(p1)!.push(p2);
  }
  const nationIds = new Map<string, string>();
  [...byNation.keys()].sort().forEach((p1, i) => nationIds.set(p1, `n${i.toString(36).padStart(2, '0')}`));
  const provId = new Map<string, string>();
  for (const [p1, list] of byNation) list.forEach((p2, k) => provId.set(p2, `${nationIds.get(p1)}-${k + 1}`));

  const provinces: ProvinceDef[] = [];
  for (const p2 of [...provCells.keys()].sort()) {
    const { cells: land, center } = provCells.get(p2)!;
    const id = provId.get(p2)!;
    let city = land[0]!;
    let best = Infinity;
    for (const c of land) {
      const [la, lo] = cellToLatLng(c);
      const d = distanceKm([lo, la], center);
      if (d < best) {
        best = d;
        city = c;
      }
      cells[c] = id;
    }
    const [cla, clo] = cellToLatLng(city);
    const neighbors = gridDisk(p2, 1)
      .filter((x) => x !== p2 && provId.has(x))
      .map((x) => provId.get(x)!)
      .sort();
    provinces.push({
      id,
      name: id,
      nationId: id.split('-')[0]!,
      centroid: [clo, cla],
      cityPoint: [clo, cla],
      isCapital: id.endsWith('-1'),
      coastal: land.length < 49,
      income: { money: 50, oil: 2 },
      buildings: [],
      neighbors,
      areaKm2: land.length * 1770,
    });
  }
  const nations = [...nationIds.values()].sort().map((id, i) => ({
    id,
    iso: id.toUpperCase(),
    name: `Nation ${id}`,
    kind: 'state' as const,
    color: `#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}`,
    capitalProvinceId: `${id}-1`,
  }));
  return { nations, provinces, cells: { res: 4, cells }, straits: [], disputed: [] };
}
