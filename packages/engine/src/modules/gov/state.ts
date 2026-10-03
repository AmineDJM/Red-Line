import {
  GovernmentBalanceSchema,
  type GameTime,
  type GovBudget,
  type GovernmentBalance,
  type GovJournalEntry,
  type GovMissionStatus,
  type GovOffice,
  type GovSkill,
  type LocText,
  type NationId,
  type ProvinceId,
} from '@redline/shared';
import { nextFloat, seedRng, type RngState } from '../../rng/rng.js';
import type { EngineState } from '../../state/types.js';

/**
 * État sérialisable du gouvernement (state.mods.gov). Données JSON uniquement ; toute itération qui
 * influence le résultat se fait dans l'ordre trié des clés. Absent des anciennes sauvegardes : créé à
 * la volée au premier ordre du joueur.
 */

export interface HeadSt {
  id: string;
  /** Rang du candidat dans le vivier du poste (tirage déterministe). */
  idx: number;
  first: string;
  last: string;
  culture: string;
  skills: Record<GovSkill, number>;
  traits: string[];
  since: GameTime;
  /** Jours de coût impayés consécutifs. */
  unpaid: number;
}

export interface PoolSt {
  /** Rangs des candidats proposés (ordre d'arrivée). */
  ids: number[];
  next: number;
  at: GameTime;
}

/** Action en cours lancée par une mission (suivie jusqu'à son aboutissement). */
export interface PendingSt {
  k: 'job' | 'prod' | 'res' | 'op' | 'rep';
  /** Chantier, élément de production, nœud de recherche, opération, "<province>:<bâtiment>". */
  id: string;
  pid?: ProvinceId;
  b?: string;
  lvl?: number;
  /** Lots commandés (production). */
  n?: number;
}

export interface MissionSt {
  id: string;
  office: GovOffice;
  type: string;
  priority: number;
  budget: GovBudget;
  /** Dépensé net (rabais déduits). */
  spent: number;
  /** Enveloppe en part des revenus : crédit cumulé (versé chaque jour). */
  credit: number;
  goal: number;
  done: number;
  pending: PendingSt[];
  status: GovMissionStatus;
  suspended: boolean;
  why?: LocText;
  last?: LocText;
  since: GameTime;
  ended?: GameTime;
  /** Mission retirée par le joueur (historique). */
  cancelled?: boolean;
  resource?: string;
  branch?: string;
  category?: string;
  nationId?: NationId;
  provinceId?: ProvinceId;
  radiusKm?: number;
  /** Rotation des opérations (renseignement). */
  k?: number;
  /**
   * Mission bloquée : prochain examen (économie de calcul). Enveloppe épuisée : au prochain crédit
   * journalier ; manque d'argent ou file pleine : 2 h ; aucun emplacement, aucune cible : 6 h.
   * Effacé par une modification, une reprise, une nomination ou l'aboutissement d'une action.
   */
  retryAt?: GameTime;
}

export interface GovNation {
  heads: Partial<Record<GovOffice, HeadSt>>;
  pools: Partial<Record<GovOffice, PoolSt>>;
  missions: Record<string, MissionSt>;
  history: MissionSt[];
  journal: Partial<Record<GovOffice, GovJournalEntry[]>>;
  /** Version : invalide les réflexions immédiates programmées. */
  v: number;
}

export interface GovState {
  seq: number;
  rng: RngState | null;
  nations: Record<NationId, GovNation>;
  /** Tick de réflexion programmé. */
  ticking: boolean;
}

export function emptyGov(): GovState {
  return { seq: 0, rng: null, nations: {}, ticking: false };
}

/** État du module (créé à la volée : parties antérieures au gouvernement). */
export function gov(state: EngineState): GovState {
  const mods = state.mods as Record<string, unknown>;
  let g = mods.gov as GovState | undefined;
  if (!g) {
    g = emptyGov();
    mods.gov = g;
  }
  return g;
}

/** Lecture sans création (vues, crochets fréquents). */
export function govOpt(state: EngineState): GovState | undefined {
  return (state.mods as Record<string, unknown> | undefined)?.gov as GovState | undefined;
}

export function govNation(state: EngineState, n: NationId): GovNation {
  const g = gov(state);
  let gn = g.nations[n];
  if (!gn)
    g.nations[n] = gn = { heads: {}, pools: {}, missions: {}, history: [], journal: {}, v: 0 };
  return gn;
}

const balCache = new WeakMap<object, GovernmentBalance>();

/** Équilibrage du gouvernement (section `government`, défauts sinon). */
export function govBal(state: EngineState): GovernmentBalance {
  const b = state.world.balance;
  let r = balCache.get(b);
  if (!r) {
    r = GovernmentBalanceSchema.parse(b.government ?? {});
    balCache.set(b, r);
  }
  return r;
}

export function nextGovId(state: EngineState, prefix: string): string {
  return `${prefix}${++gov(state).seq}`;
}

/** PRNG propre au module (choix des titulaires peu experts), sérialisé. */
export function govRoll(state: EngineState): number {
  const g = gov(state);
  if (!g.rng) g.rng = seedRng((state.setup.seed ^ 0x6f0e_77a1) >>> 0);
  return nextFloat(g.rng);
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
