import {
  DEPARTMENTS,
  type AgentCover,
  type IntelSource,
  type OrbatEstimate,
  type ThreatIndicator,
  type BuildingType,
  type Department,
  type GameTime,
  type IntelOpKind,
  type IntelOpTarget,
  type IntelReport,
  type LngLat,
  type NationId,
  type ProvinceId,
  type SystemId,
  type UnitId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import type { InteriorState } from './interior.js';

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
  /** Reconnaissance d'un pays entier (absent : opération en une fois, ou mission d'avant les phases). */
  rn?: NationRecon;
  /** Préparation repérée par la sécurité intérieure de la cible (JAMAIS envoyé au client). */
  dt?: 1;
}

/**
 * Déroulement d'une reconnaissance de pays : `n` phases au total, `w` écoulées, `ok` abouties, provinces
 * couvertes (ordre de couverture) et installations découvertes par province (rapport final).
 */
export interface NationRecon {
  n: number;
  w: number;
  ok: number;
  pids: ProvinceId[];
  found: [ProvinceId, BuildingType[]][];
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
  /** Couverture (absente : diplomatique pour un officier, non officielle pour une source). */
  cv?: AgentCover;
  /** Accès : 0 rue, 1 ministère, 2 état-major (absent : 0). */
  ac?: number;
  /** Fiabilité perçue par le propriétaire, 0..1 (absente : valeur de départ). */
  rl?: number;
  /** Expulsé (couverture diplomatique) plutôt qu'emprisonné. */
  ex?: 1;
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
  /** Renseignement intérieur (priorité, sites protégés, menace) ; absent = réglages par défaut. */
  int?: InteriorState;
  /** Capteurs en service (recalculés chaque jour) : écoute, imagerie, guerre électronique. */
  sx?: { s: number; i: number; e: number };
  /** Décryptage des communications de chaque nation, 0..1. */
  cr?: Record<NationId, number>;
  /** Évaluations par nation (dossiers) : forces, menace, intentions, économie, technologie. */
  ev?: Record<NationId, Assessment>;
  /** Sites durcis contre le sabotage jusqu'à cette date. */
  hd?: GameTime;
}

/**
 * Ce que les services d'une nation croient savoir d'une autre. Les intentions peuvent être truquées
 * (`fk`, intoxication, agent double) : le drapeau ne sort jamais du moteur.
 */
export interface Assessment {
  /** Dernière mise à jour. */
  t: GameTime;
  /** Indice de menace courant et de la veille, dernière alerte stratégique. */
  th: number;
  tp?: number;
  al?: GameTime;
  ind: ThreatIndicator[];
  /** Ordre de bataille estimé. */
  ob?: OrbatEstimate;
  /** Intentions : nations visées par des plans de guerre, source, qualité 0..1, date. */
  pl?: { t: GameTime; v: NationId[]; s: IntelSource; q: number; fk?: 1 };
  /** Économie : trésor estimé. */
  ec?: { t: GameTime; m: [number, number] };
  /** Technologie : recherche en cours connue, niveau de service estimé. */
  te?: { t: GameTime; r?: string; l?: number };
  /** Trafic de commandement en hausse (interception récente). */
  cm?: GameTime;
  /** Chiffrement estimé de ses communications (0..1). */
  en?: number;
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
