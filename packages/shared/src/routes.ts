/**
 * Réseau de routes des unités terrestres (façon Conflict of Nations) : nœuds (villes, centres de
 * province, ports, points de passage) reliés par des tracés. Les unités terrestres ne circulent que
 * sur ce réseau ; un ordre vers un point quelconque est accroché au point du réseau le plus proche.
 *
 * Fichier généré par `pnpm --filter @redline/tools-map routes` (data/map/routes.json). Le code de
 * graphe ci-dessous est partagé par le moteur (trajets) et le client (aperçu, accrochage) : purement
 * arithmétique et déterministe (aucun hasard, ordre de parcours et départages intrinsèques).
 */
import { z } from 'zod';
import { EARTH_RADIUS_KM, type LngLat } from './ids.js';
import { distanceKm, interpolate, toVec } from './geo.js';

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const ROAD_NODE_KINDS = ['city', 'center', 'port', 'pass', 'junction'] as const;
export type RoadNodeKind = (typeof ROAD_NODE_KINDS)[number];

export const RoadNodeSchema = z.object({
  /** Identifiant stable : « c:fra-3 » (ville), « k:fra-3 » (centre), « p:fra-3 » (port), « b:… » (passage). */
  id: z.string(),
  kind: z.enum(ROAD_NODE_KINDS),
  pos: lngLat,
  /** Province où se trouve le nœud. */
  province: z.string(),
  /** Point d'embarquement (port, ou ville côtière qui sert de port). */
  port: z.boolean().optional(),
});
export type RoadNode = z.infer<typeof RoadNodeSchema>;

export const RoadEdgeSchema = z.object({
  /** Indices des extrémités dans `nodes`. */
  a: z.number().int().min(0),
  b: z.number().int().min(0),
  /** Points intermédiaires du tracé, de a vers b (extrémités exclues). */
  pts: z.array(lngLat).default([]),
  /** 'ferry' : liaison maritime marquée (absente pour une route terrestre). */
  kind: z.enum(['road', 'ferry']).optional(),
});
export type RoadEdge = z.infer<typeof RoadEdgeSchema>;

export const RoutesFileSchema = z
  .object({
    version: z.number().int(),
    nodes: z.array(RoadNodeSchema),
    edges: z.array(RoadEdgeSchema),
  })
  .superRefine((f, ctx) => {
    f.edges.forEach((e, i) => {
      if (e.a >= f.nodes.length || e.b >= f.nodes.length || e.a === e.b)
        ctx.addIssue({ code: 'custom', message: `arête ${i} : extrémités invalides` });
    });
  });
export type RoutesFile = z.infer<typeof RoutesFileSchema>;

/** Point du réseau : sur une arête (à `along` km de son nœud a), ou exactement sur un nœud. */
export interface RoadPoint {
  edge: number;
  /** Distance depuis le nœud a de l'arête, en km. */
  along: number;
  pos: LngLat;
  /** Nœud exact (−1 si le point est à l'intérieur de l'arête). */
  node: number;
  /** Distance au point demandé (km). */
  d: number;
}

export interface RoadRoute {
  /** Tracé complet, du point de départ au point d'arrivée. */
  pts: LngLat[];
  km: number;
}

/** En deçà de cette distance d'un nœud (km), un point accroché est placé exactement sur le nœud. */
export const ROAD_NODE_SNAP_KM = 1;

const DEG_KM = (Math.PI / 180) * EARTH_RADIUS_KM;

interface EdgeGeom {
  a: number;
  b: number;
  pts: LngLat[];
  /** Distance cumulée (km) à chaque sommet. */
  cum: number[];
  km: number;
  ferry: boolean;
}

