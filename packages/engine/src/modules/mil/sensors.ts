import {
  HOUR,
  MINUTE,
  destination,
  type LngLat,
  type NationId,
  type Order,
  type SatellitePassView,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { retireUnit } from '../../combat/combat.js';
import { evalPair, refreshUnitPairs, removeUnitPairs } from '../../encounters/pairs.js';
import { detectKm, isHiddenSub, isOthRadar, isRadarSensor } from '../../encounters/profile.js';
import { atWar, sightLevel, sortedSet, sysOf, warsOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { modifier, signal } from '../registry.js';
import { mil, milBal } from './state.js';
import {
  OK,
  fail,
  generic,
  posOf,
  provincesNear,
  resolveOwn,
  roll,
  satKind,
  schedule,
  unitsNear,
  noteLoc,
} from './util.js';

/**
 * Capteurs : brouilleurs (émettent par défaut ; ordre `jam` pour couper ou rétablir l'émission ; un
 * brouilleur qui émet est repéré par quiconque est dans sa zone d'effet), radars aveuglés par le
 * signal `cyber` (kind 'radar'), satellites (passages périodiques sur une zone visée : instantané de
 * ce qui se trouve sous la fauchée), radars transhorizon (balayage périodique, niveau « détecté »),
 * leurres (signal `decoys`), imagerie (signal `imagery` à chaque passage de satellite et survol de
 * reconnaissance, pour le module intel).
 */

/* ——— Brouillage ——— */

export function orderJam(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'jam' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds);
  if (!Array.isArray(units)) return units;
  for (const u of units) {
    if (sysOf(state, u).ew.jamming <= 0)
      return fail('not_allowed', 'Cette unité n’a pas de brouilleur.');
  }
  const m = mil(state);
  for (const u of units) {
    const was = !m.jamOff[u.id];
    if (o.on) delete m.jamOff[u.id];
    else m.jamOff[u.id] = true;
    if (was !== o.on) refreshUnitPairs(state, u);
  }
  return OK;
}

/* ——— Cyberattaque contre les radars ——— */

export function blindRadars(state: EngineState, victim: NationId, hours: number): void {
  if (!state.nations[victim] || !(hours > 0)) return;
  const m = mil(state);
  const until = state.time + hours * HOUR;
  const was = m.blind[victim];
  m.blind[victim] = Math.max(was ?? 0, until);
  if (was === undefined || was <= state.time) refreshSensors(state, victim);
  schedule(state, until, 'unblind', { n: victim });
  generic(
    state,
    [victim],
    'cyber',
    'Radars aveuglés',
    'Une cyberattaque perturbe nos radars.',
    'warn',
    null,
    noteLoc('radarsBlinded'),
  );
}

export function handleUnblind(state: EngineState, d: { n: string }): void {
  const m = mil(state);
  const until = m.blind[d.n];
  if (until === undefined || until > state.time) return;
  delete m.blind[d.n];
  refreshSensors(state, d.n);
}

/** Recalcule les paires des radars d'une nation et de ses provinces. */
function refreshSensors(state: EngineState, n: NationId): void {
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[id];
    if (u && !u.off && isRadarSensor(sysOf(state, u))) refreshUnitPairs(state, u);
  }
  for (const pid of sortedSet(state.rt.provsOf.get(n))) {
    for (const key of sortedSet(state.rt.pairsOf.get(`p:${pid}`))) evalPair(state, key);
  }
}

/* ——— Zones de brouillage (signal jam du renseignement) ——— */

/**
 * Signal `jam` { by, at, radiusKm, hours } : pendant `hours`, les radars des autres nations situés dans
 * la zone perdent military.sensors.zoneJamFactor de leur portée.
 */
export function jamZone(state: EngineState, data: Record<string, unknown>): void {
  const by = data.by as NationId;
  const at = data.at as LngLat | undefined;
  const r = Number(data.radiusKm);
  const hours = Number(data.hours);
  if (!state.nations[by] || !at || !(r > 0) || !(hours > 0)) return;
  const m = mil(state);
  const id = `jz${++m.seq}`;
  const until = state.time + hours * HOUR;
  m.jz[id] = { by, at: [at[0], at[1]], r, until };
  refreshRadarsNear(state, at, r, by);
  schedule(state, until, 'jamEnd', { id });
}

export function handleJamEnd(state: EngineState, d: { id: string }): void {
  const m = mil(state);
  const z = m.jz[d.id];
  if (!z) return;
  delete m.jz[d.id];
  refreshRadarsNear(state, z.at, z.r, z.by);
}

function refreshRadarsNear(state: EngineState, at: LngLat, r: number, by: NationId): void {
  for (const u of unitsNear(state, at, r)) {
    if (u.owner !== by && isRadarSensor(sysOf(state, u))) refreshUnitPairs(state, u);
  }
}

