import {
  distanceKm,
  HOUR,
  interpolate,
  MINUTE,
  EARTH_RADIUS_KM,
  type Balance,
  type Leg,
  type LngLat,
  type WeaponSystem,
} from '@redline/shared';
import { gridDisk } from 'h3-js';
import { astar } from './astar.js';
import type { NavGraph } from './graph.js';

export type PlanResult = { legs: Leg[] } | { error: 'unreachable' | 'not_allowed' };

/** Longueur maximale d'un segment lissé, en nombre de cellules du chemin. */
const MAX_SPAN = 64;

/** Grand cercle direct (aéronefs). */
export function planAir(sys: WeaponSystem, from: LngLat, to: LngLat, t0: number): PlanResult {
  if (sys.speedKmh <= 0) return { error: 'not_allowed' };
  const d = distanceKm(from, to);
  if (d < 1e-6) return { legs: [] };
  return { legs: [{ from, to, t0, t1: t0 + (d / sys.speedKmh) * HOUR, medium: 'air' }] };
}

function snapTo(g: NavGraph, cell: string, to: LngLat, ok: (c: string) => boolean): string | null {
  if (ok(cell)) return cell;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of gridDisk(cell, 1).sort()) {
    if (!ok(c)) continue;
    const d = distanceKm(g.center(g.node(c)), to);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Chemin de surface : A* sur la grille H3 (terre avec embarquement automatique, ou mer + détroits),
 * puis lissage en peu de segments de grand cercle en vérifiant le milieu des cellules traversées.
 */
export function planSurface(
  g: NavGraph,
  balance: Balance,
  sys: WeaponSystem,
  from: LngLat,
  to: LngLat,
  t0: number,
): PlanResult {
  if (sys.speedKmh <= 0) return { error: 'not_allowed' };
  const naval = sys.movement === 'sea';
  const okGoal = naval ? (c: string) => g.isShipCell(c) : (c: string) => g.isLandCell(c);
  const startCell = g.cellAt(from);
  const goalCellRaw = g.cellAt(to);
  const goalCell = snapTo(g, goalCellRaw, to, okGoal);
  if (!goalCell) return { error: 'unreachable' };
  const dest: LngLat = goalCell === goalCellRaw ? to : g.center(g.node(goalCell));
  const start = g.node(startCell);
  const goal = g.node(goalCell);

  if (naval) {
    let s = start;
    if (g.ship[s] !== 1) {
      const snapped = snapTo(g, startCell, from, (c) => g.isShipCell(c));
      if (!snapped) return { error: 'unreachable' };
      s = g.node(snapped);
    }
    if (!g.shipConnected(s, goal)) return { error: 'unreachable' };
  }

  const speedMsPerRad = (EARTH_RADIUS_KM / sys.speedKmh) * HOUR;
  const seaFactor = naval ? 1 : balance.movement.embarkedSpeedFactor;
  const embarkMs = naval ? 0 : balance.movement.embarkMinutes * MINUTE;
  const path = astar(g, start, goal, {
    mode: naval ? 'sea' : 'land',
    landMsPerRad: speedMsPerRad,
    seaMsPerRad: speedMsPerRad / seaFactor,
    transitionMs: embarkMs,
  });
  if (!path) return { error: 'unreachable' };

  // Points : départ réel, centres des cellules intermédiaires, arrivée réelle.
  const pts: LngLat[] = path.map((n, i) =>
    i === 0 ? from : i === path.length - 1 ? dest : g.center(n),
  );
  if (path.length === 1) pts.push(dest);
  const nodeOf = (i: number): number => path[Math.min(i, path.length - 1)]!;
  const mediumOf = (i: number): 'land' | 'sea' =>
    naval ? 'sea' : g.land[nodeOf(i)] === 1 ? 'land' : 'sea';

  // Découpage en tronçons de même milieu.
  const runs: { m: 'land' | 'sea'; a: number; b: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const m = mediumOf(i);
    const last = runs[runs.length - 1];
    if (last && last.m === m) last.b = i;
    else runs.push({ m, a: i, b: i });
  }

  const legs: Leg[] = [];
  let t = t0;
  const speedLand = sys.speedKmh;
  const speedSea = sys.speedKmh * seaFactor;
  const travel = (a: LngLat, b: LngLat, medium: 'land' | 'sea'): void => {
    const d = distanceKm(a, b);
    if (d < 1e-6) return;
    const v = medium === 'land' || naval ? speedLand : speedSea;
    const dt = (d / v) * HOUR;
    legs.push({ from: a, to: b, t0: t, t1: t + dt, medium: naval ? 'sea' : medium });
    t += dt;
  };
  const wait = (p: LngLat, medium: 'land' | 'sea'): void => {
    if (embarkMs <= 0) return;
    legs.push({ from: p, to: p, t0: t, t1: t + embarkMs, medium });
    t += embarkMs;
  };

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!;
    let seq: LngLat[];
    if (run.m === 'sea' && !naval) {
      // Tronçon embarqué : du dernier point terrestre au premier point terrestre suivant.
      const a = r > 0 ? run.a - 1 : run.a;
      const b = r < runs.length - 1 ? run.b + 1 : run.b;
      seq = pts.slice(a, b + 1);
      if (r > 0) wait(pts[a]!, 'land'); // embarquement
    } else {
      seq = pts.slice(run.a, run.b + 1);
    }
    const allowed =
      naval
        ? (c: string) => g.isShipCell(c)
        : run.m === 'land'
          ? (c: string) => g.isLandCell(c)
          : (c: string) => !g.isLandCell(c);
    const smooth = smoothRun(g, seq, allowed);
    for (let i = 0; i + 1 < smooth.length; i++) travel(smooth[i]!, smooth[i + 1]!, run.m);
    if (run.m === 'sea' && !naval && r < runs.length - 1) wait(seq[seq.length - 1]!, 'sea'); // débarquement
  }
  return { legs };
}

/** Lissage « string pulling » : recherche exponentielle puis dichotomique du point visible le plus loin. */
function smoothRun(g: NavGraph, pts: LngLat[], allowed: (cell: string) => boolean): LngLat[] {
  if (pts.length <= 2) return pts;
  const fixed = new Set<string>([g.cellAt(pts[0]!), g.cellAt(pts[pts.length - 1]!)]);
  const stepKm = g.edgeKm * 0.75;
  const los = (i: number, j: number): boolean => {
    const a = pts[i]!;
    const b = pts[j]!;
    const d = distanceKm(a, b);
    const n = Math.ceil(d / stepKm);
    for (let k = 1; k < n; k++) {
      const p = interpolate(a, b, k / n);
      const c = g.cellAt(p);
      if (!fixed.has(c) && !allowed(c)) return false;
    }
    return true;
  };
  const out: LngLat[] = [pts[0]!];
  const last = pts.length - 1;
  let i = 0;
  while (i < last) {
    let lo = i + 1;
    let hi = -1;
    let step = 2;
    for (;;) {
      const j = Math.min(last, i + step, i + MAX_SPAN);
      if (j <= lo) break;
      if (los(i, j)) {
        lo = j;
        if (j === last || j - i >= MAX_SPAN) break;
        step *= 2;
      } else {
        hi = j;
        break;
      }
    }
    if (hi !== -1) {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (los(i, mid)) lo = mid;
        else hi = mid;
      }
    }
    out.push(pts[lo]!);
    i = lo;
  }
  return out;
}
