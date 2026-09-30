import {
  EARTH_RADIUS_KM,
  type NationId,
  type ProvinceId,
  type UnitId,
  type Vec3,
} from '@redline/shared';
import { coverCap, sweepCells } from '../geo/grid.js';
import { dotAt, nextBandChange } from '../geo/crossing.js';
import { pieceIndexAt, vecAngle, type Piece } from '../geo/sphere.js';
import { schedule, sortedSet, unitPieces } from '../state/access.js';
import { addToIndex, removeFromIndex } from '../state/runtime.js';
import type { EngineState, PairState, Unit } from '../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../state/world.js';
import { changeSight, detectionLevel, detectionRadii } from './sight.js';
import { inRange, provSightRangeKm, sightRangeKm, weaponRange, zoneKm } from './profile.js';

/**
 * Rencontres. Chaque paire (unité, unité étrangère) ou (province, unité) proche est surveillée : on
 * calcule l'instant exact du prochain franchissement d'un de ses seuils (portées de détection par
 * niveau, portées d'armes, rayon de capture, contact terrestre) et on programme un seul événement.
 * Quand un trajet change, seules les paires de l'unité concernée sont recalculées ; les paires
 * candidates viennent de l'index spatial (trajets balayés et zones).
 */

export function unitPairKey(a: UnitId, b: UnitId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function provPairKey(p: ProvinceId, u: UnitId): string {
  return `${p}#${u}`;
}

export function provEntity(p: ProvinceId): string {
  return `p:${p}`;
}

/** Portée d'arme effective de l'unité à la distance d (voir profile.ts). */
export function inWeaponRange(state: EngineState, u: Unit, d: number): boolean {
  return inRange(weaponRange(state, u), d);
}

/** Rayons strictement positifs, triés, sans doublons, convertis en cosinus (seuils de bande). */
function toCos(radii: number[]): number[] {
  const out: number[] = [];
  for (const r of radii) if (r > 0) out.push(r);
  // Tri par insertion (≤ 10 valeurs) : même résultat que sort((a, b) => a - b), sans rappel.
  for (let i = 1; i < out.length; i++) {
    const x = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]! > x) {
      out[j + 1] = out[j]!;
      j--;
    }
    out[j + 1] = x;
  }
  let w = 0;
  for (let i = 0; i < out.length; i++) if (w === 0 || out[i] !== out[w - 1]) out[w++] = out[i]!;
  out.length = w;
  for (let i = 0; i < w; i++) out[i] = Math.cos(out[i]! / EARTH_RADIUS_KM);
  return out;
}

/** Plus grand rayon strictement positif (0 si aucun). */
function maxPositive(radii: number[]): number {
  let m = 0;
  for (const r of radii) if (r > m) m = r;
  return m;
}

/**
 * Calotte (centre, rayon angulaire) qui contient toute la trajectoire à partir de l'instant t.
 * Mise en cache par tableau de morceaux (celui d'une unité ne change pas tant que son trajet ne change
 * pas) et par instant.
 */
interface Cap {
  t: number;
  c: Vec3;
  r: number;
}
const capCache = new WeakMap<Piece[], Cap>();

function trajCap(P: Piece[], t: number): Cap {
  const hit = capCache.get(P);
  if (hit && hit.t === t) return hit;
  let c: Vec3 | null = null;
  let r = 0;
  for (let i = pieceIndexAt(P, t); i < P.length; i++) {
    const p = P[i]!;
    let ci: Vec3;
    let ri: number;
    if (p.s) {
      ci = p.v;
      ri = 0;
    } else {
      let th0 = p.w * (t - p.t0);
      if (th0 < 0) th0 = 0;
      else if (th0 > p.len) th0 = p.len;
      const tm = (th0 + p.len) / 2;
      const co = Math.cos(tm);
      const si = Math.sin(tm);
      ci = [p.p0[0] * co + p.u[0] * si, p.p0[1] * co + p.u[1] * si, p.p0[2] * co + p.u[2] * si];
      ri = (p.len - th0) / 2;
    }
    if (!c) {
      c = ci;
      r = ri;
    } else {
      const d = vecAngle(c, ci) + ri;
      if (d > r) r = d;
    }
  }
  const cap: Cap = { t, c: c ?? [1, 0, 0], r };
  capCache.set(P, cap);
  return cap;
}

