import {
  distanceKm,
  EARTH_RADIUS_KM,
  HOUR,
  MINUTE,
  type Balance,
  type LngLat,
  type RoadNet,
  type RoadPoint,
  type WeaponSystem,
} from '@redline/shared';
import { astar } from './astar.js';
import type { NavGraph } from './graph.js';
import { smoothRun, type Segment, type SurfaceSegments } from './plan.js';

/**
 * Déplacements des unités terrestres sur le réseau de routes (data/map/routes.json).
 *
 * - La destination est accrochée au point du réseau le plus proche (nœud ou point d'arête) à moins de
 *   `balance.movement.roadSnapKm` ; au-delà, l'ordre est refusé (`off_road`).
 * - Le départ est la position de l'unité, rattachée au réseau par un court segment si elle en est
 *   écartée (unités d'anciennes sauvegardes, positionnées hors réseau : rejoignent la route la plus
 *   proche au prochain ordre, de façon déterministe).
 * - Si la destination est sur une autre masse continentale (ou si la mer est plus rapide), l'unité
 *   gagne un port, embarque, traverse la mer sur la grille navale H3 jusqu'à un port (ou une ville
 *   côtière) et reprend la route : même règles de vitesse et d'embarquement qu'avant.
 *
 * Résultat fonction pure de (système, départ, arrivée, en mer ou non) : mémoïsable, identique bit à bit.
 */

/** Rayon d'accrochage par défaut (km) si l'équilibrage n'en fixe pas. */
export const DEFAULT_ROAD_SNAP_KM = 60;
/** Distance maximale (km) pour rattacher au réseau une unité qui en est écartée. */
const JOIN_MAX_KM = 4000;
/** En deçà (km), une unité est considérée sur le réseau (pas de segment de rattachement). */
const ON_ROAD_KM = 0.05;
/** Ports candidats de chaque côté d'une traversée, et traversées calculées au plus. */
const PORT_CANDIDATES = 6;
const MAX_SEA_SEARCHES = 4;

export function roadSnapKm(balance: Balance): number {
  return balance.movement.roadSnapKm ?? DEFAULT_ROAD_SNAP_KM;
}

/** Traversées port → port mises en cache par grille (géométrie seule, indépendante de la vitesse). */
const seaCache = new WeakMap<NavGraph, Map<string, LngLat[] | null>>();

/** Cellule navigable voisine (ou la cellule elle-même), pour le test de connexité navale. */
function shipNode(g: NavGraph, cell: string): number | null {
  const id = g.node(cell);
  if (g.ship[id] === 1) return id;
  const ring = g.neighbors(id);
  let best = -1;
  for (const n of ring) if (g.ship[n] === 1 && (best < 0 || g.keyLess(n, best))) best = n;
  return best >= 0 ? best : null;
}

/** Trajet maritime entre deux points côtiers (ou en mer), lissé, ou null. */
function seaPath(g: NavGraph, a: LngLat, b: LngLat, cacheKey: string | null): LngLat[] | null {
  let cache = seaCache.get(g);
  if (!cache) seaCache.set(g, (cache = new Map()));
  if (cacheKey !== null) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const ca = g.cellAt(a);
  const cb = g.cellAt(b);
  let out: LngLat[] | null = null;
  const sa = shipNode(g, ca);
  const sb = shipNode(g, cb);
  if (sa !== null && sb !== null && g.shipConnected(sa, sb)) {
    const start = g.node(ca);
    const goal = g.node(cb);
    const path = astar(g, start, goal, {
      mode: 'sea',
      landMsPerRad: EARTH_RADIUS_KM,
      seaMsPerRad: EARTH_RADIUS_KM,
      transitionMs: 0,
    });
    if (path) {
      const pts: LngLat[] = path.map((n, i) =>
        i === 0 ? a : i === path.length - 1 ? b : g.center(n),
      );
      if (path.length === 1) pts.push(b);
      out = smoothRun(g, pts, (c) => g.isShipCell(c));
    }
  }
  if (cacheKey !== null) {
    if (cache.size > 4096) cache.clear();
    cache.set(cacheKey, out);
  }
  return out;
}

interface Option {
  ms: number;
  segs: Segment[];
}

