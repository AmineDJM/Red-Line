import {
  HOUR,
  MINUTE,
  distanceKm,
  type Leg,
  type LngLat,
  type MissionKind,
  type NationId,
  type Order,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { clearTarget, destroyUnit, requestChase, setTarget } from '../../combat/combat.js';
import { refreshUnitPairs, removeUnitPairs } from '../../encounters/pairs.js';
import {
  airBasePos,
  airRadiusKm,
  hostile,
  isLanded,
  targetClassOf,
} from '../../encounters/profile.js';
import { setMovement } from '../../movement/movement.js';
import { airCanReach, planUnitMove } from '../../movement/plan-unit.js';
import { planAir } from '../../nav/plan.js';
import { sortedKeys, sortedSet, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier, unitModifier } from '../registry.js';
import { emitImagery } from './sensors.js';
import { mil, milBal, type MissionSt } from './state.js';
import { deliverAirStrike } from './strike.js';
import { countLoss } from './stats.js';
import {
  OK,
  airfieldsOf,
  carrierCapacity,
  cityOf,
  fail,
  failR,
  generic,
  hasBuilding,
  isAew,
  isFuelAir,
  isRecon,
  isSatellite,
  isTanker,
  nearestProvince,
  portsOf,
  posOf,
  provinceAt,
  resolveOwn,
  schedule,
  noteLoc,
} from './util.js';

/**
 * Aviation. Chaque aéronef à carburant (fiche `air`) a une base d'attache (province avec base
 * aérienne, ou porte-avions / navire porteur), une autonomie qui baisse en vol et une mission.
 *  - Au sol : plein fait, remise en œuvre (`military.air.turnaroundH`) avant de redécoller ; ni tir
 *    ni détection, vulnérable comme une installation (classe « building »).
 *  - En vol : un seul événement « bingo » est programmé, l'instant exact (à la milliseconde près, par
 *    dichotomie le long du trajet) où l'autonomie restante ne couvre plus le retour + la réserve ;
 *    à cet instant l'aéronef rejoint un ravitailleur en orbite s'il le peut, sinon rentre. Un second
 *    événement détruit l'appareil s'il est encore en vol quand le carburant est épuisé.
 *  - Rayon d'action compté depuis la base (fiche × recherche × général).
 *  - Patrouille (CAP) : l'appareil tient son point ; toutes les `capScanMinutes` il cherche un intrus
 *    hostile visible dans son rayon, l'engage, puis revient au centre (laisse au-delà de 1,25 × rayon).
 *    Ravitailleurs (mission « refuel ») et avions radar (« awacs ») tiennent l'orbite sans combattre.
 * Les aéronefs sans fiche `air` (anciens catalogues, bac à sable) gardent le comportement de phase 1.
 */

export function msOf(state: EngineState, u: Unit): MissionSt | undefined {
  return mil(state).ms[u.id];
}

export function maxFuel(state: EngineState, u: Unit): number {
  const a = sysOf(state, u).air;
  if (!a) return 0;
  return a.fuelH * modifier(state, u.owner, 'air.fuel') * unitModifier(state, u, 'air.fuel');
}

export function fuelAt(m: MissionSt, t: number): number {
  return m.up ? m.fuel - (t - m.ft) / HOUR : m.fuel;
}

function speedOf(state: EngineState, u: Unit): number {
  return Math.max(1, sysOf(state, u).speedKmh);
}

export function newMission(fa: boolean): MissionSt {
  return {
    fa,
    bk: null,
    base: null,
    up: false,
    fuel: 0,
    ft: 0,
    v: 0,
    bingo: null,
    ready: 0,
    mis: 'none',
    ph: null,
    at: null,
    r: 0,
    tg: null,
    retry: 0,
    give: 0,
    emb: null,
    tk: null,
    sv: 0,
  };
}

/** Mission d'une unité (créée au besoin pour les navires et aéronefs sans carburant). */
export function missionOf(state: EngineState, u: Unit): MissionSt {
  const m = mil(state);
  let s = m.ms[u.id];
  if (!s) {
    s = newMission(false);
    m.ms[u.id] = s;
  }
  return s;
}

/** Éléments embarqués sur une unité porteuse. */
export function embarkedCount(state: EngineState, carrierId: string): number {
  const m = mil(state);
  let n = 0;
  for (const id of sortedKeys(m.ms)) {
    if (m.ms[id]!.emb === carrierId) n += state.units[id]?.count ?? 0;
  }
  return n;
}

export function canCarry(state: EngineState, carrier: Unit, u: Unit): boolean {
  const cap = carrierCapacity(sysOf(state, carrier)) * carrier.count;
  if (cap <= 0 || carrier.owner !== u.owner || carrier.off || carrier.role) return false;
  const s = sysOf(state, u);
  if (!(s.air?.carrierCapable || s.category === 'helicopter')) return false;
  return embarkedCount(state, carrier.id) + u.count <= cap;
}

/** Aéronef créé (production, ORBAT, bac à sable) : base d'attache, au sol ou déjà en vol. */
export function initAircraft(state: EngineState, u: Unit): void {
  const sys = sysOf(state, u);
  // Munitions (missiles, munitions rôdeuses) : stock tiré par l'ordre strike, pas d'aviation.
  if (!isFuelAir(sys) || u.role || sys.missile) return;
  const m = newMission(true);
  mil(state).ms[u.id] = m;
  m.fuel = maxFuel(state, u);
  m.ft = state.time;
  m.give = sys.air!.tankerFuelH ?? 0;
  const bal = milBal(state).air;
  const pos = u.pos;
  // Sur un porte-avions ami tout proche : embarqué.
  for (const id of sortedSet(state.rt.byNation.get(u.owner))) {
    const c = state.units[id];
    if (!c || c === u || carrierCapacity(sysOf(state, c)) <= 0) continue;
    if (distanceKm(posOf(state, c), pos) > bal.landingKm) continue;
    if (!canCarry(state, c, u)) continue;
    m.bk = 'c';
    m.base = c.id;
    embark(state, u, m, c);
    return;
  }
  const pid = provinceAt(state, pos);
  const city = pid ? cityOf(state, pid) : null;
  if (
    pid &&
    city &&
    state.provinces[pid]!.owner === u.owner &&
    distanceKm(city, pos) <= bal.landingKm
  ) {
    m.bk = 'p';
    m.base = pid;
  } else {
    ensureBase(state, u, m);
    const b = airBasePos(state, u);
    if (!b || distanceKm(b, pos) > bal.landingKm) {
      // Créé en l'air (bac à sable) : en vol, plein fait.
      m.up = true;
      m.ft = state.time;
    }
  }
  refreshUnitPairs(state, u);
  state.rt.dirtyCombat.add(u.id);
  if (m.up) armFuel(state, u);
}

function embark(state: EngineState, u: Unit, m: MissionSt, c: Unit): void {
  m.emb = c.id;
  m.up = false;
  if (u.target) clearTarget(state, u);
  if (u.move) setMovement(state, u, null);
  u.pos = posOf(state, c);
  u.off = true;
  removeUnitPairs(state, u.id);
  state.rt.geom.delete(u.id);
  state.rt.dirtyCombat.delete(u.id);
}

/** Base d'attache valide, sinon réaffectée au terrain ami le plus proche (ou à une ville amie). */
export function ensureBase(state: EngineState, u: Unit, m: MissionSt): boolean {
  if (m.bk === 'p' && m.base && state.provinces[m.base]?.owner === u.owner) return true;
  if (m.bk === 'c' && m.base) {
    const c = state.units[m.base];
    if (c && c.owner === u.owner) return true;
  }
  const here = posOf(state, u);
  const best =
    nearestProvince(state, airfieldsOf(state, u.owner), here) ??
    nearestProvince(state, sortedSet(state.rt.provsOf.get(u.owner)), here);
  if (!best) {
    m.bk = null;
    m.base = null;
    return false;
  }
  m.bk = 'p';
  m.base = best.pid;
  return true;
}

/** Programme le retour automatique (bingo) et l'épuisement du carburant d'un aéronef en vol. */
export function armFuel(state: EngineState, u: Unit): void {
  const m = msOf(state, u);
  if (!m || !m.fa || !m.up) return;
  const now = state.time;
  m.fuel = fuelAt(m, now);
  m.ft = now;
  m.v++;
  m.bingo = null;
  const tf = now + Math.max(0, m.fuel) * HOUR;
  schedule(state, tf, 'fuelout', { u: u.id, v: m.v });
  if (m.ph === 'back' || m.ph === 'tanker') return;
  const B = airBasePos(state, u);
  if (!B) return;
  const tb = bingoTime(state, u, m, B);
  if (tb < tf) {
    m.bingo = tb;
    schedule(state, tb, 'bingo', { u: u.id, v: m.v });
  }
}

/** Premier instant où l'autonomie ne couvre plus le retour à la base + la réserve. */
function bingoTime(state: EngineState, u: Unit, m: MissionSt, B: LngLat): number {
  const now = state.time;
  const s = speedOf(state, u);
  const R = milBal(state).air.reserveH;
  const g = (t: number): number =>
    m.fuel - (t - now) / HOUR - distanceKm(unitPosAt(state, u, t), B) / s - R;
  const g0 = g(now);
  if (g0 <= 0) return now;
  const legs = u.move?.legs;
  if (!legs || legs.length === 0) return now + g0 * HOUR;
  const tEnd = legs[legs.length - 1]!.t1;
  if (tEnd > now) {
    const N = 24;
    let prev = now;
    for (let i = 1; i <= N; i++) {
      const ti = now + ((tEnd - now) * i) / N;
      if (g(ti) <= 0) {
        let lo = prev;
        let hi = ti;
        while (hi - lo > 1000) {
          const mid = (lo + hi) / 2;
          if (g(mid) > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      prev = ti;
    }
  }
  const gEnd = g(Math.max(now, tEnd));
  return Math.max(now, tEnd) + Math.max(0, gEnd) * HOUR;
}

/** Décollage (y compris catapultage depuis un porte-avions). */
export function takeoff(state: EngineState, u: Unit, m: MissionSt): void {
  if (m.up) return;
  if (m.emb) {
    const c = state.units[m.emb];
    if (c) u.pos = posOf(state, c);
    m.emb = null;
    u.off = false;
    state.rt.geom.delete(u.id);
    m.up = true;
    m.ft = state.time;
    // De retour sur la carte : réinscrit dans l'index spatial même si aucun trajet ne suit.
    refreshUnitPairs(state, u);
    state.rt.dirtyCombat.add(u.id);
    return;
  }
  m.up = true;
  m.ft = state.time;
}

/** Crochet : tout changement de trajet d'un aéronef à carburant (décollage, poursuite, retour…). */
export function onAirMovement(state: EngineState, u: Unit): void {
  const m = msOf(state, u);
  if (!m || !m.fa) return;
  if (u.move && !m.up) {
    takeoff(state, u, m);
    refreshUnitPairs(state, u);
    state.rt.dirtyCombat.add(u.id);
  }
  if (m.up) armFuel(state, u);
}

function moveTo(state: EngineState, u: Unit, to: LngLat): boolean {
  const sys = sysOf(state, u);
  const from = posOf(state, u);
  if (sys.movement === 'air') {
    const p = planAir(sys, from, to, state.time);
    if ('error' in p) return false;
    setMovement(state, u, p.legs.length > 0 ? p.legs : null);
    return true;
  }
  const p = planUnitMove(state, u, to);
  if ('error' in p) return false;
  setMovement(state, u, p.legs.length > 0 ? p.legs : null);
  return true;
}

/** Retour à la base (aéronef) ou au port / à la ville amie la plus proche (autres). */
export function rtb(state: EngineState, u: Unit): void {
  const m = msOf(state, u);
  if (!m) return;
  if (u.target) clearTarget(state, u);
  m.mis = 'rtb';
  m.ph = 'back';
  m.tg = null;
  m.tk = null;
  m.sv++;
  if (!m.fa) {
    const sys = sysOf(state, u);
    const here = posOf(state, u);
    if (sys.movement === 'sea') {
      const port =
        (m.bk === 'p' && m.base && state.provinces[m.base]?.owner === u.owner ? m.base : null) ??
        nearestProvince(state, portsOf(state, u.owner), here)?.pid;
      const spot = port ? wi(state.world).seaSpawn.get(port) : null;
      if (spot && moveTo(state, u, spot)) return;
    } else {
      const best = nearestProvince(state, sortedSet(state.rt.provsOf.get(u.owner)), here);
      if (best && moveTo(state, u, cityOf(state, best.pid)!)) return;
    }
    m.mis = 'none';
    m.ph = null;
    return;
  }
  if (!m.up) {
    m.mis = 'none';
    m.ph = null;
    return;
  }
  ensureBase(state, u, m);
  const B = airBasePos(state, u);
  if (!B) {
    armFuel(state, u);
    return;
  }
  if (distanceKm(posOf(state, u), B) <= milBal(state).air.landingKm) {
    if (u.move) setMovement(state, u, null);
    land(state, u);
    return;
  }
  if (!moveTo(state, u, B)) armFuel(state, u);
}

/** Atterrissage (ou appontage) : plein refait, remise en œuvre, fin de mission. */
export function land(state: EngineState, u: Unit): void {
  const m = msOf(state, u);
  if (!m || !m.fa) return;
  if (u.target) clearTarget(state, u);
  if (u.move) setMovement(state, u, null);
  const sys = sysOf(state, u);
  m.up = false;
  m.fuel = maxFuel(state, u);
  m.ft = state.time;
  m.v++;
  m.bingo = null;
  m.ready = state.time + milBal(state).air.turnaroundH * HOUR;
  m.mis = 'none';
  m.ph = null;
  m.at = null;
  m.r = 0;
  m.tg = null;
  m.retry = 0;
  m.tk = null;
  m.sv++;
  m.give = sys.air?.tankerFuelH ?? 0;
  if (m.bk === 'c' && m.base) {
    const c = state.units[m.base];
    if (c && canCarry(state, c, u)) {
      embark(state, u, m, c);
      return;
    }
    // Porteur plein ou perdu : on se pose sur le terrain le plus proche au prochain retour.
    m.bk = null;
    m.base = null;
    ensureBase(state, u, m);
  }
  refreshUnitPairs(state, u);
  state.rt.dirtyCombat.add(u.id);
}

/** Événement bingo : jonction avec un ravitailleur si possible, sinon retour à la base. */
export function handleBingo(state: EngineState, d: { u: string; v: number }): void {
  const u = state.units[d.u];
  const m = u ? msOf(state, u) : undefined;
  if (!u || !m || m.v !== d.v || !m.up || m.ph === 'back' || m.ph === 'tanker') return;
  const tanker = findTanker(state, u, m);
  if (tanker) {
    m.ph = 'tanker';
    m.tk = tanker.id;
    if (u.target) clearTarget(state, u);
    if (!moveTo(state, u, posOf(state, tanker))) rtb(state, u);
    return;
  }
  rtb(state, u);
}

function findTanker(state: EngineState, u: Unit, m: MissionSt): Unit | null {
  const sys = sysOf(state, u);
  if (!sys.air?.refuelable) return null;
  const here = posOf(state, u);
  const fuel = fuelAt(m, state.time);
  const R = milBal(state).air.reserveH;
  const s = speedOf(state, u);
  const ms = mil(state).ms;
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const id of sortedSet(state.rt.byNation.get(u.owner))) {
    if (id === u.id) continue;
    const t = state.units[id];
    const tm = ms[id];
    if (!t || !tm || tm.mis !== 'refuel' || !tm.up || tm.ph !== 'station' || tm.give <= 0) continue;
    const dist = distanceKm(here, posOf(state, t));
    if (dist / s + R > fuel || dist >= bestD) continue;
    best = t;
    bestD = dist;
  }
  return best;
}

export function handleFuelout(state: EngineState, d: { u: string; v: number }): void {
  const u = state.units[d.u];
  const m = u ? msOf(state, u) : undefined;
  if (!u || !m || m.v !== d.v || !m.up) return;
  const at = posOf(state, u);
  generic(
    state,
    [u.owner],
    'air',
    'Appareil perdu',
    `${sysOf(state, u).name} : carburant épuisé avant le retour à la base.`,
    'warn',
    at,
    noteLoc('fuelLost', { system: { system: u.sys } }),
  );
  countLoss(state, u, u.count, null);
  destroyUnit(state, u, null);
}

/** Reprend la mission après une jonction avec un ravitailleur. */
function resume(state: EngineState, u: Unit, m: MissionSt): void {
  m.tk = null;
  if (m.mis === 'strike' && m.tg) {
    m.ph = 'out';
    const aim = strikeAim(state, m);
    if (aim && moveTo(state, u, aim)) return;
    rtb(state, u);
    return;
  }
  if (m.at) {
    m.ph = 'out';
    if (distanceKm(posOf(state, u), m.at) < 1) {
      m.ph = 'station';
      armFuel(state, u);
      return;
    }
    if (moveTo(state, u, m.at)) return;
  }
  m.ph = 'station';
  armFuel(state, u);
}

export function strikeAim(state: EngineState, m: MissionSt): LngLat | null {
  const tg = m.tg;
  if (!tg) return null;
  if (tg.type === 'point') return tg.at;
  if (tg.type === 'building') return cityOf(state, tg.provinceId);
  const t = state.units[tg.unitId];
  return t && !t.off ? posOf(state, t) : null;
}

/** Crochet : arrivée d'une unité ayant une mission. */
export function onMissionArrived(state: EngineState, u: Unit): void {
  const m = msOf(state, u);
  if (!m) return;
  const bal = milBal(state).air;
  const here = posOf(state, u);
  if (!m.fa) {
    if (m.mis === 'strike' && m.ph === 'out') {
      deliverAirStrike(state, u, m);
      return;
    }
    if (m.ph === 'out' && m.at) m.ph = 'station';
    else if (m.ph === 'back') {
      m.mis = 'none';
      m.ph = null;
    }
    return;
  }
  if (!m.up) return;
  if (m.ph === 'back') {
    const B = airBasePos(state, u);
    if (B && distanceKm(here, B) <= bal.landingKm) {
      land(state, u);
      return;
    }
    if (m.bk === 'c' && B && m.retry < 6) {
      m.retry++;
      if (moveTo(state, u, B)) return;
    }
    m.bk = null;
    m.base = null;
    ensureBase(state, u, m);
    m.retry = 0;
    const B2 = airBasePos(state, u);
    if (B2 && distanceKm(here, B2) <= bal.landingKm) land(state, u);
    else if (!B2 || !moveTo(state, u, B2)) armFuel(state, u);
    return;
  }
  if (m.ph === 'tanker') {
    const t = m.tk ? state.units[m.tk] : undefined;
    const tm = t ? msOf(state, t) : undefined;
    if (t && tm && tm.give > 0 && distanceKm(here, posOf(state, t)) <= bal.tankerMeetKm) {
      const now = state.time;
      const cur = fuelAt(m, now);
      const give = Math.min(Math.max(0, maxFuel(state, u) - cur), tm.give);
      tm.give -= give;
      m.fuel = cur + give;
      m.ft = now;
      resume(state, u, m);
      return;
    }
    m.ph = null;
    rtb(state, u);
    return;
  }
  if (m.mis === 'strike' && m.ph === 'out') {
    deliverAirStrike(state, u, m);
    return;
  }
  if (m.ph === 'out' && m.mis !== 'none') {
    m.ph = 'station';
    if (m.mis === 'recon' || isRecon(sysOf(state, u))) emitImagery(state, u, 'arrival');
    return;
  }
  if (m.mis === 'none') {
    // Simple déplacement : arrivée sur un terrain ami ⇒ changement de base et atterrissage.
    const pid = provinceAt(state, here);
    const city = pid ? cityOf(state, pid) : null;
    if (
      pid &&
      city &&
      state.provinces[pid]!.owner === u.owner &&
      distanceKm(city, here) <= bal.landingKm &&
      (hasBuilding(state, pid, 'air_base') || (m.bk === 'p' && m.base === pid))
    ) {
      m.bk = 'p';
      m.base = pid;
      land(state, u);
      return;
    }
    m.ph = 'station';
    if (isRecon(sysOf(state, u))) emitImagery(state, u, 'arrival');
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Veille des patrouilles                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const PATROL_LIKE: MissionKind[] = ['patrol', 'awacs', 'refuel', 'recon', 'blockade'];

export function startScan(state: EngineState, u: Unit, m: MissionSt): void {
  m.sv++;
  schedule(state, state.time + MINUTE, 'scan', { u: u.id, sv: m.sv });
}

export function handleScan(state: EngineState, d: { u: string; sv: number }): void {
  const u = state.units[d.u];
  const m = u ? msOf(state, u) : undefined;
  if (!u || !m || m.sv !== d.sv || !PATROL_LIKE.includes(m.mis) || !m.at) return;
  const every = milBal(state).air.capScanMinutes * MINUTE;
  schedule(state, state.time + every, 'scan', { u: u.id, sv: m.sv });
  if (m.fa && (!m.up || m.ph === 'back' || m.ph === 'tanker')) return;
  if (u.off) return;
  const sys = sysOf(state, u);
  if (m.mis === 'recon' || (isRecon(sys) && m.ph === 'station')) emitImagery(state, u, 'patrol');
  if (m.mis !== 'patrol' && m.mis !== 'blockade') {
    if (!u.move && m.ph === 'station' && distanceKm(posOf(state, u), m.at) > 5)
      moveTo(state, u, m.at);
    return;
  }
  const center = m.at;
  const leash = Math.max(m.r, 5) * 1.25;
  if (u.target) {
    const t = state.units[u.target];
    if (!t || distanceKm(posOf(state, t), center) > leash) {
      clearTarget(state, u);
      moveTo(state, u, center);
    }
    return;
  }
  const pick = intruder(state, u, center, Math.max(m.r, 5));
  if (pick) {
    setTarget(state, u, pick.id, 'auto');
    requestChase(state, u.id, 0);
    state.rt.dirtyCombat.add(u.id);
    return;
  }
  if (!u.move && distanceKm(posOf(state, u), center) > 5) moveTo(state, u, center);
}

/** Intrus hostile visible le plus proche du centre de patrouille, que l'unité peut toucher. */
function intruder(state: EngineState, u: Unit, center: LngLat, r: number): Unit | null {
  const known = state.know[u.owner];
  if (!known) return null;
  const sys = sysOf(state, u);
  let best: Unit | null = null;
  let bestD = Infinity;
  // Le plus proche, à égalité le premier identifiant dans l'ordre trié : parcours non trié avec
  // départage explicite (même résultat), et la distance (le filtre le plus sélectif) d'abord.
  for (const id in known) {
    const c = known[id]!;
    if (!c.seen) continue;
    const o = state.units[id];
    if (!o || o.off || o.role === 'missile') continue;
    const dist = distanceKm(posOf(state, o), center);
    if (dist > r || dist > bestD || (dist === bestD && best !== null && id > best.id)) continue;
    if (sys.damage[targetClassOf(state, o)] <= 0) continue;
    if (!hostile(state, u, o)) continue;
    best = o;
    bestD = dist;
  }
  return best;
}

/* ------------------------------------------------------------------------------------------------ */
/* Ordres                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

function kindFor(state: EngineState, u: Unit): MissionKind {
  const s = sysOf(state, u);
  if (isTanker(s)) return 'refuel';
  if (isAew(s)) return 'awacs';
  if (isRecon(s)) return 'recon';
  return 'patrol';
}

/** Zone d'exclusion aérienne étrangère au point visé (ordre refusé). */
export function noFlyAt(state: EngineState, n: NationId, p: LngLat): boolean {
  const pid = provinceAt(state, p);
  return !!pid && !!board(state).noFly[pid] && state.provinces[pid]!.owner !== n;
}

/** Contrôle d'un vol aller vers `to` puis retour à la base (ou vers `back`). */
export function airFeasible(
  state: EngineState,
  u: Unit,
  to: LngLat,
  back?: LngLat | null,
): OrderResult | null {
  const m = msOf(state, u);
  if (!m || !m.fa)
    return airCanReach(state, u, to) ? null : fail('out_of_range', "Hors du rayon d'action.");
  if (!m.up && m.ready > state.time) {
    const min = Math.ceil((m.ready - state.time) / MINUTE);
    return failR(
      'cooldown',
      'aircraft_cooldown',
      `Appareil en remise en œuvre au sol (prêt dans ${min} min).`,
      { min },
    );
  }
  ensureBase(state, u, m);
  const B = back ?? airBasePos(state, u);
  if (!B) return fail('not_allowed', 'Aucune base d’attache.');
  const home = airBasePos(state, u) ?? B;
  const dist = distanceKm(home, to);
  const radius = airRadiusKm(state, u);
  if (dist > radius) {
    return failR(
      'out_of_range',
      'aircraft_out_of_radius',
      `Hors du rayon d'action : ${Math.round(dist)} km depuis la base pour ${Math.round(radius)} km.`,
      { dist: Math.round(dist), range: Math.round(radius) },
    );
  }
  const s = speedOf(state, u);
  const here = m.emb ? posOf(state, state.units[m.emb] ?? u) : posOf(state, u);
  const need = distanceKm(here, to) / s + distanceKm(to, B) / s + milBal(state).air.reserveH;
  const fuel = m.up ? fuelAt(m, state.time) : maxFuel(state, u);
  if (need > fuel) return fail('out_of_range', 'Autonomie insuffisante pour l’aller et le retour.');
  return null;
}

/** Démarre un vol vers `to` (décollage ou catapultage compris). */
export function flyTo(state: EngineState, u: Unit, to: LngLat): void {
  const m = msOf(state, u);
  if (u.target) clearTarget(state, u);
  if (m && m.fa && !m.up) takeoff(state, u, m);
  const sys = sysOf(state, u);
  const p = planAir(sys, posOf(state, u), to, state.time);
  const legs: Leg[] = 'error' in p ? [] : p.legs;
  if (legs.length > 0) setMovement(state, u, legs);
  else {
    if (u.move) setMovement(state, u, null);
    refreshUnitPairs(state, u);
    state.rt.dirtyCombat.add(u.id);
    armFuel(state, u);
    onMissionArrived(state, u);
  }
}

/** Ordre `patrol` : aéronefs (CAP, ravitailleur, avion radar, reconnaissance), navires, satellites. */
export function orderPatrol(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'patrol' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  for (const u of units) {
    const sys = sysOf(state, u);
    if (isSatellite(sys)) continue;
    if (mil(state).fixedOf[u.id]) return fail('not_allowed', 'Unité fixe.');
    if (sys.movement === 'air') {
      if (noFlyAt(state, n, o.at)) return fail('locked', 'Zone d’exclusion aérienne.');
      const err = airFeasible(state, u, o.at);
      if (err) return err;
    } else if (sys.movement === 'sea') {
      const p = planUnitMove(state, u, o.at);
      if ('error' in p) return fail(p.error, 'Destination inaccessible.');
    } else {
      return fail('not_allowed', 'Seuls les aéronefs, navires et satellites patrouillent.');
    }
  }
  for (const u of units) {
    const sys = sysOf(state, u);
    if (isSatellite(sys)) {
      const s = mil(state).sats[u.id];
      if (s) s.aim = [o.at[0], o.at[1]];
      continue;
    }
    const m = missionOf(state, u);
    m.mis = sys.movement === 'air' ? kindFor(state, u) : 'patrol';
    m.at = [o.at[0], o.at[1]];
    m.r = o.radiusKm;
    m.tg = null;
    m.ph = 'out';
    m.retry = 0;
    m.tk = null;
    startScan(state, u, m);
    if (sys.movement === 'air') flyTo(state, u, o.at);
    else {
      if (u.target) clearTarget(state, u);
      if (!moveTo(state, u, o.at)) m.ph = 'station';
    }
  }
  return OK;
}

/** Ordre `move` d'aéronefs à carburant, de satellites (zone visée) ou d'unités embarquées. */
export function interceptMove(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'move' }>,
): OrderResult | null {
  const m = mil(state);
  const special = o.unitIds.some((id) => {
    const u = state.units[id];
    if (!u || u.owner !== n) return false;
    const s = sysOf(state, u);
    return !!m.ms[id]?.fa || isSatellite(s) || !!m.fixedOf[id] || !!s.missile;
  });
  if (!special) return null;
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  const plans = new Map<string, Leg[]>();
  for (const u of units) {
    const sys = sysOf(state, u);
    if (m.fixedOf[u.id]) return fail('not_allowed', 'Unité fixe (bâtiment de défense).');
    if (sys.missile) return fail('not_allowed', 'Munitions : utilisez l’ordre de frappe.');
    if (isSatellite(sys)) continue;
    if (m.ms[u.id]?.fa) {
      if (noFlyAt(state, n, o.to)) return fail('locked', 'Zone d’exclusion aérienne.');
      // Arrivée sur un terrain ami : pas de retour à prévoir.
      const pid = provinceAt(state, o.to);
      const field =
        pid && state.provinces[pid]!.owner === n && hasBuilding(state, pid, 'air_base')
          ? cityOf(state, pid)
          : null;
      const err = airFeasible(state, u, o.to, field ?? undefined);
      if (err && !(field && err.error === 'out_of_range' && rebaseReach(state, u, o.to)))
        return err;
      continue;
    }
    if (u.off) return fail('not_allowed', 'Unité indisponible pour cet ordre.');
    const p = planUnitMove(state, u, o.to);
    if ('error' in p) return fail(p.error, 'Destination inaccessible.');
    plans.set(u.id, p.legs);
  }
  for (const u of units) {
    const sys = sysOf(state, u);
    if (isSatellite(sys)) {
      const s = m.sats[u.id];
      if (s) s.aim = [o.to[0], o.to[1]];
      continue;
    }
    const ms = m.ms[u.id];
    if (ms?.fa) {
      ms.mis = 'none';
      ms.ph = 'out';
      ms.at = [o.to[0], o.to[1]];
      ms.r = 0;
      ms.tg = null;
      ms.tk = null;
      ms.retry = 0;
      ms.sv++;
      flyTo(state, u, o.to);
      continue;
    }
    if (u.target) clearTarget(state, u);
    if (ms) {
      ms.mis = 'none';
      ms.ph = null;
      ms.sv++;
    }
    setMovement(state, u, plans.get(u.id)!);
  }
  return OK;
}

/** Transfert vers un terrain ami éloigné : seule compte l'autonomie pour l'aller. */
function rebaseReach(state: EngineState, u: Unit, to: LngLat): boolean {
  const m = msOf(state, u);
  if (!m) return false;
  if (!m.up && m.ready > state.time) return false;
  const fuel = m.up ? fuelAt(m, state.time) : maxFuel(state, u);
  const here = m.emb ? posOf(state, state.units[m.emb] ?? u) : posOf(state, u);
  return distanceKm(here, to) / speedOf(state, u) + milBal(state).air.reserveH <= fuel;
}

/**
 * Après un ordre `move` ou `stop` traité par le cœur : la mission en cours (patrouille d'un navire,
 * frappe ou veille d'un aéronef) prend fin, sinon la veille ramènerait l'unité à son point de
 * patrouille. Un aéronef en vol arrêté tient sa position (orbite) jusqu'au retour automatique.
 */
export function endMissions(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'move' | 'stop' }>,
): void {
  const all = mil(state).ms;
  for (const id of [...new Set(o.unitIds)].sort()) {
    const u = state.units[id];
    const m = all[id];
    if (!u || u.owner !== n || !m) continue;
    if (!m.fa) {
      if (m.mis !== 'none') {
        m.mis = 'none';
        m.ph = null;
        m.at = null;
        m.tg = null;
        m.sv++;
      }
      continue;
    }
    if (o.kind !== 'stop' || !m.up) continue;
    m.mis = 'none';
    m.ph = 'station';
    m.at = posOf(state, u);
    m.r = 0;
    m.tg = null;
    m.tk = null;
    m.sv++;
    armFuel(state, u);
  }
}

/** Ordre `rtb` : aéronefs (base), navires (port), troupes au sol (ville amie la plus proche). */
export function orderRtb(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'rtb' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  for (const u of units) {
    const s = sysOf(state, u);
    if (s.movement === 'static' || s.speedKmh <= 0 || mil(state).fixedOf[u.id])
      return fail('not_allowed', 'Unité fixe : pas de retour possible.');
    if (isSatellite(s)) return fail('not_allowed', 'Un satellite ne rentre pas à la base.');
    if (s.missile) return fail('not_allowed', 'Munitions : utilisez l’ordre de frappe.');
  }
  for (const u of units) {
    if (u.off) continue;
    missionOf(state, u);
    rtb(state, u);
  }
  return OK;
}

/** Ordre `rebase` : nouvelle base (province avec base aérienne / port, ou unité porteuse). */
export function orderRebase(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'rebase' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  const carrier = state.units[o.provinceId];
  const P = state.provinces[o.provinceId];
  if (!carrier && !P) return fail('invalid_target', 'Base inconnue.');
  if (carrier && (carrier.owner !== n || carrierCapacity(sysOf(state, carrier)) <= 0)) {
    return fail('invalid_target', 'Cette unité ne peut pas accueillir d’aéronefs.');
  }
  if (P && P.owner !== n) return fail('not_owner', 'Cette province ne vous appartient pas.');
  let needed = 0;
  for (const u of units) {
    const s = sysOf(state, u);
    if (s.movement === 'air') {
      if (!isFuelAir(s)) return fail('not_allowed', 'Cet aéronef n’a pas de base d’attache.');
      if (carrier) {
        if (!(s.air?.carrierCapable || s.category === 'helicopter')) {
          return fail('not_allowed', 'Appareil non embarquable.');
        }
        needed += u.count;
        const target = posOf(state, carrier);
        if (!rebaseReach(state, u, target)) return fail('out_of_range', 'Autonomie insuffisante.');
      } else {
        const heli = s.category === 'helicopter';
        if (
          !hasBuilding(state, o.provinceId, 'air_base') &&
          !(heli && hasBuilding(state, o.provinceId, 'military_base'))
        ) {
          return fail('invalid_target', 'Pas de base aérienne dans cette province.');
        }
        if (!rebaseReach(state, u, cityOf(state, o.provinceId)!))
          return fail('out_of_range', 'Autonomie insuffisante.');
      }
    } else if (s.movement === 'sea') {
      if (carrier || !P) return fail('invalid_target', 'Un navire change de port d’attache.');
      if (!(
        hasBuilding(state, o.provinceId, 'port') || hasBuilding(state, o.provinceId, 'naval_base')
      )) {
        return fail('invalid_target', 'Pas de port dans cette province.');
      }
      const spot = wi(state.world).seaSpawn.get(o.provinceId);
      if (!spot) return fail('invalid_target', 'Province sans accès à la mer.');
      const p = planUnitMove(state, u, spot);
      if ('error' in p) return fail(p.error, 'Destination inaccessible.');
    } else {
      return fail('not_allowed', 'Aéronefs et navires seulement.');
    }
  }
  if (carrier) {
    const cap = carrierCapacity(sysOf(state, carrier)) * carrier.count;
    const already = units
      .filter((u) => msOf(state, u)?.emb === carrier.id)
      .reduce((a, u) => a + u.count, 0);
    if (embarkedCount(state, carrier.id) - already + needed > cap) {
      return fail('capacity', 'Capacité du porte-avions dépassée.');
    }
  }
  for (const u of units) {
    const m = missionOf(state, u);
    const s = sysOf(state, u);
    m.bk = carrier ? 'c' : 'p';
    m.base = carrier ? carrier.id : o.provinceId;
    m.retry = 0;
    if (s.movement === 'sea') {
      m.mis = 'rtb';
      m.ph = 'back';
      if (u.target) clearTarget(state, u);
      moveTo(state, u, wi(state.world).seaSpawn.get(o.provinceId)!);
      continue;
    }
    if (m.emb && carrier && m.emb === carrier.id) continue;
    if (!m.up) takeoff(state, u, m);
    m.mis = 'rtb';
    m.ph = 'back';
    m.sv++;
    rtb(state, u);
  }
  return OK;
}

/** L'aéronef est-il au sol (vue) ? */
export function grounded(state: EngineState, u: Unit): boolean {
  return isLanded(state, u);
}
