import { DAY, MINUTE, type NationId, type OperationView, type Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { applyOrderImpl } from '../../orders/orders.js';
import { notify } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { mil, nextId, type OpSt } from './state.js';
import { OK, fail, schedule } from './util.js';

/**
 * Opérations combinées (heure H). Chaque étape est un ordre de base appliqué via applyOrder à
 * l'instant hHour + offsetMin, par la nation qui a planifié l'opération, avec les mêmes règles
 * qu'un ordre direct (une étape peut donc échouer : son erreur est conservée). Toutes les étapes
 * doivent tomber dans le futur au moment de la planification.
 */

export function orderOperation(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'operation' }>,
): OrderResult {
  if (o.steps.length === 0) return fail('invalid_target', 'Opération sans étape.');
  const times = o.steps.map((s) => o.hHour + s.offsetMin * MINUTE);
  if (times.some((t) => !(t >= state.time))) {
    return fail('invalid_target', 'L’heure H est trop proche : certaines étapes seraient déjà passées.');
  }
  for (const s of o.steps) {
    const k = (s.order as { kind?: string }).kind;
    if (k === 'operation' || k === 'cancelOperation') {
      return fail('invalid_target', 'Une étape ne peut pas être une opération.');
    }
  }
  const id = nextId(state, 'op');
  const op: OpSt = {
    id,
    owner: n,
    name: o.name,
    hHour: o.hHour,
    status: 'planned',
    steps: o.steps.map((s, i) => ({
      offsetMin: s.offsetMin,
      label: s.label ?? `Étape ${i + 1}`,
      order: s.order,
      status: 'pending',
    })),
    createdAt: state.time,
  };
  mil(state).ops[id] = op;
  o.steps.forEach((_, i) => schedule(state, times[i]!, 'opstep', { op: id, i }));
  notify(state, { kind: 'operation', time: state.time, operationId: id, status: 'planned' }, [n]);
  return OK;
}

export function orderCancelOperation(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'cancelOperation' }>,
): OrderResult {
  const op = mil(state).ops[o.operationId];
  if (!op) return fail('invalid_target', 'Opération inconnue.');
  if (op.owner !== n) return fail('not_owner', 'Cette opération ne vous appartient pas.');
  if (op.status !== 'planned' && op.status !== 'running') {
    return fail('not_allowed', 'Opération déjà terminée.');
  }
  op.status = 'cancelled';
  notify(state, { kind: 'operation', time: state.time, operationId: op.id, status: 'cancelled' }, [n]);
  return OK;
}

export function handleOpStep(state: EngineState, d: { op: string; i: number }): void {
  const op = mil(state).ops[d.op];
  if (!op || (op.status !== 'planned' && op.status !== 'running')) return;
  const step = op.steps[d.i];
  if (!step || step.status !== 'pending') return;
  if (op.status === 'planned') {
    op.status = 'running';
    notify(state, { kind: 'operation', time: state.time, operationId: op.id, status: 'running' }, [op.owner]);
  }
  const res = state.nations[op.owner]?.alive
    ? applyOrderImpl(state, op.owner, step.order as Order)
    : { ok: false, error: 'not_allowed' as const, message: 'Nation vaincue.' };
  if (res.ok) step.status = 'done';
  else {
    step.status = 'failed';
    step.error = res.message ?? res.error ?? 'unknown';
    notify(
      state,
      { kind: 'operation', time: state.time, operationId: op.id, status: `step_failed:${d.i}` },
      [op.owner],
    );
  }
  if (op.steps.every((s) => s.status !== 'pending')) {
    op.status = op.steps.every((s) => s.status === 'failed') ? 'failed' : 'done';
    notify(state, { kind: 'operation', time: state.time, operationId: op.id, status: op.status }, [op.owner]);
  }
}

export function operationsFor(state: EngineState, n: NationId): OperationView[] {
  const ops = mil(state).ops;
  return Object.keys(ops)
    .map((k) => ops[k]!)
    .filter((op) => op.owner === n)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, 30)
    .map((op) => ({
      id: op.id,
      name: op.name,
      hHour: op.hHour,
      status: op.status,
      steps: op.steps.map((s) => {
        const v: OperationView['steps'][number] = {
          offsetMin: s.offsetMin,
          label: s.label,
          status: s.status,
        };
        if (s.error) v.error = s.error;
        return v;
      }),
    }));
}

/** Oubli des opérations terminées depuis plus de 7 jours. */
export function pruneOps(state: EngineState): void {
  const ops = mil(state).ops;
  for (const k of Object.keys(ops).sort()) {
    const op = ops[k]!;
    if (op.status === 'planned' || op.status === 'running') continue;
    const last = op.hHour + Math.max(...op.steps.map((s) => s.offsetMin)) * MINUTE;
    if (state.time - Math.max(last, op.createdAt) > 7 * DAY) delete ops[k];
  }
}
