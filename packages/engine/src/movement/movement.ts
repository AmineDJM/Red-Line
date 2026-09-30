import {
  distanceKm,
  interpolate,
  MINUTE,
  type Leg,
  type LngLat,
  type ProvinceId,
} from '@redline/shared';
import { atWar, notify, schedule, sortedSet, sysOf, unitPosAt } from '../state/access.js';
import type { Crossing, EngineState, Unit } from '../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../state/world.js';
import { refreshUnitPairs, registerUnit } from '../encounters/pairs.js';
import { declareWar, hasPassage } from '../state/war.js';
import { requestChase } from '../combat/combat.js';
import type { GameEvent } from '../queue/events.js';
import { callHook } from '../modules/registry.js';
import { board } from '../modules/kit.js';

/**
 * Change le trajet d'une unité à l'instant courant (null = arrêt sur place). Invalide tous ses
 * événements de mouvement (version `mv`), reprogramme fin de segment, frontières et arrivée, et
 * recalcule uniquement les paires de cette unité.
 */
export function setMovement(
  state: EngineState,
  u: Unit,
  legs: Leg[] | null,
  opts: { chasing?: boolean } = {},
): void {
  const t = state.time;
  u.pos = unitPosAt(state, u, t);
  u.move = legs && legs.length > 0 ? { legs } : null;
  u.mv++;
  u.leg = 0;
  u.cross = null;
  u.chasing = !!opts.chasing && u.move !== null;
  state.rt.geom.delete(u.id);
  if (u.move) {
    const ls = u.move.legs;
    if (ls.length > 1) schedule(state, { k: 'leg', t: ls[0]!.t1, u: u.id, v: u.mv, i: 0 });
    schedule(state, { k: 'arr', t: ls[ls.length - 1]!.t1, u: u.id, v: u.mv });
    // Les missiles en vol ne déclarent pas de guerre en survolant un territoire.
    if (sysOf(state, u).movement !== 'sea' && u.role !== 'missile') {
      const cross = computeCrossings(state, u.pos, ls);
      if (cross.length > 0) {
        u.cross = cross;
        schedule(state, { k: 'terr', t: cross[0]!.t, u: u.id, v: u.mv, i: 0 });
      }
    }
  }
  refreshUnitPairs(state, u);
  // Les poursuivants de cette unité recalculent leur trajet (avec un délai pour éviter les boucles).
  const delay = state.world.balance.time.combatRoundMinutes * MINUTE;
  for (const c of sortedSet(state.rt.chasers.get(u.id))) requestChase(state, c, delay);
  markNearCities(state, u);
  state.rt.dirtyCombat.add(u.id);
  callHook('onMovementChanged', state, u);
}

/** Les villes proches de l'unité réévaluent leur capture (arrêt / départ d'un capteur). */
export function markNearCities(state: EngineState, u: Unit): void {
  for (const key of sortedSet(state.rt.pairsOf.get(u.id))) {
    if (!key.includes('#')) continue;
    const pair = state.pairs[key];
    if (!pair || pair.d > Math.max(CAPTURE_RADIUS_KM, state.world.balance.combat.groundContactKm))
      continue;
    state.rt.dirtyCapture.add(key.slice(0, key.indexOf('#')));
  }
}

export function handleLegEnd(state: EngineState, ev: Extract<GameEvent, { k: 'leg' }>): void {
  const u = state.units[ev.u]!;
  const legs = u.move?.legs;
  if (!legs) return;
  u.leg = ev.i + 1;
  if (ev.i + 1 < legs.length - 1) {
    schedule(state, { k: 'leg', t: legs[ev.i + 1]!.t1, u: u.id, v: u.mv, i: ev.i + 1 });
  }
}

export function handleArrival(state: EngineState, ev: Extract<GameEvent, { k: 'arr' }>): void {
  const u = state.units[ev.u]!;
  const legs = u.move?.legs;
  if (!legs) return;
  const dest = legs[legs.length - 1]!.to;
  u.pos = dest;
  u.move = null;
  u.leg = 0;
  u.cross = null;
  u.chasing = false;
  state.rt.geom.delete(u.id);
  // Même géométrie qu'avant (point final) : on réduit seulement le balayage indexé.
  registerUnit(state, u);
  if (!u.role) {
    notify(state, { kind: 'arrived', time: state.time, at: dest, unitId: u.id }, [u.owner]);
  }
  markNearCities(state, u);
  state.rt.dirtyCombat.add(u.id);
  callHook('onArrived', state, u);
}

export function handleTerritory(state: EngineState, ev: Extract<GameEvent, { k: 'terr' }>): void {
  const u = state.units[ev.u]!;
  const c = u.cross?.[ev.i];
  if (!c) return;
  // Les porteurs non combattants (convois, cargos des livraisons) ne déclarent pas la guerre.
  if (c.p && sysOf(state, u).category !== 'logistics') {
    const P = state.provinces[c.p];
    if (
      P &&
      P.owner !== u.owner &&
      !atWar(state, u.owner, P.owner) &&
      !hasPassage(state, u.owner, P.owner)
    ) {
      declareWar(state, u.owner, P.owner);
    }
    // Entrée dans une zone d'exclusion aérienne : le propriétaire peut engager l'aéronef.
    if (P && board(state).noFly[c.p]) {
      state.rt.dirtyCombat.add(u.id);
      for (const key of sortedSet(state.rt.pairsOf.get(u.id))) {
        if (key.includes('#')) continue;
        const [a, b] = key.split('|') as [string, string];
        state.rt.dirtyCombat.add(a === u.id ? b : a);
      }
    }
  }
  const next = u.cross![ev.i + 1];
  if (next) schedule(state, { k: 'terr', t: next.t, u: u.id, v: u.mv, i: ev.i + 1 });
}

/** Passages de frontières de provinces le long d'un trajet (échantillonnage puis dichotomie). */
export function computeCrossings(state: EngineState, start: LngLat, legs: Leg[]): Crossing[] {
  const nav = wi(state.world).nav;
  const provAt = (p: LngLat): ProvinceId | '' => nav.cellProv.get(nav.cellAt(p)) ?? '';
  const step = nav.edgeKm * 0.5;
  const out: Crossing[] = [];
  let prev = provAt(start);
  // Un trajet qui commence en territoire étranger compte comme une entrée (unité posée ou arrêtée là).
  if (prev && legs.length > 0) out.push({ t: legs[0]!.t0, p: prev });
  for (const leg of legs) {
    const d = distanceKm(leg.from, leg.to);
    if (d < 1e-6 || leg.t1 <= leg.t0) continue;
    const n = Math.max(1, Math.ceil(d / step));
    const at = (t: number): LngLat =>
      interpolate(leg.from, leg.to, (t - leg.t0) / (leg.t1 - leg.t0));
    let tPrev = leg.t0;
    for (let k = 1; k <= n; k++) {
      const tk = leg.t0 + ((leg.t1 - leg.t0) * k) / n;
      const pk = provAt(at(tk));
      if (pk !== prev) {
        // Dichotomie jusqu'à 1 s de jeu sur « encore dans la province précédente ».
        let lo = tPrev;
        let hi = tk;
        const was = prev;
        while (hi - lo > 1000) {
          const mid = (lo + hi) / 2;
          if (provAt(at(mid)) === was) lo = mid;
          else hi = mid;
        }
        const ph = provAt(at(hi));
        out.push({ t: hi, p: ph });
        prev = ph;
        if (ph !== pk) {
          out.push({ t: tk, p: pk });
          prev = pk;
        }
      }
      tPrev = tk;
    }
  }
  return out;
}
