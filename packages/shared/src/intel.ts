import type { GameTime, LngLat, NationId, ProvinceId, SystemId, UnitId } from './ids.js';
import type { Category } from './catalog.js';
import type { LocText } from './i18n.js';
import type { InteriorIntelView } from './domestic.js';

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
  /** Titre localisable (le client traduit ; `title` reste le français, le corps aussi). */
  loc?: { title?: LocText };
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
  | 'counterintel_sweep'
  // Reconnaissance ciblée (connaissance progressive des provinces étrangères)
  | 'recon_economic' // révèle les installations économiques (cible : nation ou province)
  | 'recon_military' // révèle les installations militaires (cible : nation ou province)
  // ——— Profondeur : SIGINT ———
  | 'cryptanalysis' // décryptage progressif du chiffrement d'une nation
  | 'intercept_comms' // interception des communications d'une nation (ordres, préparatifs, intentions)
  | 'geolocate_emitters' // géolocalisation des émetteurs (radars, défense aérienne, PC)
  // ——— Profondeur : HUMINT ———
  | 'cultivate_source' // élever l'accès d'un agent (ministère, puis état-major)
  | 'vet_agents' // vérifier ses agents dans un pays (détection des agents doubles)
  // ——— Profondeur : renseignement militaire ———
  | 'designate_targets' // analyse d'imagerie et désignation des cibles d'une province
  // ——— Profondeur : renseignement intérieur ———
  | 'dismantle_network' // démantèlement du réseau d'une nation sur notre sol
  | 'deception_plan' // faux plans transmis aux services adverses
  | 'harden_sites'; // protection renforcée contre le sabotage (quelques jours)

export interface IntelOpTarget {
  nationId?: NationId;
  provinceId?: ProvinceId;
  unitId?: UnitId;
  at?: LngLat;
  radiusKm?: number;
  /** Couverture d'un agent infiltré (défaut : diplomatique). */
  cover?: AgentCover;
  /** Agent visé (culture d'une source). */
  agentId?: string;
}

/** Couverture d'un agent : diplomatique (expulsion) ou non officielle (arrestation, crise). */
export type AgentCover = 'diplomatic' | 'nonofficial';
/** Accès d'une source : rue (renseignement d'ambiance), ministère (budget, recherche), état-major (plans). */
export const AGENT_ACCESS = ['street', 'ministry', 'staff'] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

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
  /**
   * Reconnaissance d'un pays entier (cible nation) : phases écoulées sur le total, phases abouties,
   * provinces couvertes jusqu'ici. Absent pour les autres opérations.
   */
  recon?: { waves: number; done: number; ok: number; provinces: number };
}

/** Missions de reconnaissance (cible : une province, ou un pays entier). */
export const RECON_OPS = ['recon_military', 'recon_economic'] as const;
export type ReconOpKind = (typeof RECON_OPS)[number];

/**
 * Niveau de connaissance (0..3) à partir duquel une province est considérée comme « révélée » sur un axe
 * (bonne connaissance) : décompte « n provinces révélées sur N » d'un pays.
 */
export const RECON_KNOWN_LEVEL = 2;

export interface AgentView {
  id: string;
  codename: string;
  nationId: NationId; // pays d'implantation
  status: 'active' | 'burned' | 'double' | 'exfiltrated' | 'captured' | 'expelled';
  since: GameTime;
  /** Officier traitant infiltré ou source recrutée sur place. */
  kind?: 'officer' | 'source';
  /** Couverture, accès et fiabilité perçue (cotation A..F) de l'agent. */
  cover?: AgentCover;
  access?: AgentAccess;
  reliability?: SourceReliability;
}

/** Fourchette estimée [bas, haut]. */
export type Range = [number, number];

/** Ordre de bataille estimé d'une nation (renseignement militaire). */
export interface OrbatEstimate {
  time: GameTime;
  total: Range;
  cats: { category: Category; range: Range }[];
}

/** Indicateurs d'alerte d'un théâtre (clés traduites par le client). */
export type ThreatIndicator =
  | 'war' // en guerre
  | 'massing' // concentration de forces près de nos frontières
  | 'plans' // plans de guerre contre nous (renseignement)
  | 'comms' // trafic de commandement en hausse (interceptions)
  | 'mobilization' // production d'armement en hausse
  | 'covert'; // opérations clandestines attribuées

/** Dossier pays : tout ce que nos services savent d'une nation (estimations, jamais la vérité brute). */
export interface NationDossier {
  nationId: NationId;
  updatedAt: GameTime;
  /** Indice d'imminence d'une attaque contre nous, 0..100, et tendance depuis la veille. */
  threat: number;
  trend: -1 | 0 | 1;
  indicators: ThreatIndicator[];
  /** Alerte stratégique en cours (seuil franchi). */
  alert?: boolean;
  forces?: OrbatEstimate;
  /** Intentions connues (interceptions décryptées, sources d'état-major). */
  intentions?: {
    time: GameTime;
    plansAgainst: NationId[];
    source: IntelSource;
    reliability: SourceReliability;
  };
  /** Économie (sources au ministère) : trésor estimé. */
  economy?: { time: GameTime; money: Range };
  /** Technologie : programme de recherche en cours (sources), niveaux de service estimés. */
  tech?: { time: GameTime; research?: string; services?: number };
  /** Décryptage de ses communications (0..1) et chiffrement estimé (0..1). */
  crypto: number;
  encryption: number;
  /** Agents actifs chez elle et meilleur accès. */
  agents: number;
  access?: AgentAccess;
  /** Fiabilité d'ensemble du dossier. */
  reliability: SourceReliability;
}

/** Capteurs et moyens d'écoute d'une nation (matériels en service). */
export interface SigintView {
  /** Écoute électronique (satellites et appareils SIGINT/ELINT). */
  sigint: number;
  /** Imagerie (satellites optiques et radar, drones et avions de reconnaissance). */
  imagery: number;
  /** Guerre électronique (brouilleurs). */
  ew: number;
  /** Bonus de capteurs appliqué aux opérations (0..1). */
  bonus: number;
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
  /** Renseignement intérieur : priorité, sites protégés, menace par province, effets du budget. */
  interior?: InteriorIntelView;
  /** Capteurs d'écoute et d'imagerie en service. */
  sensors?: SigintView;
  /** Dossiers pays (synthèse, carte des menaces), triés par menace décroissante. */
  dossiers?: NationDossier[];
  /** Sites durcis contre le sabotage jusqu'à cette date. */
  hardenedUntil?: GameTime;
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
