import {
  distanceKm,
  type BlockadeView,
  type BuildingType,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
} from '@redline/shared';
import { cellToLatLng } from 'h3-js';
import type { OrderResult } from '../../api.js';
import { clearTarget, destroyUnit, inflict, retireUnit, roundDamage } from '../../combat/combat.js';
import { refreshUnitPairs } from '../../encounters/pairs.js';
import { isLauncher } from '../../encounters/profile.js';
import { setMovement } from '../../movement/movement.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { atWar, sortedKeys, sortedSet, sysOf, veterancyLevel } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { declareWar } from '../../state/war.js';
import { wi } from '../../state/world.js';
import { signal } from '../registry.js';
import { armFuel, missionOf, msOf, newMission, startScan } from './air.js';
import { raiseAlert } from './alert.js';
import { mil, milBal, nextId, type BlkSt } from './state.js';
import { countLoss } from './stats.js';
import { damageUnit, hitBuilding } from './strike.js';
import {
  OK,
  buildingsOf,
  cityOf,
  fail,
  generic,
  isSpecialForces,
  nameOfProvince,
  nearestProvince,
  posOf,
  resolveOwn,
  roll,
  unitsNear,
} from './util.js';

/* ================================================================================================ */
/* Forces spéciales                                                                                 */
/* ================================================================================================ */

/**
 * `specialOp` : une équipe de forces spéciales rejoint la ville de la province visée ; à l'arrivée
 * (si aucun ordre n'a changé son trajet entre-temps), l'opération réussit avec une probabilité
 * baseSuccess − defenderPenalty × (unités terrestres du propriétaire près de la ville), bonifiée par
 * la vétérance. Raid : dégâts à toutes les unités du propriétaire dans raidRadiusKm. Sabotage :
 * `building_hit`. Sauvetage : signal `rescue` { by, pid, victim } (intel peut libérer ses agents).
 * Échec : l'équipe perd failureLoss de ses PV. Puis elle rentre vers la ville amie la plus proche.
 */
export function orderSpecialOp(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'specialOp' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds);
  if (!Array.isArray(units)) return units;
  const P = state.provinces[o.provinceId];
  if (!P) return fail('invalid_target', 'Province inconnue.');
  if (P.owner === n && o.mission !== 'rescue') return fail('invalid_target', 'Province amie.');
  let building: BuildingType | null = null;
  if (o.mission === 'sabotage') {
    const list = buildingsOf(state, o.provinceId);
    building = o.building ?? list[0] ?? null;
    if (!building || !list.includes(building))
      return fail('invalid_target', 'Aucun bâtiment à saboter.');
  }
  const city = cityOf(state, o.provinceId)!;
  const plans = new Map<string, ReturnType<typeof planUnitMove>>();
  for (const u of units) {
    if (!isSpecialForces(sysOf(state, u)))
      return fail('not_allowed', 'Réservé aux forces spéciales.');
    const p = planUnitMove(state, u, city);
    if ('error' in p) return fail(p.error, 'Destination inaccessible.');
    plans.set(u.id, p);
  }
  const m = mil(state);
  for (const u of units) {
    if (u.target) clearTarget(state, u);
    const p = plans.get(u.id)!;
    if ('error' in p) continue;
    setMovement(state, u, p.legs.length > 0 ? p.legs : null);
    m.sf[u.id] = { pid: o.provinceId, mission: o.mission, building, mv: u.mv };
    if (p.legs.length === 0) resolveSpecialOp(state, u);
  }
  return OK;
}

