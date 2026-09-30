/**
 * API de démonstration (?mock=1) : sert les fixtures de apps/client/test-fixtures, sans serveur.
 * Chargé paresseusement (jamais inclus dans le parcours normal).
 */
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
import { FALLBACK_TILES, FONTS } from '../config.js';
import { loadBasemap, probeBinary } from './http.js';
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
  fixtures ??= (async () =>
    (forceFixtures ? null : await loadRealData()) ?? loadMinimalFixtures())();
  return fixtures;
}

const guestUser: PublicUser = {
  id: 'guest-demo',
  displayName: 'Invité',
  email: null,
  role: 'player',
  isGuest: true,
};

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
    return (await loadFixtures()).provinces;
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
    let me = MOCK_DEFAULT_NATION;
    try {
      me = sessionStorage.getItem(NATION_KEY) ?? MOCK_DEFAULT_NATION;
    } catch {
      /* stockage indisponible */
    }
    return { game: mockMeta(), me };
  }
}
