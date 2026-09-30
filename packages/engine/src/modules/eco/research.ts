import { HOUR, type NationId, type Order, type ResearchNode } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { notify } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { modifier } from '../registry.js';
import { scheduleMod } from '../kit.js';
import { cfg } from './config.js';
import { eco, ecoNation, ecoRt, insertSorted, type Paid } from './state.js';
import { canPay, fail, pay, refund, scaledRes } from './util.js';

/** Nœud disponible dans ce scénario (arbre chargé, ère). */
export function nodeOf(state: EngineState, id: string): ResearchNode | undefined {
  const node = state.world.research?.get(id);
  if (!node) return undefined;
  if (node.eraYear !== undefined && node.eraYear > eco(state).year) return undefined;
  return node;
}

/**
 * Porte de recherche satisfaite : acquise, ou inconnue de l'arbre chargé (signalée au chargement :
 * une porte qu'aucun nœud ne fournit ne bloque pas la production).
 */
export function hasGate(state: EngineState, n: NationId, gate: string): boolean {
  const en = ecoNation(state, n);
  if (binaryHas(en.done, gate)) return true;
  const tree = state.world.research;
  return !!tree && !tree.has(gate);
}

function binaryHas(list: string[], id: string): boolean {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid]!;
    if (v === id) return true;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Produit des effets des nœuds acquis pour une clé (cache par nation). */
export function researchModifier(state: EngineState, n: NationId, key: string): number {
  const tree = state.world.research;
  if (!tree) return 1;
  const rt = ecoRt(state);
  let m = rt.mods.get(n);
  if (!m) {
    m = new Map();
    for (const id of ecoNation(state, n).done) {
      const node = tree.get(id);
      if (!node) continue;
      for (const k of Object.keys(node.effects).sort()) {
        const v = node.effects[k]!;
        if (Number.isFinite(v)) m.set(k, (m.get(k) ?? 1) * v);
      }
    }
    rt.mods.set(n, m);
  }
  return m.get(key) ?? 1;
}

/** Accorde un nœud (fin de recherche, vol, départ). */
export function grantNode(state: EngineState, n: NationId, id: string, announce: boolean): void {
  const en = ecoNation(state, n);
  if (binaryHas(en.done, id)) return;
  insertSorted(en.done, id);
  if (announce) {
    en.doneAt[id] = state.time;
    notify(state, { kind: 'research_complete', time: state.time, nodeId: id }, [n]);
  }
  ecoRt(state).mods.delete(n);
}

function inProgress(state: EngineState, n: NationId, id: string): boolean {
  const en = ecoNation(state, n);
  return en.cur?.id === id || en.queue.some((q) => q.id === id);
}

export function researchOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'research' }>,
): OrderResult {
  const node = nodeOf(state, order.nodeId);
  if (!node) return fail('invalid_target', 'Recherche inconnue dans ce scénario.');
  const en = ecoNation(state, n);
  if (binaryHas(en.done, node.id)) return fail('not_allowed', 'Recherche déjà acquise.');
  if (inProgress(state, n, node.id)) return fail('not_allowed', 'Recherche déjà planifiée.');
  for (const r of node.requires)
    if (!hasGate(state, n, r) && !inProgress(state, n, r)) return fail('research_required');
  if (en.cur && en.queue.length >= cfg(state.world).research.maxQueue) return fail('capacity');
  const paid: Paid = { money: node.cost.money, res: scaledRes(node.cost.resources, 1) };
  const err = canPay(state, n, paid);
  if (err) return fail(err);
  pay(state, n, paid);
  if (en.cur) en.queue.push({ id: node.id, paid });
  else startResearch(state, n, node.id, paid);
  return { ok: true };
}

function startResearch(state: EngineState, n: NationId, id: string, paid: Paid): void {
  const node = state.world.research!.get(id)!;
  const en = ecoNation(state, n);
  const speed = modifier(state, n, 'research.speed');
  const ms =
    (node.durationH * cfg(state.world).research.durationMultiplier * HOUR) /
    (speed > 0 ? speed : 1);
  const v = ++eco(state).seq;
  en.cur = { id, startedAt: state.time, completesAt: state.time + ms, paid, v };
  scheduleMod(state, { t: en.cur.completesAt, m: 'eco', e: 'res', d: { n, v } });
}

/** Démarre la prochaine recherche de la file (les nœuds devenus impossibles sont remboursés). */
function startNext(state: EngineState, n: NationId): void {
  const en = ecoNation(state, n);
  while (!en.cur && en.queue.length > 0) {
    const q = en.queue.shift()!;
    const node = nodeOf(state, q.id);
    if (
      !node ||
      binaryHas(en.done, q.id) ||
      !node.requires.every((r) => hasGate(state, n, r) || inProgress(state, n, r))
    ) {
      refund(state, n, q.paid, 1);
      continue;
    }
    startResearch(state, n, q.id, q.paid);
  }
}

export function onResearchDone(state: EngineState, d: { n: NationId; v: number }): void {
  const en = eco(state).nations[d.n];
  if (!en?.cur || en.cur.v !== d.v) return;
  const id = en.cur.id;
  en.cur = null;
  if (state.nations[d.n]?.alive) grantNode(state, d.n, id, true);
  startNext(state, d.n);
}

export function cancelResearchOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'cancelResearch' }>,
): OrderResult {
  const en = ecoNation(state, n);
  if (en.cur?.id === order.nodeId) {
    refund(state, n, en.cur.paid, cfg(state.world).industry.cancelRefund);
    en.cur = null;
    startNext(state, n);
    return { ok: true };
  }
  const i = en.queue.findIndex((q) => q.id === order.nodeId);
  if (i < 0) return fail('invalid_target', 'Recherche non planifiée.');
  refund(state, n, en.queue[i]!.paid, 1);
  en.queue.splice(i, 1);
  return { ok: true };
}

export function accelerateResearch(state: EngineState, n: NationId, id: string, ms: number) {
  const en = ecoNation(state, n);
  if (!en.cur || en.cur.id !== id) return false;
  en.cur.v = ++eco(state).seq;
  en.cur.completesAt = Math.max(state.time, en.cur.completesAt - ms);
  scheduleMod(state, { t: en.cur.completesAt, m: 'eco', e: 'res', d: { n, v: en.cur.v } });
  return true;
}

/** Nœud volé (renseignement) : accordé ; s'il était planifié, il est retiré et remboursé. */
export function stealNode(state: EngineState, n: NationId, id: string): void {
  if (!state.nations[n] || !state.world.research?.has(id)) return;
  const en = ecoNation(state, n);
  if (en.cur?.id === id) {
    refund(state, n, en.cur.paid, 1);
    en.cur = null;
  }
  const i = en.queue.findIndex((q) => q.id === id);
  if (i >= 0) {
    refund(state, n, en.queue[i]!.paid, 1);
    en.queue.splice(i, 1);
  }
  grantNode(state, n, id, true);
  startNext(state, n);
}
