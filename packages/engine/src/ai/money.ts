import type { NationId } from '@redline/shared';
import type { EngineState } from '../state/types.js';
import { breakdown, budgetDay } from '../modules/eco/budget.js';
import { eco, ecoNation } from '../modules/eco/state.js';
import { aiCfg } from './config.js';

/**
 * Trésorerie de l'IA : elle ne voit que ses propres comptes (grand livre de la veille). Toute dépense
 * de l'IA (production, recherche, chantiers) garde une réserve : quelques jours de budget, plus de quoi
 * couvrir le déficit structurel (entretien supérieur aux revenus) pendant `deficitDays` jours.
 */

/** Postes récurrents du grand livre : revenus et entretien (hors dépenses ponctuelles). */
const RECURRING = [
  'budgetNational',
  'budgetProvincial',
  'trade',
  'mobilization',
  'modifiers',
  'upkeep',
];

/** Solde journalier récurrent (revenus − entretien) ; null hors économie réelle. */
export function netDaily(state: EngineState, n: NationId): number | null {
  if (!eco(state).live) return null;
  const last = ecoNation(state, n).lastDay;
  let net = 0;
  let known = false;
  for (const k of RECURRING) {
    const v = last[k];
    if (v === undefined) continue;
    net += v;
    known = true;
  }
  if (known) return net;
  // Premier jour : pas encore de grand livre, prévision du jour.
  const b = breakdown(state, n);
  return b.total - b.upkeepTotal;
}

/**
 * Réserve que l'IA garde avant toute dépense. `critical` (capitale menacée) : survie d'abord, seule la
 * couverture du déficit reste.
 */
export function aiReserve(state: EngineState, n: NationId, war: boolean, critical = false): number {
  const bd = budgetDay(state, n);
  if (bd <= 0) return 0;
  const c = aiCfg(state.world).economy;
  const net = netDaily(state, n) ?? 0;
  const deficit = net < 0 ? -net * c.deficitDays : 0;
  if (critical) return deficit * 0.5;
  return bd * (war ? c.reserveDaysWar : c.reserveDaysPeace) + deficit;
}