/** Tas min (f, id) : départage par identifiant, ordre total donc déterministe. */
class MinHeap {
  private f: number[] = [];
  private id: number[] = [];
  get size(): number {
    return this.id.length;
  }
  private less(i: number, j: number): boolean {
    const a = this.f[i]!;
    const b = this.f[j]!;
    return a < b || (a === b && this.id[i]! < this.id[j]!);
  }
  private swap(i: number, j: number): void {
    const f = this.f[i]!;
    this.f[i] = this.f[j]!;
    this.f[j] = f;
    const d = this.id[i]!;
    this.id[i] = this.id[j]!;
    this.id[j] = d;
  }
  push(id: number, f: number): void {
    this.f.push(f);
    this.id.push(id);
    let i = this.id.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** Renvoie [id, f]. */
  pop(): [number, number] {
    const top: [number, number] = [this.id[0]!, this.f[0]!];
    const lf = this.f.pop()!;
    const li = this.id.pop()!;
    const n = this.id.length;
    if (n > 0) {
      this.f[0] = lf;
      this.id[0] = li;
      let i = 0;
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
    return top;
  }
}

function wrapLng(d: number): number {
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}

/** Graphe des routes, prêt pour l'accrochage et les plus courts chemins. */
export class RoadNet {
  readonly nodes: RoadNode[];
  readonly edges: EdgeGeom[];
  /** Arêtes incidentes à chaque nœud (indices croissants). */
  readonly adj: number[][];
  /** Composante connexe de chaque nœud (routes et liaisons marquées comprises). */
  readonly comp: Int32Array;
  /** Nœuds d'embarquement, triés. */
  readonly ports: number[];
  private readonly nx: Float64Array;
  private readonly ny: Float64Array;
  private readonly nz: Float64Array;
  /** Segments : arête et indice du sommet de départ. */
  private readonly segEdge: Int32Array;
  private readonly segK: Int32Array;
  private readonly segStamp: Int32Array;
  private stamp = 0;
  /** Cases de 1° → segments (indices croissants). */
  private readonly grid = new Map<number, number[]>();
  private readonly nodeGrid = new Map<number, number[]>();
  private readonly idIndex = new Map<string, number>();
  /** Nombre de nœuds sans arête. */
  private readonly isolated: number;

  constructor(file: RoutesFile) {
    this.nodes = file.nodes;
    const n = file.nodes.length;
    this.nx = new Float64Array(n);
    this.ny = new Float64Array(n);
    this.nz = new Float64Array(n);
    file.nodes.forEach((nd, i) => {
      const v = toVec(nd.pos);
      this.nx[i] = v[0];
      this.ny[i] = v[1];
      this.nz[i] = v[2];
      this.idIndex.set(nd.id, i);
      this.addBucket(this.nodeGrid, Math.floor(nd.pos[1]), Math.floor(nd.pos[1]), nd.pos[0], 0, i);
    });
    this.adj = Array.from({ length: n }, () => []);
    this.edges = file.edges.map((e, i) => {
      const pts: LngLat[] = [file.nodes[e.a]!.pos, ...(e.pts ?? []), file.nodes[e.b]!.pos];
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1]! + distanceKm(pts[k - 1]!, pts[k]!));
      this.adj[e.a]!.push(i);
      this.adj[e.b]!.push(i);
      return { a: e.a, b: e.b, pts, cum, km: cum[cum.length - 1]!, ferry: e.kind === 'ferry' };
    });
    let segs = 0;
    for (const e of this.edges) segs += e.pts.length - 1;
    this.segEdge = new Int32Array(segs);
    this.segK = new Int32Array(segs);
    this.segStamp = new Int32Array(segs);
    let s = 0;
    this.edges.forEach((e, i) => {
      for (let k = 0; k + 1 < e.pts.length; k++, s++) {
        this.segEdge[s] = i;
        this.segK[s] = k;
        const p = e.pts[k]!;
        const q = e.pts[k + 1]!;
        const lat0 = Math.floor(Math.min(p[1], q[1]) - 0.05);
        const lat1 = Math.floor(Math.max(p[1], q[1]) + 0.05);
        const span = wrapLng(q[0] - p[0]);
        const lo = Math.min(p[0], p[0] + span);
        this.addBucket(this.grid, lat0, lat1, lo - 0.05, Math.abs(span) + 0.1, s);
      }
    });
    // Composantes connexes.
    this.comp = new Int32Array(n).fill(-1);
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (this.comp[i] !== -1) continue;
      const stack = [i];
      this.comp[i] = c;
      while (stack.length) {
        const u = stack.pop()!;
        for (const ei of this.adj[u]!) {
          const e = this.edges[ei]!;
          const v = e.a === u ? e.b : e.a;
          if (this.comp[v] === -1) {
            this.comp[v] = c;
            stack.push(v);
          }
        }
      }
      c++;
    }
    this.isolated = this.adj.filter((l) => l.length === 0).length;
    this.ports = [];
    for (let i = 0; i < n; i++) if (file.nodes[i]!.port) this.ports.push(i);
  }

  private addBucket(
    grid: Map<number, number[]>,
    lat0: number,
    lat1: number,
    lng: number,
    lngSpan: number,
    item: number,
  ): void {
    const x0 = Math.floor(lng);
    const x1 = Math.floor(lng + lngSpan);
    for (let y = Math.max(-90, lat0); y <= Math.min(89, lat1); y++) {
      for (let x = x0; x <= Math.min(x1, x0 + 359); x++) {
        const key = (y + 90) * 360 + (((x % 360) + 360) % 360);
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        if (list[list.length - 1] !== item) list.push(item);
      }
    }
  }

  /** Parcourt les éléments des cases couvrant le disque (centre p, rayon km), chacun une fois. */
  private visit(
    grid: Map<number, number[]>,
    total: number,
    p: LngLat,
    km: number,
    fn: (item: number) => void,
    stamp?: Int32Array,
  ): void {
    const dLat = km / DEG_KM + 0.01;
    const y0 = Math.max(-90, Math.floor(p[1] - dLat));
    const y1 = Math.min(89, Math.floor(p[1] + dLat));
    const cosMin = Math.min(
      Math.cos((Math.min(90, Math.abs(p[1]) + dLat) * Math.PI) / 180),
      Math.cos((Math.min(90, Math.abs(p[1])) * Math.PI) / 180),
    );
    const dLng = cosMin > 1e-6 ? km / (DEG_KM * cosMin) + 0.01 : 360;
    const all = dLng >= 180;
    const x0 = all ? -180 : Math.floor(p[0] - dLng);
    const x1 = all ? 179 : Math.floor(p[0] + dLng);
    if ((y1 - y0 + 1) * (x1 - x0 + 1) > 6000) {
      for (let i = 0; i < total; i++) fn(i);
      return;
    }
    if (stamp) this.stamp++;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const list = grid.get((y + 90) * 360 + (((x % 360) + 360) % 360));
        if (!list) continue;
        for (const it of list) {
          if (stamp) {
            if (stamp[it] === this.stamp) continue;
            stamp[it] = this.stamp;
          }
          fn(it);
        }
      }
    }
  }

  nodeIndex(id: string): number | undefined {
    return this.idIndex.get(id);
  }

  nodePoint(i: number): RoadPoint {
    const e = this.adj[i]![0] ?? -1;
    const edge = e >= 0 ? this.edges[e]! : null;
    return {
      edge: e,
      along: edge && edge.b === i ? edge.km : 0,
      pos: this.nodes[i]!.pos,
      node: i,
      d: 0,
    };
  }

  /** Composante du point (celle des extrémités de son arête). */
  compOf(p: RoadPoint): number {
    if (p.node >= 0) return this.comp[p.node]!;
    return this.comp[this.edges[p.edge]!.a]!;
  }

  /**
   * Point du réseau le plus proche de p, à moins de maxKm, ou null. Un point à moins de
   * ROAD_NODE_SNAP_KM d'une extrémité est placé exactement sur le nœud.
   */
  snap(p: LngLat, maxKm: number, filter?: (edge: number) => boolean): RoadPoint | null {
    let best: RoadPoint | null = null;
    let bestSeg = -1;
    const k = Math.cos((p[1] * Math.PI) / 180);
    this.visit(
      this.grid,
      this.segEdge.length,
      p,
      maxKm,
      (s) => {
        const ei = this.segEdge[s]!;
        if (filter && !filter(ei)) return;
        const e = this.edges[ei]!;
        const kk = this.segK[s]!;
        const a = e.pts[kk]!;
        const b = e.pts[kk + 1]!;
        const ax = wrapLng(a[0] - p[0]) * k;
        const ay = a[1] - p[1];
        const dx = wrapLng(b[0] - a[0]) * k;
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        // Filtre grossier (projection plane locale) avant le calcul exact.
        const px = ax + t * dx;
        const py = ay + t * dy;
        const approx = Math.sqrt(px * px + py * py) * DEG_KM;
        if (approx > maxKm * 1.05 + 1 || (best && approx > best.d * 1.05 + 1)) return;
        const pos = t === 0 ? a : t === 1 ? b : interpolate(a, b, t);
        const d = distanceKm(p, pos);
        if (d > maxKm) return;
        if (!best || d < best.d || (d === best.d && s < bestSeg)) {
          const segLen = e.cum[kk + 1]! - e.cum[kk]!;
          best = { edge: ei, along: e.cum[kk]! + t * segLen, pos, node: -1, d };
          bestSeg = s;
        }
      },
      this.segStamp,
    );
    // Nœuds isolés (ville d'une petite île sans route) : accrochables aussi.
    if (this.isolated > 0) {
      const iso = this.nearestNode(
        p,
        best ? Math.min(maxKm, (best as RoadPoint).d) : maxKm,
        (i) => this.adj[i]!.length === 0,
      );
      if (iso >= 0) {
        const d = distanceKm(p, this.nodes[iso]!.pos);
        if (!best || d < (best as RoadPoint).d)
          return { edge: -1, along: 0, pos: this.nodes[iso]!.pos, node: iso, d };
      }
    }
    if (!best) return null;
    const r = best as RoadPoint;
    const e = this.edges[r.edge]!;
    if (r.along <= ROAD_NODE_SNAP_KM) return this.onNode(r, e.a, 0, p);
    if (e.km - r.along <= ROAD_NODE_SNAP_KM) return this.onNode(r, e.b, e.km, p);
    return { ...r, pos: [r.pos[0], r.pos[1]] };
  }

  /**
   * Comme snap(), par rayons croissants (le plus proche reste le même) : rapide quand le point est
   * déjà sur le réseau ou tout près, même avec un grand rayon maximal.
   */
  snapNearest(p: LngLat, maxKm: number): RoadPoint | null {
    for (let r = 0.5; ; r *= 8) {
      const hit = this.snap(p, Math.min(r, maxKm));
      if (hit || r >= maxKm) return hit;
    }
  }

  private onNode(r: RoadPoint, node: number, along: number, p: LngLat): RoadPoint {
    const pos = this.nodes[node]!.pos;
    return { edge: r.edge, along, pos, node, d: distanceKm(p, pos) };
  }

  /** Nœud le plus proche de p à moins de maxKm (filtre facultatif), ou −1. */
  nearestNode(p: LngLat, maxKm: number, filter?: (node: number) => boolean): number {
    let best = -1;
    let bestD = Infinity;
    this.visit(this.nodeGrid, this.nodes.length, p, maxKm, (i) => {
      if (filter && !filter(i)) return;
      const d = distanceKm(p, this.nodes[i]!.pos);
      if (d <= maxKm && (d < bestD || (d === bestD && i < best))) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** Point à `s` km du nœud a sur l'arête. */
  pointAt(edge: number, s: number): LngLat {
    const e = this.edges[edge]!;
    if (s <= 0) return e.pts[0]!;
    if (s >= e.km) return e.pts[e.pts.length - 1]!;
    let lo = 0;
    let hi = e.cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (e.cum[m]! <= s) lo = m;
      else hi = m;
    }
    const len = e.cum[hi]! - e.cum[lo]!;
    return len > 0 ? interpolate(e.pts[lo]!, e.pts[hi]!, (s - e.cum[lo]!) / len) : e.pts[lo]!;
  }

  /** Tracé de l'arête entre deux abscisses (dans un sens ou dans l'autre), sommets compris. */
  slice(edge: number, s0: number, s1: number, out: LngLat[]): void {
    const e = this.edges[edge]!;
    push(out, this.pointAt(edge, s0));
    if (s1 >= s0) {
      for (let k = 0; k < e.pts.length; k++) {
        const c = e.cum[k]!;
        if (c > s0 && c < s1) push(out, e.pts[k]!);
      }
    } else {
      for (let k = e.pts.length - 1; k >= 0; k--) {
        const c = e.cum[k]!;
        if (c < s0 && c > s1) push(out, e.pts[k]!);
      }
    }
    push(out, this.pointAt(edge, s1));
  }

  private angleTo(i: number, v: [number, number, number]): number {
    const d = this.nx[i]! * v[0] + this.ny[i]! * v[1] + this.nz[i]! * v[2];
    return Math.acos(Math.max(-1, Math.min(1, d)));
  }

  /** Points de départ d'une recherche : (nœud, coût initial). */
  private sources(p: RoadPoint): [number, number][] {
    if (p.node >= 0) return [[p.node, 0]];
    const e = this.edges[p.edge]!;
    return [
      [e.a, p.along],
      [e.b, e.km - p.along],
    ];
  }

  // Tampons de recherche réutilisés (valides si `stamp` = génération courante) : pas d'allocation de
  // tableaux de la taille du graphe à chaque recherche. Sans effet sur le résultat.
  private gen = 0;
  private bufG = new Float64Array(0);
  private bufVia = new Int32Array(0);
  private bufSeen = new Int32Array(0);
  private bufClosed = new Int32Array(0);

  private begin(): number {
    const n = this.nodes.length;
    if (this.bufG.length !== n) {
      this.bufG = new Float64Array(n);
      this.bufVia = new Int32Array(n);
      this.bufSeen = new Int32Array(n);
      this.bufClosed = new Int32Array(n);
      this.gen = 0;
    }
    if (++this.gen >= 0x7fffffff) {
      this.bufSeen.fill(0);
      this.bufClosed.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  /**
   * Plus court chemin (km) entre deux points du réseau, ou null s'ils ne sont pas reliés. A* sur le
   * graphe, heuristique orthodromique (admissible : un tracé est toujours plus long que la corde).
   * `edgeOk` peut exclure des arêtes (liaisons maritimes marquées, par exemple).
   */
  route(from: RoadPoint, to: RoadPoint, edgeOk?: (edge: number) => boolean): RoadRoute | null {
    if (from.node >= 0 && from.node === to.node) return { pts: [from.pos, to.pos], km: 0 };
    let direct = Infinity;
    if (from.edge === to.edge && from.edge >= 0) direct = Math.abs(to.along - from.along);
    const gen = this.begin();
    const g = this.bufG;
    const via = this.bufVia;
    const seen = this.bufSeen;
    const closed = this.bufClosed;
    const gOf = (i: number) => (seen[i] === gen ? g[i]! : Infinity);
    const toSrc = this.sources(to);
    const extraOf = (u: number): number => {
      let x = Infinity;
      for (const [node, c] of toSrc) if (node === u && c < x) x = c;
      return x;
    };
    const goal = toVec(to.pos);
    const h = (i: number) => this.angleTo(i, goal) * EARTH_RADIUS_KM * 0.999;
    const heap = new MinHeap();
    for (const [node, c] of this.sources(from)) {
      if (c < gOf(node)) {
        g[node] = c;
        seen[node] = gen;
        via[node] = -1;
        heap.push(node, c + h(node));
      }
    }
    let best = Infinity;
    let bestEnd = -1;
    while (heap.size > 0) {
      const [u, f] = heap.pop();
      if (f >= Math.min(best, direct)) break;
      if (closed[u] === gen) continue;
      closed[u] = gen;
      const gu = g[u]!;
      const x = extraOf(u);
      if (gu + x < best) {
        best = gu + x;
        bestEnd = u;
      }
      for (const ei of this.adj[u]!) {
        if (edgeOk && !edgeOk(ei)) continue;
        const e = this.edges[ei]!;
        const v = e.a === u ? e.b : e.a;
        if (closed[v] === gen) continue;
        const gv = gu + e.km;
        if (gv < gOf(v)) {
          g[v] = gv;
          seen[v] = gen;
          via[v] = ei;
          heap.push(v, gv + h(v));
        }
      }
    }
    const pts: LngLat[] = [];
    if (direct <= best && direct < Infinity) {
      push(pts, from.pos);
      this.slice(from.edge, from.along, to.along, pts);
      replaceLast(pts, to.pos);
      if (pts.length === 1) pts.push(to.pos);
      return { pts, km: direct };
    }
    if (bestEnd < 0) return null;
    // Remontée : nœuds et arêtes du dernier au premier.
    const chain: { node: number; edge: number }[] = [];
    let u = bestEnd;
    for (;;) {
      const ei = via[u]!;
      chain.push({ node: u, edge: ei });
      if (ei < 0) break;
      const e = this.edges[ei]!;
      u = e.a === u ? e.b : e.a;
    }
    chain.reverse();
    const first = chain[0]!.node;
    push(pts, from.pos);
    if (from.node < 0) {
      const e = this.edges[from.edge]!;
      this.slice(from.edge, from.along, first === e.a ? 0 : e.km, pts);
    }
    for (let i = 1; i < chain.length; i++) {
      const ei = chain[i]!.edge;
      const e = this.edges[ei]!;
      const fromNode = chain[i - 1]!.node;
      if (fromNode === e.a) this.slice(ei, 0, e.km, pts);
      else this.slice(ei, e.km, 0, pts);
    }
    if (to.node < 0) {
      const e = this.edges[to.edge]!;
      this.slice(to.edge, bestEnd === e.a ? 0 : e.km, to.along, pts);
    }
    push(pts, to.pos);
    replaceLast(pts, to.pos);
    if (pts.length === 1) pts.push(to.pos);
    return { pts, km: best };
  }

  /**
   * Distances routières (km) depuis un point vers les nœuds atteints à moins de maxKm (Dijkstra
   * déterministe), dans l'ordre où ils sont fixés. `edgeOk` comme pour route().
   */
  distancesFrom(
    from: RoadPoint,
    maxKm = Infinity,
    edgeOk?: (edge: number) => boolean,
  ): Map<number, number> {
    const gen = this.begin();
    const g = this.bufG;
    const seen = this.bufSeen;
    const closed = this.bufClosed;
    const out = new Map<number, number>();
    const heap = new MinHeap();
    for (const [node, c] of this.sources(from)) {
      if (seen[node] !== gen || c < g[node]!) {
        g[node] = c;
        seen[node] = gen;
        heap.push(node, c);
      }
    }
    while (heap.size > 0) {
      const [u, f] = heap.pop();
      if (f > maxKm) break;
      if (closed[u] === gen) continue;
      closed[u] = gen;
      out.set(u, f);
      for (const ei of this.adj[u]!) {
        if (edgeOk && !edgeOk(ei)) continue;
        const e = this.edges[ei]!;
        const v = e.a === u ? e.b : e.a;
        const gv = f + e.km;
        if (closed[v] !== gen && (seen[v] !== gen || gv < g[v]!)) {
          g[v] = gv;
          seen[v] = gen;
          heap.push(v, gv);
        }
      }
    }
    return out;
  }

  private portKm: Float64Array | null = null;

  /**
   * Distance routière (km) du point au port le plus proche de sa composante (Infinity sans port) :
   * minorant des trajets amphibies.
   */
  portDistance(p: RoadPoint): number {
    if (!this.portKm) {
      const n = this.nodes.length;
      const d = new Float64Array(n).fill(Infinity);
      const heap = new MinHeap();
      for (const i of this.ports) {
        d[i] = 0;
        heap.push(i, 0);
      }
      while (heap.size > 0) {
        const [u, f] = heap.pop();
        if (f > d[u]!) continue;
        for (const ei of this.adj[u]!) {
          const e = this.edges[ei]!;
          const v = e.a === u ? e.b : e.a;
          if (f + e.km < d[v]!) {
            d[v] = f + e.km;
            heap.push(v, d[v]!);
          }
        }
      }
      this.portKm = d;
    }
    let best = Infinity;
    for (const [node, c] of this.sources(p)) best = Math.min(best, c + this.portKm[node]!);
    return best;
  }
}

function push(out: LngLat[], p: LngLat): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) return;
  out.push(p);
}

function replaceLast(out: LngLat[], p: LngLat): void {
  if (out.length > 1) out[out.length - 1] = p;
}

export function polylineKm(pts: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distanceKm(pts[i - 1]!, pts[i]!);
  return km;
}
