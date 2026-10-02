import type { GameTime, LngLat, NationId, ProvinceId, RealTime, SystemId, UnitId } from './ids.js';
import type { MovementKind, Resource } from './catalog.js';
import type { BuildingType } from './map.js';
import type {
  BuildOptionView,
  BuildingView,
  EconomyDetailView,
  LicenceView,
  LogisticsView,
  MarketView,
  ResearchView,
  SupplyState,
} from './economy.js';
import type {
  AlertLevel,
  BattleReportSummary,
  BlockadeView,
  FortificationView,
  GeneralView,
  MissionView,
  OperationView,
  SatellitePassView,
} from './military.js';
import type { IntelView } from './intel.js';
import type { LocText } from './i18n.js';
import type { DomesticView } from './domestic.js';
import type { CommandView } from './command.js';
import type { CouncilView, DiplomacyView, NewsItem, Relation, StabilityView } from './diplomacy.js';

/** Un segment de trajet en grand cercle, parcouru à vitesse constante entre t0 et t1. */
export interface Leg {
  from: LngLat;
  to: LngLat;
  t0: GameTime;
  t1: GameTime;
  medium: Exclude<MovementKind, 'static'>;
}

/** Trajet complet. Position à l'instant t : voir `positionAt` (geo.ts). */
export interface Movement {
  legs: Leg[];
}

export type UnitStance = 'hold' | 'defend' | 'aggressive';
export type UnitStatus = 'idle' | 'moving' | 'combat' | 'embarked' | 'destroyed';

/**
 * Niveaux d'information sur une unité.
 * 'own' : unité du joueur (tout est connu).
 * 'precise' : type, effectif et état connus. 'identified' : type connu. 'detected' : présence seule.
 */
export type InfoLevel = 'own' | 'precise' | 'identified' | 'detected';

export interface UnitView {
  id: UnitId;
  owner: NationId;
  level: InfoLevel;
  /** Position au début du trajet (ou position fixe si pas de trajet). */
  pos: LngLat;
  move?: Movement;
  /** Dernière observation (temps de jeu). Pour les unités 'own', égal au temps courant. */
  lastSeen: GameTime;
  /** Rayon d'incertitude sur la position, en km (0 si observée à l'instant). */
  uncertaintyKm: number;
  systemId?: SystemId; // >= identified
  count?: number; // >= precise
  hpRatio?: number; // >= precise, 0..1
  status?: UnitStatus; // >= precise
  stance?: UnitStance; // own
  xp?: number; // own
  /** Cible d'attaque en cours (own). */
  targetId?: UnitId | null;
  // ——— Phases 2+ (tous optionnels) ———
  /** Ravitaillement (own). */
  supply?: SupplyState;
  /** Mission aérienne ou navale (own). */
  mission?: MissionView;
  /** Niveau de vétérance 0..3 (own ou precise). */
  veterancy?: number;
  /** Général qui commande l'unité (own). */
  generalId?: string | null;
  /** Brouilleur actif (own, ou precise si détecté). */
  jamming?: boolean;
  /** Missile en vol : cible et impact prévu (own ; ou ennemi détecté par un radar d'alerte). */
  missile?: { target: import('./military.js').StrikeTarget; impactAt: GameTime } | null;
  /** Leurre (vrai uniquement côté propriétaire ; un ennemi ne le sait pas). */
  decoy?: boolean;
  /**
   * Défense antiaérienne (own) : intercepteurs disponibles, magasin plein, et instant où le magasin
   * sera de nouveau plein (rechargement progressif), null s'il l'est.
   */
  airDefense?: { ammo: number; max: number; fullAt: GameTime | null };
  /** Unité rebelle, neutre de maintien de la paix, ou mercenaire. */
  affiliation?: 'regular' | 'rebel' | 'peacekeeper' | 'mercenary';
  /**
   * Pile mixte (own ou precise) : effectif vivant par matériel, trié par identifiant de système.
   * Absent pour une pile d'un seul matériel (`systemId` × `count`). `systemId` est alors le matériel
   * principal (le plus de points de vie), qui donne l'icône.
   */
  parts?: StackPartView[];
  /** Pile terrestre embarquée sur un navire de transport (own) : le navire porteur. */
  transportId?: UnitId | null;
  /** Navire de transport (own) : capacité, troupes à bord, embarquements et débarquement en cours. */
  cargo?: CargoView;
  /** Pile terrestre en cours d'embarquement (own) : navire et fin prévue. */
  loading?: { transportId: UnitId; doneAt: GameTime } | null;
}

