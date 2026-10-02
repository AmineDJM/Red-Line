/**
 * Ressources des provinces (principale, secondaire éventuelle, ou aucune = argent seulement) et
 * répartition des rendements de la carte en conséquence. Entièrement déterministe.
 *
 * 1. Données sourcées (resources-data.ts) : bassins, mines, greniers, pôles électroniques réels.
 * 2. Heuristiques, pour les provinces sans donnée seulement (règles ci-dessous, toujours richesse 1) :
 *    - capitale → aucune ressource (administration, services) ;
 *    - grande ville (rang ≤ 2) dense ou petite province urbaine → aucune (métropole de services) ;
 *    - micro-territoire (< 1 500 km²) → aucune ;
 *    - désert (boîtes ARID) → aucune (désert sans gisement connu) ;
 *    - au-delà de 66° de latitude → métaux si la province est vaste (> 50 000 km²), sinon aucune ;
 *    - entre 58° et 66° → métaux (bouclier, taïga minière), nourriture en second si peuplée ;
 *    - ailleurs → nourriture (agriculture), métaux en second dans les reliefs miniers (MOUNTAINS)
 *      ou les très vastes provinces.
 * 2 bis. Aucune nation sans ressource : une nation dont aucune province n'a de ressource après 1 et 2
 *    reçoit de la nourriture modeste (agriculture, pêche, élevage ; richesse 1, heuristique) dans sa
 *    plus grande province, hors capitale si elle en a une autre. Seuls les micro-États (superficie
 *    totale < MICRO_STATE_KM2 : Vatican, Monaco, Saint-Marin, Tuvalu) restent « argent seulement » ;
 *    comme toutes les nations, ils reçoivent en jeu le plancher national de production
 *    (data/balance `resources.nationalFloor`, moteur eco/budget.ts).
 * 3. Rendements (`income`) : pour chaque nation et chaque ressource, le total national de la carte
 *    est conservé et réparti entre les seules provinces qui possèdent la ressource, selon la richesse
 *    (plancher par richesse) ; les autres provinces n'en produisent plus. Idempotent.
 */
import type { ProvinceDef } from '@redline/shared';
import { MAP_ALIASES } from './aliases.js';
import { RESOURCE_ZONES, type Res, type ResourceZone } from './resources-data.js';

export type { Res } from './resources-data.js';
export interface Deposit {
  type: Res;
  richness: 1 | 2 | 3;
  source: 'data' | 'heuristic';
}

type Prov = Pick<
  ProvinceDef,
  'id' | 'name' | 'nationId' | 'centroid' | 'cityPoint' | 'isCapital' | 'areaKm2' | 'income'
> &
  Partial<Pick<ProvinceDef, 'cityName' | 'cityRank' | 'population'>>;

const RES_ORDER: Res[] = ['oil', 'metals', 'electronics', 'food'];

/** Boîtes arides [ouest, sud, est, nord] : déserts chauds et froids. */
export const ARID: [number, number, number, number][] = [
  [-17, 15.5, 34, 31.3], // Sahara
  [34, 15, 60, 31], // désert d'Arabie
  [52, 28, 61.5, 35], // Dasht-e Kavir, Lut
  [69, 24, 73.5, 29.5], // Thar
  [76, 36, 92, 41.5], // Taklamakan
  [92, 39, 112, 45], // Gobi
  [118, -32, 142, -18], // déserts australiens
  [-71.5, -28, -68, -18], // Atacama
  [12, -28, 24, -17], // Namib, Kalahari
  [-120, 31, -110, 42], // Grand Bassin, Mojave, Sonora
  [53, 37.5, 66, 45], // Karakoum, Kyzylkoum
  [40, 2, 51, 12], // Corne de l'Afrique
];

