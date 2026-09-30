import type { FeatureCollection } from 'geojson';
import type {
  CreateGameBody,
  GameMeta,
  NationDef,
  NationId,
  ProvinceDef,
  PublicUser,
  ScenarioSummary,
  WeaponSystem,
} from '@redline/shared';

export interface TilesInfo {
  satellite: string;
  maxzoom: number;
}

/** Fond vectoriel (chaque couche est facultative : absente = non affichée). */
export interface BasemapData {
  /** Terres émergées (polygones). */
  land: FeatureCollection | null;
  /** Traits de côte (lignes). */
  coastline: FeatureCollection | null;
  /** Étiquettes des mers (points : name, rank, minzoom). */
  seas: FeatureCollection | null;
  /** Points d'étiquette des pays (points : id, name, rank, minzoom). */
  countries: FeatureCollection | null;
  /** Villes (points : name, rank, minzoom, capital, nation). */
  cities: FeatureCollection | null;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput extends Credentials {
  displayName: string;
}

/** Accès aux données REST (serveur réel ou fixtures du mode ?mock=1). */
export interface Api {
  readonly kind: 'http' | 'mock';
  me(): Promise<PublicUser | null>;
  guest(): Promise<PublicUser>;
  login(body: Credentials): Promise<PublicUser>;
  register(body: RegisterInput): Promise<PublicUser>;
  logout(): Promise<void>;
  catalog(): Promise<WeaponSystem[]>;
  nations(): Promise<NationDef[]>;
  provinces(): Promise<ProvinceDef[]>;
  provincesGeoJSON(): Promise<FeatureCollection>;
  tiles(): Promise<TilesInfo | null>;
  basemap(): Promise<BasemapData>;
  /** Vrai si les glyphes MapLibre sont servis. */
  glyphsAvailable(): Promise<boolean>;
  scenarios(): Promise<ScenarioSummary[]>;
  createGame(body: CreateGameBody): Promise<GameMeta>;
  game(id: string): Promise<{ game: GameMeta; me: NationId }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
