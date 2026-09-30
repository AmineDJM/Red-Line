import { HOUR, type NationId, type Order, type OrderErrorCode } from '@redline/shared';
import type { OrderResult, SystemCommand } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import type { EngineModule, ModEvent, OrderHandler } from '../types.js';
import { board } from '../kit.js';
import { ecoAiThink } from './ai.js';
import { ecoIncome, mobilizationDaily, mobilizeOrder, startingMoney } from './budget.js';
import {
  accelerateJob,
  accelerateRepair,
  buildOrder,
  buildingsOnCapture,
  damageBuilding,
  nuclearDamage,
  onJobDone,
  onRepairDone,
  repairOrder,
  researchBuildingFactor,
} from './buildings.js';
import { placeOrbatForces } from './forces.js';
import { evalSupply, fortificationArmor, supplyEfficiency } from './logistics.js';
import {
  acceptOfferOrder,
  blackMarketOrder,
  cancelOfferOrder,
  deliveryOfCarrier,
  loseDelivery,
  onDeliveryArrival,
  onOfferExpired,
  sellOfferOrder,
  transferOrder,
} from './market.js';
import {
  buyLicenceOrder,
  cancelProductionOrder,
  localCheck,
  onProductionDone,
  produceOrder,
  shiftProduction,
} from './production.js';
import {
  accelerateResearch,
  cancelResearchOrder,
  grantNode,
  onResearchDone,
  researchModifier,
  researchOrder,
  stealNode,
} from './research.js';
import { eco, ecoNation, emptyEco, orbatOf, resetEcoRt, sortedIds } from './state.js';
import { ecoAudience, ecoPublicView, ecoView } from './view.js';
import { fail } from './util.js';

/** Ordre réservé aux nations encore en vie. */
function alive<K extends Order['kind']>(
  fn: (state: EngineState, n: NationId, order: Extract<Order, { kind: K }>) => OrderResult,
): OrderHandler {
  return (state, n, order) => {
    if (!state.nations[n]?.alive) return fail('not_allowed', 'Nation vaincue.');
    return fn(state, n, order as Extract<Order, { kind: K }>);
  };
}

function init(state: EngineState, setup: { scenario?: { year?: number; orbatSet?: string } }) {
  const world = state.world;
  const live = !!(world.research || world.orbats);
  const es = emptyEco(live, setup.scenario?.year ?? 2025, setup.scenario?.orbatSet ?? '2025');
  state.mods.eco = es;
  resetEcoRt(state);
  for (const n of state.nationIds) {
    const en = ecoNation(state, n);
    const o = orbatOf(state, n);
    if (o) {
      for (const r of [...o.research].sort()) grantNode(state, n, r, false);
      for (const s of [...o.licences].sort()) en.licences[s] = 0;
      const money = startingMoney(state, n);
      if (money !== null) state.nations[n]!.money = money;
    } else if (live && world.research) {
      // Sans ORBAT : les nœuds de rang 0 (technologies de base) sont acquis.
      for (const [id, node] of world.research)
        if (node.tier === 0 && (node.eraYear === undefined || node.eraYear <= es.year))
          grantNode(state, n, id, false);
    }
  }
}

function onEvent(state: EngineState, ev: ModEvent): void {
  const d = ev.d as never;
  switch (ev.e) {
    case 'prod':
      return onProductionDone(state, d);
    case 'res':
      return onResearchDone(state, d);
    case 'job':
      return onJobDone(state, d);
    case 'rep':
      return onRepairDone(state, d);
    case 'offer':
      return onOfferExpired(state, d);
    case 'dlv':
      return onDeliveryArrival(state, d);
  }
}

