import type { AlertLevel } from '@redline/shared';
import { notify } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { board } from '../kit.js';
import { signal } from '../registry.js';
import { mil } from './state.js';

/**
 * Niveau d'alerte mondial (façon DEFCON) : 5 calme → 1 crise nucléaire. Il découle de la tension
 * mondiale 0..100 (board.tension), alimentée par le signal `alert` de tous les modules (guerres,
 * frappes, batailles, autorisations et détonations nucléaires…) et qui décroît chaque jour
 * (balance.alert.decayPerDay). Seuils : balance.alert.thresholds (niveaux 4, 3, 2, 1).
 *
 * Règles (appliquées par le module mil) :
 *  - autoriser l'emploi du nucléaire (ordre nuclearAuth) : niveau ≤ military.nuclear.maxAlertForAuth (3) ;
 *  - frappe nucléaire : autorisation + niveau ≤ military.nuclear.maxAlertForStrike (2) ;
 *  - arme antisatellite : niveau ≤ 3.
 * Une détonation porte immédiatement la tension au seuil du niveau 1.
 */

export function thresholds(state: EngineState): number[] {
  return state.world.balance.alert?.thresholds ?? [20, 45, 70, 90];
}

export function levelFor(state: EngineState, tension: number): AlertLevel {
  const th = thresholds(state);
  if (tension >= th[3]!) return 1;
  if (tension >= th[2]!) return 2;
  if (tension >= th[1]!) return 3;
  if (tension >= th[0]!) return 4;
  return 5;
}

/** Ajoute (ou retire) de la tension et met à jour le niveau ; notifie tout le monde s'il change. */
export function addTension(state: EngineState, amount: number): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const b = board(state);
  b.tension = Math.max(0, Math.min(100, b.tension + amount));
  syncLevel(state);
}

export function setTensionAtLeast(state: EngineState, v: number): void {
  const b = board(state);
  if (b.tension >= v) return;
  b.tension = Math.min(100, v);
  syncLevel(state);
}

export function syncLevel(state: EngineState): void {
  const b = board(state);
  const lvl = levelFor(state, b.tension);
  if (lvl === b.alertLevel) return;
  b.alertLevel = lvl;
  const m = mil(state);
  if (m.lastAlert !== lvl) {
    m.lastAlert = lvl;
    notify(state, { kind: 'alert_level', time: state.time, level: lvl }, null);
  }
}

/** Décroissance quotidienne. */
export function decayTension(state: EngineState): void {
  const d = state.world.balance.alert?.decayPerDay ?? 5;
  if (d > 0) addTension(state, -d);
}

/** Émet un signal `alert` (reçu aussi par ce module, qui l'applique). */
export function raiseAlert(state: EngineState, amount: number, reason: string): void {
  if (amount <= 0) return;
  signal(state, 'alert', { amount, reason });
}