/* ——— Contacts instantanés (satellites, transhorizon) ——— */

/** Contact figé (position et niveau à l'instant), sans observation continue. */
export function snapshot(state: EngineState, n: NationId, u: Unit, lvl: number): boolean {
  if (u.owner === n || u.off) return false;
  if (sightLevel(state, n, u.id) > 0) return false;
  const known = (state.know[n] ??= {});
  const c = known[u.id];
  const t = state.time;
  if (c && c.lastSeen === t && c.lvl >= lvl) return false;
  known[u.id] = {
    owner: u.owner,
    lvl,
    seen: false,
    since: t,
    lastSeen: t,
    pos: posOf(state, u),
    sys: lvl >= 2 ? u.sys : (c?.sys ?? null),
    count: lvl >= 3 ? u.count : null,
    hpr: lvl >= 3 ? u.hp / u.maxHp : null,
    status: lvl >= 3 ? (u.move ? 'moving' : 'idle') : null,
  };
  return true;
}

/* ——— Imagerie ——— */

export function emitImagery(state: EngineState, u: Unit, _why: string): void {
  const s = sysOf(state, u);
  const r = Math.max(detectKm(state, u), s.detectionRangeKm * 0.5, 10);
  const at = posOf(state, u);
  imagery(
    state,
    u.owner,
    at,
    r,
    s.movement === 'air' && s.category === 'drone' ? 'drone' : 'aircraft',
  );
}

export function imagery(
  state: EngineState,
  nation: NationId,
  at: LngLat,
  radiusKm: number,
  kind: 'satellite' | 'drone' | 'aircraft' | 'radar',
): void {
  const pids = provincesNear(state, at, radiusKm).filter(
    (p) => state.provinces[p]!.owner !== nation,
  );
  signal(state, 'imagery', { nation, at: [at[0], at[1]], radiusKm, kind, pids });
}

/* ——— Satellites ——— */

function revisitMs(state: EngineState, u: Unit): number {
  const s = sysOf(state, u);
  const h = s.space?.revisitH ?? milBal(state).sensors.defaultRevisitH;
  return (h * HOUR) / Math.max(0.1, modifier(state, u.owner, 'sensors.satellitePasses'));
}

function swathKm(state: EngineState, u: Unit): number {
  return sysOf(state, u).space?.swathKm ?? milBal(state).sensors.defaultSwathKm;
}

/** Satellite créé : mis en orbite (hors carte), premier passage programmé. */
export function initSatellite(state: EngineState, u: Unit): void {
  if (u.role) return;
  u.off = true;
  removeUnitPairs(state, u.id);
  state.rt.geom.delete(u.id);
  state.rt.dirtyCombat.delete(u.id);
  if (!satKind(sysOf(state, u)) || satKind(sysOf(state, u)) === 'early_warning') return;
  const first = state.time + Math.floor(roll(state) * revisitMs(state, u));
  mil(state).sats[u.id] = { aim: null, next: first, v: 0 };
  schedule(state, first, 'sat', { u: u.id, v: 0 });
}

/** Zone visée par défaut : capitale ennemie (guerre en cours), sinon la sienne. */
export function autoAim(state: EngineState, n: NationId): LngLat | null {
  const w = wi(state.world);
  for (const e of warsOf(state, n)) {
    const cap = w.nationById.get(e)?.capitalProvinceId;
    if (cap && state.provinces[cap]) return w.provById.get(cap)!.cityPoint;
    const any = sortedSet(state.rt.provsOf.get(e))[0];
    if (any) return w.provById.get(any)!.cityPoint;
  }
  const own = w.nationById.get(n)?.capitalProvinceId;
  if (own && w.provById.get(own)) return w.provById.get(own)!.cityPoint;
  return null;
}

export function handleSatPass(state: EngineState, d: { u: string; v: number }): void {
  const u = state.units[d.u];
  const st = mil(state).sats[d.u];
  if (!u || !st || st.v !== d.v) return;
  const kind = satKind(sysOf(state, u));
  st.next = state.time + revisitMs(state, u);
  schedule(state, st.next, 'sat', { u: u.id, v: st.v });
  // Sans zone désignée et en paix : pas de prise de vue (évite un coût inutile).
  if (!st.aim && warsOf(state, u.owner).length === 0) return;
  const aim = st.aim ?? autoAim(state, u.owner);
  if (!aim || !kind) return;
  const r = swathKm(state, u) / 2;
  const bal = milBal(state).sensors;
  const lvl =
    kind === 'optical'
      ? bal.satelliteOptical
      : kind === 'radar'
        ? bal.satelliteRadar
        : bal.satelliteSigint;
  let found = 0;
  for (const o of unitsNear(state, aim, r)) {
    if (o.owner === u.owner || o.role === 'missile') continue;
    const os = sysOf(state, o);
    if (isHiddenSub(state, o)) continue;
    if (kind === 'sigint' && !(isRadarSensor(os) || os.ew.jamming > 0 || os.movement === 'sea'))
      continue;
    if (snapshot(state, u.owner, o, Math.round(lvl))) found++;
  }
  imagery(state, u.owner, aim, r, kind === 'radar' ? 'radar' : 'satellite');
  if (found > 0) {
    generic(
      state,
      [u.owner],
      'satellite',
      'Passage satellite',
      `${sysOf(state, u).name} : ${found} contact(s) sous la fauchée.`,
      'info',
      aim,
      noteLoc('satPass', { system: { system: u.sys }, count: found }),
    );
  }
}