/** Arrivée d'une équipe : exécution de l'opération. */
export function resolveSpecialOp(state: EngineState, u: Unit): void {
  const m = mil(state);
  const op = m.sf[u.id];
  if (!op) return;
  delete m.sf[u.id];
  if (op.mv !== u.mv) return;
  const P = state.provinces[op.pid];
  if (!P) return;
  const bal = milBal(state).specialOps;
  const city = cityOf(state, op.pid)!;
  const victim = P.owner;
  const gc = state.world.balance.combat.groundContactKm;
  let defenders = 0;
  for (const d of unitsNear(state, city, gc * 2)) {
    if (d.owner === victim && !d.role && sysOf(state, d).movement === 'land') defenders++;
  }
  const vet = veterancyLevel(state, u.xp);
  const p = Math.max(
    bal.minSuccess,
    (bal.baseSuccess - bal.defenderPenalty * defenders) * (1 + 0.1 * vet),
  );
  const ok = roll(state) < p;
  const where = nameOfProvince(state, op.pid);
  if (op.mission !== 'rescue' && victim !== u.owner && !atWar(state, u.owner, victim)) {
    declareWar(state, u.owner, victim);
  }
  if (ok) {
    if (op.mission === 'raid') {
      for (const t of unitsNear(state, city, bal.raidRadiusKm)) {
        if (t.owner !== victim || t.role === 'missile') continue;
        const dmg = roundDamage(state, u, t, 1) * bal.raidMult;
        if (dmg > 0) inflict(state, u, t, dmg);
      }
    } else if (op.mission === 'sabotage' && op.building) {
      hitBuilding(state, op.pid, op.building, bal.sabotageDamage, u);
    } else if (op.mission === 'rescue') {
      signal(state, 'rescue', { by: u.owner, pid: op.pid, victim });
    }
    raiseAlert(state, 1, 'special_op');
    generic(
      state,
      [u.owner],
      'special_op',
      'Opération spéciale réussie',
      `${label(op.mission)} à ${where}.`,
      'info',
      city,
    );
    if (op.mission !== 'rescue') {
      generic(
        state,
        [victim],
        'special_op',
        'Action de forces spéciales',
        `${label(op.mission)} ennemi à ${where}.`,
        'warn',
        city,
      );
    }
  } else {
    generic(
      state,
      [u.owner],
      'special_op',
      'Opération spéciale échouée',
      `${label(op.mission)} à ${where}.`,
      'warn',
      city,
    );
    if (state.units[u.id]) damageUnit(state, null, u, u.maxHp * bal.failureLoss);
  }
  if (!state.units[u.id]) return;
  const home = nearestProvince(state, sortedSet(state.rt.provsOf.get(u.owner)), posOf(state, u));
  if (home) {
    const plan = planUnitMove(state, u, cityOf(state, home.pid)!);
    if (!('error' in plan) && plan.legs.length > 0) setMovement(state, u, plan.legs);
  }
}

function label(mission: string): string {
  return mission === 'raid' ? 'Raid' : mission === 'sabotage' ? 'Sabotage' : 'Sauvetage';
}

/* ================================================================================================ */
/* Blocus naval                                                                                     */
/* ================================================================================================ */

function straitPoint(state: EngineState, id: string): LngLat | null {
  const s = state.world.map.straits.find((x) => x.id === id);
  if (!s || s.seaCells.length === 0) return null;
  const mid = [...s.seaCells].sort()[Math.floor(s.seaCells.length / 2)]!;
  const [lat, lng] = cellToLatLng(mid);
  return [lng, lat];
}

/**
 * `blockade` d'un port (province côtière étrangère) ou d'un détroit : les navires s'y rendent ; le
 * blocus est effectif tant qu'au moins l'un d'eux est à l'arrêt à moins de military.blockade.radiusKm
 * du point (signal `blockade` on/off, vue `blockades`, ProvinceView.blockaded). Bloquer le port
 * d'une nation est un acte de guerre. Les navires en blocus engagent les navires hostiles proches.
 */
