import {
  distanceKm,
  HOUR,
  type Leg,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
  type TradeItem,
  type UnitId,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { notify, provincesOf, sortedSet, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { destroyUnit } from '../../combat/combat.js';
import { setMovement } from '../../movement/movement.js';
import { planAir, planSurface, type SurfaceSegments } from '../../nav/plan.js';
import { nextFloat } from '../../rng/rng.js';
import { scheduleMod } from '../kit.js';
import { canImport, signal } from '../registry.js';
import { cfg } from './config.js';
import { queueBlackMarket } from './production.js';
import { hasGate } from './research.js';
import { eco, ecoNation, nextId, sortedIds, type Delivery } from './state.js';
import { book, canPay, eraOk, fail, isNuclear, pay } from './util.js';

/** Porteurs génériques des livraisons (catégorie logistics), s'ils sont au catalogue. */
export const CARRIERS = {
  land: 'other.supply-convoy',
  sea: 'other.cargo-ship',
  air: 'other.cargo-aircraft',
} as const;

// ——— Utilitaires ———

function capitalOf(state: EngineState, n: NationId): ProvinceId | null {
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  if (cap && state.provinces[cap]?.owner === n) return cap;
  return provincesOf(state, n)[0] ?? null;
}

/** Unités d'un système possédées par une nation (hors porteurs en mission), triées. */
function unitsOfSystem(state: EngineState, n: NationId, systemId: string): Unit[] {
  const carriers = new Set<string>();
  const es = eco(state);
  for (const id of sortedIds(es.dlv)) {
    const c = es.dlv[id]!.carrier;
    if (c) carriers.add(c);
  }
  const out: Unit[] = [];
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[id];
    if (u && u.sys === systemId && !carriers.has(id)) out.push(u);
  }
  return out;
}

function ownedCount(state: EngineState, n: NationId, systemId: string): number {
  return unitsOfSystem(state, n, systemId).reduce((a, u) => a + u.count, 0);
}

/** Retire `count` éléments des piles d'une nation (piles vidées supprimées, sans destruction). */
function takeUnits(state: EngineState, n: NationId, systemId: string, count: number): boolean {
  const list = unitsOfSystem(state, n, systemId);
  if (list.reduce((a, u) => a + u.count, 0) < count) return false;
  let left = count;
  for (const u of list) {
    if (left <= 0) break;
    if (u.count <= left) {
      left -= u.count;
      destroyUnit(state, u, null, { quiet: true });
    } else {
      const per = u.hp / u.count;
      const sys = sysOf(state, u);
      u.count -= left;
      u.hp = Math.max(1e-9, u.hp - per * left);
      u.maxHp = u.count * sys.hp;
      left = 0;
      state.rt.dirtyCombat.add(u.id);
    }
  }
  return true;
}

/** Le vendeur peut-il céder une licence (licence détenue ou recherche maîtrisée) ? */
function canCedeLicence(state: EngineState, n: NationId, sys: WeaponSystem): boolean {
  if (!sys.licensable || isNuclear(sys)) return false;
  if (ecoNation(state, n).licences[sys.id] !== undefined) return true;
  return sys.requires.length > 0 && sys.requires.every((r) => hasGate(state, n, r));
}

/**
 * Vérifie et prélève l'objet chez le cédant (argent et ressources : immédiatement ; unités : au
 * moment de l'expédition ; licence : rien à prélever).
 */
function checkItem(state: EngineState, n: NationId, item: TradeItem): OrderResult | null {
  const ns = state.nations[n]!;
  switch (item.type) {
    case 'money':
      return ns.money >= item.amount ? null : fail('insufficient_funds');
    case 'resource':
      return ns.res[item.resource] >= item.qty ? null : fail('insufficient_resources');
    case 'units': {
      const sys = state.world.catalog.get(item.systemId);
      if (!sys) return fail('invalid_target', 'Système inconnu.');
      if (isNuclear(sys)) return fail('not_allowed', 'Armes nucléaires non cessibles.');
      return ownedCount(state, n, item.systemId) >= item.count
        ? null
        : fail('capacity', 'Unités insuffisantes.');
    }
    case 'licence': {
      const sys = state.world.catalog.get(item.systemId);
      if (!sys) return fail('invalid_target', 'Système inconnu.');
      return canCedeLicence(state, n, sys) ? null : fail('not_allowed', 'Licence non cessible.');
    }
  }
}

function escrow(state: EngineState, n: NationId, item: TradeItem, sign: 1 | -1): void {
  const ns = state.nations[n];
  if (!ns) return;
  if (item.type === 'money') ns.money -= sign * item.amount;
  else if (item.type === 'resource') ns.res[item.resource] -= sign * item.qty;
}

function embargoFor(state: EngineState, to: NationId, item: TradeItem): OrderResult | null {
  if (item.type !== 'units' && item.type !== 'licence') return null;
  const e = canImport(state, to, item.systemId);
  return e ? fail(e, 'Embargo sur les armes.') : null;
}

// ——— Marché entre joueurs ———

export function sellOfferOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'sellOffer' }>,
): OrderResult {
  const to = order.to ?? null;
  if (to !== null && (to === n || !state.nations[to])) return fail('invalid_target');
  const bad = checkItem(state, n, order.item);
  if (bad) return bad;
  escrow(state, n, order.item, 1);
  const es = eco(state);
  const id = nextId(state, 'o');
  const expiresAt = state.time + cfg(state.world).industry.offerHours * HOUR;
  es.offers[id] = {
    id,
    seller: n,
    item: order.item,
    price: order.price,
    to,
    createdAt: state.time,
    expiresAt,
  };
  scheduleMod(state, { t: expiresAt, m: 'eco', e: 'offer', d: { id } });
  return { ok: true };
}

