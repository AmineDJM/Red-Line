import type { EngineState } from '../state/types.js';
import { schedule } from '../state/access.js';
import type { ModEvent, ModuleId } from './types.js';

/** Utilitaires sans dépendance vers les modules (évite les imports circulaires). */

/** État d'un module (créé par son init). */
export function modState<T>(state: EngineState, id: ModuleId): T {
  return state.mods[id] as T;
}

/** Programme un événement de module. */
export function scheduleMod(state: EngineState, ev: ModEvent): void {
  schedule(state, { k: 'mod', t: ev.t, m: ev.m, e: ev.e, d: ev.d });
}