export function orderBlockade(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'blockade' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds);
  if (!Array.isArray(units)) return units;
  let at: LngLat | null = null;
  let victim: NationId | null = null;
  if ('provinceId' in o.target) {
    const P = state.provinces[o.target.provinceId];
    if (!P || P.owner === n) return fail('invalid_target', 'Port invalide.');
    at = wi(state.world).seaSpawn.get(o.target.provinceId) ?? null;
    if (!at) return fail('invalid_target', 'Province sans accès à la mer.');
    victim = P.owner;
  } else {
    at = straitPoint(state, o.target.straitId);
    if (!at) return fail('invalid_target', 'Détroit inconnu.');
  }
  const plans = new Map<string, ReturnType<typeof planUnitMove>>();
  for (const u of units) {
    if (sysOf(state, u).movement !== 'sea')
      return fail('not_allowed', 'Seuls les navires font un blocus.');
    const p = planUnitMove(state, u, at);
    if ('error' in p) return fail(p.error, 'Destination inaccessible.');
    plans.set(u.id, p);
  }
  if (victim && !atWar(state, n, victim)) declareWar(state, n, victim);
  const m = mil(state);
  for (const u of units) {
    leaveBlockades(state, u.id);
    if (u.target) clearTarget(state, u);
  }
  const id = nextId(state, 'bk');
  const blk: BlkSt = {
    id,
    by: n,
    target:
      'provinceId' in o.target
        ? { provinceId: o.target.provinceId }
        : { straitId: o.target.straitId },
    at,
    units: units.map((u) => u.id),
    since: state.time,
    on: false,
  };
  m.blk[id] = blk;
  for (const u of units) {
    const ms = missionOf(state, u);
    ms.mis = 'blockade';
    ms.at = [at[0], at[1]];
    ms.r = milBal(state).blockade.radiusKm;
    ms.ph = 'out';
  }
  for (const u of units) {
    const ms = missionOf(state, u);
    const p = plans.get(u.id)!;
    if (!('error' in p)) setMovement(state, u, p.legs.length > 0 ? p.legs : null);
    // Même veille que les patrouilles : engage les navires hostiles près du point.
    startScan(state, u, ms);
  }
  checkBlockade(state, blk);
  return OK;
}

function blockadesOfUnit(state: EngineState, uid: string): BlkSt[] {
  const m = mil(state);
  return sortedKeys(m.blk)
    .map((k) => m.blk[k]!)
    .filter((b) => b.units.includes(uid));
}

function leaveBlockades(state: EngineState, uid: string): void {
  for (const b of blockadesOfUnit(state, uid)) {
    b.units = b.units.filter((x) => x !== uid);
    checkBlockade(state, b);
  }
}

/** Réévalue un blocus (unité arrivée, partie, détruite). */
export function checkBlockade(state: EngineState, b: BlkSt): void {
  const m = mil(state);
  const r = milBal(state).blockade.radiusKm;
  b.units = b.units.filter((id) => {
    const u = state.units[id];
    if (!u) return false;
    const ms = m.ms[id];
    return !!ms && ms.mis === 'blockade';
  });
  const active = b.units.some((id) => {
    const u = state.units[id]!;
    return !u.move && distanceKm(posOf(state, u), b.at) <= r;
  });
  if (active !== b.on) {
    b.on = active;
    const data: Record<string, unknown> = { by: b.by, on: active };
    if ('provinceId' in b.target) data.pid = b.target.provinceId;
    else data.straitId = b.target.straitId;
    signal(state, 'blockade', data);
    const victim =
      'provinceId' in b.target ? state.provinces[b.target.provinceId]?.owner : undefined;
    const where =
      'provinceId' in b.target ? nameOfProvince(state, b.target.provinceId) : b.target.straitId;
    generic(
      state,
      victim ? [b.by, victim] : [b.by],
      'blockade',
      active ? 'Blocus effectif' : 'Blocus levé',
      `${where} (${b.by.toUpperCase()})`,
      active ? 'warn' : 'info',
      b.at,
    );
  }
  if (b.units.length === 0) delete m.blk[b.id];
}

