import type { NationId, Order, OrderErrorCode, UnitId, Leg } from '@redline/shared';
import type { OrderResult } from '../api.js';
import { sightLevel, sysOf, unitPosAt } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { declareWar } from '../state/war.js';
import { inWeaponRange, unitPairKey } from '../encounters/pairs.js';
import { targetClassOf, weaponRange } from '../encounters/profile.js';
import { setMovement } from '../movement/movement.js';
import { airCanReach, planUnitMove } from '../movement/plan-unit.js';
import { clearTarget, setTarget } from '../combat/combat.js';
import { startProduction } from '../economy/economy.js';
import { cleanTop, settle } from '../sim/settle.js';
import { callHook, moduleIntercept, moduleOrder, moduleSystem } from '../modules/registry.js';
import type { SystemCommand } from '../api.js';
import { board } from '../modules/kit.js';
import { setUnlimited } from '../state/unlimited.js';

/** Commande système (serveur, administration). */
export function applySystemImpl(state: EngineState, cmd: SystemCommand): OrderResult {
  const res =
    coreSystem(state, cmd) ??
    moduleSystem(state, cmd) ??
    fail('unknown', `Commande inconnue : ${cmd.kind}`);
  settle(state);
  cleanTop(state);
  return res;
}

function coreSystem(state: EngineState, cmd: SystemCommand): OrderResult | null {
  switch (cmd.kind) {
    case 'setAi': {
      const ns = state.nations[cmd.nationId];
      if (!ns) return fail('invalid_target', 'Nation absente de la partie.');
      ns.isAi = cmd.isAi;
      ns.isPlayer = !cmd.isAi;
      ns.active = true;
      if (cmd.aiLevel) ns.aiLevel = cmd.aiLevel;
      return { ok: true };
    }
    case 'addPlayer': {
      const ns = state.nations[cmd.nationId];
      if (!ns) return fail('invalid_target', 'Nation absente de la partie.');
      ns.isAi = false;
      ns.isPlayer = true;
      ns.active = true;
      return { ok: true };
    }
    case 'grant': {
      const ns = state.nations[cmd.nationId];
      if (!ns) return fail('invalid_target', 'Nation absente de la partie.');
      // Nation illimitée : la dotation va à sa réserve réelle (rendue à la désactivation).
      const target = state.unl?.[cmd.nationId] ?? ns;
      target.money += cmd.money ?? 0;
      for (const [r, v] of Object.entries(cmd.resources ?? {})) {
        if (r in target.res) target.res[r as keyof typeof target.res] += v;
      }
      return { ok: true };
    }
    case 'unlimited': {
      if (!state.nations[cmd.nationId])
        return fail('invalid_target', 'Nation absente de la partie.');
      setUnlimited(state, cmd.nationId, cmd.on);
      return { ok: true };
    }
    case 'dormancy': {
      const b = board(state);
      if (cmd.on) b.dormancy = true;
      else delete b.dormancy;
      return { ok: true };
    }
    default:
      return null;
  }
}

function fail(error: OrderErrorCode, message?: string): OrderResult {
  return message ? { ok: false, error, message } : { ok: false, error };
}

function resolveUnits(state: EngineState, n: NationId, ids: UnitId[]): Unit[] | OrderResult {
  const out: Unit[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    if (u.off || u.role) return fail('not_allowed', `Unité indisponible pour cet ordre : ${id}`);
    out.push(u);
  }
  return out;
}

/** Validation et application d'un ordre à l'instant state.time (atomique : tout ou rien). */
export function applyOrderImpl(state: EngineState, n: NationId, order: Order): OrderResult {
  if (state.winner) return fail('game_over', 'La partie est terminée.');
  if (!state.nations[n]) return fail('not_allowed', 'Nation absente de la partie.');
  // Un module peut prendre en charge un ordre du cœur (aéronefs à carburant, satellites…).
  const res = moduleIntercept(state, n, order) ?? dispatchOrder(state, n, order);
  if (res.ok) callHook('onOrder', state, n, order);
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
      if (
        !tgt ||
        tgt.owner === n ||
        tgt.off ||
        tgt.role === 'missile' ||
        sightLevel(state, n, tgt.id) === 0
      ) {
        return fail('invalid_target', 'Cible invalide ou hors de vue.');
      }
      const tClass = targetClassOf(state, tgt);
      const able = units.filter(
        (u) => weaponRange(state, u).max > 0 && sysOf(state, u).damage[tClass] > 0,
      );
      if (able.length === 0)
        return fail('invalid_target', 'Aucune de ces unités ne peut toucher cette cible.');
      const aim = unitPosAt(state, tgt, state.time);
      const plans = new Map<UnitId, Leg[]>();
      for (const u of able) {
        const pair = state.pairs[unitPairKey(u.id, tgt.id)];
        if (pair && inWeaponRange(state, u, pair.d)) continue;
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
      // Un module peut prendre la production en charge (séries, importations, licences).
      const mod = moduleOrder(state, n, order);
      if (mod) return mod;
      const err = startProduction(state, n, order.provinceId, order.systemId);
      return err ? fail(err, messageFor(err)) : { ok: true };
    }
    default:
      return (
        moduleOrder(state, n, order) ?? fail('unknown', `Ordre non pris en charge : ${order.kind}`)
      );
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