export function onOfferExpired(state: EngineState, d: { id: string }): void {
  const es = eco(state);
  const o = es.offers[d.id];
  if (!o || o.expiresAt > state.time) return;
  escrow(state, o.seller, o.item, -1);
  delete es.offers[d.id];
}

export function cancelOfferOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'cancelOffer' }>,
): OrderResult {
  const es = eco(state);
  const o = es.offers[order.offerId];
  if (!o) return fail('invalid_target', 'Offre inconnue.');
  if (o.seller !== n) return fail('not_owner', 'Cette offre ne vous appartient pas.');
  escrow(state, n, o.item, -1);
  delete es.offers[order.offerId];
  return { ok: true };
}

export function acceptOfferOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'acceptOffer' }>,
): OrderResult {
  const es = eco(state);
  const o = es.offers[order.offerId];
  if (!o) return fail('invalid_target', 'Offre inconnue.');
  if (o.seller === n) return fail('not_allowed');
  if (o.to !== null && o.to !== n) return fail('not_allowed', 'Offre réservée.');
  if (!state.nations[o.seller]?.alive) return fail('not_allowed');
  const emb = embargoFor(state, n, o.item);
  if (emb) return emb;
  const err = canPay(state, n, { money: o.price, res: {} });
  if (err) return fail(err);
  if (o.item.type === 'units' || o.item.type === 'licence') {
    const bad = checkItem(state, o.seller, o.item);
    if (bad) return bad;
  }
  if (o.item.type === 'units' && !takeUnits(state, o.seller, o.item.systemId, o.item.count))
    return fail('capacity');
  pay(state, n, { money: o.price, res: {} }, 'marketPurchases');
  state.nations[o.seller]!.money += o.price;
  book(state, o.seller, 'marketSales', o.price);
  delete es.offers[o.id];
  deliver(state, o.seller, n, o.item, false);
  return { ok: true };
}

export function transferOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'transfer' }>,
): OrderResult {
  const to = order.to;
  if (to === n || !state.nations[to]?.alive) return fail('invalid_target');
  const bad = checkItem(state, n, order.item);
  if (bad) return bad;
  if (!order.covert) {
    const emb = embargoFor(state, to, order.item);
    if (emb) return emb;
  }
  if (order.item.type === 'units' && !takeUnits(state, n, order.item.systemId, order.item.count))
    return fail('capacity');
  escrow(state, n, order.item, 1);
  if (order.item.type === 'money') book(state, n, 'transfersOut', -order.item.amount);
  deliver(state, n, to, order.item, order.covert);
  return { ok: true };
}

