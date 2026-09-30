import { EARTH_RADIUS_KM, type NationId, type ProvinceId, type UnitId } from '@redline/shared';
import { coverCap, sweepCells } from '../geo/grid.js';
import { dotAt, nextBandChange } from '../geo/crossing.js';
import type { Piece } from '../geo/sphere.js';
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

function toCos(radii: number[]): number[] {
  const uniq = [...new Set(radii.filter((r) => r > 0))].sort((a, b) => a - b);
  return uniq.map((r) => Math.cos(r / EARTH_RADIUS_KM));
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
  const cosThr = toCos([
    ...detectionRadii(state, rab),
    ...detectionRadii(state, rba),
    wa.max,
    wa.max > 0 ? wa.min : 0,
    wb.max,
    wb.max > 0 ? wb.min : 0,
  ]);
  const pa = unitPieces(state, A);
  const pb = unitPieces(state, B);
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
  if (
    !existing ||
    inRange(wa, oldD) !== inRange(wa, d) ||
    inRange(wb, oldD) !== inRange(wb, d)
  ) {
    state.rt.dirtyCombat.add(ia);
    state.rt.dirtyCombat.add(ib);
  }
}

function provPieces(state: EngineState, p: ProvinceId): Piece[] {
  const v = wi(state.world).cityVec.get(p)!;
  return [{ t0: -Infinity, t1: Infinity, s: true, v }];
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
  const cosThr = toCos([
    ...detectionRadii(state, rp),
    CAPTURE_RADIUS_KM,
    state.world.balance.combat.groundContactKm,
  ]);
  const pp = provPieces(state, pid);
  const pu = unitPieces(state, U);
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
