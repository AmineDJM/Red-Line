import { DAY, type AiWorldLevelBalance, type NationId } from '@redline/shared';
import type { World } from '../api.js';
import type { EngineState } from '../state/types.js';
import { atWar, sortedKeys } from '../state/access.js';
import { wi } from '../state/world.js';
import { aiCfg } from './config.js';
import { ds, isRegular, stabilityOf } from '../modules/diplo/state.js';
import { lostTo, neighborNations } from './estimate.js';

/**
 * Monde vivant des parties solo : données de rivalités et de blocs (data/balance, section ai.world)
 * indexées une fois par monde, et lectures publiques utilisées par l'IA stratégique (aucune triche :
 * guerres en cours, carte politique, stabilité publique).
 */

export interface Rival {
  t: NationId;
  weight: number;
  motive: string;
  /** Cette nation peut déclencher la guerre contre ce rival (sinon : rivalité défensive). */
  starts: boolean;
}

export interface BlocInfo {
  id: string;
  name: string;
  restraint: number;
  mutualDefense: boolean;
  members: NationId[];
}

interface WorldIndex {
  rivals: Map<NationId, Rival[]>;
  blocs: Map<NationId, BlocInfo[]>;
}

const cache = new WeakMap<World, WorldIndex>();

function index(world: World): WorldIndex {
  let ix = cache.get(world);
  if (ix) return ix;
  const W = aiCfg(world).world;
  const rivals = new Map<NationId, Rival[]>();
  const add = (a: NationId, b: NationId, weight: number, motive: string, starts: boolean) => {
    const l = rivals.get(a) ?? [];
    const cur = l.find((x) => x.t === b);
    if (cur) {
      cur.weight = Math.max(cur.weight, weight);
      cur.starts ||= starts;
    } else l.push({ t: b, weight, motive, starts });
    rivals.set(a, l);
  };
  for (const r of W.rivalries) {
    if (r.a === r.b || r.weight <= 0) continue;
    add(r.a, r.b, r.weight, r.motive, r.initiator !== 'b');
    add(r.b, r.a, r.weight, r.motive, r.initiator !== 'a');
  }
  for (const l of rivals.values()) l.sort((x, y) => (x.t < y.t ? -1 : 1));
  const blocs = new Map<NationId, BlocInfo[]>();
  for (const b of W.blocs) {
    const info: BlocInfo = {
      id: b.id,
      name: b.name || b.id,
      restraint: b.restraint,
      mutualDefense: b.mutualDefense,
      members: [...new Set(b.members)].sort(),
    };
    for (const m of info.members) {
      const l = blocs.get(m) ?? [];
      l.push(info);
      blocs.set(m, l);
    }
  }
  ix = { rivals, blocs };
  cache.set(world, ix);
  return ix;
}

/** Réglages du monde pour le niveau d'une nation. */
export function worldLevel(state: EngineState, n: NationId): AiWorldLevelBalance {
  return aiCfg(state.world).world.levels[state.nations[n]!.aiLevel];
}

export function worldIntensity(state: EngineState): number {
  return aiCfg(state.world).world.intensity;
}

/** Rivaux historiques d'une nation (données). */
export function rivalsOf(state: EngineState, n: NationId): Rival[] {
  return index(state.world).rivals.get(n) ?? [];
}

export function rivalry(state: EngineState, a: NationId, b: NationId): Rival | null {
  return rivalsOf(state, a).find((r) => r.t === b) ?? null;
}

export function blocsOf(state: EngineState, n: NationId): BlocInfo[] {
  return index(state.world).blocs.get(n) ?? [];
}

/** Membres d'un même bloc politique : pas de guerre de choix entre eux (sauf rivalité déclarée). */
export function sameBloc(state: EngineState, a: NationId, b: NationId): boolean {
  const mine = blocsOf(state, a);
  if (mine.length === 0) return false;
  return blocsOf(state, b).some((x) => mine.includes(x));
}

/** Retenue d'une nation (la plus forte de ses blocs) : réduit ses guerres opportunistes ou sans motif. */
export function restraintOf(state: EngineState, n: NationId): number {
  let r = 0;
  for (const b of blocsOf(state, n)) r = Math.max(r, b.restraint);
  return r;
}

/** Nation tenue par une IA (pas un joueur humain), vivante et régulière. */
export function aiNation(state: EngineState, n: NationId): boolean {
  const ns = state.nations[n];
  return !!ns && ns.alive && ns.isAi && !ns.isPlayer && isRegular(state, n);
}

/** Guerres en cours entre deux nations tenues par l'IA. */
export function activeAiWars(state: EngineState): number {
  let c = 0;
  for (const k of sortedKeys(state.wars)) {
    const [a, b] = k.split('|') as [NationId, NationId];
    if (aiNation(state, a) && aiNation(state, b)) c++;
  }
  return c;
}

/**
 * Voisin affaibli (lecture publique) : capitale perdue, stabilité basse, ou en guerre contre une autre
 * nation régulière et en train d'y perdre des provinces.
 */
export function isWeak(state: EngineState, t: NationId, except: NationId): boolean {
  const w = wi(state.world);
  const cap = w.nationById.get(t)?.capitalProvinceId;
  if (cap && state.provinces[cap] && state.provinces[cap]!.owner !== t) return true;
  if (stabilityOf(state, t) < aiCfg(state.world).world.weakStability) return true;
  for (const k of sortedKeys(state.wars)) {
    const [a, b] = k.split('|') as [NationId, NationId];
    const e = a === t ? b : b === t ? a : null;
    if (!e || e === except || !isRegular(state, e)) continue;
    if (lostTo(state, t, e) > 0) return true;
  }
  return false;
}

/**
 * Membres IA des blocs à défense mutuelle de `victim` qui viendraient à son secours contre `aggressor`
 * (voisins de l'un ou de l'autre, en paix avec l'agresseur, hors de ses propres blocs).
 */
export function blocDefenders(
  state: EngineState,
  victim: NationId,
  aggressor: NationId,
): NationId[] {
  const out = new Set<NationId>();
  const nearA = new Set(neighborNations(state, aggressor));
  const nearV = new Set(neighborNations(state, victim));
  for (const b of blocsOf(state, victim)) {
    if (!b.mutualDefense || b.members.includes(aggressor)) continue;
    for (const m of b.members) {
      if (m === victim || m === aggressor || !aiNation(state, m)) continue;
      if (!nearA.has(m) && !nearV.has(m)) continue;
      out.add(m);
    }
  }
  return [...out].sort();
}

/**
 * Tenue des fronts d'une guerre : provinces d'origine de chacun tenues par l'autre (carte publique).
 * Sert à mesurer l'enlisement (rien ne bouge depuis N jours).
 */
export function frontScore(state: EngineState, a: NationId, b: NationId): number {
  return lostTo(state, a, b) * 1000 + lostTo(state, b, a);
}

/** Guerre entre ces deux nations commencée il y a moins de `days` jours. */
export function warYoungerThan(
  state: EngineState,
  a: NationId,
  b: NationId,
  days: number,
): boolean {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  const since = state.wars[k];
  return since !== undefined && state.time - since < days * DAY;
}

/** Paix récente (moins de `days` jours) entre deux nations. */
export function recentPeace(state: EngineState, a: NationId, b: NationId, days: number): boolean {
  if (atWar(state, a, b)) return false;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  const since = ds(state).since[k];
  return since !== undefined && state.time - since < days * DAY;
}
