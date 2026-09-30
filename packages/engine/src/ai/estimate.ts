import type { NationId } from '@redline/shared';
import type { Contact, EngineState } from '../state/types.js';
import { nationUnits, sortedKeys } from '../state/access.js';
import { wi } from '../state/world.js';
import { board } from '../modules/registry.js';

/**
 * Estimations de rapport de force SANS tricher : une nation connaît ses propres unités, ses contacts
 * (brouillard de guerre : `state.know`) et la carte politique publique (nombre de provinces, alliances).
 * Pour le reste, elle suppose que l'adversaire a autant de forces par province qu'elle-même (hypothèse
 * miroir), majorée par la prudence du niveau de l'IA.
 */

/** Valeur d'un élément de système (prix unitaire : bon indicateur de puissance relative). */
function elementValue(state: EngineState, sysId: string): number {
  const s = state.world.catalog.get(sysId);
  if (!s) return 0;
  return Math.max(1, s.cost.money / Math.max(1, s.unitSize));
}

export interface OwnForce {
  value: number;
  perProvince: number;
  avgUnit: number;
}

export function ownForce(state: EngineState, n: NationId): OwnForce {
  let value = 0;
  let count = 0;
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    value += elementValue(state, u.sys) * u.count * (u.hp / Math.max(1, u.maxHp));
    count++;
  }
  const provs = Math.max(1, state.nations[n]!.provinceCount);
  return { value, perProvince: value / provs, avgUnit: count > 0 ? value / count : 1 };
}

/**
 * Mémo des forces connues par nation observée, actif pendant une réflexion stratégique
 * (withForceMemo) et invalidé à chaque ordre donné (invalidateForceMemo) : entre deux ordres, les
 * contacts de la nation ne changent pas. Un seul parcours trié des contacts cumule toutes les nations
 * dans le même ordre d'additions que le parcours filtré d'origine : sommes identiques bit à bit.
 */
let memoOn = false;
let memo: { state: EngineState; n: NationId; mine: OwnForce; known: Map<NationId, number> } | null =
  null;

export function withForceMemo(fn: () => void): void {
  if (memoOn) {
    fn();
    return;
  }
  memoOn = true;
  try {
    fn();
  } finally {
    memoOn = false;
    memo = null;
  }
}

export function invalidateForceMemo(): void {
  memo = null;
}

function contactValue(state: EngineState, c: Contact, mine: OwnForce): number {
  if (c.lvl >= 2 && c.sys) {
    const sys = state.world.catalog.get(c.sys);
    const count = c.lvl >= 3 && c.count !== null ? c.count : (sys?.unitSize ?? 1);
    return elementValue(state, c.sys) * count * (c.hpr ?? 1);
  }
  return mine.avgUnit;
}

function knownForce(state: EngineState, n: NationId, t: NationId, mine: OwnForce): number {
  const k = state.know[n];
  if (memoOn) {
    if (!memo || memo.state !== state || memo.n !== n || memo.mine !== mine) {
      const known = new Map<NationId, number>();
      if (k) {
        for (const id of sortedKeys(k)) {
          const c = k[id]!;
          known.set(c.owner, (known.get(c.owner) ?? 0) + contactValue(state, c, mine));
        }
      }
      memo = { state, n, mine, known };
    }
    return memo.known.get(t) ?? 0;
  }
  let known = 0;
  if (k) {
    for (const id of sortedKeys(k)) {
      const c = k[id]!;
      if (c.owner !== t) continue;
      known += contactValue(state, c, mine);
    }
  }
  return known;
}

/** Force estimée de `t` du point de vue de `n`. */
export function estimateForce(
  state: EngineState,
  n: NationId,
  t: NationId,
  mine: OwnForce,
  caution: number,
): number {
  const known = knownForce(state, n, t, mine);
  const tn = state.nations[t];
  const mirror = (tn?.provinceCount ?? 0) * mine.perProvince;
  return Math.max(known, mirror) * caution;
}

/** Membres de l'alliance de `t` liés par la défense mutuelle (charte publique), hors `t` et hors `except`. */
export function mutualAllies(state: EngineState, t: NationId, except: NationId): NationId[] {
  const b = board(state);
  const id = b.allianceOf[t];
  if (!id || !b.allianceCharters?.[id]?.mutualDefense) return [];
  return state.nationIds.filter(
    (m) => m !== t && m !== except && b.allianceOf[m] === id && state.nations[m]!.alive,
  );
}

/** Nations voisines (provinces adjacentes), carte publique. */
export function neighborNations(state: EngineState, n: NationId): NationId[] {
  return adjacency(state).get(n) ?? [];
}

/**
 * Voisinages de toutes les nations, recalculés seulement quand la carte politique change (version
 * `ownerV` tenue par le module diplo). Le cache est une fonction pure de l'état : aucun effet sur le
 * déterminisme ni sur le rejeu.
 */
const adjCache = new WeakMap<EngineState, { v: number; map: Map<NationId, NationId[]> }>();

function ownerVersion(state: EngineState): number {
  const d = (state.mods as Record<string, { ownerV?: number } | undefined>).diplo;
  return d?.ownerV ?? -1;
}

export function adjacency(state: EngineState): Map<NationId, NationId[]> {
  const v = ownerVersion(state);
  const hit = adjCache.get(state);
  if (hit && hit.v === v && v >= 0) return hit.map;
  const w = wi(state.world);
  const sets = new Map<NationId, Set<NationId>>();
  for (const pid of sortedKeys(state.provinces)) {
    const o = state.provinces[pid]!.owner;
    if (!w.nationById.has(o)) continue;
    for (const nb of w.provById.get(pid)!.neighbors) {
      const x = state.provinces[nb]?.owner;
      if (!x || x === o || !w.nationById.has(x)) continue;
      let s = sets.get(o);
      if (!s) sets.set(o, (s = new Set()));
      s.add(x);
    }
  }
  const map = new Map<NationId, NationId[]>();
  for (const [k, s] of sets) map.set(k, [...s].sort());
  adjCache.set(state, { v, map });
  return map;
}

/** Provinces d'origine de `n` désormais tenues par `by`. */
export function lostTo(state: EngineState, n: NationId, by: NationId): number {
  let c = 0;
  for (const pid of wi(state.world).provsByNation.get(n) ?? [])
    if (state.provinces[pid]?.owner === by) c++;
  return c;
}
