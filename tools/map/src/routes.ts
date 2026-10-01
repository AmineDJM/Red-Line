/**
 * Réseau de routes des unités terrestres, déduit de la carte déjà générée (provinces.json,
 * cells.json, straits.json) : reproductible et indépendant des sources Natural Earth.
 *
 * Nœuds : la ville de chaque province, son centre s'il est loin de la ville, un port pour les
 * provinces côtières dont la ville n'est pas sur la côte, et un point de passage à chaque frontière
 * entre deux nations. Arêtes : liaisons entre provinces voisines de la même masse continentale (après
 * élagage des liaisons redondantes, pour éviter les toiles d'araignée) et liaisons internes (ville ↔
 * centre, ville ↔ port), tracées sur les cellules H3 terrestres praticables (jamais sur la mer ni sur
 * les zones infranchissables), lissées et légèrement courbées.
 */
import { gridDisk } from 'h3-js';
import {
  bearing,
  destination,
  distanceKm,
  interpolate,
  type CellsFile,
  type LngLat,
  type ProvinceDef,
  type RoadNode,
  type RoutesFile,
  type Strait,
} from '@redline/shared';
import { cellCenter, cellOf, componentSizes, navalCells, nudgeInto } from './cells.js';
import { hash01, round } from './geo.js';

/** Paramètres du réseau (distances en km). */
export const ROUTES = {
  version: 1,
  /** Un centre de province devient un nœud s'il est au moins à cette distance de la ville. */
  centerMinKm: 70,
  /** Pas d'échantillonnage de la vérification « toujours sur la terre praticable ». */
  sampleKm: 4,
  /** Élagage : une liaison est retirée si un détour par un voisin commun n'est pas plus long que ×. */
  detourRatio: 1.22,
  /** Taille minimale d'une étendue d'eau pour qu'un port y donne accès (en cellules). */
  minSeaCells: 150,
  /** Courbure : amplitude relative et bornes de l'écart latéral. */
  bendRatio: 0.07,
  bendMinKm: 1.5,
  bendMaxKm: 14,
  /** Longueur maximale d'un morceau de tracé courbé. */
  pieceKm: 60,
  /** Tolérance de simplification (Douglas-Peucker). */
  simplifyKm: 1.6,
  /** Coût d'une cellule hors des provinces reliées (A*). */
  foreignCost: 3,
  maxExpand: 60000,
} as const;

type Cell = string;

export interface RoutesInput {
  provinces: ProvinceDef[];
  cells: CellsFile;
  straits: Strait[];
}

export interface RoutesStats {
  nodes: Record<RoadNode['kind'], number>;
  edges: number;
  pruned: number;
  repaired: number;
  /** Croisements de tracés restants (non résolus). */
  crossings: number;
  points: number;
}

