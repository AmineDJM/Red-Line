import type { NationId, Order, OrderErrorCode, UnitId, Leg } from '@redline/shared';
import type { OrderResult } from '../api.js';
import { sightLevel, sysOf, unitPosAt } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { declareWar } from '../state/war.js';
import { inWeaponRange, unitPairKey } from '../encounters/pairs.js';
import { setMovement } from '../movement/movement.js';
import { airCanReach, planUnitMove } from '../movement/plan-unit.js';
import { clearTarget, setTarget } from '../combat/combat.js';
import { startProduction } from '../economy/economy.js';
import { cleanTop, settle } from '../sim/settle.js';

function fail(error: OrderErrorCode, message?: string): OrderResult {
  return message ? { ok: false, error, message } : { ok: false, error };
}

function resolveUnits(state: EngineState, n: NationId, ids: UnitId[]): Unit[] | OrderResult {
  const out: Unit[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    out.push(u);
  }
  return out;
}

/** Validation et application d'un ordre à l'instant state.time (atomique : tout ou rien). */
export function applyOrderImpl(state: EngineState, n: NationId, order: Order): OrderResult {
  if (state.winner) return fail('game_over', 'La partie est terminée.');
  if (!state.nations[n]) return fail('not_allowed', 'Nation absente de la partie.');
  const res = dispatchOrder(state, n, order);
  settle(state);
  cleanTop(state);
  return res;
}

function dispatchOrder(state: EngineState, n: NationId, order: Order): OrderResult {
  switch (order.kind) {
    case 'move': {
      const units = resolveUnits(state, n, order.unitIds);
      if (!Array.isArray(units)) return units;
      const plans: Leg[][] = [];
      for (const u of units) {
        const plan = planUnitMove(state, u, order.to);
        if ('error' in plan) return fail(plan.error, messageFor(plan.error));
        plans.push(plan.legs);
      }
      units.forEach((u, i) => {
        if (u.target) clearTarget(state, u);
        setMovement(state, u, plans[i]!);
      });
      return { ok: true };
    }
    case 'attack': {
      const units = resolveUnits(state, n, order.unitIds);
      if (!Array.isArray(units)) return units;
      const tgt = state.units[order.targetId];
      if (!tgt || tgt.owner === n || sightLevel(state, n, tgt.id) === 0) {
        return fail('invalid_target', 'Cible invalide ou hors de vue.');
      }
      const tClass = sysOf(state, tgt).targetClass;
      const able = units.filter((u) => sysOf(state, u).damage[tClass] > 0);
      if (able.length === 0)
        return fail('invalid_target', 'Aucune de ces unités ne peut toucher cette cible.');
      const aim = unitPosAt(state, tgt, state.time);
      const plans = new Map<UnitId, Leg[]>();
      for (const u of able) {
        const pair = state.pairs[unitPairKey(u.id, tgt.id)];
        if (pair && inWeaponRange(sysOf(state, u), pair.d)) continue;
        const sys = sysOf(state, u);
        if (sys.movement === 'static' || sys.speedKmh <= 0) continue; // tirera si la cible s'approche
        if (sys.movement === 'air' && !airCanReach(state, u, aim)) {
          return fail('out_of_range', messageFor('out_of_range'));
        }
        const plan = planUnitMove(state, u, aim);
        if ('error' in plan) return fail(plan.error, messageFor(plan.error));
        plans.set(u.id, plan.legs);
      }
      declareWar(state, n, tgt.owner);
      for (const u of able) {
        setTarget(state, u, tgt.id, 'order');
        const legs = plans.get(u.id);
        if (legs) setMovement(state, u, legs, { chasing: true });
        else state.rt.dirtyCombat.add(u.id);
      }
      return { ok: true };
    }
    case 'stop': {
      const units = resolveUnits(state, n, order.unitIds);
      if (!Array.isArray(units)) return units;
      for (const u of units) {
        if (u.target) clearTarget(state, u);
        setMovement(state, u, null);
      }
      return { ok: true };
    }
    case 'stance': {
      const units = resolveUnits(state, n, order.unitIds);
      if (!Array.isArray(units)) return units;
      for (const u of units) {
        u.stance = order.stance;
        // Une cible acquise automatiquement (posture agressive) est abandonnée hors de cette posture.
        if (order.stance !== 'aggressive' && u.tmode === 'auto') clearTarget(state, u);
        state.rt.dirtyCombat.add(u.id);
      }
      return { ok: true };
    }
    case 'produce': {
      if (!state.nations[n]!.alive) return fail('not_allowed', 'Nation vaincue.');
      const err = startProduction(state, n, order.provinceId, order.systemId);
      return err ? fail(err, messageFor(err)) : { ok: true };
    }
  }
}

function messageFor(code: OrderErrorCode): string {
  switch (code) {
    case 'unreachable':
      return 'Destination inaccessible.';
    case 'out_of_range':
      return "Hors du rayon d'action.";
    case 'insufficient_funds':
      return 'Fonds ou ressources insuffisants.';
    case 'not_allowed':
      return 'Action impossible pour cette unité.';
    case 'not_owner':
      return 'Cette province ne vous appartient pas.';
    case 'invalid_target':
      return 'Cible invalide.';
    default:
      return code;
  }
}
