import {
  distanceKm,
  type Leg,
  type LngLat,
  type NationId,
  type OrderErrorCode,
} from '@redline/shared';
import { planAir, planSurface, type SurfaceSegments } from '../nav/plan.js';
import { provincesOf, sysOf, unitPosAt } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { wi } from '../state/world.js';

export type UnitPlan = { legs: Leg[] } | { error: OrderErrorCode };

/** Distance du point à la ville possédée la plus proche (km), Infinity si aucune. */
export function nearestOwnedCityKm(state: EngineState, n: NationId, p: LngLat): number {
  let best = Infinity;
  const w = wi(state.world);
  for (const pid of provincesOf(state, n)) {
    const d = distanceKm(w.provById.get(pid)!.cityPoint, p);
    if (d < best) best = d;
  }
  return best;
}

/** Vrai si un aéronef de la nation peut atteindre ce point (rayon d'action autour d'une ville possédée). */
export function airCanReach(state: EngineState, u: Unit, to: LngLat): boolean {
  const r = sysOf(state, u).operationalRadiusKm;
  if (r === null) return true;
  return nearestOwnedCityKm(state, u.owner, to) <= r;
}

/** Calcule le trajet d'une unité vers un point, à partir de sa position à l'instant courant. */
export function planUnitMove(state: EngineState, u: Unit, to: LngLat): UnitPlan {
  const sys = sysOf(state, u);
  if (sys.movement === 'static' || sys.speedKmh <= 0) return { error: 'not_allowed' };
  const from = unitPosAt(state, u, state.time);
  if (sys.movement === 'air') {
    if (!airCanReach(state, u, to)) return { error: 'out_of_range' };
    return planAir(sys, from, to, state.time);
  }
  return planSurface(
    wi(state.world).nav,
    state.world.balance,
    sys,
    from,
    to,
    state.time,
    state.rt.planMemo as Map<string, SurfaceSegments>,
  );
}
