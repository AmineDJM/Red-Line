import { RESOURCES, type NationId, type Resource } from '@redline/shared';
import type { EngineState } from './types.js';

/** Plafonds par défaut (data/balance : `unlimited`). */
const DEFAULT_MONEY = 1e15;
const DEFAULT_RES = 1e12;

/** Réserve réelle d'une nation au moment où le mode illimité a été activé (rendue à la désactivation). */
export interface UnlimitedSaved {
  money: number;
  res: Record<Resource, number>;
}

function caps(state: EngineState): { money: number; res: number } {
  const u = state.world.balance.unlimited;
  return { money: u?.moneyUsd ?? DEFAULT_MONEY, res: u?.resources ?? DEFAULT_RES };
}

export function isUnlimited(state: EngineState, n: NationId): boolean {
  return !!state.unl?.[n];
}

/**
 * Remet la réserve des nations illimitées à son plafond (argent et chaque ressource). Appelé après
 * chaque événement, ordre et commande système (settle) : entre deux étapes de simulation, la réserve
 * vaut toujours exactement le plafond, quel que soit le découpage des appels à advanceTo (rejeu
 * identique). Une étape ne dépense jamais une part notable d'un plafond de 1e15 $.
 */
export function refillUnlimited(state: EngineState): void {
  const unl = state.unl;
  if (!unl) return;
  const c = caps(state);
  for (const n of Object.keys(unl)) {
    const ns = state.nations[n];
    if (!ns) continue;
    ns.money = c.money;
    for (const r of RESOURCES) ns.res[r] = c.res;
  }
}

/** Active ou désactive le mode illimité d'une nation (commande système 'unlimited'). */
export function setUnlimited(state: EngineState, n: NationId, on: boolean): void {
  const ns = state.nations[n];
  if (!ns) return;
  if (on) {
    state.unl ??= {};
    if (!state.unl[n]) state.unl[n] = { money: ns.money, res: { ...ns.res } };
    refillUnlimited(state);
    return;
  }
  const saved = state.unl?.[n];
  if (!saved) return;
  // Retour à la réserve réelle d'avant l'activation : rien de ce qui a été « offert » n'est conservé.
  ns.money = saved.money;
  for (const r of RESOURCES) ns.res[r] = saved.res[r] ?? 0;
  delete state.unl![n];
  if (Object.keys(state.unl!).length === 0) delete state.unl;
}
