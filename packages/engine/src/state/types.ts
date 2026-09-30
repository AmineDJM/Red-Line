import type {
  GameNotification,
  GameTime,
  LngLat,
  Movement,
  NationId,
  ProductionItem,
  ProvinceId,
  Resource,
  SystemId,
  UnitId,
  UnitStance,
} from '@redline/shared';
import type { GameState, World } from '../api.js';
import type { GameEvent } from '../queue/events.js';
import type { Runtime } from './runtime.js';
import type { RngState } from '../rng/rng.js';

export type AiLevel = 'easy' | 'normal' | 'hard';

export interface NationState {
  id: NationId;
  /** Tenue par une IA (joueur IA ou nation neutre en garnison). */
  isAi: boolean;
  /** Tenue par un joueur humain. */
  isPlayer: boolean;
  /** Nation déclarée dans `setup.players` (joueur ou IA active), sinon neutre en garnison. */
  active: boolean;
  aiLevel: AiLevel;
  alive: boolean;
  money: number;
  res: Record<Resource, number>;
  provinceCount: number;
  production: ProductionItem[];
}

export interface CaptureState {
  by: NationId;
  startedAt: GameTime;
  completesAt: GameTime;
  v: number;
}

export interface ProvinceState {
  id: ProvinceId;
  owner: NationId;
  capture: CaptureState | null;
  /** Compteur de version des captures (invalidation des événements). */
  capV: number;
}

/** Passage d'une frontière de province le long d'un trajet ('' = mer / hors carte). */
export interface Crossing {
  t: GameTime;
  p: ProvinceId | '';
}

export interface Unit {
  id: UnitId;
  owner: NationId;
  sys: SystemId;
  /** Nombre d'éléments = ceil(hp / hp par élément). */
  count: number;
  hp: number;
  maxHp: number;
  xp: number;
  /** Position au début du trajet, ou position fixe si `move` est null. Jamais modifiée en place. */
  pos: LngLat;
  /** Trajet en cours (objet immuable, remplacé à chaque changement). */
  move: Movement | null;
  /** Version du trajet : invalide les événements de mouvement. */
  mv: number;
  /** Index du segment courant (mis à jour par les événements de fin de segment). */
  leg: number;
  /** Passages de frontières prévus sur le trajet courant. */
  cross: Crossing[] | null;
  stance: UnitStance;
  /** Cible d'attaque (ordre 'attack' ou cible acquise en posture agressive). */
  target: UnitId | null;
  /** Origine de la cible : ordre explicite ou acquisition automatique. */
  tmode: 'order' | 'auto' | null;
  /** Le trajet courant est une poursuite de la cible. */
  chasing: boolean;
  /** seq de l'événement de poursuite en attente (0 si aucun). */
  chaseEv: number;
  /** Boucle de rounds de combat active. */
  engaged: boolean;
  /** Version de la boucle de combat. */
  cv: number;
  /** Dernier dégât reçu (temps de jeu), -1 si jamais. */
  lastHit: GameTime;
  /**
   * Rôle particulier (module mil) : salve de missiles en vol, ou leurre. Un missile ne tire pas, ne
   * capture pas, ne déclare pas de guerre en survolant un territoire et n'est engagé que par interception.
   */
  role?: 'missile' | 'decoy';
  /**
   * Hors carte : aéronef embarqué sur un porte-avions, satellite en orbite. Ni index spatial, ni paires,
   * ni combat ; la position n'a pas de sens (voir le module mil).
   */
  off?: boolean;
}

/**
 * Paire surveillée : deux unités de nations différentes, ou une province (zone fixe autour de sa ville)
 * et une unité. On ne conserve que les paires « vivantes » (en relation ou avec un changement à venir).
 */
export interface PairState {
  /** Distance (km) à la dernière évaluation : constante par bande jusqu'au prochain événement. */
  d: number;
  /** Niveau de détection : A voit B (paire d'unités) ou le propriétaire de la province voit l'unité. */
  la: number;
  /** Niveau de détection : B voit A (paire d'unités). */
  lb: number;
  /** Nation observatrice à laquelle `la` est compté (paires de province). */
  obs: NationId | null;
  /** seq de l'événement prévu (0 si aucun). */
  ev: number;
}

/** Ce qu'une nation sait d'une unité étrangère. */
export interface Contact {
  owner: NationId;
  /** Niveau courant (si vue) ou au moment de la perte : 1 détectée, 2 identifiée, 3 précise. */
  lvl: number;
  seen: boolean;
  /** Début de l'observation continue en cours. */
  since: GameTime;
  lastSeen: GameTime;
  /** Dernière position connue (au moment de la perte). */
  pos: LngLat;
  sys: SystemId | null;
  count: number | null;
  hpr: number | null;
  status: string | null;
  /** Incertitude initiale de position (km) : contact issu du renseignement, pas d'un capteur. */
  unc?: number;
}

export interface PendingNote {
  n: GameNotification;
  /** Nations destinataires ; null = tout le monde. */
  aud: NationId[] | null;
}

export interface SetupInfo {
  seed: number;
  players: { nationId: NationId; isAi: boolean; aiLevel: AiLevel }[];
}

/** Données sérialisées d'une partie (tout sauf le monde et les index dérivés). */
export interface StateData {
  fmt: number;
  time: GameTime;
  setup: SetupInfo;
  rng: RngState;
  seq: number;
  nextUnit: number;
  nextProd: number;
  queue: GameEvent[];
  nationIds: NationId[];
  nations: Record<NationId, NationState>;
  provinces: Record<ProvinceId, ProvinceState>;
  totalProvinces: number;
  units: Record<UnitId, Unit>;
  /** Guerres : clé "a|b" (a < b) → début. */
  wars: Record<string, GameTime>;
  pairs: Record<string, PairState>;
  /** Compteurs d'observateurs par niveau [détectée, identifiée, précise]. */
  sight: Record<NationId, Record<UnitId, [number, number, number]>>;
  know: Record<NationId, Record<UnitId, Contact>>;
  pending: PendingNote[];
  winner: NationId | null;
  /** États des modules (phases 2+), par identifiant de module. Données sérialisables uniquement. */
  mods: Record<string, unknown>;
}

export interface EngineState extends GameState, StateData {
  readonly world: World;
  /** Index dérivés, reconstruits à la désérialisation (non énumérable). */
  readonly rt: Runtime;
}

export const STATE_FORMAT = 1;
