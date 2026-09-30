import {
  fromVec,
  legAt,
  type GameNotification,
  type Leg,
  type LngLat,
  type NationId,
  type UnitId,
  type Vec3,
  type WeaponSystem,
} from '@redline/shared';
import { heapPush } from '../queue/heap.js';
import { PRIORITY, type EventInput, type GameEvent } from '../queue/events.js';
import { posAt, trajectoryPieces, type Piece } from '../geo/sphere.js';
import type { EngineState, Unit } from './types.js';

export function sortedKeys(o: object): string[] {
  return Object.keys(o).sort();
}

export function sortedSet<T extends string>(s: Iterable<T> | undefined): T[] {
  return s ? [...s].sort() : [];
}

export function sysOf(state: EngineState, u: Unit): WeaponSystem {
  const s = state.world.catalog.get(u.sys);
  if (!s) throw new Error(`système inconnu : ${u.sys}`);
  return s;
}

/** Programme un événement ; renvoie son numéro de séquence. */
export function schedule(state: EngineState, ev: EventInput): number {
  const s = ++state.seq;
  const full = { ...ev, p: PRIORITY[ev.k], s } as GameEvent;
  heapPush(state.queue, full);
  return s;
}

export function unitPieces(state: EngineState, u: Unit): Piece[] {
  let p = state.rt.geom.get(u.id);
  if (!p) {
    p = trajectoryPieces(u.pos, u.move);
    state.rt.geom.set(u.id, p);
  }
  return p;
}

export function unitVecAt(state: EngineState, u: Unit, t: number): Vec3 {
  return posAt(unitPieces(state, u), t);
}

export function unitPosAt(state: EngineState, u: Unit, t: number): LngLat {
  if (!u.move) return u.pos;
  return fromVec(unitVecAt(state, u, t));
}

/** Segment courant (null si immobile ou trajet terminé). */
export function currentLeg(u: Unit, t: number): Leg | null {
  if (!u.move) return null;
  const leg = legAt(u.move, t);
  if (!leg || t >= leg.t1) return null;
  return leg;
}

export function isMoving(u: Unit, t: number): boolean {
  return currentLeg(u, t) !== null || (u.move !== null && (u.move.legs[0]?.t0 ?? 0) > t);
}

/** Unité terrestre actuellement embarquée en mer. */
export function isEmbarked(state: EngineState, u: Unit, t: number): boolean {
  const leg = currentLeg(u, t);
  return !!leg && leg.medium === 'sea' && sysOf(state, u).movement === 'land';
}

export function warKey(a: NationId, b: NationId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function atWar(state: EngineState, a: NationId, b: NationId): boolean {
  return a !== b && state.wars[warKey(a, b)] !== undefined;
}

export function warsOf(state: EngineState, n: NationId): NationId[] {
  return sortedSet(state.rt.enemies.get(n));
}

/** Provinces possédées par une nation, triées. */
export function provincesOf(state: EngineState, n: NationId): string[] {
  return sortedSet(state.rt.provsOf.get(n));
}

export function nationUnits(state: EngineState, n: NationId): UnitId[] {
  return sortedSet(state.rt.byNation.get(n));
}

export function notify(state: EngineState, n: GameNotification, aud: NationId[] | null): void {
  if (state.rt.silent) return;
  state.pending.push({ n, aud: aud ? [...new Set(aud)].sort() : null });
}

/** Niveau d'observation courant d'une unité par une nation (0 = non vue). */
export function sightLevel(state: EngineState, n: NationId, uid: UnitId): number {
  const c = state.sight[n]?.[uid];
  if (!c) return 0;
  return c[2] > 0 ? 3 : c[1] > 0 ? 2 : c[0] > 0 ? 1 : 0;
}

export function veterancyLevel(state: EngineState, xp: number): number {
  let lvl = 0;
  for (const th of state.world.balance.combat.veterancyXp) if (xp >= th) lvl++;
  return lvl;
}
