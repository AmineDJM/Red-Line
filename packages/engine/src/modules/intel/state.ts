import {
  DEPARTMENTS,
  type Department,
  type GameTime,
  type IntelOpKind,
  type IntelOpTarget,
  type IntelReport,
  type LngLat,
  type NationId,
  type SystemId,
  type UnitId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';

/**
 * État du module renseignement (state.mods.intel). Données sérialisables uniquement.
 * Les secrets (rapport truqué, agent retourné, leurre) ne quittent jamais cet état : la vue les filtre.
 */

/** Rapport tel que stocké : `fk` = intoxication (JAMAIS envoyé au client). */
export interface StoredReport extends IntelReport {
  fk?: 1;
}

export interface StoredOp {
  id: string;
  kind: IntelOpKind;
  dept: Department;
  target: IntelOpTarget;
  startedAt: GameTime;
  completesAt: GameTime;
  status: 'running' | 'success' | 'failed' | 'compromised';
  estimate: number;
  /** Nation visée (résolue au lancement), agent concerné (retournement, exfiltration). */
  victim?: NationId;
  agentId?: string;
}

/**
 * Agent implanté. `state` est la vérité (moteur) ; le propriétaire ne voit que ce qu'il sait :
 * un agent démasqué discrètement ou retourné reste « actif » à ses yeux, sauf s'il l'a compris (`burned`).
 */
export interface Agent {
  id: string;
  codename: string;
  owner: NationId;
  host: NationId;
  kind: 'officer' | 'source';
  since: GameTime;
  state: 'active' | 'caught' | 'double' | 'captured' | 'exfiltrated';
  /** Le propriétaire sait que l'agent est grillé. */
  burned?: boolean;
  caughtAt?: GameTime;
  turnedAt?: GameTime;
}

export interface Listen {
  id: string;
  owner: NationId;
  at: LngLat;
  r: number;
  until: GameTime;
  lvl: number;
  reported: boolean;
}

export interface Intercept {
  id: string;
  owner: NationId;
  unitId: UnitId;
  until: GameTime;
  /** Dernière destination rapportée (évite les rapports répétés). */
  dest: LngLat | null;
}

export interface Jam {
  id: string;
  owner: NationId;
  at: LngLat;
  r: number;
  until: GameTime;
}

/** Leurre : fausse unité visible des nations trompées comme un contact. */
export interface Decoy {
  id: UnitId;
  owner: NationId;
  sys: SystemId;
  pos: LngLat;
  count: number;
  until: GameTime;
  deceived: NationId[];
  /** Nations qui ont identifié le leurre (elles ne le voient plus). */
  exposed: NationId[];
}

export interface NationIntel {
  budget: Record<Department, number>;
  /** Part du budget effectivement versée au dernier jour (fonds insuffisants). */
  paid: number;
  reports: StoredReport[];
  ops: StoredOp[];
  /** Anti-répétition des rapports flash : clé → dernier instant. */
  flash: Record<string, GameTime>;
  /** Incidents subis depuis la dernière note de sécurité intérieure. */
  log: {
    sabotage: number;
    cyber: number;
    rebels: number;
    caught: number;
    strikes: number;
    /** Installations étrangères découvertes (agents) depuis la dernière note. */
    found: number;
  };
  /** Prochaine réflexion de renseignement de l'IA. */
  aiNext: GameTime;
}

export interface IntelState {
  v: 1;
  next: number;
  orbatSet: string;
  nations: Record<NationId, NationIntel>;
  agents: Record<string, Agent>;
  listens: Record<string, Listen>;
  intercepts: Record<string, Intercept>;
  jams: Record<string, Jam>;
  decoys: Record<string, Decoy>;
  /** Portes de recherche apprises par signal (recherche achevée, vol). */
  gates: Record<NationId, string[]>;
  /**
   * Connaissance des provinces étrangères, par nation observatrice : niveaux 0..3 sur les axes
   * économique (`e`) et militaire (`m`), date de dernière mise à jour (`t`). Entrées non nulles seulement.
   */
  pk: Record<NationId, Record<string, ProvinceKnowledge>>;
}

export interface ProvinceKnowledge {
  e: number;
  m: number;
  t: GameTime;
}

export function newNationIntel(budget: number): NationIntel {
  const b = {} as Record<Department, number>;
  for (const d of DEPARTMENTS) b[d] = budget;
  return {
    budget: b,
    paid: 1,
    reports: [],
    ops: [],
    flash: {},
    log: { sabotage: 0, cyber: 0, rebels: 0, caught: 0, strikes: 0, found: 0 },
    aiNext: 0,
  };
}

export function ist(state: EngineState): IntelState {
  return state.mods.intel as IntelState;
}

/** État renseignement d'une nation (créé à la volée pour une nation ajoutée après coup). */
export function nat(state: EngineState, n: NationId): NationIntel {
  const st = ist(state);
  let ni = st.nations[n];
  if (!ni) ni = st.nations[n] = newNationIntel(0);
  return ni;
}

export function nextId(state: EngineState, prefix: string): string {
  const st = ist(state);
  st.next++;
  return `${prefix}${st.next}`;
}