export function blackMarketOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'blackMarket' }>,
): OrderResult {
  const sys = state.world.catalog.get(order.systemId);
  if (!sys || !sys.enabled) return fail('invalid_target', 'Système inconnu.');
  if (isNuclear(sys)) return fail('not_allowed', 'Introuvable, même au marché noir.');
  if (!eraOk(sys, eco(state).year)) return fail('not_allowed');
  const w = wi(state.world);
  let pid = capitalOf(state, n);
  if (sys.movement === 'sea') pid = provincesOf(state, n).find((p) => w.seaSpawn.get(p)) ?? null;
  if (!pid) return fail('not_allowed', 'Aucune province de livraison.');
  const count = order.count ?? 1;
  const paid = {
    money: sys.cost.money * count * cfg(state.world).blackMarket.priceFactor,
    res: {},
  };
  const err = canPay(state, n, paid);
  if (err) return fail(err);
  pay(state, n, paid, 'blackMarket');
  queueBlackMarket(state, n, pid, sys, count, paid);
  if (nextFloat(state.rng) < cfg(state.world).blackMarket.detectionChance)
    signal(state, 'black_market_detected', { buyer: n, systemId: sys.id });
  return { ok: true };
}

// ——— Livraisons ———

interface Route {
  sysId: string;
  from: LngLat;
  legs: Leg[];
}

/** Itinéraire d'un porteur : convoi terrestre, sinon cargo par mer, sinon avion cargo. */
function planRoute(
  state: EngineState,
  from: NationId,
  dest: ProvinceId,
  item: TradeItem,
): Route | null {
  const w = wi(state.world);
  const es = eco(state);
  const destPt = w.provById.get(dest)!.cityPoint;
  const origins = provincesOf(state, from)
    .map((p) => ({ p, d: distanceKm(w.provById.get(p)!.cityPoint, destPt) }))
    .sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : 1));
  if (origins.length === 0) return null;
  const memo = state.rt.planMemo as Map<string, SurfaceSegments>;
  const t = state.time;
  const itemSys =
    item.type === 'units'
      ? state.world.catalog.get(item.systemId)
      : (undefined as WeaponSystem | undefined);
  const land = state.world.catalog.get(CARRIERS.land);
  if (land && itemSys?.movement !== 'sea') {
    const o = origins[0]!.p;
    const from0 = w.provById.get(o)!.cityPoint;
    const plan = planSurface(w.nav, state.world.balance, land, from0, destPt, t, memo);
    if (!('error' in plan) && plan.legs.length > 0 && plan.legs.every((l) => l.medium === 'land'))
      return { sysId: land.id, from: from0, legs: plan.legs };
  }
  const ship = state.world.catalog.get(CARRIERS.sea);
  if (ship) {
    const oPort = origins.find((o) => w.seaSpawn.get(o.p) && !es.blockaded[o.p]);
    const dPort = [dest, ...provincesOf(state, state.provinces[dest]!.owner)]
      .filter((p) => w.seaSpawn.get(p) && !es.blockaded[p])
      .sort((a, b) =>
        a === dest
          ? -1
          : b === dest
            ? 1
            : distanceKm(w.provById.get(a)!.cityPoint, destPt) -
                distanceKm(w.provById.get(b)!.cityPoint, destPt) || (a < b ? -1 : 1),
      )[0];
    if (oPort && dPort) {
      const a = w.seaSpawn.get(oPort.p)!;
      const b = w.seaSpawn.get(dPort)!;
      const plan = planSurface(w.nav, state.world.balance, ship, a, b, t, memo);
      if (!('error' in plan) && plan.legs.length > 0)
        return { sysId: ship.id, from: a, legs: plan.legs };
    }
  }
  const air = state.world.catalog.get(CARRIERS.air);
  if (air && itemSys?.movement !== 'sea') {
    const from0 = w.provById.get(origins[0]!.p)!.cityPoint;
    const plan = planAir(air, from0, destPt, t);
    if (!('error' in plan) && plan.legs.length > 0)
      return { sysId: air.id, from: from0, legs: plan.legs };
  }
  return null;
}

/**
 * Expédie un objet. Argent et licences : immédiat. Ressources et unités : un porteur (convoi, cargo,
 * avion cargo) voyage sur la carte et peut être intercepté ; sans porteur au catalogue (ou sans
 * itinéraire), la livraison est instantanée.
 */