export function roadSegments(
  g: NavGraph,
  roads: RoadNet,
  balance: Balance,
  sys: WeaponSystem,
  from: LngLat,
  to: LngLat,
  atSea: boolean,
): SurfaceSegments {
  if (sys.speedKmh <= 0) return { error: 'not_allowed' };
  const D = roads.snap(to, roadSnapKm(balance));
  if (!D) return { error: 'off_road' };
  const v = sys.speedKmh;
  const vSea = v * balance.movement.embarkedSpeedFactor;
  const embarkMs = balance.movement.embarkMinutes * MINUTE;
  const hours = (km: number, speed: number) => (km / speed) * HOUR;

  const travel = (segs: Segment[], pts: LngLat[], medium: 'land' | 'sea'): void => {
    const speed = medium === 'land' ? v : vSea;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = distanceKm(pts[i]!, pts[i + 1]!);
      if (d < 1e-6) continue;
      segs.push({ from: pts[i]!, to: pts[i + 1]!, dt: hours(d, speed), medium });
    }
  };
  const wait = (segs: Segment[], p: LngLat, medium: 'land' | 'sea'): void => {
    if (embarkMs > 0) segs.push({ from: p, to: p, dt: embarkMs, medium });
  };
  /** Tracé routier entre deux points du réseau (premier point remplacé par `start`). */
  const roadPts = (A: RoadPoint, B: RoadPoint, start: LngLat): LngLat[] | null => {
    const r = roads.route(A, B);
    if (!r) return null;
    const pts = r.pts.slice();
    pts[0] = start;
    return pts;
  };

  let S: RoadPoint | null = null;
  /** Début du trajet : rattachement éventuel au réseau. */
  const head: Segment[] = [];
  let startPos = from;
  if (!atSea) {
    S = roads.snapNearest(from, JOIN_MAX_KM);
    if (!S) return { error: 'unreachable' };
    if (S.d > ON_ROAD_KM) {
      travel(head, [from, S.pos], 'land');
      startPos = S.pos;
    }
  }
  const headMs = head.reduce((s, x) => s + x.dt, 0);

  let best: Option | null = null;
  // 1. Par la route seule (même masse continentale).
  if (S && roads.compOf(S) === roads.compOf(D)) {
    const pts = roadPts(S, D, startPos);
    if (pts) {
      const segs = head.slice();
      travel(segs, pts, 'land');
      best = { ms: segs.reduce((s, x) => s + x.dt, 0), segs };
    }
  }

  // 2. Par la mer : route jusqu'à un port, traversée, route depuis un port (ou débarquement direct).
  // Minorant : au moins la ligne droite et la distance routière aux ports les plus proches, à la
  // plus grande des deux vitesses, plus les attentes aux ports.
  const gc = distanceKm(startPos, D.pos);
  const portD = roads.portDistance(D);
  const portS = S ? roads.portDistance(S) : 0;
  const lowerBound =
    headMs + hours(Math.max(gc, portS + portD), Math.max(v, vSea)) + (S ? 2 : 1) * embarkMs;
  if (Number.isFinite(lowerBound) && (!best || lowerBound < best.ms)) {
    const boundKm = best ? (best.ms / HOUR) * v : Infinity;
    const dD = roads.distancesFrom(D, boundKm);
    const dS = S ? roads.distancesFrom(S, boundKm) : null;
    const pos = (p: number) => roads.nodes[p]!.pos;
    /** Ports atteints, les mieux placés d'abord (route + mer en ligne droite vers l'autre bout). */
    const rank = (reached: Map<number, number>, toward: LngLat): number[] => {
      const list: { p: number; s: number }[] = [];
      for (const [p, km] of reached) {
        if (!roads.nodes[p]!.port) continue;
        list.push({ p, s: hours(km, v) + hours(distanceKm(pos(p), toward), vSea) });
      }
      return list
        .sort((x, y) => x.s - y.s || x.p - y.p)
        .slice(0, PORT_CANDIDATES)
        .map((x) => x.p);
    };
    const destPorts = rank(dD, startPos);
    const startPorts: number[] = dS ? rank(dS, D.pos) : [-1];
    const pairs: { p: number; q: number; est: number }[] = [];
    for (const p of startPorts)
      for (const q of destPorts) {
        if (p === q) continue;
        const a = p < 0 ? startPos : pos(p);
        const est =
          headMs +
          (p < 0 ? 0 : hours(dS!.get(p)!, v) + embarkMs) +
          hours(distanceKm(a, pos(q)), vSea) +
          embarkMs +
          hours(dD.get(q)!, v);
        pairs.push({ p, q, est });
      }
    pairs.sort((x, y) => x.est - y.est || x.p - y.p || x.q - y.q);
    let searches = 0;
    for (const { p, q, est } of pairs) {
      if ((best && est >= best.ms) || searches >= MAX_SEA_SEARCHES) break;
      searches++;
      const a = p < 0 ? startPos : pos(p);
      const sea = seaPath(g, a, pos(q), p < 0 ? null : `${p}|${q}`);
      if (!sea) continue;
      const segs = head.slice();
      if (p >= 0) {
        const r1 = roadPts(S!, roads.nodePoint(p), startPos);
        if (!r1) continue;
        travel(segs, r1, 'land');
        wait(segs, pos(p), 'land'); // embarquement
      }
      travel(segs, sea, 'sea');
      wait(segs, pos(q), 'sea'); // débarquement
      const r2 = roadPts(roads.nodePoint(q), D, pos(q));
      if (!r2) continue;
      travel(segs, r2, 'land');
      const ms = segs.reduce((s, x) => s + x.dt, 0);
      if (!best || ms < best.ms) best = { ms, segs };
    }
  }
  if (!best) return { error: 'unreachable' };
  return { segs: best.segs };
}
