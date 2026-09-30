import type { GameTime, LngLat, NationId, ProvinceId, SystemId, UnitId } from './ids.js';

/** Trois départements (noms génériques, inspirés du modèle français). */
export const DEPARTMENTS = ['interior', 'exterior', 'military'] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Deux sources, deux onglets de la console. SIGINT inclut l'imagerie (satellites, drones, reco). */
export type IntelSource = 'humint' | 'sigint';

/** Cotation OTAN : fiabilité de la source A (sûre) → F (non évaluable). */
export type SourceReliability = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
/** Crédibilité de l'information 1 (confirmée) → 6 (non évaluable). */
export type InfoCredibility = 1 | 2 | 3 | 4 | 5 | 6;

export type IntelReportKind =
  | 'daily' // note de synthèse quotidienne
  | 'flash' // rapport flash sur un événement important
  | 'order_of_battle' // ordre de bataille ennemi
  | 'intentions' // intentions diplomatiques
  | 'counterintel' // espion démasqué, sabotage détecté
  | 'leak' // fuite
  | 'cyber'
  | 'result'; // résultat d'une opération

/** Action directe proposée par un rapport. */
export type ReportAction =
  | { kind: 'plan_strike'; at: LngLat; unitId?: UnitId }
  | { kind: 'send_recon'; at: LngLat }
  | { kind: 'share'; reportId: string }
  | { kind: 'open_unit'; unitId: UnitId }
  | { kind: 'open_province'; provinceId: ProvinceId };

export interface IntelReport {
  id: string;
  time: GameTime;
  dept: Department;
  source: IntelSource;
  kind: IntelReportKind;
  reliability: SourceReliability;
  credibility: InfoCredibility;
  title: string;
  /** Style note de service : quelques lignes. */
  body: string;
  /** Zone de la carte miniature. */
  at: LngLat | null;
  radiusKm: number;
  /** Unités ou nation concernées (si connues). */
  subject?: {
    nationId?: NationId;
    unitIds?: UnitId[];
    systemIds?: SystemId[];
    provinceId?: ProvinceId;
  };
  actions: ReportAction[];
  /** Partagé par un allié. */
  sharedBy?: NationId;
  /** Information ancienne (au-delà de balance.intel.staleAfterH) : position incertaine. */
  stale?: boolean;
  /**
   * Côté moteur uniquement : vrai si c'est une intoxication. JAMAIS envoyé au client
   * (le client ne voit que la cotation, qu'un bon contre-espionnage rend plus fiable).
   */
}

export type IntelOpKind =
  // HUMINT
  | 'infiltrate_spy'
  | 'recruit_source'
  | 'turn_agent' // retourner un agent ennemi démasqué en agent double
  | 'exfiltrate'
  | 'steal_research'
  | 'sabotage_factory'
  | 'fund_rebels'
  // SIGINT
  | 'listen_area'
  | 'intercept_army'
  | 'jam_area'
  | 'cyber_radar' // radars aveuglés
  | 'cyber_production' // production ralentie
  | 'cyber_orders' // ordres retardés
  // Guerre de l'information
  | 'disinformation' // baisse de stabilité
  | 'leak_plans' // publie des plans volés dans le fil d'actualité
  // Intoxication
  | 'plant_fake_report'
  | 'deploy_decoys'
  | 'fake_radio_traffic'
  // Contre-espionnage (intérieur)
  | 'counterintel_sweep';

export interface IntelOpTarget {
  nationId?: NationId;
  provinceId?: ProvinceId;
  unitId?: UnitId;
  at?: LngLat;
  radiusKm?: number;
}

export interface IntelOpView {
  id: string;
  kind: IntelOpKind;
  dept: Department;
  target: IntelOpTarget;
  startedAt: GameTime;
  completesAt: GameTime;
  status: 'running' | 'success' | 'failed' | 'compromised';
  /** Probabilité estimée affichée au joueur (0..1). */
  estimate: number;
}

export interface AgentView {
  id: string;
  codename: string;
  nationId: NationId; // pays d'implantation
  status: 'active' | 'burned' | 'double' | 'exfiltrated' | 'captured';
  since: GameTime;
  /** Officier traitant infiltré ou source recrutée sur place. */
  kind?: 'officer' | 'source';
}

export interface DepartmentView {
  id: Department;
  level: number;
  budgetPerDay: number;
  /** Opérations simultanées possibles. */
  capacity: number;
  running: number;
}

export interface IntelView {
  departments: DepartmentView[];
  /** Rapports récents (les plus récents d'abord, bornés). */
  reports: IntelReport[];
  operations: IntelOpView[];
  agents: AgentView[];
  /** Agents ennemis démasqués sur notre sol. */
  caughtAgents: { id: string; nationId: NationId; caughtAt: GameTime; turned: boolean }[];
}

/** Coût et durée par opération (data/balance, section intel.ops). */
export interface IntelOpCost {
  dept: Department;
  source: IntelSource;
  money: number;
  durationH: number;
  baseSuccess: number;
  /** Risque d'être démasqué en cas d'échec. */
  exposure: number;
}