function accelerate(state: EngineState, cmd: SystemCommand): OrderResult {
  if (cmd.kind !== 'accelerate') return fail('unknown');
  const n = cmd.nationId;
  if (!state.nations[n]) return fail('invalid_target', 'Nation absente de la partie.');
  const ms = cmd.hours * HOUR;
  if (!(ms > 0)) return fail('invalid_target');
  const { type, id } = cmd.target;
  let ok = false;
  if (type === 'production') ok = shiftProduction(state, n, id, ms);
  else if (type === 'research') ok = accelerateResearch(state, n, id, ms);
  else if (type === 'build') ok = eco(state).jobs[id]?.n === n && accelerateJob(state, id, ms);
  else if (type === 'repair') {
    const pid = id.slice(0, id.lastIndexOf(':'));
    ok = state.provinces[pid]?.owner === n && accelerateRepair(state, id, ms);
  }
  return ok ? { ok: true } : fail('invalid_target', 'Rien à accélérer.');
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function onSignal(state: EngineState, name: string, data: Record<string, unknown>): void {
  switch (name) {
    case 'building_hit':
    case 'sabotage': {
      const pid = str(data.pid);
      const b = str(data.building);
      if (pid && b) damageBuilding(state, pid, b, num(data.damage), str(data.by));
      return;
    }
    case 'nuclear_detonation': {
      const pid = str(data.pid);
      if (pid) nuclearDamage(state, pid, str(data.by));
      return;
    }
    case 'research_stolen': {
      const by = str(data.by);
      const node = str(data.nodeId);
      if (by && node) stealNode(state, by, node);
      return;
    }
    case 'delivery_intercepted': {
      const id = str(data.deliveryId);
      if (id) loseDelivery(state, id, str(data.by), true);
      return;
    }
    case 'blockade': {
      const es = eco(state);
      const by = str(data.by) ?? '';
      const pid = str(data.pid);
      const strait = str(data.straitId);
      const on = data.on !== false;
      if (pid) {
        if (on) es.blockaded[pid] = by;
        else delete es.blockaded[pid];
      }
      if (strait) {
        if (on) es.straits[strait] = by;
        else delete es.straits[strait];
      }
      return;
    }
    case 'cyber': {
      if (data.kind !== 'production') return;
      const victim = str(data.victim);
      const ns = victim ? state.nations[victim] : undefined;
      if (!victim || !ns) return;
      const ms = num(data.hours) * HOUR;
      for (const it of [...ns.production]) shiftProduction(state, victim, it.id, -ms);
      return;
    }
  }
}

/** Économie réelle (dollars US, budgets de défense, ORBAT), recherche, licences, marché, marché noir, livraisons, logistique, bâtiments, mobilisation. */
export const ecoModule: EngineModule = {
  id: 'eco',
  init,
  rebuild(state) {
    eco(state);
    resetEcoRt(state);
  },
  onEvent,
  orders: {
    produce: alive<'produce'>(produceOrder),
    research: alive<'research'>(researchOrder),
    cancelResearch: alive<'cancelResearch'>(cancelResearchOrder),
    buyLicence: alive<'buyLicence'>(buyLicenceOrder),
    cancelProduction: alive<'cancelProduction'>(cancelProductionOrder),
    build: alive<'build'>(buildOrder),
    repair: alive<'repair'>(repairOrder),
    sellOffer: alive<'sellOffer'>(sellOfferOrder),
    acceptOffer: alive<'acceptOffer'>(acceptOfferOrder),
    cancelOffer: alive<'cancelOffer'>(cancelOfferOrder),
    blackMarket: alive<'blackMarket'>(blackMarketOrder),
    transfer: alive<'transfer'>(transferOrder),
    mobilize: alive<'mobilize'>(mobilizeOrder),
  },
  system: { accelerate },
  view: ecoView,
  publicView: ecoPublicView,
  hooks: {
    income: ecoIncome,
    onDailyTick(state) {
      const es = eco(state);
      for (const uid of sortedIds(es.supply)) if (!state.units[uid]) delete es.supply[uid];
      evalSupply(state);
      mobilizationDaily(state);
    },
    onUnitDestroyed(state, u, killer) {
      const id = deliveryOfCarrier(state, u.id);
      if (id) loseDelivery(state, id, killer?.owner ?? null, false);
      delete eco(state).supply[u.id];
    },
    onProvinceCaptured(state, pid, from, to) {
      buildingsOnCapture(state, pid);
      evalSupply(state, [from, to]);
    },
    canProduce(state, n, systemId, pid): OrderErrorCode | null {
      const sys = state.world.catalog.get(systemId);
      return sys ? localCheck(state, n, sys, pid) : null;
    },
    modifier(state, n, key) {
      const r = researchModifier(state, n, key);
      if (key === 'research.speed' && eco(state).live) return r * researchBuildingFactor(state, n);
      return r;
    },
    unitModifier(state, u, key) {
      if (key === 'combat.damage') return supplyEfficiency(state, u);
      if (key === 'combat.armor') return fortificationArmor(state, u);
      return 1;
    },
    canImport(state, n) {
      return board(state).embargoed[n] ? 'locked' : null;
    },
    onSignal,
    placeStartingForces: placeOrbatForces,
    aiThink: ecoAiThink,
    audience: ecoAudience,
    stats(state, out) {
      const es = eco(state);
      for (const n of Object.keys(out.nations).sort()) {
        const en = es.nations[n];
        if (en) out.nations[n]!.spentUsd = en.spent;
      }
    },
  },
};