/** Marge angulaire (rad, ≈ 6 m) qui absorbe les erreurs d'arrondi du filtre ci-dessous. */
const CAP_MARGIN = 1e-6;

/**
 * Vrai si les deux trajectoires restent, à partir de t, à plus de rKm l'une de l'autre (preuve par
 * calottes englobantes et inégalité triangulaire). Alors aucun seuil ≤ rKm n'est jamais franchi :
 * nextBandChange renverrait null et la paire n'est pas en relation. Filtre exact (conservateur).
 */
function neverWithin(A: Piece[], B: Piece[], t: number, rKm: number): boolean {
  const a = trajCap(A, t);
  const b = trajCap(B, t);
  return vecAngle(a.c, b.c) - a.r - b.r > rKm / EARTH_RADIUS_KM + CAP_MARGIN;
}

function maxRadius(cosThr: number[]): number {
  if (cosThr.length === 0) return -1;
  return Math.acos(Math.max(-1, Math.min(1, cosThr[cosThr.length - 1]!))) * EARTH_RADIUS_KM;
}

function distKm(A: Piece[], B: Piece[], t: number): { d: number; dot: number } {
  const dot = dotAt(A, B, t);
  return { d: Math.acos(Math.max(-1, Math.min(1, dot))) * EARTH_RADIUS_KM, dot };
}

/* ------------------------------------------------------------------------------------------------ */
/* Index spatial                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export function registerProvinceZone(state: EngineState, p: ProvinceId): void {
  const def = wi(state.world).provById.get(p);
  if (!def) return;
  const cells = new Set<number>();
  coverCap(def.cityPoint, wi(state.world).provZoneKm + 0.5, cells);
  state.rt.zones.add(
    provEntity(p),
    [...cells].sort((a, b) => a - b),
  );
}

/** (Ré)enregistre le balayage d'une unité à partir de l'instant courant. */
export function registerUnit(state: EngineState, u: Unit): void {
  unregisterUnit(state, u.id);
  if (u.off) return; // hors carte : ni corps ni zone
  const pieces = unitPieces(state, u);
  const body = sweepCells(pieces, state.time, 0);
  const zr = zoneKm(state, u);
  const zone = zr > 0 ? sweepCells(pieces, state.time, zr) : [];
  state.rt.bodies.add(u.id, body);
  state.rt.zones.add(u.id, zone);
  state.rt.reg.set(u.id, { body, zone });
}

export function unregisterUnit(state: EngineState, uid: UnitId): void {
  const reg = state.rt.reg.get(uid);
  if (!reg) return;
  state.rt.bodies.remove(uid, reg.body);
  state.rt.zones.remove(uid, reg.zone);
  state.rt.reg.delete(uid);
}

/** Clés des paires à (ré)évaluer pour une unité : candidates de l'index ∪ paires existantes. */
function candidateKeys(state: EngineState, u: Unit): string[] {
  const reg = state.rt.reg.get(u.id);
  const keys = new Set<string>(state.rt.pairsOf.get(u.id) ?? []);
  if (reg) {
    const ents = new Set<string>();
    state.rt.zones.collect(reg.body, ents);
    state.rt.bodies.collect(reg.zone, ents);
    for (const e of ents) {
      if (e === u.id) continue;
      if (e.startsWith('p:')) {
        const p = e.slice(2);
        if (state.provinces[p]) keys.add(provPairKey(p, u.id));
        continue;
      }
      const o = state.units[e];
      if (!o || o.owner === u.owner || o.off) continue;
      keys.add(unitPairKey(u.id, e));
    }
  }
  return [...keys].sort();
}

/** Après un changement de trajet (ou une apparition) : réindexe et recalcule toutes les paires de l'unité. */
export function refreshUnitPairs(state: EngineState, u: Unit): void {
  registerUnit(state, u);
  for (const key of candidateKeys(state, u)) evalPair(state, key);
}

