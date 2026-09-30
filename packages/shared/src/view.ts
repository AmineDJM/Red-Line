import type { GameTime, LngLat, NationId, ProvinceId, RealTime, SystemId, UnitId } from './ids.js';
import type { MovementKind, Resource } from './catalog.js';
import type { BuildingType } from './map.js';

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
}

export interface ProductionItem {
  id: string;
  provinceId: ProvinceId;
  systemId: SystemId;
  startedAt: GameTime;
  completesAt: GameTime;
}

export interface EconomyView {
  money: number;
  resources: Record<Resource, number>;
  /** Revenu journalier estimé. */
  incomePerDay: { money: number } & Partial<Record<Resource, number>>;
  production: ProductionItem[];
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
}

/** Différence entre deux vues successives. Les champs absents n'ont pas changé. */
export interface ViewDiff {
  time: GameTime;
  nations?: Record<NationId, NationView>;
  provinces?: Record<ProvinceId, ProvinceView>;
  units?: { upsert: UnitView[]; remove: UnitId[] };
  economy?: EconomyView;
  victory?: VictoryView;
}

/** Horloge d'une partie : temps de jeu = anchorGame + (maintenant - anchorReal) × speed (0 si en pause). */
export interface ClockState {
  anchorGame: GameTime;
  anchorReal: RealTime;
  speed: number;
  paused: boolean;
}

export function gameTimeAt(clock: ClockState, now: RealTime): GameTime {
  if (clock.paused) return clock.anchorGame;
  return clock.anchorGame + (now - clock.anchorReal) * clock.speed;
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
  | { kind: 'victory'; time: GameTime; winner: NationId };