/** Reliefs miniers [ouest, sud, est, nord] : métaux en ressource secondaire. */
export const MOUNTAINS: [number, number, number, number][] = [
  [-80, -45, -64, 10], // Andes
  [-120, 35, -104, 55], // Rocheuses
  [56, 50, 62, 68], // Oural
  [68, 38, 92, 52], // Tian Shan, Altaï
  [-84, 35, -77, 42], // Appalaches (charbon)
  [145, -38, 153, -20], // Cordillère australienne
  [10, 60, 25, 70], // Alpes scandinaves
  [40, 41, 48, 44], // Caucase
  [45, 27, 56, 37], // Zagros
  [25, -15, 32, -8], // arc cuprifère d'Afrique centrale
];

const inBox = ([lng, lat]: [number, number], b: [number, number, number, number]) =>
  lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r;
  const dLng = (b[0] - a[0]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Provinces désignées par « nation:Nom » : nom de province d'abord, sinon ancien nom d'une province
 * fusionnée (data/map/aliases.json), sinon nom de ville.
 */
export function resolveRef<P extends Prov>(
  ref: string,
  provs: readonly P[],
  aliases: Record<string, string> = MAP_ALIASES,
): P[] {
  const i = ref.indexOf(':');
  const nation = ref.slice(0, i);
  const name = ref.slice(i + 1);
  const own = provs.filter((p) => p.nationId === nation);
  const byName = own.filter((p) => p.name === name);
  if (byName.length > 0) return byName;
  const id = aliases[ref];
  if (id) return own.filter((p) => p.id === id);
  return own.filter((p) => p.cityName === name);
}

/** Provinces d'une zone sourcée (un cercle n'atteint jamais une capitale). */
export function zoneProvinces<P extends Prov>(z: ResourceZone, provs: readonly P[]): P[] {
  const out = new Set<P>();
  for (const ref of z.provinces ?? []) for (const p of resolveRef(ref, provs)) out.add(p);
  if (z.circle) {
    const [lng, lat, km] = z.circle;
    for (const p of provs) {
      if (p.isCapital || (z.nations && !z.nations.includes(p.nationId))) continue;
      if (haversineKm(p.cityPoint, [lng, lat]) <= km || haversineKm(p.centroid, [lng, lat]) <= km)
        out.add(p);
    }
  }
  return [...out];
}

/** Ressources issues des données sourcées, par province. */
export function sourcedDeposits(provs: readonly Prov[]): Map<string, Deposit[]> {
  const best = new Map<string, Map<Res, 1 | 2 | 3>>();
  for (const z of RESOURCE_ZONES)
    for (const p of zoneProvinces(z, provs)) {
      const m = best.get(p.id) ?? new Map<Res, 1 | 2 | 3>();
      m.set(z.resource, Math.max(m.get(z.resource) ?? 0, z.richness) as 1 | 2 | 3);
      best.set(p.id, m);
    }
  const out = new Map<string, Deposit[]>();
  for (const [id, m] of best)
    out.set(
      id,
      [...m]
        .sort((a, b) => b[1] - a[1] || RES_ORDER.indexOf(a[0]) - RES_ORDER.indexOf(b[0]))
        .slice(0, 2)
        .map(([type, richness]) => ({ type, richness, source: 'data' as const })),
    );
  return out;
}

/** Heuristique (province sans donnée sourcée). */
export function heuristicDeposits(p: Prov): Deposit[] {
  const h = (type: Res): Deposit => ({ type, richness: 1, source: 'heuristic' });
  if (p.isCapital) return [];
  const area = Math.max(1, p.areaKm2);
  const density = (p.population ?? 0) / area;
  const rank = p.cityRank ?? 4;
  if (rank <= 2 && (density >= 150 || area < 15_000)) return [];
  if (area < 1_500) return [];
  const at = p.centroid;
  if (ARID.some((b) => inBox(at, b))) return [];
  const lat = Math.abs(at[1]);
  if (lat >= 66) return area > 50_000 ? [h('metals')] : [];
  if (lat >= 58) return density >= 10 ? [h('metals'), h('food')] : [h('metals')];
  if (MOUNTAINS.some((b) => inBox(at, b)) || area >= 150_000) return [h('food'), h('metals')];
  return [h('food')];
}

/** Superficie totale (km²) sous laquelle un micro-État peut rester « argent seulement ». */
export const MICRO_STATE_KM2 = 100;

/**
 * Province qui reçoit la ressource de repli d'une nation sans aucune ressource : la plus grande,
 * hors capitale s'il y en a une autre (identifiant en départage) ; null pour un micro-État.
 */
export function fallbackProvince<P extends Prov>(list: readonly P[]): P | null {
  const area = list.reduce((s, p) => s + Math.max(0, p.areaKm2), 0);
  if (list.length === 0 || area < MICRO_STATE_KM2) return null;
  const pool = list.some((p) => !p.isCapital) ? list.filter((p) => !p.isCapital) : list;
  return [...pool].sort((a, b) => b.areaKm2 - a.areaKm2 || (a.id < b.id ? -1 : 1))[0]!;
}

/** Ressources de toutes les provinces. */
export function assignResources(provs: readonly Prov[]): Map<string, Deposit[]> {
  const sourced = sourcedDeposits(provs);
  const out = new Map<string, Deposit[]>();
  for (const p of provs) out.set(p.id, sourced.get(p.id) ?? heuristicDeposits(p));
  // Aucune nation sans ressource (micro-États exceptés).
  const byNation = new Map<string, Prov[]>();
  for (const p of provs) byNation.set(p.nationId, [...(byNation.get(p.nationId) ?? []), p]);
  for (const [, list] of [...byNation].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.some((p) => (out.get(p.id) ?? []).length > 0)) continue;
    const p = fallbackProvince(list);
    if (p) out.set(p.id, [{ type: 'food', richness: 1, source: 'heuristic' }]);
  }
  return out;
}

