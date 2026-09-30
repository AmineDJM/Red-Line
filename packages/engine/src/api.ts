/**
 * API publique du moteur — CONTRAT FIGÉ utilisé par apps/server et apps/client (bac à sable).
 * Le moteur est pur : aucune E/S, aucun Date.now(), aucun Math.random().
 * Les fonctions qui prennent un GameState le modifient en place (le serveur possède l'état).
 */
import type {
  AlertLevel,
  Balance,
  BattleReport,
  Orbat,
  ResearchNode,
  ScenarioFile,
  GameNotification,
  GameTime,
  MapData,
  NationId,
  Order,
  OrderErrorCode,
  PlayerView,
  ViewDiff,
  WeaponSystem,
} from '@redline/shared';

/** Données statiques partagées par toutes les parties d'un processus (jamais sérialisées). */
export interface World {
  readonly map: MapData;
  readonly catalog: ReadonlyMap<string, WeaponSystem>;
  readonly balance: Balance;
  /** Index internes précalculés (grille de navigation, provinces par cellule…). Opaque. */
  readonly internal: unknown;
  // ——— Phases 2+ ———
  readonly research?: ReadonlyMap<string, ResearchNode>;
  /** ORBAT par jeu (« 2025 », « 1985 ») puis par nation. */
  readonly orbats?: ReadonlyMap<string, ReadonlyMap<NationId, Orbat>>;
  /** Rapport de chargement : incohérences non bloquantes (systèmes d'ORBAT absents du catalogue…). */
  readonly loadWarnings?: readonly string[];
}

/** Données supplémentaires de buildWorld (phases 2+). */
export interface WorldExtras {
  research?: ResearchNode[];
  orbats?: Record<string, Orbat[]>;
}

export interface PlayerSetup {
  nationId: NationId;
  isAi: boolean;
  aiLevel?: 'easy' | 'normal' | 'hard';
}

export interface GameSetup {
  seed: number;
  /** Nations tenues par un joueur ou une IA active. Toutes les autres sont des IA neutres en garnison. */
  players: PlayerSetup[];
  /**
   * Restreint la partie à un sous-ensemble de nations (scénarios régionaux, tests).
   * Absent = toutes les nations de la carte.
   */
  nationIds?: NationId[];
  /** Unités placées explicitement (bac à sable, tests). Si fourni, remplace l'armée de départ. */
  units?: { owner: NationId; systemId: string; pos: [number, number]; count?: number }[];
  // ——— Phases 2+ ———
  /** Scénario (année, jeu d'ORBAT, surcharges d'équilibrage). */
  scenario?: ScenarioFile;
  /** Vitesse de la partie (conversion des délais en heures réelles : vote du Conseil). */
  speed?: number;
  /** Conditions de victoire propres à la partie. */
  victory?: { provinceShare: number; allEnemyCapitals: boolean };
  /** Niveau des IA qui tiennent les nations non déclarées dans `players` (défaut : 'normal'). */
  aiLevel?: 'easy' | 'normal' | 'hard';
  /** Règles du Conseil de sécurité propres à la partie (sinon balance.diplomacy). */
  diplomacy?: {
    majority?: 'simple' | 'two_thirds';
    veto?: boolean;
    voteWindowRealHours?: number;
    councilEveryDays?: number;
    rotatingSeats?: number;
  };
}

/** Commandes système : serveur ou administration, jamais un client. */
export type SystemCommand =
  | { kind: 'setAi'; nationId: NationId; isAi: boolean; aiLevel?: 'easy' | 'normal' | 'hard' }
  | { kind: 'addPlayer'; nationId: NationId }
  | {
      kind: 'accelerate';
      nationId: NationId;
      target: { type: 'production' | 'research' | 'build' | 'repair'; id: string };
      hours: number;
    }
  | {
      kind: 'worldEvent';
      event: 'oil_crisis' | 'emergency_council' | 'market_crash' | 'pandemic' | 'arms_fair';
      message?: string;
      params?: Record<string, number>;
    }
  | { kind: 'grant'; nationId: NationId; money?: number; resources?: Record<string, number> };

export interface GameStats {
  nations: Record<
    NationId,
    {
      provincesStart: number;
      provincesEnd: number;
      conquered: number;
      kills: number;
      losses: number;
      spentUsd: number;
      bestUnits: { systemId: string; kills: number }[];
      /** Victimes estimées (personnels) subies (module mil). */
      casualties?: number;
    }
  >;
  alertLevel: AlertLevel;
}

/** État sérialisable d'une partie. Structure interne au moteur. */
export interface GameState {
  readonly world: World;
  time: GameTime;
  // … champs internes (voir state/)
}

export interface OrderResult {
  ok: boolean;
  error?: OrderErrorCode;
  message?: string;
}

export type BuildWorld = (
  map: MapData,
  catalog: WeaponSystem[],
  balance: Balance,
  extras?: WorldExtras,
) => World;
export type CreateGame = (world: World, setup: GameSetup) => GameState;
/** Applique l'ordre d'une nation à l'instant `state.time` (le serveur appelle advanceTo avant). */
export type ApplyOrder = (state: GameState, nationId: NationId, order: Order) => OrderResult;
/** Traite tous les événements de date <= t, dans l'ordre, puis fixe state.time = t. */
export type AdvanceTo = (state: GameState, t: GameTime) => GameNotification[];
export type NextEventTime = (state: GameState) => GameTime | null;
export type ViewFor = (state: GameState, nationId: NationId) => PlayerView;
export type DiffViews = (prev: PlayerView, next: PlayerView) => ViewDiff | null;
/** Filtre des notifications visibles par une nation (brouillard de guerre). */
export type NotificationsFor = (
  state: GameState,
  nationId: NationId,
  items: GameNotification[],
) => GameNotification[];
export type SerializeState = (state: GameState) => Uint8Array;
export type DeserializeState = (world: World, bytes: Uint8Array) => GameState;
/** Empreinte déterministe de l'état (tests de rejeu). */
export type StateHash = (state: GameState) => string;

// ——— Phases 2+ ———
export type ApplySystem = (state: GameState, cmd: SystemCommand) => OrderResult;
/** Vue publique (spectateur) : carte, frontières, unités visibles de tous, actualité ; aucun secret. */
export type PublicView = (state: GameState) => PlayerView;
/** Propriétaires des provinces (timelapse). */
export type OwnersFrame = (state: GameState) => Record<string, NationId>;
export type Stats = (state: GameState) => GameStats;
/**
 * Détail d'un rapport de bataille (GET /api/games/:id/battle-reports/:rid) : null si le rapport
 * n'existe pas ou si la nation n'y a pas pris part.
 */
export type BattleReportFor = (
  state: GameState,
  nationId: NationId,
  reportId: string,
) => BattleReport | null;
