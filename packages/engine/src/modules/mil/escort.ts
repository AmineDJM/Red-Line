import {
  HOUR,
  MINUTE,
  distanceKm,
  type Leg,
  type LngLat,
  type NationId,
  type Order,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { clearTarget, requestChase, setTarget } from '../../combat/combat.js';
import { canHarm } from '../../combat/stack-combat.js';
import { hostile, targetClassOf } from '../../encounters/profile.js';
import { setMovement } from '../../movement/movement.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { planAir } from '../../nav/plan.js';
import { sightLevel, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { airFeasible, armFuel, missionOf, msOf, noFlyAt, rtb, takeoff } from './air.js';
import { mil, milBal, type MissionSt } from './state.js';
import { inTransport } from './transport.js';
import {
  OK,
  fail,
  failR,
  generic,
  isSatellite,
  noteLoc,
  posOf,
  resolveOwn,
  schedule,
  unitsNear,
} from './util.js';

/**
 * Escorte (ordre `escort`) : une pile suit une pile amie et la protège. Chasseurs escortant des
 * bombardiers, frégates escortant un transport, défense antiaérienne mobile accompagnant une colonne :
 *  - l'escorte rejoint la pile protégée au plus tôt sur son trajet, puis vole / navigue / roule en
 *    formation (mêmes segments, même vitesse) ; elle se recale à chaque changement de trajet de la
 *    pile protégée, ou si elle s'en écarte de plus de `followKm` ;
 *  - elle engage les menaces hostiles visibles à moins de `engageKm` de la pile protégée qu'elle peut
 *    toucher (celles qui visent la pile protégée d'abord), sans s'en éloigner au-delà de `leashKm` ;
 *    ses intercepteurs tirent sur les missiles à portée (interception du module, automatique) ;
 *  - fin : ordre d'arrêt, de déplacement ou d'attaque, pile protégée détruite, embarquée ou posée,
 *    carburant (retour automatique des aéronefs : bingo).
 * Veille périodique (événement 'esc', version `sv` de la mission) : déterministe, rejouable.
 */

function escBal(state: EngineState) {
  return milBal(state).escort;
}

type Domain = 'air' | 'sea' | 'land';

function domainOf(state: EngineState, u: Unit): Domain | null {
  const s = sysOf(state, u);
  if (s.movement === 'air' || s.movement === 'sea' || s.movement === 'land') return s.movement;
  return null;
}

/** Pile capable d'escorter : mobile, armée (arme à portée et dégâts non nuls). */
export function canEscort(state: EngineState, u: Unit): boolean {
  const s = sysOf(state, u);
  if (s.missile || isSatellite(s) || s.movement === 'static' || s.speedKmh <= 0) return false;
  if (mil(state).fixedOf[u.id]) return false;
  if (s.weaponRangeKm.max <= 0) return false;
  return Object.values(s.damage).some((d) => d > 0);
}

/** Trajet direct (aéronef) ou planifié (surface) vers un point, null si impossible. */
function planTo(state: EngineState, u: Unit, to: LngLat): Leg[] | null {
  const s = sysOf(state, u);
  const p =
    s.movement === 'air' ? planAir(s, posOf(state, u), to, state.time) : planUnitMove(state, u, to);
  return 'error' in p ? null : p.legs;
}

/** Détour moyen d'un trajet de surface (recherche du point de jonction). */
const SURFACE_DETOUR = 1.3;

/**
 * Trajet en formation : jonction au plus tôt avec la pile protégée sur son trajet, puis mêmes segments
 * qu'elle (même vitesse, même chemin). Pile protégée à l'arrêt : trajet vers sa position. Jonction
 * impossible avant son arrivée : trajet vers sa destination.
 */
export function formationLegs(state: EngineState, u: Unit, T: Unit): Leg[] | null {
  const now = state.time;
  const s = sysOf(state, u);
  const v = s.speedKmh;
  if (v <= 0) return null;
  const here = posOf(state, u);
  const legsT = T.move?.legs;
  const tEnd = legsT ? legsT[legsT.length - 1]!.t1 : now;
  if (!legsT || tEnd <= now) {
    const p = posOf(state, T);
    return distanceKm(here, p) < 0.5 ? [] : planTo(state, u, p);
  }
  const air = s.movement === 'air';
  const detour = air ? 1 : SURFACE_DETOUR;
  const reach = (t: number): boolean =>
    ((distanceKm(here, unitPosAt(state, T, t)) * detour) / v) * HOUR <= t - now;
  const dest = legsT[legsT.length - 1]!.to;
  if (!reach(tEnd)) return planTo(state, u, dest);
  let lo = now;
  let hi = tEnd;
  if (reach(now)) hi = now;
  while (hi - lo > 1000) {
    const mid = (lo + hi) / 2;
    if (reach(mid)) hi = mid;
    else lo = mid;
  }
  const tj = hi;
  const P = unitPosAt(state, T, tj);
  const out: Leg[] = [];
  if (distanceKm(here, P) >= 0.5) {
    const first = planTo(state, u, P);
    if (!first) return null;
    const ta = first.length ? first[first.length - 1]!.t1 : now;
    if (ta > tj + 1000) return planTo(state, u, dest);
    out.push(...first);
    if (tj - ta > 1000) {
      const medium = air ? 'air' : (first[first.length - 1]?.medium ?? 'land');
      out.push({ from: P, to: P, t0: ta, t1: tj, medium });
    }
  }
  for (const l of legsT) {
    if (l.t1 <= tj) continue;
    const medium = air ? 'air' : s.movement === 'sea' ? 'sea' : l.medium;
    out.push({ from: l.t0 < tj ? P : l.from, to: l.to, t0: Math.max(l.t0, tj), t1: l.t1, medium });
  }
  return out;
}

/** Rejoint la pile protégée et se cale sur son trajet. */
function follow(state: EngineState, u: Unit, m: MissionSt, T: Unit): void {
  m.etv = T.mv;
  // Aéronef protégé encore au sol : l'escorte attend son décollage.
  const tm = msOf(state, T);
  if (tm?.fa && !tm.up) return;
  // Aéronef au sol (ou embarqué) : décollage d'abord (position de départ = sa base ou son porteur).
  if (m.fa && !m.up) takeoff(state, u, m);
  const legs = formationLegs(state, u, T);
  if (!legs) return;
  if (legs.length > 0) setMovement(state, u, legs);
  else {
    if (u.move) setMovement(state, u, null);
    if (m.fa) armFuel(state, u);
  }
}

export function orderEscort(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'escort' }>,
): OrderResult {
  const T = state.units[o.targetId];
  if (
    !T ||
    T.owner !== n ||
    T.off ||
    T.role ||
    sysOf(state, T).movement === 'static' ||
    sysOf(state, T).speedKmh <= 0
  ) {
    return failR(
      'invalid_target',
      'escort_target_invalid',
      'Cible d’escorte invalide : choisissez une de vos piles mobiles.',
    );
  }
  if (o.unitIds.includes(T.id))
    return failR('invalid_target', 'escort_self', 'Une pile ne peut pas s’escorter elle-même.');
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  const m = mil(state);
  const tm = m.ms[T.id];
  if (tm?.mis === 'escort' && tm.esc && o.unitIds.includes(tm.esc)) {
    return failR(
      'invalid_target',
      'escort_target_invalid',
      'Cette pile escorte déjà l’une des vôtres : escorte croisée impossible.',
    );
  }
  const tDom = domainOf(state, T);
  const at = posOf(state, T);
  for (const u of units) {
    const s = sysOf(state, u);
    if ((u.off && !m.ms[u.id]?.emb) || inTransport(state, u.id))
      return fail('not_allowed', `Unité indisponible pour cet ordre : ${u.id}`);
    if (!canEscort(state, u)) {
      return failR(
        'not_allowed',
        'escort_incapable',
        `${s.name} ne peut pas escorter (sans arme).`,
        { name: s.name },
      );
    }
    const dom = domainOf(state, u);
    // Aéronefs : toute pile ; navires : navires ; troupes et défense mobile : troupes.
    if (dom !== 'air' && dom !== tDom) {
      return failR('not_allowed', 'escort_domain', `${s.name} ne peut pas suivre cette pile.`, {
        name: s.name,
      });
    }
    if (dom === 'air') {
      if (noFlyAt(state, n, at)) return fail('locked', 'Zone d’exclusion aérienne.');
      const err = airFeasible(state, u, at);
      if (err) return err;
    } else {
      const p = planUnitMove(state, u, at);
      if ('error' in p) return fail(p.error, 'Pile à escorter inaccessible.');
    }
  }
  const b = escBal(state);
  for (const u of units) {
    if (u.target) clearTarget(state, u);
    const ms = missionOf(state, u);
    ms.mis = 'escort';
    ms.esc = T.id;
    delete ms.etu;
    ms.at = [at[0], at[1]];
    ms.r = b.engageKm;
    ms.tg = null;
    ms.ph = 'out';
    ms.retry = 0;
    ms.tk = null;
    ms.sv++;
    schedule(state, state.time + b.refreshMinutes * MINUTE, 'esc', { u: u.id, sv: ms.sv });
    follow(state, u, ms, T);
  }
  return OK;
}

/** Fin d'escorte : aéronefs en vol au retour, autres sur place. */
function endEscort(state: EngineState, u: Unit, m: MissionSt, lost: boolean): void {
  m.mis = 'none';
  m.esc = null;
  delete m.etv;
  delete m.etu;
  m.at = null;
  m.r = 0;
  m.sv++;
  if (u.target) clearTarget(state, u);
  if (m.fa) {
    if (m.up) rtb(state, u);
  } else {
    m.ph = null;
    if (u.move) setMovement(state, u, null);
  }
  if (lost) {
    generic(
      state,
      [u.owner],
      'escort',
      'Escorte terminée',
      `${sysOf(state, u).name} : la pile escortée n’est plus là.`,
      'info',
      posOf(state, u),
      noteLoc('escortEnded', { system: { system: u.sys } }),
    );
  }
}

/** Menace la plus urgente autour de la pile protégée, que l'escorte peut toucher. */
function threatFor(state: EngineState, u: Unit, T: Unit, around: LngLat, r: number): Unit | null {
  const sys = sysOf(state, u);
  let best: Unit | null = null;
  let bestScore = Infinity;
  for (const o of unitsNear(state, around, r, (x) => x.owner !== u.owner && !x.role)) {
    if (sightLevel(state, u.owner, o.id) === 0) continue;
    if (o.mix ? !canHarm(state, sys, o) : sys.damage[targetClassOf(state, o)] <= 0) continue;
    if (!hostile(state, u, o)) continue;
    // Celles qui visent la pile protégée (ou l'escorte) d'abord, puis les plus proches.
    const aimed = o.target === T.id || o.target === u.id ? 0 : 1;
    const score = aimed * 1e6 + distanceKm(posOf(state, o), around);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

/** Veille d'escorte : suivre, engager, ou mettre fin. */
export function handleEscort(state: EngineState, d: { u: string; sv: number }): void {
  const u = state.units[d.u];
  const m = u ? msOf(state, u) : undefined;
  if (!u || !m || m.sv !== d.sv || m.mis !== 'escort') return;
  const b = escBal(state);
  const T = m.esc ? state.units[m.esc] : undefined;
  const tm = T ? msOf(state, T) : undefined;
  // Pile protégée détruite, cédée, ou embarquée (porte-avions, transport) : fin de l'escorte.
  if (!T || T.owner !== u.owner || T.off) {
    endEscort(state, u, m, !T || T.owner !== u.owner);
    return;
  }
  // Aéronef protégé au sol : attente de son décollage ; posé après avoir volé : fin (retour).
  if (tm?.fa && !tm.up) {
    if (m.etu) {
      endEscort(state, u, m, false);
      return;
    }
    schedule(state, state.time + b.refreshMinutes * MINUTE, 'esc', { u: u.id, sv: m.sv });
    return;
  }
  if (tm?.fa) m.etu = true;
  schedule(state, state.time + b.refreshMinutes * MINUTE, 'esc', { u: u.id, sv: m.sv });
  // Retour carburant ou jonction avec un ravitailleur en cours : la mission reprend ensuite.
  if (m.fa && (m.ph === 'back' || m.ph === 'tanker')) return;
  const tPos = posOf(state, T);
  if (u.target) {
    const e = state.units[u.target];
    if (e && distanceKm(posOf(state, e), tPos) <= b.leashKm) return;
    clearTarget(state, u);
  }
  const threat = threatFor(state, u, T, tPos, b.engageKm);
  if (threat) {
    setTarget(state, u, threat.id, 'auto');
    requestChase(state, u.id, 0);
    state.rt.dirtyCombat.add(u.id);
    return;
  }
  m.at = [tPos[0], tPos[1]];
  const here = posOf(state, u);
  const grounded = m.fa && !m.up;
  if (grounded || m.etv !== T.mv || (!u.move && distanceKm(here, tPos) > b.followKm))
    follow(state, u, m, T);
}
