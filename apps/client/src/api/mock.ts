/**
 * API de démonstration (?mock=1) : sert les fixtures de apps/client/test-fixtures, sans serveur.
 * Chargé paresseusement (jamais inclus dans le parcours normal).
 */
import type { FeatureCollection } from 'geojson';
import type {
  BattleReport,
  CreateGameBody,
  CreateLobbyBody,
  GameMeta,
  LegalDocRef,
  NationDef,
  NationId,
  NationInfo,
  ProvinceDef,
  PublicUser,
  ResearchNode,
  ScenarioSummary,
  WeaponSystem,
} from '@redline/shared';
import { FALLBACK_TILES, FONTS } from '../config.js';
import { bundledBalance, bundledResearch } from '../lib/staticData.js';
import { loadBasemap, probeBinary } from './http.js';
import { demoCatalog, demoResearch } from './mockCatalog.js';
import {
  DEMO_COSMETICS,
  DEMO_PACKS,
  DEMO_SEASONS,
  demoBattleReport,
  demoLegal,
  demoLobby,
  demoMyGames,
  demoNationsInfo,
  demoRankings,
  demoStats,
  demoTimelapse,
  demoWallet,
  withDemoBuildings,
} from './mockRest.js';
import type { Api, BasemapData, Credentials, RegisterInput, TilesInfo } from './types.js';

export const MOCK_GAME_ID = 'demo';
const NATION_KEY = 'rl.mock.nation';
export const MOCK_DEFAULT_NATION = 'dza';

function mockMeta(): GameMeta {
  return {
    id: MOCK_GAME_ID,
    name: 'Démonstration',
    mode: 'solo',
    scenarioId: 'world-today',
    status: 'running',
    speeds: [1, 2, 4, 8, 16],
  };
}

export interface MockWorld {
  nations: NationDef[];
  provinces: ProvinceDef[];
  geo: FeatureCollection;
  catalog: WeaponSystem[];
  basemap: BasemapData;
  /** Vraies données de data/ (greffon de dev) ou fixtures minimales. */
  source: 'data' | 'fixtures';
}

let fixtures: Promise<MockWorld> | null = null;

const MOCK_HEADER = { 'x-redline-mock': '1' };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: MOCK_HEADER });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('json')) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/** Vraies données servies par le greffon de dev (REDLINE_LOCAL_DATA=1), sinon null. */
async function loadRealData(): Promise<MockWorld | null> {
  try {
    const [n, p, geo, c] = await Promise.all([
      getJson<{ nations: NationDef[] }>('/api/map/nations'),
      getJson<{ provinces: ProvinceDef[] }>('/api/map/provinces'),
      getJson<FeatureCollection>('/api/map/provinces.geojson'),
      getJson<{ systems: WeaponSystem[] }>('/api/catalog'),
    ]);
    if (!n.nations.length || !p.provinces.length) return null;
    return {
      nations: n.nations,
      provinces: p.provinces,
      geo,
      catalog: c.systems,
      basemap: await loadBasemap(),
      source: 'data',
    };
  } catch {
    return null;
  }
}

async function loadMinimalFixtures(): Promise<MockWorld> {
  const [n, p, g, c, l, s] = await Promise.all([
    import('../../test-fixtures/nations.json'),
    import('../../test-fixtures/provinces.json'),
    import('../../test-fixtures/provinces.geojson?raw'),
    import('../../test-fixtures/catalog.json'),
    import('../../test-fixtures/basemap-land.geojson?raw'),
    import('../../test-fixtures/basemap-seas.geojson?raw'),
  ]);
  return {
    nations: n.default.nations as NationDef[],
    provinces: p.default.provinces as unknown as ProvinceDef[],
    geo: JSON.parse(g.default) as FeatureCollection,
    catalog: c.default.systems as unknown as WeaponSystem[],
    basemap: {
      land: JSON.parse(l.default) as FeatureCollection,
      coastline: null,
      seas: JSON.parse(s.default) as FeatureCollection,
      countries: null,
      cities: null,
    },
    source: 'fixtures',
  };
}