/** Cargaison d'un navire de transport (vue de son propriétaire). */
export interface CargoView {
  /** Capacité totale et occupée (places, voir balance.military.transport). */
  capacity: number;
  used: number;
  /** Piles embarquées (unités hors carte, statut « embarked »). */
  unitIds: UnitId[];
  /** Piles en cours d'embarquement. */
  loadingIds?: UnitId[];
  /** Débarquement : point de mise à terre, fin prévue (null pendant la traversée). */
  landing?: { at: LngLat; doneAt: GameTime | null } | null;
}

/** Élément d'une pile mixte. */
export interface StackPartView {
  systemId: SystemId;
  count: number;
}

export interface CaptureView {
  by: NationId;
  startedAt: GameTime;
  completesAt: GameTime;
}

export interface ProvinceView {
  id: ProvinceId;
  owner: NationId;
  capture?: CaptureView | null;
  buildings: BuildingType[];
  // ——— Phases 2+ (optionnels) ———
  /** État des bâtiments (propriétaire, ou connu par le renseignement). */
  buildingState?: BuildingView[];
  /** Constructions possibles (provinces possédées) : bâtiments absents et fortification. */
  buildOptions?: BuildOptionView[];
  fortification?: FortificationView | null;
  /** Zone disputée à laquelle appartient la province. */
  disputedId?: string | null;
  /** Révolte en cours ou tension locale (0..100). */
  unrest?: number;
  blockaded?: boolean;
  /** Zone d'exclusion aérienne en vigueur. */
  noFlyZone?: boolean;
  /**
   * Connaissance d'une province étrangère par le renseignement (absent = province du joueur ou alliée).
   * Pour une province étrangère, `buildings`/`buildingState` ne contiennent QUE ce qui a été révélé
   * (missions du renseignement extérieur, satellites, reconnaissance), progressivement.
   */
  intel?: {
    /** 0 inconnue, 1 aperçu, 2 bonne connaissance, 3 connaissance complète. */
    level: 0 | 1 | 2 | 3;
    economic: boolean;
    military: boolean;
    /** Niveaux par axe (0..3), économique et militaire (absents dans les anciennes vues). */
    e?: 0 | 1 | 2 | 3;
    m?: 0 | 1 | 2 | 3;
    /** Dernière mise à jour (temps de jeu) ; au-delà d'un certain âge l'information vieillit. */
    updatedAt: GameTime;
  } | null;
}

export interface NationView {
  id: NationId;
  name: string;
  color: string;
  isAi: boolean;
  /** Nation contrôlée par un joueur humain dans cette partie. */
  isPlayer: boolean;
  alive: boolean;
  provinceCount: number;
  // ——— Phases 2+ (optionnels) ———
  /** Relation avec le joueur qui reçoit la vue. */
  relation?: Relation;
  allianceId?: string | null;
  /** Stabilité publique (arrondie) ; le détail est dans PlayerView.stability pour sa propre nation. */
  stability?: number;
  /** Réputation diplomatique publique 0..100 (agressions, violations, condamnations). */
  reputation?: number;
  mobilized?: boolean;
  embargoed?: boolean;
  sanctioned?: boolean;
  /** Doctrine principale de l'arsenal (affichage). */
  doctrine?: string;
  /** Mode illimité (compte administrateur) : argent et ressources jamais limitants, partie non classée. */
  unlimited?: boolean;
}