/** Comparaison de chaînes indépendante de la locale. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function generateRoutes(input: RoutesInput): { file: RoutesFile; stats: RoutesStats } {
  const res = input.cells.res;
  const land = new Map<Cell, string>(Object.entries(input.cells.cells));
  const impassable = new Set(input.cells.impassable ?? []);
  const provById = new Map(input.provinces.map((p) => [p.id, p]));
  const nationOf = (pid: string) => provById.get(pid)?.nationId ?? '';

  const nbCache = new Map<Cell, Cell[]>();
  const nb = (c: Cell): Cell[] => {
    let l = nbCache.get(c);
    if (!l)
      nbCache.set(
        c,
        (l = gridDisk(c, 1)
          .filter((x) => x !== c)
          .sort()),
      );
    return l;
  };
  const centerCache = new Map<Cell, LngLat>();
  const center = (c: Cell): LngLat => {
    let p = centerCache.get(c);
    if (!p) centerCache.set(c, (p = cellCenter(c)));
    return p;
  };

  const r4 = (p: LngLat): LngLat => [round(p[0], 4), round(p[1], 4)];

  // ---- Masses continentales (cellules terrestres praticables contiguës) ----
  const landComp = new Map<Cell, number>();
  let nComp = 0;
  for (const start of [...land.keys()].sort()) {
    if (landComp.has(start)) continue;
    const q = [start];
    landComp.set(start, nComp);
    for (let i = 0; i < q.length; i++)
      for (const n of nb(q[i]!))
        if (land.has(n) && !landComp.has(n)) {
          landComp.set(n, nComp);
          q.push(n);
        }
    nComp++;
  }

  // ---- Mer navigable (même définition que la grille navale du moteur) ----
  const straitCells = input.straits.flatMap((s) => s.seaCells);
  const naval = navalCells(land.keys(), impassable, straitCells, res);
  const seaSize = componentSizes(naval);
  const openSea = (c: Cell) => naval.has(c) && (seaSize.get(c) ?? 0) >= ROUTES.minSeaCells;
  const coastalCell = (c: Cell) => land.has(c) && nb(c).some(openSea);

  const provCells = new Map<string, Cell[]>();
  for (const [c, pid] of [...land].sort((a, b) => cmp(a[0], b[0]))) {
    let l = provCells.get(pid);
    if (!l) provCells.set(pid, (l = []));
    l.push(c);
  }

  // ---- Nœuds ----
  const nodes: RoadNode[] = [];
  const nodeCell: Cell[] = [];
  const addNode = (n: RoadNode): number => {
    nodes.push(n);
    nodeCell.push(cellOf(n.pos, res));
    return nodes.length - 1;
  };
  const provs = [...input.provinces].sort((a, b) => cmp(a.id, b.id));
  const cityNode = new Map<string, number>();
  for (const p of provs) {
    const c = cellOf(p.cityPoint, res);
    const i = addNode({ id: `c:${p.id}`, kind: 'city', pos: p.cityPoint, province: p.id });
    if (land.get(c) !== p.id) throw new Error(`ville hors de sa province : ${p.id}`);
    if (coastalCell(c)) nodes[i]!.port = true;
    cityNode.set(p.id, i);
  }
  const compOfNode = (i: number) => landComp.get(nodeCell[i]!) ?? -1;
  const internal: [number, number, string][] = [];
  /** Nœuds d'une province reliables à ses voisines : la ville, puis le centre. */
  const hubs = new Map<string, number[]>();
  for (const p of provs) {
    const ci = cityNode.get(p.id)!;
    const cc = compOfNode(ci);
    hubs.set(p.id, [ci]);
    const k = cellOf(p.centroid, res);
    // Masse continentale principale de la province (ville sur une île : centre sur le continent).
    const count = new Map<number, number>();
    for (const c of provCells.get(p.id) ?? []) {
      const lc = landComp.get(c)!;
      count.set(lc, (count.get(lc) ?? 0) + 1);
    }
    let main = cc;
    for (const [lc, n] of [...count].sort((x, y) => x[0] - y[0]))
      if (n > (count.get(main) ?? 0)) main = lc;
    if (main !== cc && (count.get(main) ?? 0) >= 3) {
      let pos: LngLat = p.centroid;
      if (land.get(k) !== p.id || landComp.get(k) !== main) {
        let best: { c: Cell; d: number } | null = null;
        for (const c of provCells.get(p.id) ?? []) {
          if (landComp.get(c) !== main) continue;
          const d = distanceKm(center(c), p.centroid);
          if (!best || d < best.d) best = { c, d };
        }
        pos = r4(center(best!.c));
      }
      const i = addNode({ id: `k:${p.id}`, kind: 'center', pos, province: p.id });
      hubs.get(p.id)!.push(i);
    } else if (
      distanceKm(p.centroid, p.cityPoint) >= ROUTES.centerMinKm &&
      land.get(k) === p.id &&
      landComp.get(k) === cc
    ) {
      const i = addNode({ id: `k:${p.id}`, kind: 'center', pos: p.centroid, province: p.id });
      internal.push([ci, i, p.id]);
    }
    if (!nodes[ci]!.port && p.coastal) {
      let best: { c: Cell; d: number } | null = null;
      for (const c of provCells.get(p.id) ?? []) {
        if (landComp.get(c) !== cc || !coastalCell(c)) continue;
        const d = distanceKm(center(c), p.cityPoint);
        if (!best || d < best.d) best = { c, d };
      }
      if (best) {
        const sea = nb(best.c).filter(openSea)[0]!;
        const pos = nudgeInto(interpolate(center(best.c), center(sea), 0.42), best.c, res);
        const i = addNode({ id: `p:${p.id}`, kind: 'port', pos, province: p.id, port: true });
        internal.push([ci, i, p.id]);
      }
    }
  }

  // ---- Tracés ----
  const sampleOk = (pts: LngLat[], ok: (c: Cell) => boolean): boolean => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const n = Math.max(1, Math.ceil(distanceKm(a, b) / ROUTES.sampleKm));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const p = k === 0 ? a : k === n ? b : interpolate(a, b, k / n);
        if (!ok(cellOf(p, res))) return false;
      }
    }
    return true;
  };

  /** A* sur les cellules terrestres de la masse `comp` ; coût majoré hors des provinces `home`. */
  const cellPath = (
    from: Cell,
    to: Cell,
    home: Set<string> | null,
    comp: number,
  ): Cell[] | null => {
    if (from === to) return [from];
    const g = new Map<Cell, number>([[from, 0]]);
    const came = new Map<Cell, Cell>();
    const closed = new Set<Cell>();
    const goal = center(to);
    const open: { c: Cell; f: number }[] = [{ c: from, f: distanceKm(center(from), goal) }];
    const pushOpen = (c: Cell, f: number) => {
      open.push({ c, f });
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        const A = open[i]!;
        const B = open[p]!;
        if (A.f > B.f || (A.f === B.f && A.c >= B.c)) break;
        open[i] = B;
        open[p] = A;
        i = p;
      }
    };
    const popOpen = () => {
      const top = open[0]!;
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= open.length) break;
          let c = l;
          const L = open[l]!;
          const R = open[l + 1];
          if (R && (R.f < L.f || (R.f === L.f && R.c < L.c))) c = l + 1;
          const C = open[c]!;
          const I = open[i]!;
          if (I.f < C.f || (I.f === C.f && I.c <= C.c)) break;
          open[c] = I;
          open[i] = C;
          i = c;
        }
      }
      return top;
    };
    let expanded = 0;
    while (open.length) {
      const { c } = popOpen();
      if (closed.has(c)) continue;
      if (c === to) {
        const path = [c];
        let x = c;
        while (came.has(x)) path.push((x = came.get(x)!));
        return path.reverse();
      }
      closed.add(c);
      if (++expanded > ROUTES.maxExpand) return null;
      const gc = g.get(c)!;
      for (const n of nb(c)) {
        if (closed.has(n) || !land.has(n) || landComp.get(n) !== comp) continue;
        const w = home && !home.has(land.get(n)!) ? ROUTES.foreignCost : 1;
        const t = gc + distanceKm(center(c), center(n)) * w;
        if (t < (g.get(n) ?? Infinity)) {
          g.set(n, t);
          came.set(n, c);
          pushOpen(n, t + distanceKm(center(n), goal));
        }
      }
    }
    return null;
  };

  /** Tirage du fil : sommets du chemin de cellules visibles en ligne droite sur les cellules permises. */
  const pull = (pts: LngLat[], ok: (c: Cell) => boolean): LngLat[] => {
    if (pts.length <= 2) return pts;
    const los = (i: number, j: number) => j === i + 1 || sampleOk([pts[i]!, pts[j]!], ok);
    const last = pts.length - 1;
    const out = [pts[0]!];
    let i = 0;
    while (i < last) {
      let lo = i + 1;
      if (los(i, last)) lo = last;
      else {
        let hi = last;
        for (let step = 2; i + step < last; step *= 2) {
          if (!los(i, i + step)) {
            hi = i + step;
            break;
          }
          lo = i + step;
        }
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (los(i, m)) lo = m;
          else hi = m;
        }
      }
      out.push(pts[lo]!);
      i = lo;
    }
    return out;
  };

  /** Courbure douce : arc sinusoïdal sur chaque segment, sens et amplitude tirés de l'identifiant. */
  const bend = (pts: LngLat[], key: string, scale: number): LngLat[] => {
    const out: LngLat[] = [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = distanceKm(a, b);
      const n = Math.max(1, Math.ceil(len / ROUTES.pieceKm));
      const h = hash01(`${key}#${i}`);
      const sign = h < 0.5 ? -1 : 1;
      const amp =
        scale *
        Math.min(ROUTES.bendMaxKm, Math.max(ROUTES.bendMinKm, len * ROUTES.bendRatio)) *
        (0.55 + 0.9 * Math.abs(h - 0.5));
      for (let k = 1; k < n; k++) {
        const f = k / n;
        const base = interpolate(a, b, f);
        const off = sign * amp * Math.sin(Math.PI * f);
        out.push(destination(base, bearing(base, b) + 90, off));
      }
      out.push(b);
    }
    return out;
  };

  /** Coins adoucis (Chaikin, une passe), extrémités conservées. */
  const chaikin = (pts: LngLat[]): LngLat[] => {
    if (pts.length < 3) return pts;
    const out: LngLat[] = [pts[0]!];
    for (let i = 1; i < pts.length - 1; i++) {
      out.push(interpolate(pts[i]!, pts[i - 1]!, 0.25));
      out.push(interpolate(pts[i]!, pts[i + 1]!, 0.25));
    }
    out.push(pts[pts.length - 1]!);
    return out;
  };

  /** Douglas-Peucker en projection locale (gère l'antiméridien). */
  const simplify = (pts: LngLat[], tolKm: number): LngLat[] => {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop()!;
      const a = pts[s]!;
      const b = pts[e]!;
      const k = Math.cos((a[1] * Math.PI) / 180) * 111.195;
      const wrap = (d: number) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
      const bx = wrap(b[0] - a[0]) * k;
      const by = (b[1] - a[1]) * 111.195;
      const l2 = bx * bx + by * by;
      let best = -1;
      let bestD = tolKm;
      for (let i = s + 1; i < e; i++) {
        const px = wrap(pts[i]![0] - a[0]) * k;
        const py = (pts[i]![1] - a[1]) * 111.195;
        let t = l2 > 0 ? (px * bx + py * by) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - t * bx, py - t * by);
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack.push([s, best], [best, e]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };

  /**
   * Tracé naturel entre deux nœuds, ou null si aucun chemin terrestre. `scale` borne la courbure
   * (1 : arc complet, 0 : tracé tendu) ; renvoie aussi la courbure retenue.
   */
  const trace = (
    a: number,
    b: number,
    home: Set<string> | null,
    key: string,
    scale = 1,
  ): { pts: LngLat[]; scale: number } | null => {
    const comp = compOfNode(a);
    if (comp < 0 || comp !== compOfNode(b)) return null;
    const cells = cellPath(nodeCell[a]!, nodeCell[b]!, home, comp);
    if (!cells) return null;
    const used = new Set(cells);
    const ok = (c: Cell) =>
      used.has(c) || (land.has(c) && landComp.get(c) === comp && (!home || home.has(land.get(c)!)));
    const pa = nodes[a]!.pos;
    const pb = nodes[b]!.pos;
    const raw: LngLat[] = [pa, ...cells.map(center), pb];
    const pulled = pull(raw, ok);
    const tries: [number, (() => LngLat[]) | null][] = [];
    if (scale >= 1) tries.push([1, () => chaikin(bend(pulled, key, 1))]);
    if (scale >= 0.5) tries.push([0.5, () => chaikin(bend(pulled, key, 0.5))]);
    if (scale >= 0.25) tries.push([0.25, () => chaikin(pulled)]);
    tries.push([0, () => pulled], [0, null]);
    for (const [s, make] of tries) {
      const line = make ? simplify(make(), ROUTES.simplifyKm) : raw;
      const pts = line.map((p, i, arr) => (i === 0 ? pa : i === arr.length - 1 ? pb : r4(p)));
      if (sampleOk(pts, ok)) return { pts, scale: s };
    }
    return null;
  };

  const lineKm = (pts: LngLat[]) => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += distanceKm(pts[i - 1]!, pts[i]!);
    return s;
  };
  const nodeNation = (i: number) => nationOf(nodes[i]!.province);

  interface Link {
    a: number;
    b: number;
    home: Set<string> | null;
    key: string;
    scale: number;
    pts: LngLat[];
    km: number;
    /** Nations qu'un détour remplaçant la liaison peut traverser. */
    nations: Set<string>;
    alive: boolean;
  }
  const links: Link[] = [];
  const addLink = (a: number, b: number, home: Set<string> | null, key: string): Link | null => {
    const t = trace(a, b, home, key);
    if (!t) return null;
    const l: Link = {
      a,
      b,
      home,
      key,
      scale: t.scale,
      pts: t.pts,
      km: lineKm(t.pts),
      nations: new Set([nodeNation(a), nodeNation(b)]),
      alive: true,
    };
    links.push(l);
    return l;
  };

  // ---- Liaisons entre provinces voisines ----
  const byPair = new Map<string, Link>();
  const key2 = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const p of provs) {
    for (const qid of [...p.neighbors].sort(cmp)) {
      if (qid <= p.id || !provById.has(qid)) continue;
      // Ville à ville sur la même masse continentale, sinon la paire de nœuds la plus proche.
      const ca = cityNode.get(p.id)!;
      const cb = cityNode.get(qid)!;
      let ends: [number, number] | null =
        compOfNode(ca) >= 0 && compOfNode(ca) === compOfNode(cb) ? [ca, cb] : null;
      let bestD = Infinity;
      for (const x of ends ? [] : hubs.get(p.id)!)
        for (const y of hubs.get(qid)!) {
          if (compOfNode(x) < 0 || compOfNode(x) !== compOfNode(y)) continue;
          const d = distanceKm(nodes[x]!.pos, nodes[y]!.pos);
          if (d < bestD) {
            ends = [x, y];
            bestD = d;
          }
        }
      if (!ends) continue;
      const l = addLink(ends[0], ends[1], new Set([p.id, qid]), key2(p.id, qid));
      if (l) byPair.set(key2(p.id, qid), l);
    }
  }

  // Élagage : de la plus longue à la plus courte, on retire une liaison doublée par un détour court
  // passant par une province de l'une des deux nations (le détour ne traverse pas un pays tiers).
  const nbLive = new Map<string, Set<string>>();
  for (const k of byPair.keys()) {
    const [x, y] = k.split('|') as [string, string];
    for (const [u, v] of [
      [x, y],
      [y, x],
    ] as const) {
      let s = nbLive.get(u);
      if (!s) nbLive.set(u, (s = new Set()));
      s.add(v);
    }
  }
  let pruned = 0;
  for (const [k, c] of [...byPair].sort((x, y) => y[1].km - x[1].km || cmp(x[0], y[0]))) {
    const [pa, pb] = k.split('|') as [string, string];
    let redundant = false;
    for (const r of [...(nbLive.get(pa) ?? [])].sort(cmp)) {
      if (r === pb || !nbLive.get(pb)?.has(r) || !c.nations.has(nationOf(r))) continue;
      const k1 = byPair.get(key2(pa, r))!.km;
      const k2 = byPair.get(key2(r, pb))!.km;
      if (k1 < c.km && k2 < c.km && k1 + k2 <= c.km * ROUTES.detourRatio) {
        redundant = true;
        break;
      }
    }
    if (!redundant) continue;
    c.alive = false;
    nbLive.get(pa)!.delete(pb);
    nbLive.get(pb)!.delete(pa);
    pruned++;
  }

  // ---- Liaisons internes (ville ↔ centre, ville ↔ port) ----
  for (const [a, b, pid] of internal)
    addLink(a, b, new Set([pid]), nodes[b]!.id) ?? addLink(a, b, null, nodes[b]!.id);

  // ---- Croisements : tracé tendu, puis retrait d'une liaison doublée par un détour ----
  const segsOf = (l: Link) => {
    const out: [LngLat, LngLat][] = [];
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const p = l.pts[i]!;
      const q = l.pts[i + 1]!;
      if (Math.abs(q[0] - p[0]) <= 180) out.push([p, q]);
    }
    return out;
  };
  const orient = (p: LngLat, q: LngLat, r: LngLat) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const crosses = (s: [LngLat, LngLat], t: [LngLat, LngLat]) =>
    orient(s[0], s[1], t[0]) * orient(s[0], s[1], t[1]) < 0 &&
    orient(t[0], t[1], s[0]) * orient(t[0], t[1], s[1]) < 0;
  const crossingPairs = (): [number, number][] => {
    const grid = new Map<number, number[]>();
    const segs: { l: number; s: [LngLat, LngLat] }[] = [];
    links.forEach((l, li) => {
      if (!l.alive) return;
      for (const s of segsOf(l)) {
        const j = segs.push({ l: li, s }) - 1;
        const x0 = Math.floor(Math.min(s[0][0], s[1][0]));
        const x1 = Math.floor(Math.max(s[0][0], s[1][0]));
        const y0 = Math.floor(Math.min(s[0][1], s[1][1]));
        const y1 = Math.floor(Math.max(s[0][1], s[1][1]));
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const k = (x + 200) * 400 + (y + 100);
            let list = grid.get(k);
            if (!list) grid.set(k, (list = []));
            list.push(j);
          }
      }
    });
    const found = new Set<string>();
    for (const list of grid.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const A = segs[list[i]!]!;
          const B = segs[list[j]!]!;
          if (A.l === B.l) continue;
          const k = A.l < B.l ? `${A.l}|${B.l}` : `${B.l}|${A.l}`;
          if (!found.has(k) && crosses(A.s, B.s)) found.add(k);
        }
    return [...found]
      .map((k) => k.split('|').map(Number) as [number, number])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  };
  /** Longueur du plus court détour entre a et b sans la liaison `skip` (nations permises), borné. */
  const detourKm = (skip: number, bound: number): number => {
    const L = links[skip]!;
    const adj = new Map<number, [number, number][]>();
    links.forEach((l, i) => {
      if (!l.alive || i === skip) return;
      if (!L.nations.has(nodeNation(l.a)) || !L.nations.has(nodeNation(l.b))) return;
      for (const [u, v] of [
        [l.a, l.b],
        [l.b, l.a],
      ] as const) {
        let x = adj.get(u);
        if (!x) adj.set(u, (x = []));
        x.push([v, l.km]);
      }
    });
    const dist = new Map<number, number>([[L.a, 0]]);
    const done = new Set<number>();
    for (;;) {
      let u = -1;
      let du = Infinity;
      for (const [n, d] of dist)
        if (!done.has(n) && (d < du || (d === du && n < u))) [u, du] = [n, d];
      if (u < 0 || du > bound) return Infinity;
      if (u === L.b) return du;
      done.add(u);
      for (const [v, w] of adj.get(u) ?? [])
        if (du + w < (dist.get(v) ?? Infinity)) dist.set(v, du + w);
    }
  };
  let unresolved = 0;
  for (let round = 0; round < 6; round++) {
    const pairs = crossingPairs();
    unresolved = pairs.length;
    const changed = new Set<number>();
    for (const [i, j] of pairs) {
      if (changed.has(i) || changed.has(j)) continue;
      const [li, si] = links[i]!.km > links[j]!.km ? [i, j] : [j, i];
      let done = false;
      for (const x of [li, si]) {
        const l = links[x]!;
        if (l.scale <= 0) continue;
        const t = trace(l.a, l.b, l.home, l.key, l.scale >= 1 ? 0.25 : 0);
        if (!t) continue;
        Object.assign(l, { pts: t.pts, scale: t.scale, km: lineKm(t.pts) });
        changed.add(x);
        done = true;
        break;
      }
      if (done) continue;
      for (const x of [li, si]) {
        if (detourKm(x, links[x]!.km * 1.6) === Infinity) continue;
        links[x]!.alive = false;
        changed.add(x);
        break;
      }
    }
    if (changed.size === 0) break;
  }

  // Croisements restants : carrefour au point d'intersection (deux tronçons confondus vers un même
  // nœud n'en font plus qu'un).
  const segCross = (s: [LngLat, LngLat], t: [LngLat, LngLat]): number => {
    const dx = s[1][0] - s[0][0];
    const dy = s[1][1] - s[0][1];
    const ex = t[1][0] - t[0][0];
    const ey = t[1][1] - t[0][1];
    const den = dx * ey - dy * ex;
    return den === 0 ? -1 : ((t[0][0] - s[0][0]) * ey - (t[0][1] - s[0][1]) * ex) / den;
  };
  let junctions = 0;
  for (let pass = 0; pass < 12; pass++) {
    const pairs = crossingPairs();
    unresolved = pairs.length;
    if (pairs.length === 0) break;
    const touched = new Set<number>();
    for (const [i, j] of pairs) {
      if (touched.has(i) || touched.has(j)) continue;
      const A = links[i]!;
      const B = links[j]!;
      let hit: { ia: number; ib: number; p: LngLat } | null = null;
      for (let x = 0; x + 1 < A.pts.length && !hit; x++) {
        const s: [LngLat, LngLat] = [A.pts[x]!, A.pts[x + 1]!];
        if (Math.abs(s[1][0] - s[0][0]) > 180) continue;
        for (let y = 0; y + 1 < B.pts.length; y++) {
          const t: [LngLat, LngLat] = [B.pts[y]!, B.pts[y + 1]!];
          if (Math.abs(t[1][0] - t[0][0]) > 180 || !crosses(s, t)) continue;
          const f = segCross(s, t);
          hit = { ia: x, ib: y, p: r4(interpolate(s[0], s[1], f)) };
          break;
        }
      }
      if (!hit || !land.has(cellOf(hit.p, res))) continue;
      // Le carrefour dévie un peu les deux tracés : ils doivent rester sur la terre praticable.
      const onLand = (c: Cell) => land.has(c);
      const p = hit.p;
      const bent = [
        [A.pts[hit.ia]!, p, A.pts[hit.ia + 1]!],
        [B.pts[hit.ib]!, p, B.pts[hit.ib + 1]!],
      ];
      if (!bent.every((l) => sampleOk(l, onLand))) continue;
      const J = addNode({
        id: `j:${nodes[A.a]!.province}|${junctions + 1}`,
        kind: 'junction',
        pos: hit.p,
        province: land.get(cellOf(hit.p, res))!,
      });
      junctions++;
      const split = (L: Link, k: number): [Link, Link] => {
        const base = { home: L.home, scale: 0, nations: L.nations, alive: true };
        const p1 = [...L.pts.slice(0, k + 1), hit!.p];
        const p2 = [hit!.p, ...L.pts.slice(k + 1)];
        return [
          { ...base, a: L.a, b: J, key: `${L.key}<`, pts: p1, km: lineKm(p1) },
          { ...base, a: J, b: L.b, key: `${L.key}>`, pts: p2, km: lineKm(p2) },
        ];
      };
      A.alive = false;
      B.alive = false;
      const parts = [...split(A, hit.ia), ...split(B, hit.ib)];
      // Tronçons confondus (même extrémité) : on garde le plus court.
      const kept: Link[] = [];
      for (const l of parts) {
        const other = l.a === J ? l.b : l.a;
        const dup = kept.findIndex((k) => (k.a === J ? k.b : k.a) === other);
        if (dup < 0) kept.push(l);
        else if (l.km < kept[dup]!.km) kept[dup] = l;
      }
      for (const l of kept) {
        links.push(l);
        touched.add(links.length - 1);
      }
      touched.add(i);
      touched.add(j);
    }
  }

  // ---- Réparation : une seule composante routière par masse continentale ----
  let repaired = 0;
  for (;;) {
    const parent = nodes.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    for (const l of links) if (l.alive) parent[find(l.a)] = find(l.b);
    const byComp = new Map<number, Map<number, number[]>>();
    nodes.forEach((_, i) => {
      const lc = compOfNode(i);
      if (lc < 0) return;
      let m = byComp.get(lc);
      if (!m) byComp.set(lc, (m = new Map()));
      const r = find(i);
      let l = m.get(r);
      if (!l) m.set(r, (l = []));
      l.push(i);
    });
    let added = false;
    for (const lc of [...byComp.keys()].sort((x, y) => x - y)) {
      const groups = [...byComp.get(lc)!.values()].sort((x, y) => x[0]! - y[0]!);
      if (groups.length < 2) continue;
      // Le plus petit groupe est relié au nœud le plus proche d'un autre groupe.
      const g0 = groups.reduce((s, g) => (g.length < s.length ? g : s), groups[0]!);
      let best: { a: number; b: number; d: number } | null = null;
      for (const a of g0)
        for (const g of groups) {
          if (g === g0) continue;
          for (const b of g) {
            const d = distanceKm(nodes[a]!.pos, nodes[b]!.pos);
            if (!best || d < best.d) best = { a, b, d };
          }
        }
      if (process.env.ROUTES_DEBUG)
        console.log(
          `réparation masse ${lc} : ${groups.length} groupes, petit ${g0.length} (${g0
            .slice(0, 6)
            .map((i) => nodes[i]!.id)
            .join(' ')}), ${best && nodes[best.a]!.id} → ${best && nodes[best.b]!.id}`,
        );
      const l = best
        ? addLink(Math.min(best.a, best.b), Math.max(best.a, best.b), null, `r:${best.a}|${best.b}`)
        : null;
      if (!l) throw new Error(`réparation impossible (masse ${lc})`);
      repaired++;
      added = true;
    }
    if (!added) break;
  }

  // ---- Arêtes finales, avec un point de passage à chaque frontière entre nations ----
  const edges: { a: number; b: number; pts: LngLat[] }[] = [];
  const nationAt = (p: LngLat) => nationOf(land.get(cellOf(p, res)) ?? '');
  const usedIds = new Set(nodes.map((n) => n.id));
  for (const c of links.filter((l) => l.alive).sort((x, y) => x.a - y.a || x.b - y.b)) {
    const na = nodeNation(c.a);
    if (na === nodeNation(c.b)) {
      edges.push({ a: c.a, b: c.b, pts: c.pts });
      continue;
    }
    // Premier point hors de la nation de a, affiné par dichotomie (côté a).
    let cut: { i: number; p: LngLat } | null = null;
    for (let i = 0; i + 1 < c.pts.length && !cut; i++) {
      const A = c.pts[i]!;
      const B = c.pts[i + 1]!;
      const n = Math.max(1, Math.ceil(distanceKm(A, B) / 2));
      let prev = 0;
      for (let k = 1; k <= n; k++) {
        if (nationAt(interpolate(A, B, k / n)) === na) {
          prev = k / n;
          continue;
        }
        let lo = prev;
        let hi = k / n;
        for (let it = 0; it < 30; it++) {
          const m = (lo + hi) / 2;
          if (nationAt(interpolate(A, B, m)) === na) lo = m;
          else hi = m;
        }
        const p = r4(interpolate(A, B, lo));
        if (land.has(cellOf(p, res))) cut = { i, p };
        break;
      }
    }
    if (!cut || distanceKm(cut.p, c.pts[0]!) < 3 || distanceKm(cut.p, c.pts.at(-1)!) < 3) {
      edges.push({ a: c.a, b: c.b, pts: c.pts });
      continue;
    }
    let id = `b:${nodes[c.a]!.province}|${nodes[c.b]!.province}`;
    for (let k = 2; usedIds.has(id); k++)
      id = `b:${nodes[c.a]!.province}|${nodes[c.b]!.province}#${k}`;
    usedIds.add(id);
    const prov = land.get(cellOf(cut.p, res))!;
    const m = addNode({ id, kind: 'pass', pos: cut.p, province: prov });
    edges.push({ a: c.a, b: m, pts: [...c.pts.slice(0, cut.i + 1), cut.p] });
    edges.push({ a: m, b: c.b, pts: [cut.p, ...c.pts.slice(cut.i + 1)] });
  }

  edges.sort((x, y) => x.a - y.a || x.b - y.b);
  const file: RoutesFile = {
    version: ROUTES.version,
    nodes,
    edges: edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts.slice(1, -1) })),
  };
  const kinds = { city: 0, center: 0, port: 0, pass: 0, junction: 0 };
  for (const n of nodes) kinds[n.kind]++;
  return {
    file,
    stats: {
      nodes: kinds,
      edges: edges.length,
      pruned,
      repaired,
      crossings: unresolved,
      points: file.edges.reduce((s, e) => s + e.pts.length, 0),
    },
  };
}

/** Écriture compacte et lisible : un nœud ou une arête par ligne. */
export function formatRoutes(f: RoutesFile): string {
  const lines = [`{"version":${f.version},"nodes":[`];
  f.nodes.forEach((n, i) => lines.push(JSON.stringify(n) + (i < f.nodes.length - 1 ? ',' : '')));
  lines.push('],"edges":[');
  f.edges.forEach((e, i) => lines.push(JSON.stringify(e) + (i < f.edges.length - 1 ? ',' : '')));
  lines.push(']}');
  return lines.join('\n') + '\n';
}
