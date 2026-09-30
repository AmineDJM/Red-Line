import type { GameEvent } from './events.js';

/** Ordre total (temps, priorité, séquence). */
export function eventLess(a: GameEvent, b: GameEvent): boolean {
  if (a.t !== b.t) return a.t < b.t;
  if (a.p !== b.p) return a.p < b.p;
  return a.s < b.s;
}

/** Tas binaire min stocké dans un tableau simple (sérialisable tel quel). */
export function heapPush(heap: GameEvent[], ev: GameEvent): void {
  heap.push(ev);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const p = heap[parent]!;
    if (!eventLess(ev, p)) break;
    heap[i] = p;
    i = parent;
  }
  heap[i] = ev;
}

export function heapPop(heap: GameEvent[]): GameEvent | undefined {
  const n = heap.length;
  if (n === 0) return undefined;
  const top = heap[0]!;
  const last = heap.pop()!;
  if (n === 1) return top;
  let i = 0;
  const len = heap.length;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= len) break;
    const r = l + 1;
    let c = l;
    if (r < len && eventLess(heap[r]!, heap[l]!)) c = r;
    if (!eventLess(heap[c]!, last)) break;
    heap[i] = heap[c]!;
    i = c;
  }
  heap[i] = last;
  return top;
}

export function heapPeek(heap: GameEvent[]): GameEvent | undefined {
  return heap[0];
}
