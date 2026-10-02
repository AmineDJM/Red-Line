import { MINUTE } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { scheduleMod } from '../kit.js';
import { cmd, type ArmySt } from './state.js';

/** Cadence de réflexion des généraux : celle des IA (time.aiThinkMinutes). */
export function thinkPeriod(state: EngineState): number {
  return state.world.balance.time.aiThinkMinutes * MINUTE;
}

/** Réflexion immédiate d'une armée (nouvelle mission, réponse du joueur), puis cadence commune. */
export function scheduleArmy(state: EngineState, a: ArmySt): void {
  scheduleMod(state, { t: state.time, m: 'cmd', e: 'army', d: { a: a.id, v: a.v } });
  ensureTick(state);
}

/** Tick commun de réflexion (programmé tant qu'une armée a une mission). */
export function ensureTick(state: EngineState): void {
  const c = cmd(state);
  if (c.ticking) return;
  c.ticking = true;
  const p = thinkPeriod(state);
  scheduleMod(state, { t: (Math.floor(state.time / p) + 1) * p, m: 'cmd', e: 'tick' });
}
