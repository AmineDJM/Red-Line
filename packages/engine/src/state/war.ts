import { board, callHook } from '../modules/registry.js';
import type { NationId } from '@redline/shared';
import { atWar, nationUnits, provincesOf, warKey } from './access.js';
import { addToIndex, removeFromIndex } from './runtime.js';
import type { EngineState } from './types.js';
import { clearTarget } from '../combat/combat.js';

/**
 * Déclaration de guerre (réciproque). Déclenchée par un ordre d'attaque ou par l'entrée d'une unité
 * dans une cellule d'une province de l'autre nation. Les unités des deux camps réévaluent leurs
 * cibles et les villes des deux camps leurs conditions de capture.
 */
export function declareWar(state: EngineState, a: NationId, b: NationId): void {
  if (a === b || atWar(state, a, b)) return;
  if (!state.nations[a] || !state.nations[b]) return;
  state.wars[warKey(a, b)] = state.time;
  addToIndex(state.rt.enemies, a, b);
  addToIndex(state.rt.enemies, b, a);
  for (const n of [a, b]) {
    for (const uid of nationUnits(state, n)) state.rt.dirtyCombat.add(uid);
    for (const pid of provincesOf(state, n)) state.rt.dirtyCapture.add(pid);
  }
  callHook('onWarDeclared', state, a, b);
}

/**
 * Fin de guerre (paix ou cessez-le-feu, décidée par le module diplo). Les unités abandonnent leurs
 * cibles dans l'autre camp (sinon la poursuite rouvrirait la guerre), puis combats et captures des
 * deux camps sont réévalués.
 */
export function makePeace(state: EngineState, a: NationId, b: NationId): void {
  if (!atWar(state, a, b)) return;
  delete state.wars[warKey(a, b)];
  removeFromIndex(state.rt.enemies, a, b);
  removeFromIndex(state.rt.enemies, b, a);
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const uid of nationUnits(state, x)) {
      const u = state.units[uid]!;
      if (u.target && state.units[u.target]?.owner === y) clearTarget(state, u);
      state.rt.dirtyCombat.add(uid);
    }
    for (const pid of provincesOf(state, x)) state.rt.dirtyCapture.add(pid);
  }
}

/** Droit de passage : `a` peut entrer sur le territoire de `b` sans déclarer la guerre (tableau diplo). */
export function hasPassage(state: EngineState, a: NationId, b: NationId): boolean {
  const until = board(state).passage?.[`${a}>${b}`];
  return until !== undefined && until > state.time;
}
