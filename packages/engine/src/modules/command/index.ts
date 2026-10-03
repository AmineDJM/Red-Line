import type { Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import type { EngineModule, ModEvent } from '../types.js';
import {
  armiesAt,
  orderAnswer,
  orderCreate,
  orderDissolve,
  orderEdit,
  orderMission,
  orderSuspend,
  onUnitGone,
  onUnitOrder,
} from './armies.js';
import { generalDriving, thinkArmy } from './brain.js';
import {
  commandModifier,
  gainXp,
  healGenerals,
  hqHit,
  orderAssign,
  orderChief,
  orderDismiss,
  orderHire,
  payroll,
  refreshPools,
} from './generals.js';
import {
  afterThink,
  opCaptured,
  opDamage,
  opOf,
  opUnitLost,
  orderCampaignAnswer,
  orderCampaignCancel,
  orderCampaignCreate,
  orderCampaignEdit,
  orderCampaignForces,
  orderCampaignSuspend,
  planOp,
} from './ops.js';
import { journal } from './journal.js';
import { cmd, cmdBal, cmdOpt } from './state.js';
import { ensureTick } from './schedule.js';
import { commandView } from './view.js';

/**
 * Centre de commandement (module `cmd`) : armées nommées formées des piles du joueur, missions
 * (données : balance.command.missions), généraux recrutés et payés qui commandent leur armée comme
 * l'IA du moteur. Voir docs/centre-de-commandement.md.
 */

type Handler = (state: EngineState, n: string, order: Order) => OrderResult;
const h = <K extends Order['kind']>(
  fn: (state: EngineState, n: string, o: Extract<Order, { kind: K }>) => OrderResult,
): Handler => fn as unknown as Handler;

/** Une armée a-t-elle encore besoin de réfléchir (mission en cours) ? */
function live(state: EngineState): boolean {
  const c = cmdOpt(state);
  if (!c) return false;
  for (const id of Object.keys(c.armies)) {
    const a = c.armies[id]!;
    if (a.mission && a.status !== 'success' && a.status !== 'failed') return true;
  }
  for (const id of Object.keys(c.ops ?? {})) {
    const op = c.ops![id]!;
    if (op.status !== 'success' && op.status !== 'failed' && op.armies.length) return true;
  }
  return false;
}

/** Planificateur des opérations, puis réflexion de leurs généraux (ordre des identifiants). */
function planAll(state: EngineState): void {
  const ops = cmdOpt(state)?.ops;
  if (!ops) return;
  for (const id of Object.keys(ops).sort()) planOp(state, ops[id]!);
}

function handleTick(state: EngineState): void {
  const c = cmd(state);
  c.ticking = false;
  healGenerals(state);
  planAll(state);
  for (const id of Object.keys(c.armies).sort()) {
    const a = c.armies[id];
    if (a) thinkArmy(state, a);
  }
  for (const id of Object.keys(c.ops ?? {}).sort()) afterThink(state, c.ops![id]!);
  if (live(state)) ensureTick(state);
}

function onEvent(state: EngineState, ev: ModEvent): void {
  if (ev.e === 'tick') return handleTick(state);
  if (ev.e === 'army') {
    const d = ev.d as { a: string; v: number };
    const a = cmdOpt(state)?.armies[d.a];
    if (a && a.v === d.v) thinkArmy(state, a);
  }
  if (ev.e === 'op') {
    // Opération lancée, modifiée ou reprise : planification et ordres immédiats.
    const d = ev.d as { o: string; v: number };
    const c = cmdOpt(state);
    const op = c?.ops?.[d.o];
    if (!c || !op || op.v !== d.v) return;
    planOp(state, op);
    for (const id of [...op.armies].sort()) {
      const a = c.armies[id];
      if (a) thinkArmy(state, a);
    }
    afterThink(state, op);
  }
}

/** Tick journalier : soldes, vivier, rapport quotidien des armées, expérience du combat. */
function daily(state: EngineState): void {
  const c = cmdOpt(state);
  if (!c) return;
  payroll(state);
  refreshPools(state);
  const B = cmdBal(state);
  for (const id of Object.keys(c.armies).sort()) {
    const a = c.armies[id]!;
    const g = a.general ? c.gens[a.general] : null;
    const op = opOf(state, a);
    if (op) {
      if (g && a.units.some((u) => state.units[u]?.engaged))
        gainXp(state, g, B.generals.xpCombatDay, null);
      a.rep = [a.captures, a.losses];
      continue;
    }
    if (!a.mission || a.status === 'success' || a.status === 'failed') {
      a.rep = [a.captures, a.losses];
      continue;
    }
    const [cap0, los0] = a.rep ?? [0, 0];
    const pct = a.start > 0 ? Math.round((100 * a.now) / a.start) : 100;
    // Rapport quotidien : seulement pour une armée qui agit et s'il y a du nouveau (pas de bruit).
    const acting = a.status === 'active' || a.status === 'preparing';
    if (acting && (a.captures !== cap0 || a.losses !== los0))
      journal(state, a, 'daily', {
        strength: pct,
        captures: a.captures - cap0,
        losses: a.losses - los0,
      });
    a.rep = [a.captures, a.losses];
    if (g && a.units.some((u) => state.units[u]?.engaged))
      gainXp(state, g, B.generals.xpCombatDay, B.missions[a.mission.type]?.brain ?? null);
  }
}

export const cmdModule: EngineModule = {
  id: 'cmd',
  onEvent,
  orders: {
    armyCreate: h<'armyCreate'>(orderCreate),
    armyEdit: h<'armyEdit'>(orderEdit),
    armyMission: h<'armyMission'>(orderMission),
    armySuspend: h<'armySuspend'>(orderSuspend),
    armyDissolve: h<'armyDissolve'>(orderDissolve),
    armyAnswer: h<'armyAnswer'>(orderAnswer),
    generalHire: h<'generalHire'>(orderHire),
    generalAssign: h<'generalAssign'>(orderAssign),
    generalDismiss: h<'generalDismiss'>(orderDismiss),
    commandChief: h<'commandChief'>(orderChief),
    campaignCreate: h<'campaignCreate'>(orderCampaignCreate),
    campaignEdit: h<'campaignEdit'>(orderCampaignEdit),
    campaignForces: h<'campaignForces'>(orderCampaignForces),
    campaignSuspend: h<'campaignSuspend'>(orderCampaignSuspend),
    campaignCancel: h<'campaignCancel'>(orderCampaignCancel),
    campaignAnswer: h<'campaignAnswer'>(orderCampaignAnswer),
  },
  view: commandView,
  hooks: {
    onDailyTick: daily,
    onUnitDestroyed(state, u) {
      const c = cmdOpt(state);
      const aid = c?.unitArmy[u.id];
      const a = aid ? c?.armies[aid] : undefined;
      if (a) opUnitLost(state, a, u);
      onUnitGone(state, u, true);
    },
    onUnitRemoved(state, u) {
      onUnitGone(state, u, false);
    },
    onDamage(state, att, tgt, dmg) {
      if (dmg > 0) {
        hqHit(state, tgt, dmg);
        opDamage(state, att, tgt, dmg);
      }
    },
    onOrder(state, n, order) {
      onUnitOrder(state, n, order, generalDriving());
    },
    onProvinceCaptured(state, pid, from, to) {
      const c = cmdOpt(state);
      if (!c) return;
      opCaptured(state, pid, from, to);
      const at = wi(state.world).provById.get(pid)?.cityPoint;
      if (!at) return;
      for (const a of armiesAt(state, to, at)) {
        a.captures++;
        journal(state, a, 'captured', { province: { province: pid } }, 'good');
        if (a.mission?.targets?.includes(pid)) a.mission.progressAt = state.time;
        const g = a.general ? c.gens[a.general] : null;
        if (g && a.mission) {
          const B = cmdBal(state);
          gainXp(state, g, B.generals.xpCapture, B.missions[a.mission.type]?.brain ?? null);
        }
      }
    },
    unitModifier: commandModifier,
  },
};
