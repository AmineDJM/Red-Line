import {
  HOUR,
  type NationId,
  type Order,
  type OrderErrorCode,
  type ProductionItem,
  type ProvinceId,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { notify, schedule } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { startProduction } from '../../economy/economy.js';
import { scheduleMod } from '../kit.js';
import { canImport, firstError, modifier } from '../registry.js';
import { provinceProductionSpeed } from './buildings.js';
import { cfg, requiredBuildings } from './config.js';
import { hasGate } from './research.js';
import { eco, ecoNation, type Paid } from './state.js';
import { canPay, eraOk, fail, isNuclear, pay, refund, scaledRes, unitPrice } from './util.js';

/**
 * Posséder ≠ produire : un système est productible dans une province si
 *  - il existe à l'année du scénario (era) ;
 *  - toutes ses portes de recherche (`requires`) sont acquises, OU la nation détient sa licence ;
 *  - la province possède le bâtiment requis (requiresBuilding, sinon selon la catégorie), non détruit.
 */
export function localCheck(
  state: EngineState,
  n: NationId,
  sys: WeaponSystem,
  pid: ProvinceId,
): OrderErrorCode | null {
  const es = eco(state);
  if (!es.live) return null;
  if (!eraOk(sys, es.year)) return 'not_allowed';
  const licensed = ecoNation(state, n).licences[sys.id] !== undefined;
  if (!licensed && !sys.requires.every((r) => hasGate(state, n, r))) return 'research_required';
  if (provinceProductionSpeed(state, pid, requiredBuildings(sys)) <= 0) return 'not_allowed';
  return null;
}

/** Importation possible (achat au catalogue d'un fournisseur étranger) ? */
export function importCheck(
  state: EngineState,
  n: NationId,
  sys: WeaponSystem,
): OrderErrorCode | null {
  if (!sys.exportable || isNuclear(sys) || !sys.enabled) return 'not_allowed';
  if (!eraOk(sys, eco(state).year)) return 'not_allowed';
  return canImport(state, n, sys.id);
}

function batchHours(state: EngineState, sys: WeaponSystem, count: number): number {
  return sys.buildTimeH * (1 + cfg(state.world).industry.batchTimeFactor * (count - 1));
}

function addItem(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  sys: WeaponSystem,
  elements: number,
  ms: number,
  paid: Paid,
  source: ProductionItem['source'],
): string {
  const id = `b${++state.nextProd}`;
  const item: ProductionItem = {
    id,
    provinceId: pid,
    systemId: sys.id,
    startedAt: state.time,
    completesAt: state.time + ms,
    count: elements,
    source,
  };
  state.nations[n]!.production.push(item);
  eco(state).prod[id] = { n, v: 1, paid };
  scheduleMod(state, { t: item.completesAt, m: 'eco', e: 'prod', d: { n, id, v: 1 } });
  return id;
}

export function produceOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'produce' }>,
): OrderResult {
  const es = eco(state);
  if (!es.live) {
    const err = startProduction(state, n, order.provinceId, order.systemId);
    return err ? fail(err) : { ok: true };
  }
  const P = state.provinces[order.provinceId];
  if (!P) return fail('invalid_target', 'Province inconnue.');
  if (P.owner !== n) return fail('not_owner');
  const sys = state.world.catalog.get(order.systemId);
  if (!sys || !sys.enabled) return fail('invalid_target', 'Système inconnu.');
  if (sys.movement === 'sea' && !wi(state.world).seaSpawn.get(order.provinceId))
    return fail('not_allowed', 'Province sans accès à la mer.');
  const count = order.count ?? 1;
  const elements = count * sys.unitSize;
  const local = localCheck(state, n, sys, order.provinceId);
  if (!local) {
    const other = firstError(state, n, sys.id, order.provinceId);
    if (other) return fail(other);
    const licensed = ecoNation(state, n).licences[sys.id] !== undefined;
    const discount = licensed ? 1 - cfg(state.world).licences.productionDiscount : 1;
    const paid: Paid = {
      money: sys.cost.money * count * modifier(state, n, 'production.cost') * discount,
      res: scaledRes(sys.cost.resources, count),
    };
    const err = canPay(state, n, paid);
    if (err) return fail(err);
    const speed =
      modifier(state, n, 'production.speed') *
      provinceProductionSpeed(state, order.provinceId, requiredBuildings(sys));
    pay(state, n, paid, 'production');
    const ms = (batchHours(state, sys, count) * HOUR) / (speed > 0 ? speed : 1);
    addItem(state, n, order.provinceId, sys, elements, ms, paid, 'factory');
    return { ok: true };
  }
  if (local === 'research_required' || local === 'not_allowed') {
    const imp = importCheck(state, n, sys);
    if (!imp) {
      const ind = cfg(state.world).industry;
      const paid: Paid = { money: sys.cost.money * count * ind.importPriceFactor, res: {} };
      const err = canPay(state, n, paid);
      if (err) return fail(err);
      pay(state, n, paid, 'imports');
      const ms = (batchHours(state, sys, count) + ind.importDeliveryHours) * HOUR;
      addItem(state, n, order.provinceId, sys, elements, ms, paid, 'import');
      return { ok: true };
    }
    if (imp === 'locked') return fail('locked', 'Importation sous embargo.');
  }
  return fail(local);
}

