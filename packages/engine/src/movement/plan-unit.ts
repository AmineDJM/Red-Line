import {
  distanceKm,
  type Leg,
  type LngLat,
  type NationId,
  type OrderErrorCode,
} from '@redline/shared';
import { planAir, planSurface, type SurfaceSegments } from '../nav/plan.js';
import { roadSegments } from '../nav/roads.js';
import { currentLeg, sysOf, unitPosAt } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { wi } from '../state/world.js';
import { ownCityWithin } from '../state/cities.js';
import { airBasePos, airRadiusKm } from '../encounters/profile.js';

export type UnitPlan = { legs: Leg[] } | { error: OrderErrorCode };

/** Distance du point à la ville possédée la plus proche (km), Infinity si aucune. */
export function nearestOwnedCityKm(state: EngineState, n: NationId, p: LngLat): number {
  let best = Infinity;
  const w = wi(state.world);
  // Minimum : l'ordre de parcours est sans effet (pas de tri).
  for (const pid of state.rt.provsOf.get(n) ?? []) {
    const d = distanceKm(w.provById.get(pid)!.cityPoint, p);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Vrai si un aéronef peut atteindre ce point : rayon d'action compté depuis sa base d'attache
 * (aéronefs à carburant, module mil), sinon autour d'une ville possédée.
 */
export function airCanReach(state: EngineState, u: Unit, to: LngLat): boolean {
  const r = sysOf(state, u).operationalRadiusKm;
  if (r === null) return true;
  const base = airBasePos(state, u);
  if (base) return distanceKm(base, to) <= airRadiusKm(state, u);
  return ownCityWithin(state, u.owner, to, r);
}

/** Distance (km) en deçà de laquelle une unité arrêtée hors terre est considérée sur une route côtière. */
const COAST_ROAD_KM = 2;
const MEMO_MAX = 512;

/**
 * Unité terrestre en mer : sur un segment maritime (embarquée) hors des cellules terrestres, ou
 * arrêtée en mer loin de toute route.
 */
function landUnitAtSea(state: EngineState, u: Unit, from: LngLat): boolean {
  const w = wi(state.world);
  if (w.nav.isLandCell(w.nav.cellAt(from))) return false;
  const leg = currentLeg(u, state.time);
  if (leg) return leg.medium === 'sea';
  return !w.roads?.snap(from, COAST_ROAD_KM);
}

/** Calcule le trajet d'une unité vers un point, à partir de sa position à l'instant courant. */
export function planUnitMove(state: EngineState, u: Unit, to: LngLat): UnitPlan {
  const sys = sysOf(state, u);
  if (sys.movement === 'static' || sys.speedKmh <= 0) return { error: 'not_allowed' };
  if (u.off || u.role) return { error: 'not_allowed' };
  const from = unitPosAt(state, u, state.time);
  if (sys.movement === 'air') {
    if (!airCanReach(state, u, to)) return { error: 'out_of_range' };
    return planAir(sys, from, to, state.time);
  }
  const w = wi(state.world);
  const memo = state.rt.planMemo as Map<string, SurfaceSegments>;
  if (sys.movement === 'land' && w.roads) {
    // Unités terrestres : réseau de routes (destination accrochée, traversées de port à port).
    const atSea = landUnitAtSea(state, u, from);
    const key = `R${atSea ? 1 : 0}|${sys.id}|${from[0]},${from[1]}|${to[0]},${to[1]}`;
    let r = memo.get(key);
    if (!r) {
      r = roadSegments(w.nav, w.roads, state.world.balance, sys, from, to, atSea);
      if (memo.size >= MEMO_MAX) memo.clear();
      memo.set(key, r);
    }
    if ('error' in r) return { error: r.error };
    const legs: Leg[] = [];
    let t = state.time;
    for (const s of r.segs) {
      legs.push({ from: s.from, to: s.to, t0: t, t1: t + s.dt, medium: s.medium });
      t += s.dt;
    }
    return { legs };
  }
  return planSurface(w.nav, state.world.balance, sys, from, to, state.time, memo);
}