export interface ProductionItem {
  id: string;
  provinceId: ProvinceId;
  systemId: SystemId;
  startedAt: GameTime;
  completesAt: GameTime;
  // ——— Phases 2+ (optionnels) ———
  /** Éléments livrés à la fin (série). */
  count?: number;
  /** Fabrication locale, importation au catalogue d'un fournisseur ou marché noir. */
  source?: 'factory' | 'import' | 'black_market';
}

export interface EconomyView {
  money: number;
  resources: Record<Resource, number>;
  /** Revenu journalier estimé. */
  incomePerDay: { money: number } & Partial<Record<Resource, number>>;
  production: ProductionItem[];
  /** Tableau de bord économique détaillé (économie réelle, propre nation). */
  detail?: EconomyDetailView;
  /** Mode illimité : afficher « ∞ » au lieu des montants, aucune alerte de déficit ni de pénurie. */
  unlimited?: boolean;
}

export interface VictoryView {
  provinceShareTarget: number;
  leader: NationId | null;
  winner: NationId | null;
}

/** Tout ce qu'un joueur a le droit de savoir, à un instant donné. */
export interface PlayerView {
  time: GameTime;
  me: NationId;
  nations: Record<NationId, NationView>;
  provinces: Record<ProvinceId, ProvinceView>;
  units: Record<UnitId, UnitView>;
  economy: EconomyView;
  victory: VictoryView;
  // ——— Phases 2+ : sections optionnelles fournies par les modules du moteur ———
  research?: ResearchView;
  licences?: LicenceView[];
  market?: MarketView;
  logistics?: LogisticsView;
  alertLevel?: AlertLevel;
  operations?: OperationView[];
  battleReports?: BattleReportSummary[];
  generals?: GeneralView[];
  blockades?: BlockadeView[];
  satellites?: SatellitePassView[];
  intel?: IntelView;
  diplomacy?: DiplomacyView;
  council?: CouncilView;
  stability?: StabilityView;
  news?: NewsItem[];
  /** Gestion intérieure : politiques, indicateurs, troubles (onglet Intérieur). */
  domestic?: DomesticView;
  /** Centre de commandement : armées, missions et généraux du joueur (jamais ceux des autres). */
  command?: CommandView;
  /** Mode spectateur : vue publique sans brouillard ni secrets. */
  spectator?: boolean;
}

/** Sections de premier niveau de PlayerView diffusées en bloc par ViewDiff (hors units). */
export const VIEW_SECTIONS = [
  'nations',
  'provinces',
  'economy',
  'victory',
  'research',
  'licences',
  'market',
  'logistics',
  'alertLevel',
  'operations',
  'battleReports',
  'generals',
  'blockades',
  'satellites',
  'intel',
  'diplomacy',
  'council',
  'stability',
  'news',
  'domestic',
  'command',
] as const;

/** Différence entre deux vues successives. Les champs absents n'ont pas changé. */
export interface ViewDiff {
  time: GameTime;
  nations?: Record<NationId, NationView>;
  provinces?: Record<ProvinceId, ProvinceView>;
  units?: { upsert: UnitView[]; remove: UnitId[] };
  economy?: EconomyView;
  victory?: VictoryView;
  research?: ResearchView;
  licences?: LicenceView[];
  market?: MarketView;
  logistics?: LogisticsView;
  alertLevel?: AlertLevel;
  operations?: OperationView[];
  battleReports?: BattleReportSummary[];
  generals?: GeneralView[];
  blockades?: BlockadeView[];
  satellites?: SatellitePassView[];
  intel?: IntelView;
  diplomacy?: DiplomacyView;
  council?: CouncilView;
  stability?: StabilityView;
  news?: NewsItem[];
  domestic?: DomesticView;
  command?: CommandView;
}