/** Livraison au marché noir : comme une importation, sans embargo, plus chère. */
export function queueBlackMarket(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  sys: WeaponSystem,
  count: number,
  paid: Paid,
): void {
  const ms = cfg(state.world).industry.blackMarketDeliveryHours * HOUR;
  addItem(state, n, pid, sys, count * sys.unitSize, ms, paid, 'black_market');
}

export function onProductionDone(
  state: EngineState,
  d: { n: NationId; id: string; v: number },
): void {
  const es = eco(state);
  const meta = es.prod[d.id];
  if (!meta || meta.v !== d.v) return;
  delete es.prod[d.id];
  const ns = state.nations[d.n];
  if (!ns) return;
  const idx = ns.production.findIndex((it) => it.id === d.id);
  if (idx < 0) return; // province perdue entre-temps
  const item = ns.production[idx]!;
  ns.production.splice(idx, 1);
  const P = state.provinces[item.provinceId];
  if (!P || P.owner !== d.n) return;
  const sys = state.world.catalog.get(item.systemId)!;
  const w = wi(state.world);
  const pos =
    sys.movement === 'sea'
      ? w.seaSpawn.get(item.provinceId)
      : w.provById.get(item.provinceId)!.cityPoint;
  if (!pos) return;
  const u = spawnUnit(state, d.n, item.systemId, pos, item.count ?? sys.unitSize);
  notify(
    state,
    { kind: 'production_complete', time: state.time, at: pos, unitId: u.id, systemId: u.sys },
    [d.n],
  );
}

export function cancelProductionOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'cancelProduction' }>,
): OrderResult {
  const es = eco(state);
  const ns = state.nations[n]!;
  const idx = ns.production.findIndex((it) => it.id === order.productionId);
  if (idx < 0) return fail('invalid_target', 'Production inconnue.');
  const item = ns.production[idx]!;
  ns.production.splice(idx, 1);
  const share = cfg(state.world).industry.cancelRefund;
  const meta = es.prod[item.id];
  const key =
    item.source === 'import'
      ? 'imports'
      : item.source === 'black_market'
        ? 'blackMarket'
        : 'production';
  if (meta) {
    refund(state, n, meta.paid, share, key);
    delete es.prod[item.id];
  } else {
    const sys = state.world.catalog.get(item.systemId);
    if (sys)
      refund(
        state,
        n,
        { money: sys.cost.money, res: scaledRes(sys.cost.resources, 1) },
        share,
        key,
      );
  }
  return { ok: true };
}

/** Recule (ms > 0 : accélère) ou retarde (ms < 0) une production. */
export function shiftProduction(state: EngineState, n: NationId, id: string, ms: number): boolean {
  const ns = state.nations[n];
  const item = ns?.production.find((it) => it.id === id);
  if (!item) return false;
  item.completesAt = Math.max(state.time, item.completesAt - ms);
  const meta = eco(state).prod[id];
  if (meta) {
    meta.v++;
    scheduleMod(state, {
      t: item.completesAt,
      m: 'eco',
      e: 'prod',
      d: { n, id, v: meta.v },
    });
  } else if (ms > 0) {
    // Production du cœur (hors économie réelle) : un nouvel événement plus tôt suffit.
    schedule(state, { k: 'prod', t: item.completesAt, n, id });
  } else return false;
  return true;
}

// ——— Licences ———

export function licencePrice(state: EngineState, sys: WeaponSystem): number {
  return unitPrice(sys) * cfg(state.world).licences.priceFactor;
}

export function buyLicenceOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'buyLicence' }>,
): OrderResult {
  const sys = state.world.catalog.get(order.systemId);
  if (!sys || !sys.enabled) return fail('invalid_target', 'Système inconnu.');
  if (!sys.licensable || isNuclear(sys)) return fail('not_allowed', 'Licence non disponible.');
  if (!eraOk(sys, eco(state).year)) return fail('not_allowed');
  const en = ecoNation(state, n);
  if (en.licences[sys.id] !== undefined) return fail('not_allowed', 'Licence déjà détenue.');
  const imp = canImport(state, n, sys.id);
  if (imp) return fail(imp, 'Licence sous embargo.');
  const paid: Paid = { money: licencePrice(state, sys), res: {} };
  const err = canPay(state, n, paid);
  if (err) return fail(err);
  pay(state, n, paid, 'licences');
  en.licences[sys.id] = state.time;
  return { ok: true };
}