/** Données du mode démonstration : vraies données si disponibles (?fixtures=1 force les fixtures). */
export function loadFixtures(): Promise<MockWorld> {
  const forceFixtures = new URLSearchParams(window.location.search).get('fixtures') === '1';
  fixtures ??= (async () => {
    const w = (forceFixtures ? null : await loadRealData()) ?? (await loadMinimalFixtures());
    // Démonstration : prix en dollars et catalogue complet (identifiants de data/catalog-ids.json).
    return { ...w, catalog: await demoCatalog(w.catalog) };
  })();
  return fixtures;
}

/** Arbre technologique de démonstration : data/research s'il existe, sinon portes fixes. */
export async function loadDemoResearch(): Promise<ResearchNode[]> {
  const nodes = await bundledResearch().catch(() => []);
  return nodes.length ? nodes : demoResearch();
}

/** Accès à la partie simulée en cours (rapports de bataille détaillés). */
export const mockSession: {
  battle?: (id: string) => BattleReport | null;
} = {};

const WALLET = { balance: 1080 };
const OWNED = new Set(['theme-amber']);
const LEGAL_KEY = 'rl.mock.legal';

const guestUser: PublicUser = {
  id: 'guest-demo',
  displayName: 'Invité',
  email: null,
  role: 'player',
  isGuest: true,
};

/** Parties supprimées pendant la session de démonstration. */
const deletedGames = new Set<string>();

export class MockApi implements Api {
  readonly kind = 'mock' as const;
  private user: PublicUser | null = null;

  async me() {
    return this.user;
  }
  async guest() {
    this.user = guestUser;
    return guestUser;
  }
  async login(body: Credentials) {
    this.user = {
      id: 'demo',
      displayName: body.email.split('@')[0] ?? 'Joueur',
      email: body.email,
      role: 'player',
      isGuest: false,
    };
    return this.user;
  }
  async register(body: RegisterInput) {
    this.user = {
      id: 'demo',
      displayName: body.displayName,
      email: body.email,
      role: 'player',
      isGuest: false,
    };
    return this.user;
  }
  async logout() {
    this.user = null;
  }
  async catalog() {
    return (await loadFixtures()).catalog;
  }
  async nations() {
    return (await loadFixtures()).nations;
  }
  async provinces() {
    // Démo : revenus affichés en dollars (≈ budget de défense réel réparti sur les provinces).
    // La simulation locale garde les valeurs d'origine.
    return (await loadFixtures()).provinces.map((p) => ({
      ...p,
      income: { ...p.income, money: Math.round(p.income.money * 28_000) },
    }));
  }
  async provincesGeoJSON() {
    return (await loadFixtures()).geo;
  }
  async tiles(): Promise<TilesInfo | null> {
    const full = '/tiles/satellite.pmtiles';
    if (await probeBinary(full, true)) return { satellite: full, maxzoom: 8 };
    return (await probeBinary(FALLBACK_TILES.satellite, true)) ? { ...FALLBACK_TILES } : null;
  }
  async basemap(): Promise<BasemapData> {
    return (await loadFixtures()).basemap;
  }
  glyphsAvailable() {
    return probeBinary(`/glyphs/${encodeURIComponent(FONTS.title)}/0-255.pbf`);
  }
  async scenarios() {
    try {
      const res = await fetch('/api/scenarios', { headers: MOCK_HEADER });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json'))
        return ((await res.json()) as { scenarios: ScenarioSummary[] }).scenarios;
    } catch {
      /* repli */
    }
    return [
      {
        id: 'world-today',
        name: 'Le monde aujourd’hui',
        description: '',
        playableNations: 'all' as const,
      },
    ];
  }
  async createGame(body: CreateGameBody): Promise<GameMeta> {
    try {
      sessionStorage.setItem(NATION_KEY, body.nationId);
    } catch {
      /* stockage indisponible */
    }
    return mockMeta();
  }
  async game(): Promise<{ game: GameMeta; me: NationId }> {
    return { game: mockMeta(), me: mockNation() };
  }