/* ------------------------------------------------------------------------------------------------ */
/* Évaluation d'une paire                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export function evalPair(state: EngineState, key: string): void {
  if (key.includes('#')) evalProvPair(state, key);
  else evalUnitPair(state, key);
}

function indexPair(state: EngineState, key: string, a: string, b: string): void {
  addToIndex(state.rt.pairsOf, a, key);
  addToIndex(state.rt.pairsOf, b, key);
}

function evalUnitPair(state: EngineState, key: string): void {
  const existing = state.pairs[key];
  const [ia, ib] = key.split('|') as [UnitId, UnitId];
  const A = state.units[ia];
  const B = state.units[ib];
  if (!A || !B || A.owner === B.owner || A.off || B.off) {
    if (existing) removePair(state, key);
    return;
  }
  const t = state.time;
  const rab = sightRangeKm(state, A, B);
  const rba = sightRangeKm(state, B, A);
  const wa = weaponRange(state, A);
  const wb = weaponRange(state, B);
  const radii = detectionRadii(state, rab);
  for (const r of detectionRadii(state, rba)) radii.push(r);
  radii.push(wa.max, wa.max > 0 ? wa.min : 0, wb.max, wb.max > 0 ? wb.min : 0);
  const pa = unitPieces(state, A);
  const pb = unitPieces(state, B);
  // Paire candidate de l'index spatial mais hors de portée pour toujours : rien à faire (cas le plus
  // fréquent, sans calcul de franchissement).
  const rMax = maxPositive(radii);
  if (rMax <= 0 || neverWithin(pa, pb, t, rMax)) {
    if (existing) removePair(state, key);
    return;
  }
  const cosThr = toCos(radii);
  const { d } = distKm(pa, pb, t);
  const next = nextBandChange(pa, pb, cosThr, t);
  const inRel = d <= maxRadius(cosThr);
  if (!inRel && next === null) {
    if (existing) removePair(state, key);
    return;
  }
  const la = detectionLevel(state, d, rab);
  const lb = detectionLevel(state, d, rba);
  const oldD = existing ? existing.d : Infinity;
  const pair: PairState = existing ?? { d, la: 0, lb: 0, obs: null, ev: 0 };
  const oldLa = pair.la;
  const oldLb = pair.lb;
  pair.d = d;
  pair.la = la;
  pair.lb = lb;
  if (!existing) {
    state.pairs[key] = pair;
    indexPair(state, key, ia, ib);
  }
  pair.ev = next !== null ? schedule(state, { k: 'contact', t: next, key }) : 0;
  changeSight(state, A.owner, B.id, oldLa, la);
  changeSight(state, B.owner, A.id, oldLb, lb);
  if (!existing || inRange(wa, oldD) !== inRange(wa, d) || inRange(wb, oldD) !== inRange(wb, d)) {
    state.rt.dirtyCombat.add(ia);
    state.rt.dirtyCombat.add(ib);
  }
}

/** Trajectoire immobile du point de ville (partagée : le vecteur de la ville est une donnée du monde). */
const cityPieces = new WeakMap<Vec3, Piece[]>();

function provPieces(state: EngineState, p: ProvinceId): Piece[] {
  const v = wi(state.world).cityVec.get(p)!;
  let pieces = cityPieces.get(v);
  if (!pieces) cityPieces.set(v, (pieces = [{ t0: -Infinity, t1: Infinity, s: true, v }]));
  return pieces;
}

function cityFlags(state: EngineState, d: number): number {
  return (
    (d <= CAPTURE_RADIUS_KM ? 1 : 0) | (d <= state.world.balance.combat.groundContactKm ? 2 : 0)
  );
}

