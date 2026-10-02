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
  orderDismiss,
  orderHire,
  payroll,
  refreshPools,
} from './generals.js';
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
  return false;
}

function handleTick(state: EngineState): void {
  const c = cmd(state);
  c.ticking = false;
  healGenerals(state);
  for (const id of Object.keys(c.armies).sort()) {
    const a = c.armies[id];
    if (a) thinkArmy(state, a);
  }
  if (live(state)) ensureTick(state);
}

function onEvent(state: EngineState, ev: ModEvent): void {
  if (ev.e === 'tick') return handleTick(state);
  if (ev.e === 'army') {
    const d = ev.d as { a: string; v: number };
    const a = cmdOpt(state)?.armies[d.a];
    if (a && a.v === d.v) thinkArmy(state, a);
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
    if (!a.mission || a.status === 'success' || a.status === 'failed') {
      a.rep = [a.captures, a.losses];
      continue;
    }
    const [cap0, los0] = a.rep ?? [0, 0];
    const pct = a.start > 0 ? Math.round((100 * a.now) / a.start) : 100;
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
  },
  view: commandView,
  hooks: {
    onDailyTick: daily,
    onUnitDestroyed(state, u) {
      onUnitGone(state, u, true);
    },
    onUnitRemoved(state, u) {
      onUnitGone(state, u, false);
    },
    onDamage(state, _att, tgt, dmg) {
      if (dmg > 0) hqHit(state, tgt, dmg);
    },
    onOrder(state, n, order) {
      onUnitOrder(state, n, order, generalDriving());
    },
    onProvinceCaptured(state, pid, _from, to) {
      const c = cmdOpt(state);
      if (!c) return;
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