/** Crochets : arrivée, changement de trajet, disparition d'une unité de blocus. */
export function blockadeUnitChanged(state: EngineState, u: Unit, gone: boolean): void {
  const list = blockadesOfUnit(state, u.id);
  if (list.length === 0) return;
  if (!gone) {
    const ms = msOf(state, u);
    // Un nouvel ordre qui éloigne le navire du point le retire du blocus.
    const dest = u.move ? u.move.legs[u.move.legs.length - 1]!.to : posOf(state, u);
    for (const b of list) {
      if (distanceKm(dest, b.at) > milBal(state).blockade.radiusKm && ms) {
        ms.mis = 'none';
        ms.ph = null;
      }
    }
  } else {
    for (const b of list) b.units = b.units.filter((x) => x !== u.id);
  }
  for (const b of list) checkBlockade(state, b);
}

export function blockadesView(state: EngineState): BlockadeView[] {
  const m = mil(state);
  return sortedKeys(m.blk)
    .map((k) => m.blk[k]!)
    .filter((b) => b.on)
    .map((b) => ({ id: b.id, by: b.by, target: { ...b.target }, since: b.since }));
}

export function blockadedProvinces(state: EngineState): Set<ProvinceId> {
  const out = new Set<ProvinceId>();
  const m = mil(state);
  for (const k of Object.keys(m.blk)) {
    const b = m.blk[k]!;
    if (b.on && 'provinceId' in b.target) out.add(b.target.provinceId);
  }
  return out;
}

/* ================================================================================================ */
/* Matériel capturé                                                                                 */
/* ================================================================================================ */

/**
 * Prise d'une province avec base (aérienne, militaire ou navale) : les aéronefs ennemis posés sur la
 * base sont perdus pour leur propriétaire, une part (military.capture.fraction) passe au vainqueur ;
 * quelques armes de l'arsenal adverse (les systèmes terrestres les plus répandus, au plus maxSystems)
 * sont récupérées. Les unités fixes des bâtiments de défense de l'ancien propriétaire sont détruites.
 */
export function captureMateriel(
  state: EngineState,
  pid: ProvinceId,
  from: NationId,
  to: NationId,
): void {
  const m = mil(state);
  const bal = milBal(state).capture;
  const city = cityOf(state, pid);
  if (!city) return;
  for (const k of sortedKeys(m.fixed)) {
    if (!k.startsWith(`${pid}:`)) continue;
    const u = state.units[m.fixed[k]!];
    delete m.fixed[k];
    if (u && u.owner === from) {
      delete m.fixedOf[u.id];
      countLoss(state, u, u.count, null);
      destroyUnit(state, u, null);
    }
  }
  const blds = buildingsOf(state, pid);
  if (!blds.some((b) => b === 'air_base' || b === 'military_base' || b === 'naval_base')) return;
  const gained: string[] = [];
  const land = milBal(state).air.landingKm;
  for (const id of sortedKeys(m.ms)) {
    const ms = m.ms[id]!;
    const a = state.units[id];
    if (!a || a.owner !== from || !ms.fa || ms.up || ms.emb) continue;
    if (distanceKm(posOf(state, a), city) > land) continue;
    const k = Math.floor(a.count * bal.fraction);
    const sysId = a.sys;
    countLoss(state, a, a.count, null);
    destroyUnit(state, a, null);
    if (k >= 1) {
      spawnUnit(state, to, sysId, city, k);
      gained.push(`${k} ${state.world.catalog.get(sysId)!.name}`);
    }
  }
  const counts = new Map<string, number>();
  for (const id of sortedSet(state.rt.byNation.get(from))) {
    const u = state.units[id]!;
    if (u.role || u.off) continue;
    const s = sysOf(state, u);
    if (s.movement !== 'land' || isLauncher(s) || s.category === 'infantry') continue;
    counts.set(u.sys, (counts.get(u.sys) ?? 0) + u.count);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.round(bal.maxSystems));
  for (const [sysId, total] of top) {
    const k = Math.max(
      1,
      Math.min(4, Math.floor((total / Math.max(1, counts.size)) * bal.fraction)),
    );
    spawnUnit(state, to, sysId, city, k);
    gained.push(`${k} ${state.world.catalog.get(sysId)!.name}`);
  }
  if (gained.length > 0) {
    generic(
      state,
      [to],
      'capture',
      'Matériel capturé',
      `${nameOfProvince(state, pid)} : ${gained.join(', ')}.`,
      'info',
      city,
    );
  }
}

