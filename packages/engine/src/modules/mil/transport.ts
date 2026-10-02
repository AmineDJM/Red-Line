import {
  HOUR,
  MINUTE,
  distanceKm,
  type CargoView,
  type LngLat,
  type NationId,
  type Order,
  type UnitId,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { clearTarget, destroyUnit } from '../../combat/combat.js';
import { otherOf, refreshUnitPairs, removeUnitPairs } from '../../encounters/pairs.js';
import { markNearCities, setMovement } from '../../movement/movement.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { atWar, sortedKeys, sysOf } from '../../state/access.js';
import { partsOf } from '../../state/stack.js';
import type { EngineState, Unit } from '../../state/types.js';
import { declareWar, hasPassage } from '../../state/war.js';
import { wi } from '../../state/world.js';
import { mil, milBal, type LandSt } from './state.js';
import { countLoss } from './stats.js';
import {
  OK,
  fail,
  failR,
  generic,
  noteLoc,
  placeOf,
  portsOf,
  posOf,
  provinceAt,
  resolveOwn,
  schedule,
} from './util.js';

/**
 * Transport naval de troupes : des navires dotés d'une capacité de transport (`payload.transport` du
 * catalogue : porte-hélicoptères d'assaut, navires amphibies) embarquent des piles terrestres dans un
 * port ami (ou depuis une côte, plus lentement), naviguent sur la grille navale, puis les débarquent
 * dans un port ou sur une côte (débarquement amphibie, contesté si l'ennemi est au contact : malus de
 * dégâts pendant quelques heures). Les troupes à bord sont hors carte (`off`) : invisibles de l'ennemi,
 * perdues si le navire est coulé. Les traversées automatiques de port à port des unités terrestres
 * (réseau de routes) restent inchangées.
 *
 * État (mil) : `tr` pile → navire, `trl` embarquements en cours, `tru` débarquements, `lnd` malus.
 * Événements : 'trLoad' (fin d'embarquement), 'trLand' (fin de mise à terre). Tout mouvement de la pile
 * ou du navire pendant l'opération l'annule (versions de trajet).
 */

export function trBal(state: EngineState) {
  return milBal(state).transport;
}

/** Capacité de transport d'un matériel (places par élément), 0 s'il ne transporte pas de troupes. */
export function transportPlaces(state: EngineState, s: WeaponSystem): number {
  if (s.movement !== 'sea') return 0;
  return (s.payload.transport ?? 0) * trBal(state).placesPerTransport;
}

/** Capacité totale d'un navire (places). */
export function capacityOf(state: EngineState, ship: Unit): number {
  let cap = 0;
  for (const p of partsOf(state, ship)) cap += p.c * transportPlaces(state, p.sys);
  return cap;
}

/** Places occupées par une pile terrestre. */
export function placesOf(state: EngineState, u: Unit): number {
  const b = trBal(state);
  let n = 0;
  for (const p of partsOf(state, u)) n += p.c * (b.places[p.sys.category] ?? b.defaultPlaces);
  return n;
}

/** Piles embarquées sur un navire (triées). */
export function cargoOf(state: EngineState, shipId: UnitId): UnitId[] {
  const tr = mil(state).tr;
  if (!tr) return [];
  return sortedKeys(tr).filter((id) => tr[id] === shipId);
}

/** Piles en cours d'embarquement sur un navire (triées). */
export function loadingOf(state: EngineState, shipId: UnitId): UnitId[] {
  const trl = mil(state).trl;
  if (!trl) return [];
  return sortedKeys(trl).filter((id) => trl[id]!.s === shipId);
}

/** Places occupées (à bord et en cours d'embarquement). */
export function usedPlaces(state: EngineState, shipId: UnitId): number {
  let n = 0;
  for (const id of [...cargoOf(state, shipId), ...loadingOf(state, shipId)]) {
    const u = state.units[id];
    if (u) n += placesOf(state, u);
  }
  return n;
}

/** La pile est-elle à bord d'un navire, ou en train d'embarquer ? */
export function inTransport(state: EngineState, id: UnitId): boolean {
  const m = mil(state);
  return !!m.tr?.[id] || !!m.trl?.[id];
}

/** Le navire transporte-t-il des troupes (à bord, en embarquement ou en débarquement) ? */
export function hasCargo(state: EngineState, shipId: UnitId): boolean {
  return cargoOf(state, shipId).length > 0 || loadingOf(state, shipId).length > 0;
}

function moving(state: EngineState, u: Unit): boolean {
  return !!u.move && u.move.legs[u.move.legs.length - 1]!.t1 > state.time;
}

/** Un port ami (nœud d'embarquement du réseau, ou province portuaire) à moins de portKm ? */
function nearFriendlyPort(state: EngineState, n: NationId, p: LngLat): boolean {
  const km = trBal(state).portKm;
  const w = wi(state.world);
  const roads = w.roads;
  if (roads) {
    const i = roads.nearestNode(
      p,
      km,
      (k) => !!roads.nodes[k]!.port && state.provinces[roads.nodes[k]!.province]?.owner === n,
    );
    if (i >= 0) return true;
  }
  for (const pid of portsOf(state, n)) {
    const spot = w.seaSpawn.get(pid);
    if (spot && distanceKm(spot, p) <= km) return true;
  }
  return false;
}

/** Durée d'un embarquement / débarquement : au port, sinon depuis la côte (plus lent). */
function opMs(state: EngineState, n: NationId, at: LngLat): number {
  const b = trBal(state);
  const port = nearFriendlyPort(state, n, at);
  return b.portMinutes * (port ? 1 : b.coastFactor) * MINUTE;
}

/** Point de mise à terre près de `p` (réseau de routes, sinon terre ferme), ou null. */
export function landingSpot(state: EngineState, p: LngLat): LngLat | null {
  const w = wi(state.world);
  const km = trBal(state).landingKm;
  if (w.roads) {
    const r = w.roads.snap(p, km);
    return r ? [r.pos[0], r.pos[1]] : null;
  }
  if (w.nav.isLandCell(w.nav.cellAt(p))) return p;
  let best: LngLat | null = null;
  let bd = Infinity;
  for (const pid of w.provIds) {
    const c = w.provById.get(pid)!.cityPoint;
    const d = distanceKm(c, p);
    if (d <= km && d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Point de mer navigable le plus proche d'un point côtier (anneaux de la grille H3), ou null. */
export function seaSpotNear(state: EngineState, p: LngLat): LngLat | null {
  const nav = wi(state.world).nav;
  const start = nav.node(nav.cellAt(p));
  if (nav.ship[start] === 1) return p;
  const rings = Math.ceil(trBal(state).landingKm / Math.max(1, nav.edgeKm)) + 1;
  let frontier = [start];
  const seen = new Set<number>([start]);
  let best = -1;
  let bd = Infinity;
  for (let r = 0; r < rings && frontier.length > 0; r++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const nb of nav.neighbors(id)) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
        if (nav.ship[nb] !== 1) continue;
        const d = distanceKm(nav.center(nb), p);
        if (d < bd || (d === bd && best >= 0 && nav.keyLess(nb, best))) {
          bd = d;
          best = nb;
        }
      }
    }
    if (best >= 0) break;
    frontier = next.sort((a, b) => a - b);
  }
  return best >= 0 ? nav.center(best) : null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Ordres                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

function shipFor(state: EngineState, n: NationId, id: string): Unit | OrderResult {
  const s = state.units[id];
  if (!s || s.role || s.off) return fail('unknown_unit', `Unité inconnue : ${id}`);
  if (s.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
  if (capacityOf(state, s) <= 0) {
    return failR(
      'invalid_target',
      'transport_not_ship',
      `${sysOf(state, s).name} ne peut pas transporter de troupes.`,
      { name: sysOf(state, s).name },
    );
  }
  return s;
}

/** Ordre `embark` : des piles terrestres proches embarquent sur un navire de transport ami. */
export function orderEmbark(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'embark' }>,
): OrderResult {
  const ship = shipFor(state, n, o.transportId);
  if (!('id' in ship)) return ship;
  const units = resolveOwn(state, n, o.unitIds);
  if (!Array.isArray(units)) return units;
  const m = mil(state);
  const b = trBal(state);
  if (moving(state, ship))
    return failR('not_allowed', 'transport_moving', 'Le navire doit être à l’arrêt.');
  const at = posOf(state, ship);
  let need = 0;
  for (const u of units) {
    const s = sysOf(state, u);
    if (s.movement !== 'land' || s.speedKmh <= 0 || m.fixedOf[u.id]) {
      return failR(
        'not_allowed',
        'transport_not_land',
        `${s.name} : seules les troupes au sol embarquent.`,
        { name: s.name },
      );
    }
    if (inTransport(state, u.id))
      return failR('not_allowed', 'transport_busy', `${s.name} : déjà en transport.`, {
        name: s.name,
      });
    const d = distanceKm(posOf(state, u), at);
    if (d > b.embarkKm) {
      return failR(
        'out_of_range',
        'transport_too_far',
        `${s.name} : trop loin du navire (${Math.round(d)} km, ${Math.round(b.embarkKm)} km au plus).`,
        { name: s.name, dist: Math.round(d), max: Math.round(b.embarkKm) },
      );
    }
    need += placesOf(state, u);
  }
  const cap = capacityOf(state, ship);
  const free = cap - usedPlaces(state, ship.id);
  if (need > free) {
    return failR(
      'capacity',
      'transport_capacity',
      `Capacité dépassée : ${Math.ceil(need)} places requises, ${Math.floor(free)} libres sur ${Math.floor(cap)}. Scindez la pile.`,
      { need: Math.ceil(need), free: Math.floor(Math.max(0, free)), cap: Math.floor(cap) },
    );
  }
  const done = state.time + opMs(state, n, at);
  m.trl ??= {};
  for (const u of units) {
    if (u.target) clearTarget(state, u);
    if (u.move) setMovement(state, u, null);
    m.trl[u.id] = { s: ship.id, at: done, umv: u.mv, smv: ship.mv };
    schedule(state, done, 'trLoad', { u: u.id });
  }
  return OK;
}

/** Ordre `disembark` : sur place (côte ou port proche), ou après une traversée vers `to`. */
export function orderDisembark(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'disembark' }>,
): OrderResult {
  const ship = shipFor(state, n, o.transportId);
  if (!('id' in ship)) return ship;
  const aboard = cargoOf(state, ship.id);
  const ids = o.unitIds
    ? [...new Set(o.unitIds)].sort().filter((id) => aboard.includes(id))
    : aboard;
  if (ids.length === 0 || (o.unitIds && ids.length !== new Set(o.unitIds).size)) {
    return failR('invalid_target', 'transport_empty', 'Aucune de ces troupes n’est à bord.');
  }
  const m = mil(state);
  if (!o.to) {
    if (moving(state, ship))
      return failR('not_allowed', 'transport_moving', 'Le navire doit être à l’arrêt.');
    const spot = landingSpot(state, posOf(state, ship));
    if (!spot) return noShore(state);
    m.tru ??= {};
    delete m.tru[ship.id];
    startLanding(state, ship, { to: spot, ids, at: null, mv: ship.mv });
    return OK;
  }
  const spot = landingSpot(state, o.to);
  if (!spot) return noShore(state);
  const sea = seaSpotNear(state, spot);
  if (!sea || distanceKm(sea, spot) > trBal(state).landingKm) return noShore(state);
  const plan = planUnitMove(state, ship, sea);
  if ('error' in plan) return fail(plan.error, 'Destination inaccessible.');
  if (ship.target) clearTarget(state, ship);
  const ms = m.ms[ship.id];
  if (ms && ms.mis !== 'none') {
    ms.mis = 'none';
    ms.ph = null;
    ms.at = null;
    ms.sv++;
  }
  setMovement(state, ship, plan.legs.length > 0 ? plan.legs : null);
  m.tru ??= {};
  const st: LandSt = { to: spot, ids, at: null, mv: ship.mv };
  m.tru[ship.id] = st;
  if (!ship.move) startLanding(state, ship, st);
  return OK;
}

function noShore(state: EngineState): OrderResult {
  void state;
  return failR(
    'unreachable',
    'transport_no_shore',
    'Aucune côte praticable à proximité : approchez le navire d’un port ou d’une route côtière.',
  );
}

/** Mise à terre : le navire, à l'arrêt, débarque ses troupes au bout du délai. */
function startLanding(state: EngineState, ship: Unit, st: LandSt): void {
  const m = mil(state);
  st.at = state.time + opMs(state, ship.owner, st.to);
  st.mv = ship.mv;
  m.tru ??= {};
  m.tru[ship.id] = st;
  schedule(state, st.at, 'trLand', { s: ship.id, mv: ship.mv });
}

/* ------------------------------------------------------------------------------------------------ */
/* Événements et crochets                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export function handleLoad(state: EngineState, d: { u: string }): void {
  const m = mil(state);
  const st = m.trl?.[d.u];
  if (!st || st.at !== state.time) return;
  delete m.trl![d.u];
  const u = state.units[d.u];
  const ship = state.units[st.s];
  if (!u || !ship || u.mv !== st.umv || ship.mv !== st.smv || u.move || u.off) return;
  if (distanceKm(posOf(state, u), posOf(state, ship)) > trBal(state).embarkKm) return;
  if (u.target) clearTarget(state, u);
  u.pos = posOf(state, ship);
  u.off = true;
  u.engaged = false;
  u.cv++;
  markNearCities(state, u);
  removeUnitPairs(state, u.id);
  state.rt.geom.delete(u.id);
  state.rt.dirtyCombat.delete(u.id);
  m.tr ??= {};
  m.tr[u.id] = ship.id;
  generic(
    state,
    [u.owner],
    'transport',
    'Troupes embarquées',
    `${sysOf(state, u).name} à bord de ${sysOf(state, ship).name}.`,
    'info',
    u.pos,
    noteLoc('troopsEmbarked', { system: { system: u.sys }, ship: { system: ship.sys } }),
  );
}

export function handleLand(state: EngineState, d: { s: string; mv: number }): void {
  const m = mil(state);
  const st = m.tru?.[d.s];
  const ship = state.units[d.s];
  if (!st || !ship || st.at !== state.time || ship.mv !== d.mv || st.mv !== ship.mv) return;
  delete m.tru![d.s];
  if (moving(state, ship)) return;
  const b = trBal(state);
  const spot = st.to;
  const pid = provinceAt(state, spot);
  const landed: Unit[] = [];
  for (const id of st.ids) {
    const u = state.units[id];
    if (!u || m.tr?.[id] !== ship.id) continue;
    delete m.tr![id];
    u.off = false;
    u.pos = [spot[0], spot[1]];
    state.rt.geom.delete(u.id);
    refreshUnitPairs(state, u);
    markNearCities(state, u);
    state.rt.dirtyCombat.add(u.id);
    landed.push(u);
  }
  if (landed.length === 0) return;
  const n = ship.owner;
  // Mise à terre en territoire étranger : même règle qu'une entrée par la route.
  const owner = pid ? state.provinces[pid]?.owner : undefined;
  if (owner && owner !== n && !atWar(state, n, owner) && !hasPassage(state, n, owner)) {
    declareWar(state, n, owner);
  }
  // Débarquement contesté : ennemi terrestre au contact du point de mise à terre.
  const gc = state.world.balance.combat.groundContactKm;
  let contested = false;
  for (const u of landed) {
    for (const key of [...(state.rt.pairsOf.get(u.id) ?? [])].sort()) {
      if (key.includes('#')) continue;
      const pair = state.pairs[key];
      const o = state.units[otherOf(key, u.id)];
      if (!pair || !o || o.off || pair.d > gc) continue;
      if (sysOf(state, o).movement === 'land' && atWar(state, n, o.owner)) contested = true;
    }
  }
  if (contested && b.landingPenalty > 0 && b.landingPenaltyHours > 0) {
    m.lnd ??= {};
    for (const u of landed) m.lnd[u.id] = state.time + b.landingPenaltyHours * HOUR;
  }
  generic(
    state,
    [n],
    'transport',
    contested ? 'Débarquement sous le feu' : 'Troupes débarquées',
    `${landed.length} pile(s) mise(s) à terre.`,
    contested ? 'warn' : 'info',
    spot,
    noteLoc(contested ? 'troopsLandedContested' : 'troopsLanded', {
      count: landed.length,
      place: placeOf(pid),
    }),
  );
}

/** Malus de dégâts d'une pile débarquée sous le feu (crochet unitModifier). */
export function landingModifier(state: EngineState, u: Unit, key: string): number {
  if (key !== 'combat.damage') return 1;
  const until = mil(state).lnd?.[u.id];
  if (until === undefined) return 1;
  if (until <= state.time) {
    delete mil(state).lnd![u.id];
    return 1;
  }
  return 1 - Math.min(1, trBal(state).landingPenalty);
}

/** Crochet : changement de trajet (pile en embarquement, navire qui embarque ou débarque). */
export function transportMoved(state: EngineState, u: Unit): void {
  const m = mil(state);
  if (m.trl) {
    const st = m.trl[u.id];
    if (st && st.umv !== u.mv) delete m.trl[u.id];
    for (const id of sortedKeys(m.trl)) {
      const x = m.trl[id]!;
      if (x.s === u.id && x.smv !== u.mv) delete m.trl[id];
    }
  }
  const land = m.tru?.[u.id];
  if (land && land.mv !== u.mv) delete m.tru![u.id];
}

/** Crochet : arrivée d'un navire qui doit débarquer ses troupes. */
export function transportArrived(state: EngineState, u: Unit): void {
  const st = mil(state).tru?.[u.id];
  if (st && st.at === null && st.mv === u.mv) startLanding(state, u, st);
}

/** Crochet : unité disparue (pile transportée, navire coulé : troupes à bord perdues). */
export function transportGone(state: EngineState, u: Unit): void {
  const m = mil(state);
  if (m.tr?.[u.id]) delete m.tr[u.id];
  if (m.trl?.[u.id]) delete m.trl[u.id];
  if (m.lnd?.[u.id]) delete m.lnd[u.id];
  if (m.tru?.[u.id]) delete m.tru[u.id];
  if (m.trl) for (const id of sortedKeys(m.trl)) if (m.trl[id]!.s === u.id) delete m.trl[id];
  const lost = cargoOf(state, u.id);
  if (lost.length === 0) return;
  const at = posOf(state, u);
  for (const id of lost) {
    delete m.tr![id];
    const a = state.units[id];
    if (!a) continue;
    a.pos = at;
    countLoss(state, a, a.count, null);
    destroyUnit(state, a, null);
  }
  generic(
    state,
    [u.owner],
    'transport',
    'Transport coulé',
    `${sysOf(state, u).name} perdu avec ${lost.length} pile(s) à bord.`,
    'critical',
    at,
    noteLoc('transportSunk', { system: { system: u.sys }, count: lost.length }),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Vue                                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export function cargoView(state: EngineState, ship: Unit): CargoView | undefined {
  const cap = capacityOf(state, ship);
  if (cap <= 0) return undefined;
  const unitIds = cargoOf(state, ship.id);
  const loadingIds = loadingOf(state, ship.id);
  const v: CargoView = {
    capacity: Math.floor(cap),
    used: Math.ceil(usedPlaces(state, ship.id)),
    unitIds,
  };
  if (loadingIds.length) v.loadingIds = loadingIds;
  const st = mil(state).tru?.[ship.id];
  if (st) v.landing = { at: st.to, doneAt: st.at };
  return v;
}

/** Ordre `move` d'une pile à bord : refus motivé (le navire la débarque). */
export function embarkedMove(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'move' }>,
): OrderResult | null {
  const tr = mil(state).tr;
  if (!tr) return null;
  for (const id of o.unitIds) {
    const u = state.units[id];
    if (u && u.owner === n && tr[id]) {
      return failR(
        'not_allowed',
        'transport_embarked',
        `${sysOf(state, u).name} : troupes à bord, utilisez « Débarquer » sur le navire.`,
        { name: sysOf(state, u).name },
      );
    }
  }
  return null;
}

/** Ordres refusés aux piles en transport et aux navires chargés (scission, fusion). */
export function transportRefusal(state: EngineState, units: Unit[]): OrderResult | null {
  for (const u of units) {
    if (inTransport(state, u.id) || hasCargo(state, u.id) || mil(state).tru?.[u.id]) {
      return failR(
        'not_allowed',
        'transport_embarked',
        `${sysOf(state, u).name} : troupes en transport (débarquez-les d’abord).`,
        { name: sysOf(state, u).name },
      );
    }
  }
  return null;
}
