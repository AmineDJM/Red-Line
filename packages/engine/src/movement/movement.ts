import { distanceKm, MINUTE, type Leg, type LngLat, type ProvinceId } from '@redline/shared';
import { atWar, notify, schedule, sortedSet, sysOf, unitPosAt } from '../state/access.js';
import type { Crossing, EngineState, Unit } from '../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../state/world.js';
import { refreshUnitPairs, registerUnit } from '../encounters/pairs.js';
import { declareWar, hasPassage } from '../state/war.js';
import { requestChase } from '../combat/combat.js';
import type { GameEvent } from '../queue/events.js';
import { callHook } from '../modules/registry.js';
import { board } from '../modules/kit.js';
import { interpolator } from '../geo/sphere.js';

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
  // Ajouts à un ensemble retraité dans l'ordre trié par settle : pas de tri ici.
  for (const key of state.rt.pairsOf.get(u.id) ?? []) {
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

/**
 * Cache des derniers calculs de passages (clé : contenu exact du départ et des segments). L'IA calcule
 * le trajet d'une unité pour vérifier qu'il ne viole pas un neutre, puis donne l'ordre : le moteur
 * recalculait alors exactement les mêmes passages. Résultat identique bit à bit (fonction pure du
 * monde et des nombres de la clé) ; une copie est rendue (le tableau est rangé dans l'état).
 */
const crossCache = new WeakMap<object, Map<string, Crossing[]>>();
const CROSS_CACHE_MAX = 256;

function crossKey(start: LngLat, legs: Leg[]): string {
  let k = `${start[0]},${start[1]}`;
  for (const l of legs) {
    k += `|${l.from[0]},${l.from[1]},${l.to[0]},${l.to[1]},${l.t0},${l.t1}`;
  }
  return k;
}

/** Passages de frontières de provinces le long d'un trajet (échantillonnage puis dichotomie). */
export function computeCrossings(state: EngineState, start: LngLat, legs: Leg[]): Crossing[] {
  const nav = wi(state.world).nav;
  let cache = crossCache.get(nav);
  if (!cache) crossCache.set(nav, (cache = new Map()));
  const key = crossKey(start, legs);
  let out = cache.get(key);
  if (!out) {
    out = crossingsOf(state, start, legs)!;
    if (cache.size >= CROSS_CACHE_MAX) cache.clear();
    cache.set(key, out);
  }
  return out.map((c) => ({ t: c.t, p: c.p }));
}

/**
 * Le trajet entre-t-il dans une province pour laquelle `hit` est vrai ? Mêmes passages que
 * computeCrossings, mais arrêt au premier passage concerné ; un calcul complet est mis en cache (l'ordre
 * qui suit souvent cette vérification le réutilise).
 */
export function crossingHits(
  state: EngineState,
  start: LngLat,
  legs: Leg[],
  hit: (p: ProvinceId) => boolean,
): boolean {
  const nav = wi(state.world).nav;
  let cache = crossCache.get(nav);
  if (!cache) crossCache.set(nav, (cache = new Map()));
  const key = crossKey(start, legs);
  const done = cache.get(key);
  if (done) return done.some((c) => !!c.p && hit(c.p));
  let found = false;
  const out = crossingsOf(state, start, legs, (c) => (found = !!c.p && hit(c.p)));
  if (out) {
    if (cache.size >= CROSS_CACHE_MAX) cache.clear();
    cache.set(key, out);
  }
  return found;
}

function crossingsOf(
  state: EngineState,
  start: LngLat,
  legs: Leg[],
  stop?: (c: Crossing) => boolean,
): Crossing[] | null {
  const nav = wi(state.world).nav;
  const provAt = (p: LngLat): ProvinceId | '' => nav.cellProv.get(nav.cellAt(p)) ?? '';
  const step = nav.edgeKm * 0.5;
  const out: Crossing[] = [];
  const push = (c: Crossing): boolean => {
    out.push(c);
    return !!stop && stop(c);
  };
  let prev = provAt(start);
  // Un trajet qui commence en territoire étranger compte comme une entrée (unité posée ou arrêtée là).
  if (prev && legs.length > 0 && push({ t: legs[0]!.t0, p: prev })) return null;
  for (const leg of legs) {
    const d = distanceKm(leg.from, leg.to);
    if (d < 1e-6 || leg.t1 <= leg.t0) continue;
    const n = Math.max(1, Math.ceil(d / step));
    const along = interpolator(leg.from, leg.to);
    const at = (t: number): LngLat => along((t - leg.t0) / (leg.t1 - leg.t0));
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
        if (push({ t: hi, p: ph })) return null;
        prev = ph;
        if (ph !== pk) {
          if (push({ t: tk, p: pk })) return null;
          prev = pk;
        }
      }
      tPrev = tk;
    }
  }
  return out;
}