/**
 * Horloge d'une partie : temps de jeu = anchorGame + (maintenant - anchorReal) × speed × rate (figé si en
 * pause). `speed` est le multiplicateur affiché (×1, ×2, ×4…) ; `rate` est le temps de jeu écoulé par
 * unité de temps réel à ×1 (équilibrage `time.realtimeFactor`, ex. 10 : ×1 = 10 min de jeu par minute).
 */
export interface ClockState {
  anchorGame: GameTime;
  anchorReal: RealTime;
  speed: number;
  paused: boolean;
  /** Facultatif (défaut 1, parties créées avant le réglage). */
  rate?: number;
}

/** Temps de jeu écoulé par milliseconde réelle (vitesse × cadence de base). */
export function clockRate(clock: ClockState): number {
  return clock.speed * (clock.rate ?? 1);
}

export function gameTimeAt(clock: ClockState, now: RealTime): GameTime {
  if (clock.paused) return clock.anchorGame;
  return clock.anchorGame + (now - clock.anchorReal) * clockRate(clock);
}

/** Notifications destinées au centre d'alertes et au bandeau titre. */
export type GameNotification =
  | { kind: 'combat_started'; time: GameTime; at: LngLat; unitIds: UnitId[] }
  | {
      kind: 'unit_destroyed';
      time: GameTime;
      at: LngLat;
      unitId: UnitId;
      owner: NationId;
      systemId?: SystemId;
    }
  | { kind: 'unit_detected'; time: GameTime; at: LngLat; unitId: UnitId }
  | {
      kind: 'province_capture_started';
      time: GameTime;
      at: LngLat;
      provinceId: ProvinceId;
      by: NationId;
    }
  | {
      kind: 'province_captured';
      time: GameTime;
      at: LngLat;
      provinceId: ProvinceId;
      by: NationId;
      from: NationId;
    }
  | { kind: 'production_complete'; time: GameTime; at: LngLat; unitId: UnitId; systemId: SystemId }
  | { kind: 'arrived'; time: GameTime; at: LngLat; unitId: UnitId }
  | { kind: 'nation_defeated'; time: GameTime; nationId: NationId }
  | { kind: 'victory'; time: GameTime; winner: NationId }
  // ——— Phases 2+ ———
  | { kind: 'research_complete'; time: GameTime; nodeId: string }
  | { kind: 'war_declared'; time: GameTime; by: NationId; against: NationId }
  | { kind: 'peace_signed'; time: GameTime; a: NationId; b: NationId }
  | {
      kind: 'missile_launch';
      time: GameTime;
      at: LngLat;
      unitId: UnitId;
      impactAt: GameTime;
      target?: LngLat;
    }
  | {
      kind: 'building_hit';
      time: GameTime;
      at: LngLat;
      provinceId: ProvinceId;
      building: BuildingType;
      health: number;
    }
  | {
      kind: 'delivery';
      time: GameTime;
      at: LngLat;
      deliveryId: string;
      outcome: 'arrived' | 'intercepted';
    }
  | { kind: 'intel_report'; time: GameTime; reportId: string; flash: boolean; at: LngLat | null }
  | { kind: 'battle_report'; time: GameTime; reportId: string; at: LngLat }
  | { kind: 'operation'; time: GameTime; operationId: string; status: string }
  | { kind: 'alert_level'; time: GameTime; level: AlertLevel }
  | {
      kind: 'council';
      time: GameTime;
      text: string;
      /** Texte localisable (le client traduit ; `text` reste le français). */
      loc?: LocText;
    }
  | { kind: 'news'; time: GameTime; newsId: string; at: LngLat | null }
  /** Notification générique : tout le reste (révolte, coup d'État, agent démasqué, alliance…). */
  | {
      kind: 'generic';
      time: GameTime;
      at: LngLat | null;
      category: string;
      title: string;
      text: string;
      severity: 'info' | 'warn' | 'critical';
      /** Titre et texte localisables (le client traduit ; `title`/`text` restent le français). */
      loc?: { title: LocText; text: LocText };
    };