export function deliver(
  state: EngineState,
  from: NationId,
  to: NationId,
  item: TradeItem,
  covert: boolean,
): void {
  if (item.type === 'money') {
    state.nations[to]!.money += item.amount;
    book(state, to, 'transfersIn', item.amount);
    return;
  }
  if (item.type === 'licence') {
    ecoNation(state, to).licences[item.systemId] ??= state.time;
    return;
  }
  const dest = capitalOf(state, to);
  if (!dest) return;
  const es = eco(state);
  const id = nextId(state, 'v');
  const route = planRoute(state, from, dest, item);
  const d: Delivery = {
    id,
    from,
    to,
    item,
    carrier: null,
    eta: state.time,
    covert,
    dest,
    mv: 0,
  };
  if (!route) {
    arrive(state, d, null);
    return;
  }
  const u = spawnUnit(state, from, route.sysId, route.from, 1);
  setMovement(state, u, route.legs);
  d.carrier = u.id;
  d.mv = u.mv;
  d.eta = route.legs[route.legs.length - 1]!.t1;
  es.dlv[id] = d;
  scheduleMod(state, { t: d.eta, m: 'eco', e: 'dlv', d: { id, mv: u.mv } });
}

function audienceOf(d: Delivery): NationId[] {
  return d.from === d.to ? [d.to] : [d.from, d.to];
}

function arrive(state: EngineState, d: Delivery, carrier: Unit | null): void {
  const w = wi(state.world);
  const dest = state.provinces[d.dest]?.owner === d.to ? d.dest : capitalOf(state, d.to);
  const at = carrier
    ? unitPosAt(state, carrier, state.time)
    : dest
      ? w.provById.get(dest)!.cityPoint
      : ([0, 0] as LngLat);
  if (carrier) destroyUnit(state, carrier, null, { quiet: true });
  delete eco(state).dlv[d.id];
  if (!state.nations[d.to]?.alive || !dest) return;
  if (d.item.type === 'resource') state.nations[d.to]!.res[d.item.resource] += d.item.qty;
  else if (d.item.type === 'units') {
    const sys = state.world.catalog.get(d.item.systemId);
    if (sys) {
      const pos =
        sys.movement === 'sea'
          ? (w.seaSpawn.get(dest) ?? (carrier ? at : null))
          : w.provById.get(dest)!.cityPoint;
      if (pos) spawnUnit(state, d.to, sys.id, pos, d.item.count);
    }
  }
  notify(
    state,
    { kind: 'delivery', time: state.time, at, deliveryId: d.id, outcome: 'arrived' },
    audienceOf(d),
  );
}

export function onDeliveryArrival(state: EngineState, ev: { id: string; mv: number }): void {
  const d = eco(state).dlv[ev.id];
  if (!d || !d.carrier) return;
  const u = state.units[d.carrier];
  if (!u) return;
  if (u.mv !== ev.mv && u.move) {
    // Porteur détourné : on attend sa nouvelle arrivée.
    const legs = u.move.legs;
    d.mv = u.mv;
    d.eta = legs[legs.length - 1]!.t1;
    scheduleMod(state, {
      t: Math.max(d.eta, state.time),
      m: 'eco',
      e: 'dlv',
      d: { id: d.id, mv: u.mv },
    });
    return;
  }
  arrive(state, d, u);
}

/** Porteur détruit ou livraison saisie : la livraison est perdue. */
export function loseDelivery(
  state: EngineState,
  id: string,
  by: NationId | null,
  removeCarrier: boolean,
): void {
  const es = eco(state);
  const d = es.dlv[id];
  if (!d) return;
  delete es.dlv[id];
  const carrier = d.carrier ? state.units[d.carrier] : undefined;
  const at: LngLat = carrier
    ? unitPosAt(state, carrier, state.time)
    : wi(state.world).provById.get(d.dest)!.cityPoint;
  notify(
    state,
    { kind: 'delivery', time: state.time, at, deliveryId: id, outcome: 'intercepted' },
    [...audienceOf(d), ...(by && state.nations[by] ? [by] : [])],
  );
  if (carrier && removeCarrier) destroyUnit(state, carrier, null, { quiet: true });
}

export function deliveryOfCarrier(state: EngineState, uid: UnitId): string | null {
  const es = eco(state);
  for (const id of sortedIds(es.dlv)) if (es.dlv[id]!.carrier === uid) return id;
  return null;
}