/* ================================================================================================ */
/* Piles : scission et fusion                                                                       */
/* ================================================================================================ */

export function orderSplit(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'split' }>,
): OrderResult {
  const res = resolveOwn(state, n, [o.unitId], true);
  if (!Array.isArray(res)) return res;
  const u = res[0]!;
  if (o.count >= u.count) return fail('invalid_target', 'Effectif insuffisant pour scinder.');
  if (mil(state).fixedOf[u.id]) return fail('not_allowed', 'Unité fixe.');
  const sys = sysOf(state, u);
  const ratio = u.hp / u.maxHp;
  const m = mil(state);
  const src = m.ms[u.id];
  const pos = posOf(state, u);
  const nu = spawnUnit(state, n, u.sys, pos, o.count, (x) => {
    x.stance = u.stance;
    x.xp = u.xp;
    if (u.off) x.off = true;
  });
  nu.maxHp = o.count * sys.hp;
  nu.hp = nu.maxHp * ratio;
  u.count -= o.count;
  u.maxHp = u.count * sys.hp;
  u.hp = u.maxHp * ratio;
  if (src) {
    // La nouvelle pile garde base, carburant et embarquement ; elle tient sa position.
    const copy = newMission(src.fa);
    copy.bk = src.bk;
    copy.base = src.base;
    copy.up = src.up;
    copy.fuel = src.fuel;
    copy.ft = src.ft;
    copy.ready = src.ready;
    copy.give = src.give;
    copy.emb = src.emb;
    m.ms[nu.id] = copy;
    if (copy.fa && copy.up) armFuel(state, nu);
  }
  const gid = m.unitGen[u.id];
  const g = gid ? m.gens[gid] : undefined;
  if (g && g.units.length < milBal(state).generals.maxUnits) {
    g.units = [...g.units, nu.id].sort();
    m.unitGen[nu.id] = g.id;
  }
  if (!nu.off) refreshUnitPairs(state, nu);
  state.rt.dirtyCombat.add(nu.id);
  state.rt.dirtyCombat.add(u.id);
  return OK;
}

export function orderMerge(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'merge' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  if (units.length < 2) return fail('invalid_target', 'Il faut au moins deux unités.');
  const first = units[0]!;
  const p0 = posOf(state, first);
  for (const u of units) {
    if (u.sys !== first.sys)
      return fail('invalid_target', 'Fusion possible seulement entre unités du même type.');
    if (u.move) return fail('not_allowed', 'Les unités doivent être à l’arrêt.');
    if (!!u.off !== !!first.off) return fail('not_allowed', 'Unités embarquées et non embarquées.');
    if (distanceKm(posOf(state, u), p0) > 10)
      return fail('out_of_range', 'Unités trop éloignées (10 km).');
    if (mil(state).fixedOf[u.id]) return fail('not_allowed', 'Unité fixe.');
  }
  const m = mil(state);
  let hp = 0;
  let maxHp = 0;
  let count = 0;
  let xp = 0;
  for (const u of units) {
    hp += u.hp;
    maxHp += u.maxHp;
    count += u.count;
    xp += u.xp * u.count;
  }
  const fuelMin = Math.min(...units.map((u) => m.ms[u.id]?.fuel ?? Infinity));
  for (const u of units.slice(1)) retireUnit(state, u);
  first.hp = hp;
  first.maxHp = maxHp;
  first.count = count;
  first.xp = xp / Math.max(1, count);
  const fm = m.ms[first.id];
  if (fm && Number.isFinite(fuelMin)) fm.fuel = Math.min(fm.fuel, fuelMin);
  state.rt.dirtyCombat.add(first.id);
  return OK;
}
