import type { Department, NationId, PlayerView, ResearchView } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { provincesOf, sortedKeys, warsOf } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { nextFloat } from '../../rng/rng.js';
import { board } from '../kit.js';
import { modifier, moduleById } from '../registry.js';
import { cfg, clamp } from './config.js';
import { ist, nat } from './state.js';

// ——— Tirages déterministes ———

/** Tirage uniforme [0, 1) sur le PRNG de l'état. */
export function roll(state: EngineState): number {
  return nextFloat(state.rng);
}

export function pick<T>(state: EngineState, arr: readonly T[]): T {
  return arr[Math.floor(roll(state) * arr.length)]!;
}

/** Hachage déterministe (FNV-1a 32 bits) → [0, 1), sans consommer le PRNG (balayages massifs). */
export function hash01(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// ——— Recherche des autres modules, sans import (lecture de leur vue) ———

let peeking = false;

/**
 * Lit la section « recherche » que le module eco publie dans la vue d'une nation (interface publique
 * des modules, pas d'import croisé). Pas de cache : le résultat ne dépend que de l'état (rejeu exact).
 */
export function researchOf(state: EngineState, n: NationId): ResearchView | null {
  const eco = moduleById('eco');
  if (!eco?.view || peeking) return null;
  const skeleton = {
    time: state.time,
    me: n,
    nations: {},
    provinces: {},
    units: {},
    economy: { money: 0, resources: {}, incomePerDay: { money: 0 }, production: [] },
    victory: { provinceShareTarget: 0, leader: null, winner: null },
  } as unknown as PlayerView;
  peeking = true;
  try {
    eco.view(state, n, skeleton);
    return skeleton.research ?? null;
  } catch {
    return null;
  } finally {
    peeking = false;
  }
}

/** Nœuds de recherche connus d'une nation : ORBAT de départ, signaux, section recherche d'eco. */
export function researchDone(state: EngineState, n: NationId): string[] {
  const out = new Set<string>();
  const set = state.world.orbats?.get(ist(state).orbatSet)?.get(n);
  for (const r of set?.research ?? []) out.add(r);
  for (const r of ist(state).gates[n] ?? []) out.add(r);
  for (const r of researchOf(state, n)?.done ?? []) out.add(r);
  return [...out].sort();
}

// ——— Niveaux, qualité, capacité ———

/**
 * Niveau d'un département : 1 + portes `research.intel.<dept>1..3` acquises. Un modificateur
 * `intel.<dept>.level` supérieur à 1 vaut (valeur − 1) niveaux ; on garde le plus favorable des deux
 * (pas de double compte quand le nœud de recherche porte aussi l'effet).
 */
export function level(
  state: EngineState,
  n: NationId,
  dept: Department,
  done: string[] = researchDone(state, n),
): number {
  let tiers = 0;
  for (let i = 1; i <= 3; i++) if (done.includes(`research.intel.${dept}${i}`)) tiers++;
  const m = modifier(state, n, `intel.${dept}.level`);
  const bonus = m > 1 ? Math.round(m - 1) : 0;
  return 1 + Math.max(tiers, bonus);
}

/** Effet du budget, 0..1 (1/2 au budget de référence). */
export function budgetFactor(state: EngineState, n: NationId, dept: Department): number {
  const ni = nat(state, n);
  const b = Math.max(0, ni.budget[dept] * ni.paid);
  const ref = cfg(state).budgetRefUsdPerDay;
  return b / (b + ref);
}

/** Qualité d'un département, 0..1 : niveau (recherche) et budget. */
export function quality(
  state: EngineState,
  n: NationId,
  dept: Department,
  lvl = level(state, n, dept),
): number {
  return clamp(0.1 + 0.15 * lvl + 0.35 * budgetFactor(state, n, dept), 0.05, 0.95);
}

/** Opérations simultanées : 1 + niveau, × modificateur `intel.capacity`. */
export function capacity(
  state: EngineState,
  n: NationId,
  dept: Department,
  lvl = level(state, n, dept),
): number {
  const m = modifier(state, n, 'intel.capacity');
  return Math.max(1, Math.round((1 + lvl) * m));
}

// ——— Relations ———

export function allied(state: EngineState, a: NationId, b: NationId): boolean {
  if (a === b) return true;
  const al = board(state).allianceOf;
  return !!al[a] && al[a] === al[b];
}

/** Alliés avec lesquels le renseignement est partagé automatiquement (charte intelSharing). */
export function sharingPartners(state: EngineState, n: NationId): NationId[] {
  const b = board(state);
  const aid = b.allianceOf[n];
  if (!aid || !b.intelSharing?.[aid]) return [];
  return state.nationIds.filter(
    (x) => x !== n && b.allianceOf[x] === aid && !!state.nations[x]?.alive,
  );
}

/** Nations voisines (par les provinces). */
export function neighborNations(state: EngineState, n: NationId): NationId[] {
  const w = wi(state.world);
  const out = new Set<NationId>();
  for (const pid of provincesOf(state, n)) {
    for (const q of w.provById.get(pid)?.neighbors ?? []) {
      const o = state.provinces[q]?.owner;
      if (o && o !== n) out.add(o);
    }
  }
  return [...out].sort();
}

/**
 * Nations suivies en priorité par les services : en guerre, qui planifient une guerre contre nous,
 * où nous avons des agents, voisines. Alliés exclus.
 */
export function focusNations(state: EngineState, n: NationId, max: number): NationId[] {
  const out: NationId[] = [];
  const add = (x: NationId): void => {
    if (x === n || out.includes(x) || !state.nations[x]?.alive || allied(state, n, x)) return;
    out.push(x);
  };
  for (const x of warsOf(state, n)) add(x);
  const plans = board(state).warPlans ?? {};
  for (const x of sortedKeys(plans)) if (plans[x]?.includes(n)) add(x);
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.owner === n && (a.state === 'active' || a.state === 'caught' || a.state === 'double'))
      add(a.host);
  }
  for (const x of neighborNations(state, n)) add(x);
  return out.slice(0, max);
}

/** Poids des agents d'une nation chez une autre (officier 1, source 0,5), grillés compris. */
export function agentsIn(state: EngineState, owner: NationId, host: NationId): number {
  const st = ist(state);
  let w = 0;
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.owner !== owner || a.host !== host) continue;
    if (a.state === 'active' || a.state === 'caught' || a.state === 'double')
      w += a.kind === 'officer' ? 1 : 0.5;
  }
  return w;
}

/** Un agent de `owner` chez `host` est-il retourné (ses informations sont alors truquées) ? */
export function doubledIn(state: EngineState, owner: NationId, host: NationId): boolean {
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.owner === owner && a.host === host && a.state === 'double') return true;
  }
  return false;
}
