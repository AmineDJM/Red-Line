import type { GameNotification, GameTime } from '@redline/shared';
import { heapPeek, heapPop } from '../queue/heap.js';
import type { GameEvent } from '../queue/events.js';
import type { EngineState } from '../state/types.js';
import { evalPair } from '../encounters/pairs.js';
import { handleArrival, handleLegEnd, handleTerritory } from '../movement/movement.js';
import { handleChase, handleRound } from '../combat/combat.js';
import { handleCaptureComplete } from '../combat/capture.js';
import { handleDailyTick, handleProductionComplete } from '../economy/economy.js';
import { handleAiThink } from '../ai/ai.js';
import { cleanTop, isValid, settle } from './settle.js';
import { setAudience } from '../view/notify.js';
import { dispatchModEvent } from '../modules/registry.js';

function dispatch(state: EngineState, ev: GameEvent): void {
  switch (ev.k) {
    case 'leg':
      return handleLegEnd(state, ev);
    case 'arr':
      return handleArrival(state, ev);
    case 'terr':
      return handleTerritory(state, ev);
    case 'zone':
    case 'contact':
      return evalPair(state, ev.key);
    case 'round':
      return handleRound(state, ev);
    case 'chase':
      return handleChase(state, ev);
    case 'cap':
      return handleCaptureComplete(state, ev);
    case 'prod':
      return handleProductionComplete(state, ev);
    case 'day':
      return handleDailyTick(state);
    case 'ai':
      return handleAiThink(state);
    case 'mod':
      return dispatchModEvent(state, ev);
  }
}

/** Traite tous les événements de date ≤ t dans l'ordre (t, priorité, seq), puis fixe state.time = t. */
export function advanceImpl(state: EngineState, t: GameTime): GameNotification[] {
  if (!(t >= state.time)) t = state.time;
  settle(state);
  for (;;) {
    const top = heapPeek(state.queue);
    if (!top || top.t > t) break;
    heapPop(state.queue);
    if (!isValid(state, top)) continue;
    if (top.t > state.time) state.time = top.t;
    dispatch(state, top);
    settle(state);
  }
  state.time = t;
  cleanTop(state);
  return flushNotifications(state);
}

export function flushNotifications(state: EngineState): GameNotification[] {
  const out: GameNotification[] = [];
  for (const p of state.pending) {
    setAudience(p.n, p.aud);
    out.push(p.n);
  }
  state.pending = [];
  return out;
}

export function nextEventTimeImpl(state: EngineState): GameTime | null {
  cleanTopReadonly(state);
  return heapPeek(state.queue)?.t ?? null;
}

/** Le sommet est maintenu valide par advanceTo/applyOrder ; simple vérification défensive. */
function cleanTopReadonly(state: EngineState): void {
  const top = heapPeek(state.queue);
  if (top && !isValid(state, top)) cleanTop(state);
}
