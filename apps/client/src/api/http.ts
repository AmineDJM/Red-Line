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
import { BASEMAP_FILES, FALLBACK_TILES, FONTS } from '../config.js';
import { ApiError, type Api, type BasemapData, type Credentials, type RegisterInput, type TilesInfo } from './types.js';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const type = res.headers.get('content-type') ?? '';
  const data: unknown = type.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; message?: string };
    throw new ApiError(res.status, d.code ?? d.error ?? `http_${res.status}`, d.message);
  }
  if (data === null) throw new ApiError(res.status, 'bad_response');
  return data as T;
}

/** Charge un fichier GeoJSON facultatif (null si absent ou invalide, sans erreur bloquante). */
async function optionalGeoJSON(url: string): Promise<FeatureCollection | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return null;
    const data = (await res.json()) as FeatureCollection;
    return data && data.type === 'FeatureCollection' ? data : null;
  } catch {
    return null;
  }
}

export async function loadBasemap(): Promise<BasemapData> {
  const [land, coastline, seas, countries, cities] = await Promise.all(
    (['land', 'coastline', 'seas', 'countries', 'cities'] as const).map((k) => optionalGeoJSON(`/basemap/${BASEMAP_FILES[k]}`)),
  );
  return { land: land ?? null, coastline: coastline ?? null, seas: seas ?? null, countries: countries ?? null, cities: cities ?? null };
}

/** Vérifie qu'une ressource binaire existe (et n'est pas la page SPA de repli). */
export async function probeBinary(url: string, range = false): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: range ? { Range: 'bytes=0-15' } : undefined });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0;
  } catch {
    return false;
  }
}

export class HttpApi implements Api {
  readonly kind = 'http' as const;

  async me(): Promise<PublicUser | null> {
    try {
      return (await request<{ user: PublicUser }>('GET', '/api/me')).user;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 0 || e.status >= 500)) return null;
      throw e;
    }
  }
  async guest() {
    return (await request<{ user: PublicUser }>('POST', '/api/auth/guest', {})).user;
  }
  async login(body: Credentials) {
    return (await request<{ user: PublicUser }>('POST', '/api/auth/login', body)).user;
  }
  async register(body: RegisterInput) {
    return (await request<{ user: PublicUser }>('POST', '/api/auth/register', body)).user;
  }
  async logout() {
    await request('POST', '/api/auth/logout', {});
  }
  async catalog(): Promise<WeaponSystem[]> {
    return (await request<{ systems: WeaponSystem[] }>('GET', '/api/catalog')).systems;
  }
  async nations(): Promise<NationDef[]> {
    return (await request<{ nations: NationDef[] }>('GET', '/api/map/nations')).nations;
  }
  async provinces(): Promise<ProvinceDef[]> {
    return (await request<{ provinces: ProvinceDef[] }>('GET', '/api/map/provinces')).provinces;
  }
  async provincesGeoJSON(): Promise<FeatureCollection> {
    return request<FeatureCollection>('GET', '/api/map/provinces.geojson');
  }
  async tiles(): Promise<TilesInfo | null> {
    try {
      return await request<TilesInfo>('GET', '/api/map/tiles');
    } catch {
      return (await probeBinary(FALLBACK_TILES.satellite, true)) ? { ...FALLBACK_TILES } : null;
    }
  }
  async basemap(): Promise<BasemapData> {
    return loadBasemap();
  }
  glyphsAvailable(): Promise<boolean> {
    return probeBinary(`/glyphs/${encodeURIComponent(FONTS.title)}/0-255.pbf`);
  }
  async scenarios(): Promise<ScenarioSummary[]> {
    return (await request<{ scenarios: ScenarioSummary[] }>('GET', '/api/scenarios')).scenarios;
  }
  async createGame(body: CreateGameBody): Promise<GameMeta> {
    return (await request<{ game: GameMeta }>('POST', '/api/games', body)).game;
  }
  async game(id: string): Promise<{ game: GameMeta; me: NationId }> {
    return request<{ game: GameMeta; me: NationId }>('GET', `/api/games/${encodeURIComponent(id)}`);
  }
}
