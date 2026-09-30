/**
 * API publique du moteur — CONTRAT FIGÉ utilisé par apps/server et apps/client (bac à sable).
 * Le moteur est pur : aucune E/S, aucun Date.now(), aucun Math.random().
 * Les fonctions qui prennent un GameState le modifient en place (le serveur possède l'état).
 */
import type {
  Balance,
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

export type BuildWorld = (map: MapData, catalog: WeaponSystem[], balance: Balance) => World;
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
