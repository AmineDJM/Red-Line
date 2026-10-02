/**
 * Lieux réels pour les tests sur les vraies données : la province est désignée par une ville
 * (coordonnées), jamais par son identifiant, qui change quand la carte est redécoupée (fusion des
 * provinces, data/map/version.json).
 */
import { latLngToCell } from 'h3-js';
import type { LngLat, MapData, ProvinceDef } from '@redline/shared';

export const PLACES = {
  paris: [2.3522, 48.8566],
  lille: [3.0573, 50.6292],
  lyon: [4.8357, 45.764],
  toulon: [5.928, 43.1242],
  montpellier: [3.8767, 43.6108],
  charleroi: [4.444, 50.4108],
  bruxelles: [4.3517, 50.8503],
  namur: [4.8719, 50.4674],
  luxembourg: [6.1296, 49.6116],
  varsovie: [21.0122, 52.2297],
  cagliari: [9.1217, 39.2238],
  syracuse: [15.2866, 37.0755],
  laValette: [14.5146, 35.8989],
  koursk: [36.1874, 51.7304],
  kiev: [30.5234, 50.4501],
} satisfies Record<string, LngLat>;

/** Province qui contient un lieu (cellule H3 de la carte). */
export function provinceAt(map: MapData, p: LngLat): ProvinceDef {
  const id = map.cells.cells[latLngToCell(p[1], p[0], map.cells.res)];
  const prov = id ? map.provinces.find((x) => x.id === id) : undefined;
  if (!prov) throw new Error(`aucune province en ${p.join(', ')}`);
  return prov;
}
