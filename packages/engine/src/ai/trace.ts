import type { NationId, Order } from '@redline/shared';
import type { OrderResult } from '../api.js';
import type { EngineState } from '../state/types.js';
import { applyOrderImpl } from '../orders/orders.js';

/**
 * Point de passage unique des ordres de l'IA (tactique, stratégique, crochets aiThink des modules).
 * Un traceur de diagnostic (banc d'évaluation `bench/ai-eval.ts`) peut s'y brancher : il observe les
 * ordres sans rien modifier, ni l'état ni le tirage aléatoire (aucun effet sur le rejeu).
 */
export type AiTracer = (
  state: EngineState,
  n: NationId,
  order: Order | { kind: string; [k: string]: unknown },
  result: OrderResult,
) => void;

let tracer: AiTracer | null = null;

/** Branche (ou débranche avec null) le traceur des ordres de l'IA. Diagnostic uniquement. */
export function setAiTracer(t: AiTracer | null): void {
  tracer = t;
}

/** Ordre d'une IA, par les mêmes règles qu'un joueur. */
export function aiOrder(state: EngineState, n: NationId, o: Order): OrderResult {
  const r = applyOrderImpl(state, n, o);
  if (tracer) tracer(state, n, o, r);
  return r;
}

/** Signale au traceur une action de l'IA qui ne passe pas par `applyOrder` (opération de renseignement). */
export function aiTrace(
  state: EngineState,
  n: NationId,
  o: { kind: string; [k: string]: unknown },
  r: OrderResult,
): void {
  if (tracer) tracer(state, n, o, r);
}
