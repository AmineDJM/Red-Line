import type { EngineState } from '../state/types.js';
import { schedule } from '../state/access.js';
import type { ModEvent, ModuleId, SharedBoard } from './types.js';

/** Tableau partagé entre modules (créé à la création de partie, complété si absent). */
export function board(state: EngineState): SharedBoard {
  const mods = state.mods as Record<string, unknown>;
  let b = mods.board as SharedBoard | undefined;
  if (!b) {
    b = {
      alertLevel: 5,
      tension: 0,
      embargoed: {},
      sanctions: {},
      noFly: {},
      ceasefires: {},
      stability: {},
      allianceOf: {},
      nuclearAuth: {},
      mobilized: {},
      sites: {},
    };
    mods.board = b;
  }
  b.sites ??= {};
  return b;
}

/** Utilitaires sans dépendance vers les modules (évite les imports circulaires). */

/** État d'un module (créé par son init). */
export function modState<T>(state: EngineState, id: ModuleId): T {
  return state.mods[id] as T;
}

/** Programme un événement de module. */
export function scheduleMod(state: EngineState, ev: ModEvent): void {
  schedule(state, { k: 'mod', t: ev.t, m: ev.m, e: ev.e, d: ev.d });
}
