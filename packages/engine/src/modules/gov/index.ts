import type { Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import type { EngineModule, ModEvent } from '../types.js';
import { orderAppoint, orderDismiss, payroll, refreshPools } from './heads.js';
import {
  accrueDaily,
  anyLive,
  handleTick,
  orderMission,
  orderMissionCancel,
  orderMissionEdit,
  orderMissionSuspend,
  scheduleNation,
  thinkNation,
} from './missions.js';
import { govOpt } from './state.js';
import { governmentView } from './view.js';

/**
 * Gouvernement (module `gov`) : ministères de la Défense (infrastructures et logistique, directions de
 * l'armement et du renseignement) et de l'Économie, titulaires fictifs nommés et payés, missions
 * exécutées à la cadence de l'IA par les ordres de jeu existants, dans une enveloppe de budget.
 * Données : balance.government. Voir docs/gouvernement.md.
 */

type Handler = (state: EngineState, n: string, order: Order) => OrderResult;
const h = <K extends Order['kind']>(
  fn: (state: EngineState, n: string, o: Extract<Order, { kind: K }>) => OrderResult,
): Handler => fn as unknown as Handler;

/** Nomination : les missions du poste reprennent aussitôt. */
const appoint: Handler = (state, n, o) => {
  const r = orderAppoint(state, n, o as Extract<Order, { kind: 'govAppoint' }>);
  if (r.ok && anyLive(state)) scheduleNation(state, n);
  return r;
};

function onEvent(state: EngineState, ev: ModEvent): void {
  if (ev.e === 'tick') return handleTick(state);
  if (ev.e === 'think') {
    const d = ev.d as { n: string; v: number };
    const gn = govOpt(state)?.nations[d.n];
    if (gn && gn.v === d.v) thinkNation(state, d.n);
  }
}

export const govModule: EngineModule = {
  id: 'gov',
  onEvent,
  orders: {
    govAppoint: appoint,
    govDismiss: h<'govDismiss'>(orderDismiss),
    govMission: h<'govMission'>(orderMission),
    govMissionEdit: h<'govMissionEdit'>(orderMissionEdit),
    govMissionSuspend: h<'govMissionSuspend'>(orderMissionSuspend),
    govMissionCancel: h<'govMissionCancel'>(orderMissionCancel),
  },
  view: governmentView,
  hooks: {
    onDailyTick(state) {
      if (!govOpt(state)) return;
      payroll(state);
      refreshPools(state);
      accrueDaily(state);
    },
  },
};