function evalProvPair(state: EngineState, key: string): void {
  const existing = state.pairs[key];
  const h = key.indexOf('#');
  const pid = key.slice(0, h);
  const uid = key.slice(h + 1);
  const P = state.provinces[pid];
  const U = state.units[uid];
  if (!P || !U || U.off) {
    if (existing) removePair(state, key);
    return;
  }
  const t = state.time;
  const obs = P.owner;
  const rp = obs !== U.owner ? provSightRangeKm(state, obs, U) : 0;
  const radii = detectionRadii(state, rp);
  radii.push(CAPTURE_RADIUS_KM, state.world.balance.combat.groundContactKm);
  const pp = provPieces(state, pid);
  const pu = unitPieces(state, U);
  const rMax = maxPositive(radii);
  if (rMax <= 0 || neverWithin(pp, pu, t, rMax)) {
    if (existing) removePair(state, key);
    return;
  }
  const cosThr = toCos(radii);
  const { d } = distKm(pp, pu, t);
  const next = nextBandChange(pp, pu, cosThr, t);
  const inRel = d <= maxRadius(cosThr);
  if (!inRel && next === null) {
    if (existing) removePair(state, key);
    return;
  }
  const lp = detectionLevel(state, d, rp);
  const pair: PairState = existing ?? { d, la: 0, lb: 0, obs: null, ev: 0 };
  const oldFlags = existing ? cityFlags(state, existing.d) : -1;
  const oldObs = pair.obs;
  const oldLa = pair.la;
  pair.d = d;
  pair.la = lp;
  pair.obs = obs;
  if (!existing) {
    state.pairs[key] = pair;
    indexPair(state, key, provEntity(pid), uid);
  }
  pair.ev = next !== null ? schedule(state, { k: 'zone', t: next, key }) : 0;
  if (oldObs === obs) changeSight(state, obs, uid, oldLa, lp);
  else {
    if (oldObs) changeSight(state, oldObs, uid, oldLa, 0);
    changeSight(state, obs, uid, 0, lp);
  }
  if (oldFlags !== cityFlags(state, d)) {
    state.rt.dirtyCapture.add(pid);
    state.rt.dirtyCombat.add(uid);
  }
}

export function removePair(state: EngineState, key: string): void {
  const pair = state.pairs[key];
  if (!pair) return;
  delete state.pairs[key];
  if (key.includes('#')) {
    const h = key.indexOf('#');
    const pid = key.slice(0, h);
    const uid = key.slice(h + 1);
    removeFromIndex(state.rt.pairsOf, provEntity(pid), key);
    removeFromIndex(state.rt.pairsOf, uid, key);
    if (pair.obs && pair.la > 0) changeSight(state, pair.obs, uid, pair.la, 0);
    state.rt.dirtyCapture.add(pid);
    if (state.units[uid]) state.rt.dirtyCombat.add(uid);
    return;
  }
  const [ia, ib] = key.split('|') as [UnitId, UnitId];
  removeFromIndex(state.rt.pairsOf, ia, key);
  removeFromIndex(state.rt.pairsOf, ib, key);
  const A = state.units[ia];
  const B = state.units[ib];
  if (A && B) {
    changeSight(state, A.owner, B.id, pair.la, 0);
    changeSight(state, B.owner, A.id, pair.lb, 0);
  }
  if (A) state.rt.dirtyCombat.add(ia);
  if (B) state.rt.dirtyCombat.add(ib);
}

/** Supprime toutes les paires d'une unité (destruction). L'unité doit encore exister dans l'état. */
export function removeUnitPairs(state: EngineState, uid: UnitId): void {
  for (const key of sortedSet(state.rt.pairsOf.get(uid))) removePair(state, key);
  unregisterUnit(state, uid);
}

/** Changement de propriétaire d'une province : la détection de sa ville change de camp. */
export function provinceOwnerChanged(state: EngineState, pid: ProvinceId, to: NationId): void {
  for (const key of sortedSet(state.rt.pairsOf.get(provEntity(pid)))) {
    const pair = state.pairs[key];
    if (!pair) continue;
    const uid = key.slice(key.indexOf('#') + 1);
    const U = state.units[uid];
    if (!U) continue;
    const lp = U.owner !== to ? detectionLevel(state, pair.d, provSightRangeKm(state, to, U)) : 0;
    if (pair.obs) changeSight(state, pair.obs, uid, pair.la, 0);
    pair.obs = to;
    pair.la = lp;
    changeSight(state, to, uid, 0, lp);
  }
}

/** Paires d'une unité, triées : [autre entité, paire]. */
export function pairsOfUnit(state: EngineState, uid: UnitId): { key: string; pair: PairState }[] {
  const out: { key: string; pair: PairState }[] = [];
  for (const key of sortedSet(state.rt.pairsOf.get(uid))) {
    const pair = state.pairs[key];
    if (pair) out.push({ key, pair });
  }
  return out;
}

export function otherOf(key: string, uid: UnitId): string {
  const [a, b] = key.split('|') as [string, string];
  return a === uid ? b : a;
}