/** Plancher de rendement par richesse (ressource principale ; × 0,6 en secondaire). */
const FLOOR: Record<1 | 2 | 3, number> = { 1: 2, 2: 8, 3: 20 };
/** Poids de répartition par richesse. */
const WEIGHT: Record<1 | 2 | 3, number> = { 1: 1, 2: 2.5, 3: 6 };

/**
 * Rendements cohérents avec les ressources : total national conservé (relevé aux planchers si
 * besoin), réparti entre les provinces qui ont la ressource ; restes au plus fort reste (tri stable).
 */
export function reshapeIncome<P extends Prov>(
  provs: readonly P[],
  deposits: Map<string, Deposit[]>,
): Map<string, P['income']> {
  const out = new Map<string, P['income']>();
  for (const p of provs) out.set(p.id, { money: p.income.money });
  const byNation = new Map<string, P[]>();
  for (const p of provs) {
    const l = byNation.get(p.nationId) ?? [];
    l.push(p);
    byNation.set(p.nationId, l);
  }
  for (const [, list] of [...byNation].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    for (const r of RES_ORDER) {
      let total = 0;
      for (const p of list) total += p.income[r] ?? 0;
      const holders = list
        .map((p) => {
          const ds = deposits.get(p.id) ?? [];
          const k = ds.findIndex((d) => d.type === r);
          if (k < 0) return null;
          const d = ds[k]!;
          const rankF = k === 0 ? 1 : 0.6;
          const size = Math.min(2, Math.max(0.5, Math.sqrt(p.areaKm2 / 20_000)));
          return {
            id: p.id,
            floor: Math.max(1, Math.round(FLOOR[d.richness] * rankF)),
            w: WEIGHT[d.richness] * rankF * size,
          };
        })
        .filter((x): x is { id: string; floor: number; w: number } => x !== null)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (holders.length === 0) continue;
      const floors = holders.reduce((s, x) => s + x.floor, 0);
      total = Math.max(Math.round(total), floors);
      const rest = total - floors;
      const W = holders.reduce((s, x) => s + x.w, 0);
      const parts = holders.map((x) => {
        const v = (rest * x.w) / W;
        return { ...x, v: Math.floor(v), frac: v - Math.floor(v) };
      });
      let left = rest - parts.reduce((s, x) => s + x.v, 0);
      for (const x of [...parts].sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1))) {
        if (left <= 0) break;
        x.v++;
        left--;
      }
      for (const x of parts) out.get(x.id)![r] = x.floor + x.v;
    }
  return out;
}
