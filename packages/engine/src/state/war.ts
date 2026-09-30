import type { NationId } from '@redline/shared';
import { atWar, nationUnits, sortedKeys, warKey } from './access.js';
import type { EngineState } from './types.js';

/**
 * Déclaration de guerre (réciproque). Déclenchée par un ordre d'attaque ou par l'entrée d'une unité
 * dans une cellule d'une province de l'autre nation. Les unités des deux camps réévaluent leurs
 * cibles et les villes des deux camps leurs conditions de capture.
 */
export function declareWar(state: EngineState, a: NationId, b: NationId): void {
  if (a === b || atWar(state, a, b)) return;
  if (!state.nations[a] || !state.nations[b]) return;
  state.wars[warKey(a, b)] = state.time;
  for (const n of [a, b]) for (const uid of nationUnits(state, n)) state.rt.dirtyCombat.add(uid);
  for (const pid of sortedKeys(state.provinces)) {
    const owner = state.provinces[pid]!.owner;
    if (owner === a || owner === b) state.rt.dirtyCapture.add(pid);
  }
}
