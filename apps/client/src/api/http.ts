import type { FeatureCollection } from 'geojson';
import type {
  Balance,
  BattleReport,
  CosmeticItem,
  CreateGameBody,
  CreateLobbyBody,
  GameMeta,
  GameStatsView,
  LegalDoc,
  LegalDocRef,
  LobbyGame,
  MyGame,
  NationDef,
  NationId,
  NationInfo,
  ProvinceDef,
  PublicUser,
  RankingEntry,
  ResearchNode,
  ScenarioSummary,
  SeasonView,
  ShopPack,
  TimelapseView,
  WalletEntry,
  WeaponSystem,
} from '@redline/shared';
import { bundledResearch } from '../lib/staticData.js';
import { BASEMAP_FILES, FALLBACK_TILES, FONTS } from '../config.js';
import {
  ApiError,
  type Api,
  type BasemapData,
  type Credentials,
  type RegisterInput,
  type TilesInfo,
} from './types.js';

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
  // Pas de couche « land » : les terres viennent de l'imagerie et des provinces (data/basemap n'en
  // fournit pas ; la demander produisait un 404 à chaque chargement).
  const [coastline, seas, countries, cities] = await Promise.all(
    (['coastline', 'seas', 'countries', 'cities'] as const).map((k) =>
      optionalGeoJSON(`/basemap/${BASEMAP_FILES[k]}`),
    ),
  );
  return {
    land: null,
    coastline: coastline ?? null,
    seas: seas ?? null,
    countries: countries ?? null,
    cities: cities ?? null,
  };
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
      if (e instanceof ApiError && (e.status === 401 || e.status === 0 || e.status >= 500))
        return null;
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

  // ——— Phases 2+ ———
  async balance(): Promise<Balance | null> {
    try {
      return (await request<{ balance: Balance | null }>('GET', '/api/balance')).balance;
    } catch {
      return null;
    }
  }
  async researchNodes(): Promise<ResearchNode[]> {
    try {
      const r = await request<{ nodes: ResearchNode[] }>('GET', '/api/research');
      if (r.nodes?.length) return r.nodes;
    } catch {
      /* route absente : repli sur data/research embarqué */
    }
    return bundledResearch();
  }
  async nationsInfo(): Promise<NationInfo[]> {
    return (await request<{ nations: NationInfo[] }>('GET', '/api/nations/info')).nations;
  }
  async myGames(): Promise<MyGame[]> {
    return (await request<{ games: MyGame[] }>('GET', '/api/games')).games;
  }
  async lobby(): Promise<LobbyGame[]> {
    return (await request<{ games: LobbyGame[] }>('GET', '/api/lobby')).games;
  }
  async createLobby(body: CreateLobbyBody): Promise<GameMeta> {
    return (await request<{ game: GameMeta }>('POST', '/api/lobby', body)).game;
  }
  async joinLobby(id: string, nationId: NationId): Promise<GameMeta> {
    return (await request<{ game: GameMeta }>('POST', `/api/lobby/${enc(id)}/join`, { nationId }))
      .game;
  }
  async lobbyGame(id: string): Promise<LobbyGame> {
    return (await request<{ game: LobbyGame }>('GET', `/api/lobby/${enc(id)}`)).game;
  }
  async leaveLobby(id: string): Promise<void> {
    await request('POST', `/api/lobby/${enc(id)}/leave`, {});
  }
  async startLobby(id: string): Promise<GameMeta> {
    return (await request<{ game: GameMeta }>('POST', `/api/lobby/${enc(id)}/start`, {})).game;
  }
  async spectate(id: string): Promise<GameMeta> {
    return (await request<{ game: GameMeta }>('GET', `/api/games/${enc(id)}/spectate`)).game;
  }
  async stats(id: string): Promise<GameStatsView> {
    return request<GameStatsView>('GET', `/api/games/${enc(id)}/stats`);
  }
  async timelapse(id: string): Promise<TimelapseView> {
    return request<TimelapseView>('GET', `/api/games/${enc(id)}/timelapse`);
  }
  async battleReport(gameId: string, reportId: string): Promise<BattleReport> {
    return (
      await request<{ report: BattleReport }>(
        'GET',
        `/api/games/${enc(gameId)}/battle-reports/${enc(reportId)}`,
      )
    ).report;
  }
  async pushKey(): Promise<string | null> {
    try {
      return (await request<{ publicKey: string }>('GET', '/api/push/key')).publicKey || null;
    } catch {
      return null;
    }
  }
  async pushSubscribe(sub: PushSubscriptionJSON): Promise<void> {
    await request('POST', '/api/push/subscribe', sub);
  }
  async pushUnsubscribe(): Promise<void> {
    await request('DELETE', '/api/push/subscribe');
  }
  async shopPacks(): Promise<ShopPack[]> {
    return (await request<{ packs: ShopPack[] }>('GET', '/api/shop/packs')).packs;
  }
  async wallet(): Promise<{ balance: number; history: WalletEntry[] }> {
    return request('GET', '/api/shop/wallet');
  }
  async checkout(packId: string): Promise<{ url: string }> {
    return request('POST', '/api/shop/checkout', { packId });
  }
  async accelerate(
    gameId: string,
    target: { type: 'production' | 'research' | 'build' | 'repair'; id: string },
    hours: number,
  ): Promise<{ ok: boolean; balance: number }> {
    return request('POST', `/api/games/${enc(gameId)}/accelerate`, { target, hours });
  }
  async cosmetics(): Promise<{ items: CosmeticItem[]; owned: string[] }> {
    return request('GET', '/api/shop/cosmetics');
  }
  async buyCosmetic(id: string): Promise<{ ok: boolean; balance: number }> {
    return request('POST', `/api/shop/cosmetics/${enc(id)}/buy`, {});
  }
  async rankings(season?: string): Promise<{ season: SeasonView; entries: RankingEntry[] }> {
    return request('GET', `/api/rankings${season ? `?season=${enc(season)}` : ''}`);
  }
  async seasons(): Promise<SeasonView[]> {
    return (await request<{ seasons: SeasonView[] }>('GET', '/api/seasons')).seasons;
  }
  async legal(doc: LegalDocRef['id']): Promise<LegalDoc> {
    return (await request<{ doc: LegalDoc }>('GET', `/api/legal/${doc}`)).doc;
  }
  async acceptLegal(docs: LegalDocRef[]): Promise<void> {
    await request('POST', '/api/legal/accept', { docs });
  }
  async legalPending(): Promise<LegalDocRef[]> {
    try {
      const r = await request<{ legal?: { needsAcceptance?: LegalDocRef[] } }>('GET', '/api/me');
      return r.legal?.needsAcceptance ?? [];
    } catch {
      return [];
    }
  }
}

const enc = encodeURIComponent;
