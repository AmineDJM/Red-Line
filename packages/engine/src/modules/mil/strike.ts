import {
  HOUR,
  MINUTE,
  distanceKm,
  type BuildingType,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
  type StrikeTarget,
  type TargetClass,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult, World } from '../../api.js';
import { destroyUnit, inflict, jammingFor, retireUnit, roundDamage } from '../../combat/combat.js';
import { otherOf, refreshUnitPairs, unitPairKey } from '../../encounters/pairs.js';
import {
  ceasefire,
  hostile,
  inRange,
  isLauncher,
  isRadarSensor,
  targetClassOf,
  weaponRange,
} from '../../encounters/profile.js';
import { setMovement } from '../../movement/movement.js';
import { atWar, notify, sightLevel, sortedKeys, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { declareWar } from '../../state/war.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier, signal, unitModifier } from '../registry.js';
import { airFeasible, flyTo, missionOf, noFlyAt, rtb, strikeAim } from './air.js';
import { raiseAlert } from './alert.js';
import {
  battleFor,
  countermeasure,
  engage,
  recordInterception,
  recordLaunch,
  shot,
  timeline,
  touch,
} from './battles.js';
import { detonate } from './nuclear.js';
import { mil, milBal, type MissileSt, type MissionSt } from './state.js';
import { countLoss, elementsLost, statOf } from './stats.js';
import {
  OK,
  buildingsOf,
  cityOf,
  fail,
  generic,
  interceptClass,
  isAsat,
  earlyWarningUnits,
  isEarlyWarning,
  isSatellite,
  launchCells,
  nameOfProvince,
  posOf,
  provinceAt,
  resolveOwn,
  roll,
  schedule,
  strikeRangeKm,
  unitsNear,
} from './util.js';

/**
 * Frappes : missiles (lanceurs et cellules de lancement des navires), frappes aériennes (aller,
 * frappe, retour) et armes antisatellites.
 *
 * Missiles. Une salve est une unité de rôle « missile » : elle vole en grand cercle à
 * `missile.speedKmh` vers le point visé ; son arrivée est l'impact. Elle est visible des capteurs
 * comme toute unité (furtivité de la fiche) et n'est engagée QUE par interception : quand elle entre
 * dans la portée d'arme d'une unité capable d'intercepter (fiche `interceptor`, ou à défaut dégâts
 * « missile » > 0), un engagement est programmé. Par engagement : tirs ≤ min(munitions, canaux
 * libres de la fenêtre, missiles × tirs par missile) ; pk = interceptor.pk × (1 − évasion) ×
 * recherche × (1 − brouillage ami couvrant la salve). Les canaux sont partagés sur une fenêtre de
 * `reengageMinutes` : au-delà, les missiles passent (saturation). Ré-engagement tant que la salve
 * reste à portée ; magasin rechargé après `reloadHours` sans tirer.
 *
 * Impact : cible unité (autodirecteur : raccroche la cible à `homingKm` près pour les antinavires et
 * antiradars, sinon rayon d'effet), point (unités hostiles dans le rayon), bâtiment (signal
 * `building_hit`, dégâts = missiles × dégâts « building » / buildingHp ; aéronefs posés et unités
 * fixes de la province touchés aussi). Antiradar : bonus contre radars et défense aérienne.
 */

type ExecKind = 'launcher' | 'cells' | 'air' | 'asat';

interface Plan {
  u: Unit;
  kind: ExecKind;
  msys?: WeaponSystem;
  count?: number;
  nuclear?: boolean;
}

const shipMissileCache = new WeakMap<World, WeaponSystem[]>();

function strikeMissiles(state: EngineState): WeaponSystem[] {
  let list = shipMissileCache.get(state.world);
  if (!list) {
    list = [];
    for (const id of wi(state.world).systemIds) {
      const s = state.world.catalog.get(id)!;
      if (s.enabled && s.missile && (s.category === 'strike_missile' || s.category === 'nuclear')) {
        list.push(s);
      }
    }
    shipMissileCache.set(state.world, list);
  }
  return list;
}

export function isSsbn(sys: WeaponSystem): boolean {
  return sys.requires.includes('research.naval.ssbn') || sys.roles.includes('ssbn');
}

/** Missile tiré depuis les cellules d'un navire : même doctrine de préférence. */
export function missileForShip(
  state: EngineState,
  ship: WeaponSystem,
  antiShip: boolean,
): WeaponSystem | null {
  const nuclear = isSsbn(ship);
  const ok = (s: WeaponSystem): boolean => {
    const k = s.missile!.kind;
    if (nuclear) return k === 'slbm';
    if (s.missile!.warhead !== 'conventional') return false;
    return antiShip ? k === 'antiship' || k === 'cruise' : k === 'cruise';
  };
  const cands = strikeMissiles(state).filter(ok);
  const score = (s: WeaponSystem): number =>
    (s.doctrine === ship.doctrine ? 2 : 0) + (antiShip && s.missile!.kind === 'antiship' ? 1 : 0);
  let best: WeaponSystem | null = null;
  for (const s of cands) if (!best || score(s) > score(best)) best = s;
  return best;
}

export function cellsLeft(state: EngineState, u: Unit): number {
  const m = mil(state);
  const v = m.cells[u.id];
  return v ?? u.count * launchCells(sysOf(state, u));
}

/** Consomme des munitions d'une pile (retirée à zéro, ce n'est pas une perte). */
export function consume(state: EngineState, u: Unit, n: number): void {
  const s = sysOf(state, u);
  const left = u.count - n;
  if (left <= 0) {
    retireUnit(state, u);
    return;
  }
  const ratio = u.hp / u.maxHp;
  u.count = left;
  u.maxHp = left * s.hp;
  u.hp = u.maxHp * ratio;
}

/** Nation visée par une cible (null : personne, en mer). */
export function victimOf(state: EngineState, target: StrikeTarget): NationId | null {
  if (target.type === 'unit') return state.units[target.unitId]?.owner ?? null;
  if (target.type === 'building') return state.provinces[target.provinceId]?.owner ?? null;
  const pid = provinceAt(state, target.at);
  return pid ? state.provinces[pid]!.owner : null;
}

export function aimOf(state: EngineState, target: StrikeTarget): LngLat | null {
  if (target.type === 'point') return target.at;
  if (target.type === 'building') return cityOf(state, target.provinceId);
  const t = state.units[target.unitId];
  return t ? posOf(state, t) : null;
}

function nuclearAllowed(state: EngineState, n: NationId): OrderResult | null {
  const b = board(state);
  if (!b.nuclearAuth[n])
    return fail('locked', 'Emploi du nucléaire non autorisé (ordre nuclearAuth).');
  if (b.alertLevel > milBal(state).nuclear.maxAlertForStrike) {
    return fail('locked', `Niveau d'alerte ${b.alertLevel} : frappe nucléaire impossible.`);
  }
  return null;
}

/** Ordre `strike`. */
export function orderStrike(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'strike' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  const target = o.target;
  let tUnit: Unit | null = null;
  if (target.type === 'unit') {
    tUnit = state.units[target.unitId] ?? null;
    if (!tUnit || tUnit.owner === n || tUnit.role === 'missile') {
      return fail('invalid_target', 'Cible invalide.');
    }
    const sat = isSatellite(sysOf(state, tUnit));
    if (!sat && (tUnit.off || sightLevel(state, n, tUnit.id) === 0)) {
      return fail('invalid_target', 'Cible hors de vue.');
    }
  } else if (target.type === 'building') {
    const P = state.provinces[target.provinceId];
    if (!P || P.owner === n) return fail('invalid_target', 'Province invalide.');
    if (!buildingsOf(state, target.provinceId).includes(target.building)) {
      return fail('invalid_target', 'Bâtiment absent de cette province.');
    }
  }
  const aim = aimOf(state, target);
  if (!aim) return fail('invalid_target', 'Cible invalide.');
  const victim = victimOf(state, target);
  if (victim === n) return fail('invalid_target', 'Cible amie.');
  if (victim && ceasefire(state, n, victim)) return fail('locked', 'Cessez-le-feu en vigueur.');
  const tClass: TargetClass = tUnit ? targetClassOf(state, tUnit) : 'building';

  const plans: Plan[] = [];
  const m = mil(state);
  for (const u of units) {
    const s = sysOf(state, u);
    if (isAsat(s)) {
      if (!tUnit || !isSatellite(sysOf(state, tUnit))) {
        return fail('invalid_target', 'Une arme antisatellite ne vise qu’un satellite.');
      }
      if (board(state).alertLevel > 3)
        return fail('locked', 'Niveau d’alerte trop bas pour une arme antisatellite.');
      plans.push({ u, kind: 'asat', count: 1 });
      continue;
    }
    if (tUnit && isSatellite(sysOf(state, tUnit)))
      return fail('invalid_target', 'Satellite hors d’atteinte.');
    if (u.off && !m.ms[u.id]?.emb) return fail('not_allowed', 'Unité indisponible.');
    if (isLauncher(s)) {
      if (distanceKm(posOf(state, u), aim) > strikeRangeKm(s)) {
        return fail('out_of_range', 'Cible hors de portée du missile.');
      }
      const nuclear = s.missile!.warhead === 'nuclear';
      if (nuclear) {
        const err = nuclearAllowed(state, n);
        if (err) return err;
      }
      if (s.missile!.kind === 'antiradiation' && tUnit && !isRadarSensor(sysOf(state, tUnit))) {
        return fail('invalid_target', 'Un missile antiradar ne vise qu’un émetteur radar.');
      }
      if (s.missile!.kind === 'antiship' && tUnit && sysOf(state, tUnit).movement !== 'sea') {
        return fail('invalid_target', 'Un missile antinavire ne vise que les navires.');
      }
      const salvo = Math.min(u.count, o.count ?? u.count);
      plans.push({ u, kind: 'launcher', msys: s, count: salvo, nuclear });
      continue;
    }
    if (s.movement === 'sea' && launchCells(s) > 0) {
      const msys = missileForShip(state, s, tClass === 'ship' || tClass === 'submarine');
      if (!msys) return fail('not_allowed', 'Aucun missile disponible pour ce navire.');
      const left = cellsLeft(state, u);
      if (left <= 0)
        return fail(
          'insufficient_resources',
          'Cellules de lancement vides (rechargement au port).',
        );
      if (distanceKm(posOf(state, u), aim) > strikeRangeKm(msys)) {
        return fail('out_of_range', 'Cible hors de portée du missile.');
      }
      const nuclear = msys.missile!.warhead === 'nuclear';
      if (nuclear) {
        const err = nuclearAllowed(state, n);
        if (err) return err;
      }
      const salvo = Math.min(left, o.count ?? u.count * milBal(state).strike.cellsSalvoPerElement);
      plans.push({ u, kind: 'cells', msys, count: salvo, nuclear });
      continue;
    }
    if (s.movement === 'air') {
      if (s.damage[tClass] <= 0)
        return fail('invalid_target', 'Cet appareil ne peut pas frapper cette cible.');
      if (noFlyAt(state, n, aim)) return fail('locked', 'Zone d’exclusion aérienne.');
      const err = airFeasible(state, u, aim);
      if (err) return err;
      plans.push({ u, kind: 'air' });
      continue;
    }
    return fail('not_allowed', 'Cette unité ne peut pas exécuter de frappe.');
  }

  if (victim && victim !== n && !atWar(state, n, victim)) declareWar(state, n, victim);
  for (const p of plans) {
    const u = p.u;
    if (p.kind === 'asat') {
      asatShot(state, u, tUnit!);
      consume(state, u, 1);
      continue;
    }
    if (p.kind === 'air') {
      const ms = missionOf(state, u);
      ms.mis = 'strike';
      ms.ph = 'out';
      ms.tg = target;
      ms.at = null;
      ms.retry = 0;
      ms.sv++;
      flyTo(state, u, aim);
      continue;
    }
    const count = p.count!;
    if (p.kind === 'cells') m.cells[u.id] = cellsLeft(state, u) - count;
    launch(state, u, p.msys!, count, target, aim, victim, !!p.nuclear);
    // Munitions en stock : consommées au tir.
    if (p.kind === 'launcher') consume(state, u, count);
  }
  return OK;
}

/* ------------------------------------------------------------------------------------------------ */
/* Tir et vol                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export function launch(
  state: EngineState,
  from: Unit,
  msys: WeaponSystem,
  count: number,
  target: StrikeTarget,
  aim: LngLat,
  victim: NationId | null,
  nuclear: boolean,
): Unit {
  const at = posOf(state, from);
  const M = spawnUnit(state, from.owner, msys.id, at, count, (u) => {
    u.role = 'missile';
    u.stance = 'hold';
  });
  const speed = Math.max(1, msys.missile!.speedKmh);
  const d = distanceKm(at, aim);
  const t1 = state.time + Math.max(MINUTE, (d / speed) * HOUR);
  const b = victim ? battleFor(state, from.owner, victim, aim) : null;
  const st: MissileSt = {
    by: from.owner,
    from: from.id,
    launchAt: at,
    aim: [aim[0], aim[1]],
    target,
    victim,
    impactAt: t1,
    nuclear,
    kind: msys.missile!.kind,
    cls: msys.category === 'drone' ? 'drone' : interceptClass(msys.missile!.kind),
    battle: b?.id ?? null,
    launched: count,
  };
  mil(state).msl[M.id] = st;
  setMovement(state, M, [{ from: at, to: [aim[0], aim[1]], t0: state.time, t1, medium: 'air' }]);
  statOf(state, from.owner).missiles += count;
  if (b) {
    engage(state, b, from);
    recordLaunch(b, from.owner, count);
    timeline(
      state,
      b,
      `Tir de ${count} ${msys.name}${nuclear ? ' (charge nucléaire)' : ''} depuis ${nameOfProvince(state, provinceAt(state, at))}`,
      [from],
    );
    touch(state, b);
  }
  // Un sous-marin qui tire se découvre.
  const fs = sysOf(state, from);
  if (fs.naval?.submerged) expose(state, from);
  warnLaunch(state, M, st);
  return M;
}

export function expose(state: EngineState, u: Unit): void {
  const m = mil(state);
  const until = state.time + milBal(state).strike.submarineExposureMinutes * MINUTE;
  const was = m.exposed[u.id];
  m.exposed[u.id] = Math.max(was ?? 0, until);
  if (was === undefined || was <= state.time) refreshUnitPairs(state, u);
  schedule(state, until, 'unexpose', { u: u.id });
}

export function handleUnexpose(state: EngineState, d: { u: string }): void {
  const m = mil(state);
  const until = m.exposed[d.u];
  if (until === undefined || until > state.time) return;
  delete m.exposed[d.u];
  const u = state.units[d.u];
  if (u) refreshUnitPairs(state, u);
}

/**
 * Alerte au lancement : le tireur, les nations dotées d'un satellite d'alerte avancée (tirs
 * balistiques et hypersoniques du monde entier) et celles dont un radar d'alerte couvre le point de
 * départ ou d'arrivée. Elles reçoivent `missile_launch` et un contact sur la salve.
 */
function warnLaunch(state: EngineState, M: Unit, st: MissileSt): void {
  const aud = new Set<NationId>([M.owner]);
  const cls = st.cls;
  if (cls === 'ballistic' || cls === 'hypersonic') {
    // Construction d'un ensemble (trié ensuite) : l'ordre de parcours est sans effet. Seules les
    // unités d'alerte avancée sont parcourues (index d'exécution).
    for (const id of earlyWarningUnits(state)) {
      const u = state.units[id];
      if (!u) continue;
      if (u.owner === M.owner || u.role) continue;
      const s = sysOf(state, u);
      if (!isEarlyWarning(s)) continue;
      if (isSatellite(s)) {
        aud.add(u.owner);
        continue;
      }
      const r = s.sensor?.rangeKm ?? s.detectionRangeKm;
      const p = posOf(state, u);
      if (distanceKm(p, st.launchAt) <= r || distanceKm(p, st.aim) <= r) aud.add(u.owner);
    }
  }
  const t = state.time;
  for (const n of [...aud].sort()) {
    if (n === M.owner || sightLevel(state, n, M.id) > 0) continue;
    const known = (state.know[n] ??= {});
    known[M.id] = {
      owner: M.owner,
      lvl: 2,
      seen: false,
      since: t,
      lastSeen: t,
      pos: [st.launchAt[0], st.launchAt[1]],
      sys: M.sys,
      count: null,
      hpr: null,
      status: null,
    };
  }
  notify(
    state,
    {
      kind: 'missile_launch',
      time: t,
      at: st.launchAt,
      unitId: M.id,
      impactAt: st.impactAt,
      target: st.aim,
    },
    [...aud],
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Interception                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

interface InterceptorProfile {
  pk: number;
  magazine: number;
  against: string[];
}

export function interceptorOf(state: EngineState, I: Unit): InterceptorProfile | null {
  if (I.off || I.role) return null;
  if (weaponRange(state, I).max <= 0) return null;
  const s = sysOf(state, I);
  if (s.interceptor) {
    return {
      pk: s.interceptor.pk,
      magazine: s.interceptor.magazine,
      against: s.interceptor.against,
    };
  }
  if (s.damage.missile > 0) {
    const b = milBal(state).intercept;
    const against = ['cruise', 'drone', 'aircraft'];
    if (s.damage.missile >= 12) against.push('ballistic');
    return {
      pk: Math.min(b.fallbackPkMax, s.damage.missile * b.fallbackPkPerDamage),
      magazine: b.fallbackMagazine,
      against,
    };
  }
  return null;
}

function interceptHostile(state: EngineState, I: Unit, M: Unit): boolean {
  if (I.owner === M.owner) return false;
  const st = mil(state).msl[M.id];
  if (atWar(state, I.owner, M.owner)) return !ceasefire(state, I.owner, M.owner);
  // Défense d'un allié visé (même alliance) : on intercepte ce qui le vise.
  const b = board(state);
  const ally =
    st?.victim && b.allianceOf[I.owner] && b.allianceOf[I.owner] === b.allianceOf[st.victim];
  return !!ally;
}

/** Crochet onCombatRefresh : programme les engagements d'interception d'une unité. */
export function scheduleInterceptions(state: EngineState, I: Unit): void {
  const prof = interceptorOf(state, I);
  if (!prof) return;
  const m = mil(state);
  // Parcours des salves en vol (peu nombreuses) plutôt que de toutes les paires de l'intercepteur.
  let any = false;
  for (const _ in m.msl) {
    any = true;
    break;
  }
  if (!any) return;
  const w = weaponRange(state, I);
  // Seules les salves en paire avec l'intercepteur comptent : on parcourt le plus petit des deux
  // ensembles, puis on trie (même ordre que le parcours trié de toutes les salves).
  const pk = state.rt.pairsOf.get(I.id);
  let mids: string[];
  if (pk && pk.size < Object.keys(m.msl).length) {
    mids = [];
    for (const key of pk) {
      if (key.includes('#')) continue;
      const other = otherOf(key, I.id);
      if (m.msl[other]) mids.push(other);
    }
    mids.sort();
  } else mids = Object.keys(m.msl).sort();
  for (const mid of mids) {
    const M = state.units[mid];
    if (!M || M.owner === I.owner) continue;
    const pair = state.pairs[unitPairKey(I.id, mid)];
    if (!pair || !inRange(w, pair.d)) continue;
    const st = m.msl[mid];
    if (!st || !prof.against.includes(st.cls)) continue;
    if (sightLevel(state, I.owner, M.id) === 0) continue;
    if (!interceptHostile(state, I, M)) continue;
    const k = `${I.id}>${M.id}`;
    if (m.icq[k] !== undefined) continue;
    m.icq[k] = state.time;
    schedule(state, state.time, 'icpt', { i: I.id, m: M.id });
  }
}

export function handleIntercept(state: EngineState, d: { i: string; m: string }): void {
  const m = mil(state);
  const k = `${d.i}>${d.m}`;
  const I = state.units[d.i];
  const M = state.units[d.m];
  const st = M ? m.msl[M.id] : undefined;
  if (m.icq[k] === -1) return;
  const drop = (): void => {
    delete m.icq[k];
  };
  if (!I || !M || !st || M.role !== 'missile') return drop();
  const prof = interceptorOf(state, I);
  if (!prof || !prof.against.includes(st.cls)) return drop();
  const pair = state.pairs[unitPairKey(I.id, M.id)];
  if (!pair || !inRange(weaponRange(state, I), pair.d)) return drop();
  if (sightLevel(state, I.owner, M.id) === 0 || !interceptHostile(state, I, M)) return drop();
  const bal = milBal(state).intercept;
  const now = state.time;
  const full = Math.max(1, Math.round(prof.magazine * I.count));
  let [left, last] = m.mag[I.id] ?? [full, -1];
  if (last >= 0 && now - last >= bal.reloadHours * HOUR) left = full;
  if (left <= 0) {
    // Munitions épuisées : la salve passe cette défense (compté une fois, pas de ré-engagement).
    const b = st.battle ? m.battles[st.battle] : undefined;
    if (b) countermeasure(b, 'saturation', M.count);
    m.icq[k] = -1;
    return;
  }
  const winMs = bal.reengageMinutes * MINUTE;
  let [ws, used] = m.icw[I.id] ?? [now, 0];
  // `now >= ws + winMs` (et non `now - ws >= winMs`) : l'événement de la fenêtre suivante est
  // programmé à `ws + winMs` ; la soustraction flottante peut donner winMs − ε à cet instant précis,
  // et l'interception se reprogrammait alors indéfiniment au même instant (boucle infinie).
  if (now >= ws + winMs) {
    ws = now;
    used = 0;
  }
  const channels = Math.max(1, Math.round(I.count * bal.channelsPerElement)) - used;
  if (channels <= 0) {
    // Tous les canaux sont pris (saturation) : prochaine fenêtre.
    m.icq[k] = ws + winMs;
    schedule(state, ws + winMs, 'icpt', d);
    return;
  }
  const msys = sysOf(state, M);
  const isys = sysOf(state, I);
  const jam = jammingFor(state, M) * (1 - isys.ew.jamResistance);
  let pk =
    prof.pk *
    (1 - (msys.missile?.evasion ?? 0)) *
    modifier(state, I.owner, 'missiles.interception') *
    unitModifier(state, I, 'missiles.interception') *
    (1 - jam);
  pk = Math.max(0, Math.min(0.98, pk));
  const avail = Math.min(left, channels, M.count * Math.max(1, Math.round(bal.shotsPerMissile)));
  let fired = 0;
  let killed = 0;
  let remaining = M.count;
  for (let pass = 0; pass < Math.max(1, Math.round(bal.shotsPerMissile)) && fired < avail; pass++) {
    const targets = remaining;
    for (let j = 0; j < targets && fired < avail; j++) {
      fired++;
      if (roll(state) < pk) {
        remaining--;
        killed++;
      }
    }
  }
  m.mag[I.id] = [left - fired, now];
  m.icw[I.id] = [ws, used + fired];
  const ipos = posOf(state, I);
  const mpos = posOf(state, M);
  const b = st.battle ? m.battles[st.battle] : battleFor(state, I.owner, M.owner, mpos);
  if (b) {
    engage(state, b, I);
    countermeasure(b, 'interception', killed);
    recordInterception(b, I.owner, M.owner, killed);
    countermeasure(b, 'evasion', fired - killed);
    if (jam > 0) countermeasure(b, 'jamming', 1);
    shot(state, b, ipos, mpos, 'missile', killed > 0, I);
    timeline(
      state,
      b,
      `${isys.name} (${I.owner.toUpperCase()}) : ${killed}/${M.count} ${msys.name} interceptés (${fired} tirs)`,
      [I],
    );
    touch(state, b);
  }
  statOf(state, I.owner).intercepted += killed;
  I.xp += killed * msys.hp;
  if (killed >= M.count) {
    delete m.icq[k];
    destroyUnit(state, M, I);
    return;
  }
  if (killed > 0) {
    M.count -= killed;
    M.hp = Math.min(M.hp, M.count * msys.hp);
    M.maxHp = M.count * msys.hp;
    state.rt.dirtyCombat.add(M.id);
  }
  const next = now + winMs;
  if (next < st.impactAt) {
    m.icq[k] = next;
    schedule(state, next, 'icpt', d);
  } else drop();
}

/** Nettoyage des engagements d'une salve disparue. */
export function forgetMissile(state: EngineState, id: string): void {
  const m = mil(state);
  delete m.msl[id];
  const suffix = `>${id}`;
  for (const k of Object.keys(m.icq)) if (k.endsWith(suffix)) delete m.icq[k];
}

/* ------------------------------------------------------------------------------------------------ */
/* Impact                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

function strikeDamage(
  state: EngineState,
  by: Unit,
  sys: WeaponSystem,
  t: Unit,
  per: number,
): number {
  const cls = targetClassOf(state, t);
  const ts = sysOf(state, t);
  let dmg = sys.damage[cls] * per;
  dmg *= modifier(state, by.owner, 'missiles.accuracy');
  dmg *= modifier(state, by.owner, 'combat.damage') / modifier(state, t.owner, 'combat.armor');
  dmg /= unitModifier(state, t, 'combat.armor');
  dmg *= 1 - ts.armor;
  if (sys.missile?.kind === 'antiradiation' && isRadarSensor(ts)) {
    dmg *= milBal(state).strike.antiRadiationBonus;
  }
  return Math.max(0, dmg);
}

/** Crochet onArrived d'une salve : impact. */
export function impact(state: EngineState, M: Unit): void {
  const m = mil(state);
  const st = m.msl[M.id];
  if (!st) {
    retireUnit(state, M);
    return;
  }
  const sys = sysOf(state, M);
  const at = st.aim;
  if (st.nuclear) {
    detonate(state, M, at, st);
    retireUnit(state, M);
    return;
  }
  const bal = milBal(state).strike;
  const blast = Math.max(sys.missile?.blastKm ?? 0, bal.minBlastKm);
  const b = st.battle ? m.battles[st.battle] : null;
  const n = M.count;
  let hits = 0;
  if (st.target.type === 'building') {
    const pid = st.target.provinceId;
    const dmg =
      (n * sys.damage.building * modifier(state, M.owner, 'missiles.accuracy')) / bal.buildingHp;
    hitBuilding(state, pid, st.target.building, dmg, M);
    hits = n;
  } else {
    const victims: Unit[] = [];
    let primary: Unit | null = null;
    const homing = st.kind === 'antiship' || st.kind === 'antiradiation' ? bal.homingKm : blast;
    if (st.target.type === 'unit') {
      const t = state.units[st.target.unitId];
      if (t && !t.off && distanceKm(posOf(state, t), at) <= homing) primary = t;
    } else if (st.kind === 'antiradiation') {
      let bestD = Infinity;
      for (const t of unitsNear(state, at, homing)) {
        if (!isRadarSensor(sysOf(state, t)) || !hostile(state, M, t)) continue;
        const dd = distanceKm(posOf(state, t), at);
        if (dd < bestD) {
          bestD = dd;
          primary = t;
        }
      }
    }
    if (primary) victims.push(primary);
    for (const t of unitsNear(state, at, blast)) {
      if (t === primary || t.role === 'missile' || t.owner === M.owner) continue;
      if (!atWar(state, M.owner, t.owner)) continue;
      victims.push(t);
    }
    for (const t of victims) {
      if (!state.units[t.id]) continue;
      const per = t === primary ? n : n * 0.5;
      const dmg = strikeDamage(state, M, sys, t, per);
      if (dmg <= 0) continue;
      hits++;
      if (t.role === 'decoy' && b) countermeasure(b, 'decoy', 1);
      inflict(state, M, t, dmg);
    }
    if (b)
      shot(
        state,
        b,
        st.launchAt,
        at,
        primary ? targetClassOf(state, primary) : 'infantry',
        hits > 0,
        st.from,
      );
  }
  if (b) {
    timeline(
      state,
      b,
      `Impact de ${n} ${sys.name} : ${hits > 0 ? 'cible touchée' : 'aucun dégât'}`,
      [M],
    );
    touch(state, b);
  }
  signal(state, 'strike', { by: M.owner, victim: st.victim, at, kind: 'missile', nuclear: false });
  raiseAlert(state, milBal(state).tension.strike, 'strike');
  retireUnit(state, M);
}

/**
 * Coup au but sur un bâtiment : signal `building_hit` (eco tient la santé) ; notification au
 * propriétaire et au tireur ; aéronefs posés sur une base aérienne touchée et unités fixes du
 * bâtiment endommagés.
 */
export function hitBuilding(
  state: EngineState,
  pid: ProvinceId,
  building: BuildingType,
  damage: number,
  by: Unit | null,
  byNation?: NationId,
): void {
  const P = state.provinces[pid];
  if (!P || damage <= 0) return;
  const dmg = Math.min(1, damage);
  const who = by?.owner ?? byNation ?? null;
  signal(state, 'building_hit', { pid, building, damage: dmg, by: who });
  // La santé du bâtiment et la notification building_hit sont tenues par eco ; les sites fixes
  // (unités de défense) suivent la santé annoncée par eco (static_defense / radar_station).
  if (building === 'air_base') {
    const city = cityOf(state, pid)!;
    const m = mil(state);
    const land = milBal(state).air.landingKm;
    for (const id of sortedKeys(m.ms)) {
      const ms = m.ms[id]!;
      const a = state.units[id];
      if (!a || !ms.fa || ms.up || ms.emb || a.owner !== P.owner) continue;
      if (distanceKm(posOf(state, a), city) > land) continue;
      damageUnit(state, by, a, a.maxHp * dmg * 0.5);
    }
  }
}

/** Dégâts avec ou sans attaquant (les pertes sont comptées une seule fois). */
export function damageUnit(state: EngineState, by: Unit | null, t: Unit, dmg: number): void {
  if (!(dmg > 0) || !state.units[t.id]) return;
  if (by) {
    inflict(state, by, t, dmg);
    return;
  }
  countLoss(state, t, elementsLost(state, t, t.hp - dmg), null);
  inflict(state, null, t, dmg);
}

/** Frappe aérienne à l'arrivée sur l'objectif, puis retour. */
export function deliverAirStrike(state: EngineState, u: Unit, ms: MissionSt): void {
  const tg = ms.tg;
  const bal = milBal(state).strike;
  const sys = sysOf(state, u);
  const here = posOf(state, u);
  const done = (): void => {
    ms.tg = null;
    ms.ph = 'back';
    rtb(state, u);
  };
  if (!tg) return done();
  let victim: NationId | null = victimOf(state, tg);
  let hit = false;
  if (tg.type === 'unit') {
    const t = state.units[tg.unitId];
    if (!t || t.off) return done();
    const reach = Math.max(weaponRange(state, u).max, sys.weaponRangeKm.max, 10) + 5;
    if (distanceKm(posOf(state, t), here) > reach) {
      if (ms.retry < 2 && sightLevel(state, u.owner, t.id) > 0) {
        ms.retry++;
        const aim = strikeAim(state, ms);
        if (aim) {
          flyTo(state, u, aim);
          return;
        }
      }
      return done();
    }
    const dmg = roundDamage(state, u, t, 1) * bal.airStrikeMult;
    if (dmg > 0) {
      hit = true;
      inflict(state, u, t, dmg);
    }
  } else if (tg.type === 'building') {
    const dmg =
      (sys.damage.building *
        u.count *
        bal.airStrikeMult *
        modifier(state, u.owner, 'combat.damage') *
        unitModifier(state, u, 'combat.damage')) /
      bal.buildingHp;
    hitBuilding(state, tg.provinceId, tg.building, dmg, u);
    hit = dmg > 0;
    const b = victim ? battleFor(state, u.owner, victim, here) : null;
    if (b) {
      engage(state, b, u);
      timeline(
        state,
        b,
        `Frappe aérienne (${sys.name}) sur ${tg.building} à ${nameOfProvince(state, tg.provinceId)}`,
        [u],
      );
      shot(state, b, here, cityOf(state, tg.provinceId)!, 'building', hit, u);
      touch(state, b);
    }
  } else {
    const radius = Math.max(bal.minBlastKm, 5);
    for (const t of unitsNear(state, tg.at, radius)) {
      if (t.role === 'missile' || !hostile(state, u, t)) continue;
      const dmg = roundDamage(state, u, t, 1) * bal.airStrikeMult * 0.5;
      if (dmg <= 0) continue;
      hit = true;
      victim ??= t.owner;
      inflict(state, u, t, dmg);
    }
  }
  signal(state, 'strike', { by: u.owner, victim, at: here, kind: 'air', nuclear: false });
  raiseAlert(state, milBal(state).tension.strike, 'strike');
  if (!hit) {
    generic(
      state,
      [u.owner],
      'strike',
      'Frappe sans effet',
      `${sys.name} : objectif non atteint.`,
      'info',
      here,
    );
  }
  done();
}

/** Arme antisatellite : tir immédiat (orbite basse). */
function asatShot(state: EngineState, u: Unit, sat: Unit): void {
  const pk = milBal(state).intercept.asatPk * modifier(state, u.owner, 'missiles.accuracy');
  const ok = roll(state) < pk;
  raiseAlert(state, milBal(state).tension.asat, 'asat');
  if (ok) {
    countLoss(state, sat, sat.count, u);
    destroyUnit(state, sat, u);
  }
  generic(
    state,
    [u.owner, sat.owner],
    'space',
    ok ? 'Satellite détruit' : 'Tir antisatellite manqué',
    `${sysOf(state, sat).name} (${sat.owner.toUpperCase()})`,
    'warn',
  );
}

/** Rechargement des cellules des navires à quai (tick quotidien). */
export function reloadShipsInPort(state: EngineState): void {
  const m = mil(state);
  const range = milBal(state).strike.portReloadKm;
  for (const id of sortedKeys(m.cells)) {
    const u = state.units[id];
    if (!u) {
      delete m.cells[id];
      continue;
    }
    if (u.move) continue;
    const here = posOf(state, u);
    const ports = [...(state.rt.provsOf.get(u.owner) ?? [])].sort();
    const near = ports.some((p) => {
      const sp = wi(state.world).seaSpawn.get(p);
      return (
        !!sp &&
        distanceKm(sp, here) <= range &&
        (buildingsOf(state, p).includes('port') || buildingsOf(state, p).includes('naval_base'))
      );
    });
    if (near) delete m.cells[id];
  }
}
