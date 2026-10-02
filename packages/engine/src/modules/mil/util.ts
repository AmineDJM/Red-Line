import {
  MINUTE,
  distanceKm,
  frLe,
  type BuildingType,
  type GameNotification,
  type LngLat,
  type NationId,
  type OrderErrorCode,
  type ProvinceId,
  type WeaponSystem,
  type LocText,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { coverCap } from '../../geo/grid.js';
import { board } from '../kit.js';
import { scheduleMod } from '../kit.js';
import { nextFloat, seedRng, type RngState } from '../../rng/rng.js';
import { notify, sortedSet, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { mil } from './state.js';

/** Classification des systèmes du catalogue (déduite des fiches, jamais d'identifiants en dur). */

export const isAirSys = (s: WeaponSystem): boolean => s.movement === 'air';
export const isFuelAir = (s: WeaponSystem): boolean => s.movement === 'air' && !!s.air;
export const isTanker = (s: WeaponSystem): boolean => (s.air?.tankerFuelH ?? 0) > 0;
export const isAew = (s: WeaponSystem): boolean => s.sensor?.kind === 'aew';
export const isSeaSys = (s: WeaponSystem): boolean => s.movement === 'sea';
export const isSatellite = (s: WeaponSystem): boolean => s.category === 'space';
export const carrierCapacity = (s: WeaponSystem): number => s.naval?.aircraftCapacity ?? 0;
export const launchCells = (s: WeaponSystem): number => s.naval?.launchCells ?? 0;

export function isAsat(s: WeaponSystem): boolean {
  return s.category === 'space' && (s.roles.includes('asat') || /(^|[.-])asat($|-)/.test(s.id));
}

const earlyWarning = new WeakMap<WeaponSystem, boolean>();

export function isEarlyWarning(s: WeaponSystem): boolean {
  let v = earlyWarning.get(s);
  if (v === undefined) {
    v = s.sensor?.kind === 'early_warning' || /early-warning/.test(s.id);
    earlyWarning.set(s, v);
  }
  return v;
}

/**
 * Unités d'alerte avancée de la partie (index d'exécution, jamais sérialisé) : construit au premier
 * usage par un parcours de toutes les unités, puis tenu à jour par les crochets d'apparition et de
 * retrait (trackEarlyWarning). Les propriétaires et systèmes des unités ne changent jamais.
 */
const ewUnits = new WeakMap<EngineState, Set<string>>();

export function earlyWarningUnits(state: EngineState): Set<string> {
  let set = ewUnits.get(state);
  if (!set) {
    set = new Set();
    for (const id in state.units) if (isEarlyWarning(sysOf(state, state.units[id]!))) set.add(id);
    ewUnits.set(state, set);
  }
  return set;
}

export function trackEarlyWarning(state: EngineState, u: Unit, present: boolean): void {
  const set = ewUnits.get(state);
  if (!set) return;
  if (!present) set.delete(u.id);
  else if (isEarlyWarning(sysOf(state, u))) set.add(u.id);
}

/** Satellite : type de capteur (optique, radar, écoute, alerte avancée). */
export function satKind(s: WeaponSystem): 'optical' | 'radar' | 'sigint' | 'early_warning' | null {
  if (!isSatellite(s) || isAsat(s)) return null;
  if (isEarlyWarning(s)) return 'early_warning';
  const k = s.sensor?.kind;
  if (k === 'sigint' || /sigint/.test(s.id)) return 'sigint';
  if (k === 'radar' || /radar-satellite/.test(s.id)) return 'radar';
  return 'optical';
}

const RECON_ROLES = ['recon', 'reconnaissance', 'isr', 'surveillance', 'maritime_patrol'];

/** Drone ou avion de reconnaissance (imagerie à chaque survol). */
export function isRecon(s: WeaponSystem): boolean {
  if (s.movement !== 'air') return false;
  if (s.roles.some((r) => RECON_ROLES.includes(r))) return true;
  if (s.sensor?.kind === 'optical') return true;
  if (s.category === 'drone') {
    let dmg = 0;
    for (const v of Object.values(s.damage)) dmg += v;
    return dmg <= 0;
  }
  return false;
}

const SF_ROLES = ['special_forces', 'special-forces', 'spetsnaz', 'commando', 'special'];

export function isSpecialForces(s: WeaponSystem): boolean {
  return (
    s.category === 'infantry' &&
    (s.roles.some((r) => SF_ROLES.includes(r)) || /special-forces|spetsnaz|commando/.test(s.id))
  );
}

/** Classe d'interception d'un missile. */
export function interceptClass(kind: string): 'cruise' | 'ballistic' | 'hypersonic' {
  if (kind === 'ballistic' || kind === 'icbm' || kind === 'slbm') return 'ballistic';
  if (kind === 'hypersonic') return 'hypersonic';
  return 'cruise';
}

/** Portée de frappe d'un lanceur (km). */
export function strikeRangeKm(s: WeaponSystem): number {
  return Math.max(s.weaponRangeKm.max, s.sheet.rangeKm ?? 0, s.operationalRadiusKm ?? 0);
}

/* ------------------------------------------------------------------------------------------------ */

export function provDef(state: EngineState, pid: ProvinceId) {
  return wi(state.world).provById.get(pid);
}

export function cityOf(state: EngineState, pid: ProvinceId): LngLat | null {
  return provDef(state, pid)?.cityPoint ?? null;
}

export function provinceAt(state: EngineState, p: LngLat): ProvinceId | null {
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellOfPos(p));
  return pid && state.provinces[pid] ? pid : null;
}

/** Bâtiments d'une province (carte + construits en cours de partie), triés. */
export function buildingsOf(state: EngineState, pid: ProvinceId): BuildingType[] {
  const base = provDef(state, pid)?.buildings ?? [];
  const extra = board(state).extraBuildings?.[pid] ?? [];
  return [...new Set([...base, ...extra])].sort();
}

export function buildingHealth(state: EngineState, pid: ProvinceId, b: BuildingType): number {
  return board(state).buildingHealth?.[pid]?.[b] ?? 1;
}

/** La province possède-t-elle ce bâtiment en état de marche ? */
export function hasBuilding(state: EngineState, pid: ProvinceId, b: BuildingType): boolean {
  return buildingsOf(state, pid).includes(b) && buildingHealth(state, pid, b) > 0;
}

/** Terrains d'aviation d'une nation (provinces possédées avec base aérienne), triés. */
export function airfieldsOf(state: EngineState, n: NationId): ProvinceId[] {
  return sortedSet(state.rt.provsOf.get(n)).filter((p) => hasBuilding(state, p, 'air_base'));
}

/** Ports d'une nation (port ou base navale en état de marche). */
export function portsOf(state: EngineState, n: NationId): ProvinceId[] {
  return sortedSet(state.rt.provsOf.get(n)).filter(
    (p) =>
      (hasBuilding(state, p, 'port') || hasBuilding(state, p, 'naval_base')) &&
      !!wi(state.world).seaSpawn.get(p),
  );
}

/** Province la plus proche d'un point parmi une liste (départage par identifiant). */
export function nearestProvince(
  state: EngineState,
  list: ProvinceId[],
  p: LngLat,
): { pid: ProvinceId; d: number } | null {
  let best: { pid: ProvinceId; d: number } | null = null;
  for (const pid of list) {
    const c = cityOf(state, pid);
    if (!c) continue;
    const d = distanceKm(c, p);
    if (!best || d < best.d) best = { pid, d };
  }
  return best;
}

/**
 * Unités sur la carte dans un rayon (index spatial des trajets), triées par identifiant. `pre` : filtre
 * pur (sans effet) appliqué avant le calcul de distance — même résultat que filtrer ensuite.
 */
export function unitsNear(
  state: EngineState,
  at: LngLat,
  rKm: number,
  pre?: (u: Unit) => boolean,
): Unit[] {
  const cells = new Set<number>();
  coverCap(at, rKm + 1, cells);
  const ids = new Set<string>();
  state.rt.bodies.collect([...cells], ids);
  // Filtres purs d'abord, tri des seules unités retenues (même ordre que le parcours trié).
  const out: Unit[] = [];
  for (const id of ids) {
    const u = state.units[id];
    if (!u || u.off) continue;
    if (pre && !pre(u)) continue;
    if (distanceKm(unitPosAt(state, u, state.time), at) <= rKm) out.push(u);
  }
  if (out.length > 1) out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Provinces dont la ville est dans un rayon (index spatial des zones de province), triées. */
export function provincesNear(state: EngineState, at: LngLat, rKm: number): ProvinceId[] {
  const cells = new Set<number>();
  coverCap(at, rKm + 1, cells);
  const ids = new Set<string>();
  state.rt.zones.collect([...cells], ids);
  const out: ProvinceId[] = [];
  for (const e of [...ids].sort()) {
    if (!e.startsWith('p:')) continue;
    const pid = e.slice(2);
    const c = cityOf(state, pid);
    if (c && distanceKm(c, at) <= rKm) out.push(pid);
  }
  return out;
}

export function posOf(state: EngineState, u: Unit): LngLat {
  return unitPosAt(state, u, state.time);
}

export function distUnits(state: EngineState, a: Unit, b: Unit): number {
  return distanceKm(posOf(state, a), posOf(state, b));
}

/* ------------------------------------------------------------------------------------------------ */

/** PRNG propre au module (ne perturbe pas la suite du cœur), sérialisé dans l'état du module. */
export function milRng(state: EngineState): RngState {
  const m = mil(state);
  if (!m.rng) m.rng = seedRng((state.setup.seed ^ 0x5eed_4d11) >>> 0);
  return m.rng;
}

export function roll(state: EngineState): number {
  return nextFloat(milRng(state));
}

export function after(state: EngineState, minutes: number): number {
  return state.time + minutes * MINUTE;
}

export function schedule(state: EngineState, t: number, e: string, d?: unknown): void {
  scheduleMod(state, { t: Math.max(t, state.time), m: 'mil', e, d });
}

export function generic(
  state: EngineState,
  aud: NationId[] | null,
  category: string,
  title: string,
  text: string,
  severity: 'info' | 'warn' | 'critical',
  at: LngLat | null = null,
  locText?: { title: LocText; text: LocText },
): void {
  const n: GameNotification = {
    kind: 'generic',
    time: state.time,
    at,
    category,
    title,
    text,
    severity,
    ...(locText ? { loc: locText } : {}),
  };
  notify(state, n, aud);
}

export { noteLoc, placeOf } from '../../state/loc.js';

export function nameOfProvince(state: EngineState, pid: ProvinceId | null): string {
  if (!pid) return 'en mer';
  const d = provDef(state, pid);
  return d?.cityName ?? d?.name ?? pid;
}

/** Nom de nation avec son article (« le Maroc », « l'Algérie ») pour les textes de mil. */
export function nationLe(state: EngineState, n: NationId): string {
  const d = wi(state.world).nationById.get(n);
  return d ? frLe(d.name, d.article) : n.toUpperCase();
}

/** « à Oran », ou « en mer » hors de toute province. */
export function atProvince(state: EngineState, pid: ProvinceId | null): string {
  return pid ? `à ${nameOfProvince(state, pid)}` : 'en mer';
}

export function sysName(state: EngineState, u: Unit): string {
  return sysOf(state, u).name;
}

export function fail(error: OrderErrorCode, message?: string): OrderResult {
  return message ? { ok: false, error, message } : { ok: false, error };
}

export const OK: OrderResult = { ok: true };

/**
 * Unités d'un ordre (triées, dédoublonnées), appartenant à `n`. Les missiles en vol ne reçoivent
 * jamais d'ordre ; les unités hors carte (embarquées, satellites) seulement si `allowOff`.
 */
export function resolveOwn(
  state: EngineState,
  n: NationId,
  ids: string[],
  allowOff = false,
): Unit[] | OrderResult {
  const out: Unit[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    if (u.role || (u.off && !allowOff)) {
      return fail('not_allowed', `Unité indisponible pour cet ordre : ${id}`);
    }
    out.push(u);
  }
  return out;
}

/** Valeur d'un élément (dollars réels si connus, sinon coût du catalogue). */
export function elementValue(s: WeaponSystem): number {
  return s.unitPriceUsd ?? s.cost.money / Math.max(1, s.unitSize);
}

/** Doctrine dominante d'une nation (catalogue de ses unités), 'other' par défaut. */
export function doctrineOf(state: EngineState, n: NationId): WeaponSystem['doctrine'] {
  const count = new Map<string, number>();
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[id];
    if (!u || u.role) continue;
    const d = sysOf(state, u).doctrine;
    count.set(d, (count.get(d) ?? 0) + u.count);
  }
  let best: WeaponSystem['doctrine'] = 'other';
  let bestN = -1;
  for (const [d, c] of [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c > bestN) {
      bestN = c;
      best = d as WeaponSystem['doctrine'];
    }
  }
  return best;
}
