import { heapPeek, heapPop } from '../queue/heap.js';
import type { GameEvent } from '../queue/events.js';
import type { EngineState } from '../state/types.js';
import { refreshCombat } from '../combat/combat.js';
import { evaluateCapture } from '../combat/capture.js';
import { refillUnlimited } from '../state/unlimited.js';

/** Un événement est-il encore d'actualité (invalidation paresseuse par version) ? */
export function isValid(state: EngineState, ev: GameEvent): boolean {
  switch (ev.k) {
    case 'leg':
    case 'arr':
    case 'terr':
      return state.units[ev.u]?.mv === ev.v;
    case 'zone':
    case 'contact':
      return state.pairs[ev.key]?.ev === ev.s;
    case 'round': {
      const u = state.units[ev.u];
      return !!u && u.engaged && u.cv === ev.v;
    }
    case 'chase':
      return state.units[ev.u]?.chaseEv === ev.s;
    case 'cap':
      return state.provinces[ev.prov]?.capture?.v === ev.v;
    case 'prod':
      return !!state.nations[ev.n]?.production.some((it) => it.id === ev.id);
    case 'day':
    case 'ai':
    case 'mod':
      return true;
  }
}

/** Retire les événements périmés du sommet : le sommet est toujours valide entre deux appels. */
export function cleanTop(state: EngineState): void {
  for (;;) {
    const top = heapPeek(state.queue);
    if (!top || isValid(state, top)) return;
    heapPop(state.queue);
  }
}

/**
 * Propage les conséquences d'un changement jusqu'au point fixe : combats (cibles, rounds, poursuites)
 * puis captures. Chaque passe traite les identifiants dans l'ordre trié.
 */
export function settle(state: EngineState): void {
  const rt = state.rt;
  let guard = 0;
  while (rt.dirtyCombat.size > 0 || rt.dirtyCapture.size > 0) {
    if (++guard > 100_000) throw new Error('settle : pas de point fixe');
    if (rt.dirtyCombat.size > 0) {
      const ids = [...rt.dirtyCombat].sort();
      rt.dirtyCombat.clear();
      for (const id of ids) refreshCombat(state, id);
      continue;
    }
    const provs = [...rt.dirtyCapture].sort();
    rt.dirtyCapture.clear();
    for (const p of provs) evaluateCapture(state, p);
  }
  // Mode illimité : réserve remise au plafond après chaque événement, ordre ou commande système.
  if (state.unl) refillUnlimited(state);
}