  // ——— Phases 2+ ———
  researchNodes() {
    return loadDemoResearch();
  }
  async balance() {
    return withDemoBuildings(await bundledBalance());
  }
  async nationsInfo(): Promise<NationInfo[]> {
    const f = await loadFixtures();
    return demoNationsInfo(f.nations, f.provinces, f.catalog);
  }
  async myGames() {
    return demoMyGames(mockNation()).filter((g) => !deletedGames.has(g.game.id));
  }
  async deleteGame(id: string) {
    deletedGames.add(id);
  }
  async lobby() {
    return demoLobby((await loadFixtures()).nations);
  }
  async createLobby(body: CreateLobbyBody): Promise<GameMeta> {
    remember(body.nationId);
    return { ...mockMeta(), mode: 'multi', name: body.name, maxPlayers: body.maxPlayers };
  }
  async joinLobby(_id: string, nationId: NationId): Promise<GameMeta> {
    remember(nationId);
    return mockMeta();
  }
  async lobbyGame(id: string) {
    const list = demoLobby((await loadFixtures()).nations);
    return list.find((g) => g.game.id === id) ?? list[0]!;
  }
  async leaveLobby() {}
  async startLobby(): Promise<GameMeta> {
    return mockMeta();
  }
  async spectate(): Promise<GameMeta> {
    return { ...mockMeta(), spectator: true };
  }
  async timelapse() {
    const f = await loadFixtures();
    return demoTimelapse(f.provinces, mockNation());
  }
  async stats() {
    const f = await loadFixtures();
    const me = mockNation();
    return demoStats(me, demoTimelapse(f.provinces, me), f.catalog);
  }
  async battleReport(_gameId: string, reportId: string): Promise<BattleReport> {
    const r = mockSession.battle?.(reportId);
    if (!r) throw new Error('not_found');
    return r;
  }
  async pushKey() {
    return null;
  }
  async pushSubscribe() {}
  async pushUnsubscribe() {}
  async shopPacks() {
    return DEMO_PACKS;
  }
  async wallet() {
    return demoWallet(WALLET.balance);
  }
  async checkout(packId: string) {
    const p = DEMO_PACKS.find((x) => x.id === packId);
    if (p) WALLET.balance += p.amount + p.bonus;
    return { url: '' };
  }
  async accelerate(_g: string, _t: unknown, hours: number) {
    const cost = Math.ceil(hours * 10);
    if (WALLET.balance < cost) return { ok: false, balance: WALLET.balance };
    WALLET.balance -= cost;
    return { ok: true, balance: WALLET.balance };
  }
  async cosmetics() {
    return { items: DEMO_COSMETICS, owned: [...OWNED] };
  }
  async buyCosmetic(id: string) {
    const c = DEMO_COSMETICS.find((x) => x.id === id);
    if (!c || WALLET.balance < c.price || OWNED.has(id))
      return { ok: false, balance: WALLET.balance };
    WALLET.balance -= c.price;
    OWNED.add(id);
    return { ok: true, balance: WALLET.balance };
  }
  async rankings(season?: string) {
    return {
      season: DEMO_SEASONS.find((s) => s.id === season) ?? DEMO_SEASONS[0]!,
      entries: demoRankings(),
    };
  }
  async seasons() {
    return DEMO_SEASONS;
  }
  async legal(doc: LegalDocRef['id']) {
    return demoLegal(doc);
  }
  async publicStats() {
    return { nations: 201, provinces: 2567, systems: 406, gamesRunning: 37, playersOnline: 112 };
  }
  async acceptLegal() {
    try {
      localStorage.setItem(LEGAL_KEY, '3');
    } catch {
      /* stockage indisponible */
    }
  }
  async legalPending(): Promise<LegalDocRef[]> {
    // Démonstration : l'écran d'acceptation s'affiche avec ?legal=1 tant qu'il n'a pas été validé.
    const force = new URLSearchParams(window.location.search).get('legal') === '1';
    let accepted = false;
    try {
      accepted = localStorage.getItem(LEGAL_KEY) === '3';
    } catch {
      accepted = true;
    }
    return force && !accepted
      ? [
          { id: 'cgu', version: 3 },
          { id: 'privacy', version: 3 },
        ]
      : [];
  }
}

function mockNation(): NationId {
  try {
    return sessionStorage.getItem(NATION_KEY) ?? MOCK_DEFAULT_NATION;
  } catch {
    return MOCK_DEFAULT_NATION;
  }
}

function remember(nationId: NationId) {
  try {
    sessionStorage.setItem(NATION_KEY, nationId);
  } catch {
    /* stockage indisponible */
  }
}
