import type { NavGraph } from './graph.js';

export interface AstarCosts {
  /** 'land' : toutes les cellules (mer = embarqué) ; 'sea' : cellules navigables seulement. */
  mode: 'land' | 'sea';
  /** ms par radian sur terre (ou en mer pour un navire). */
  landMsPerRad: number;
  /** ms par radian en mer pour une unité terrestre embarquée. */
  seaMsPerRad: number;
  /** Pénalité à chaque transition terre ↔ mer (ms). */
  transitionMs: number;
  /** Nombre maximal de nœuds développés. */
  maxExpand?: number;
}

/** Tas min (f, clé intrinsèque) sur des identifiants de nœuds. */
class OpenHeap {
  private ids: number[] = [];
  private fs: number[] = [];
  constructor(private readonly g: NavGraph) {}
  get size(): number {
    return this.ids.length;
  }
  private less(i: number, j: number): boolean {
    const fi = this.fs[i]!;
    const fj = this.fs[j]!;
    if (fi !== fj) return fi < fj;
    return this.g.keyLess(this.ids[i]!, this.ids[j]!);
  }
  private swap(i: number, j: number): void {
    const a = this.ids[i]!;
    this.ids[i] = this.ids[j]!;
    this.ids[j] = a;
    const f = this.fs[i]!;
    this.fs[i] = this.fs[j]!;
    this.fs[j] = f;
  }
  push(id: number, f: number): void {
    this.ids.push(id);
    this.fs.push(f);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const id = this.ids[0]!;
    const f = this.fs[0]!;
    const lastId = this.ids.pop()!;
    const lastF = this.fs.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        let c = l;
        if (l + 1 < n && this.less(l + 1, l)) c = l + 1;
        if (!this.less(c, i)) break;
        this.swap(c, i);
        i = c;
      }
    }
    return [id, f];
  }
}

/**
 * A* sur la grille H3. Coût = temps de parcours (ms) selon le milieu, plus une pénalité à chaque
 * embarquement/débarquement. Heuristique admissible : distance orthodromique au plus rapide.
 * Renvoie la suite de nœuds de start à goal, ou null.
 */
export function astar(g: NavGraph, start: number, goal: number, costs: AstarCosts): number[] | null {
  if (start === goal) return [start];
  const maxExpand = costs.maxExpand ?? 400_000;
  const fastest = costs.mode === 'land' ? Math.min(costs.landMsPerRad, costs.seaMsPerRad) : costs.landMsPerRad;
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const open = new OpenHeap(g);
  gScore.set(start, 0);
  open.push(start, g.angle(start, goal) * fastest);
  let expanded = 0;
  while (open.size > 0) {
    const [u, f] = open.pop();
    if (closed.has(u)) continue;
    const gu = gScore.get(u)!;
    if (f > gu + g.angle(u, goal) * fastest + 1e-6) continue; // entrée périmée
    if (u === goal) {
      const path = [u];
      let c = u;
      while (came.has(c)) {
        c = came.get(c)!;
        path.push(c);
      }
      return path.reverse();
    }
    closed.add(u);
    if (++expanded > maxExpand) return null;
    const uLand = g.land[u] === 1;
    for (const v of g.neighbors(u)) {
      if (closed.has(v)) continue;
      if (g.blocked[v] === 1 && g.ship[v] !== 1) continue;
      const vLand = g.land[v] === 1;
      let cost: number;
      if (costs.mode === 'sea') {
        if (g.ship[v] !== 1 && v !== goal) continue;
        cost = g.angle(u, v) * costs.landMsPerRad;
      } else if (uLand && vLand) {
        cost = g.angle(u, v) * costs.landMsPerRad;
      } else if (!uLand && !vLand) {
        cost = g.angle(u, v) * costs.seaMsPerRad;
      } else {
        cost = g.angle(u, v) * costs.seaMsPerRad + costs.transitionMs;
      }
      const tentative = gu + cost;
      const prev = gScore.get(v);
      if (prev !== undefined && tentative >= prev) continue;
      gScore.set(v, tentative);
      came.set(v, u);
      open.push(v, tentative + g.angle(v, goal) * fastest);
    }
  }
  return null;
}