export function satellitesFor(state: EngineState, n: NationId): SatellitePassView[] {
  const m = mil(state);
  const out: SatellitePassView[] = [];
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const st = m.sats[id];
    const u = state.units[id];
    if (!st || !u) continue;
    const aim = st.aim ?? autoAim(state, n);
    const footprint: LngLat[] = [];
    if (aim) {
      const r = swathKm(state, u) / 2;
      for (let i = 0; i <= 16; i++) footprint.push(destination(aim, (360 * i) / 16, r));
    }
    out.push({ unitId: id, nextPassAt: st.next, footprint });
  }
  return out;
}

/* ——— Radars transhorizon ——— */

export function initOth(state: EngineState, u: Unit): void {
  if (u.role || !isOthRadar(state, sysOf(state, u))) return;
  schedule(state, state.time + milBal(state).sensors.othScanMinutes * MINUTE, 'oth', { u: u.id });
}

export function handleOth(state: EngineState, d: { u: string }): void {
  const u = state.units[d.u];
  if (!u) return;
  schedule(state, state.time + milBal(state).sensors.othScanMinutes * MINUTE, 'oth', { u: u.id });
  // Balayage seulement en temps de guerre (coût nul en paix).
  if (warsOf(state, u.owner).length === 0) return;
  const s = sysOf(state, u);
  const r =
    (s.sensor?.rangeKm ?? s.detectionRangeKm) * modifier(state, u.owner, 'sensors.radarRange');
  const here = posOf(state, u);
  // Filtre pur (camp, milieu) avant le calcul de distance : même liste, bien moins de calculs.
  const pre = (o: Unit): boolean => {
    if (o.owner === u.owner || !atWar(state, u.owner, o.owner)) return false;
    const m = sysOf(state, o).movement;
    return m === 'air' || m === 'sea';
  };
  for (const o of unitsNear(state, here, r, pre)) {
    const os = sysOf(state, o);
    if (isHiddenSub(state, o)) continue;
    if (os.stealth > 0 && roll(state) < os.stealth * (1 - (s.sensor?.stealthDetect ?? 0))) continue;
    snapshot(state, u.owner, o, 1);
  }
}

/* ——— Leurres ——— */

/**
 * Signal `decoys` { by, at, count, systemId?, hours? } (module intel) : crée `count` leurres de
 * `systemId` (par défaut le système terrestre le plus répandu de la nation) autour de `at`. Un leurre
 * ressemble en tout point à l'unité imitée pour l'ennemi, ne tire pas, ne capture pas, disparaît au
 * premier coup reçu ou à expiration.
 */
export function spawnDecoys(state: EngineState, data: Record<string, unknown>): void {
  const by = data.by as NationId;
  const at = data.at as LngLat | undefined;
  if (!state.nations[by] || !at) return;
  const count = Math.max(1, Math.min(20, Math.floor(Number(data.count ?? 1))));
  let sysId = typeof data.systemId === 'string' ? data.systemId : null;
  if (!sysId || !state.world.catalog.get(sysId)) sysId = commonLandSystem(state, by);
  if (!sysId) return;
  const bal = milBal(state).decoys;
  const hours = Number(data.hours ?? bal.hours) || bal.hours;
  const m = mil(state);
  for (let i = 0; i < count; i++) {
    const p = destination(at, roll(state) * 360, roll(state) * bal.spreadKm);
    const u = spawnUnit(state, by, sysId, p, undefined, (x) => {
      x.role = 'decoy';
    });
    m.decoy[u.id] = state.time + hours * HOUR;
    schedule(state, m.decoy[u.id]!, 'decoyEnd', { u: u.id });
  }
}

function commonLandSystem(state: EngineState, n: NationId): string | null {
  const count = new Map<string, number>();
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[id]!;
    if (u.role || u.off) continue;
    const s = sysOf(state, u);
    if (s.movement !== 'land') continue;
    count.set(u.sys, (count.get(u.sys) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

export function handleDecoyEnd(state: EngineState, d: { u: string }): void {
  const m = mil(state);
  const end = m.decoy[d.u];
  if (end === undefined || end > state.time) return;
  delete m.decoy[d.u];
  const u = state.units[d.u];
  if (u) retireUnit(state, u);
}
