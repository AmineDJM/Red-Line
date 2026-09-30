/**
 * API de démonstration (?mock=1) : sert les fixtures de apps/client/test-fixtures, sans serveur.
 * Chargé paresseusement (jamais inclus dans le parcours normal).
 */
import type { FeatureCollection } from 'geojson';
import type { CreateGameBody, GameMeta, NationDef, NationId, ProvinceDef, PublicUser, WeaponSystem } from '@redline/shared';
import { FALLBACK_TILES, FONTS } from '../config.js';
import { probeBinary } from './http.js';
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

let fixtures: Promise<{
  nations: NationDef[];
  provinces: ProvinceDef[];
  geo: FeatureCollection;
  catalog: WeaponSystem[];
  land: FeatureCollection;
  seas: FeatureCollection;
}> | null = null;

export function loadFixtures() {
  fixtures ??= (async () => {
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
      land: JSON.parse(l.default) as FeatureCollection,
      seas: JSON.parse(s.default) as FeatureCollection,
    };
  })();
  return fixtures;
}

const guestUser: PublicUser = { id: 'guest-demo', displayName: 'Invité', email: null, role: 'player', isGuest: true };

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
    this.user = { id: 'demo', displayName: body.email.split('@')[0] ?? 'Joueur', email: body.email, role: 'player', isGuest: false };
    return this.user;
  }
  async register(body: RegisterInput) {
    this.user = { id: 'demo', displayName: body.displayName, email: body.email, role: 'player', isGuest: false };
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
    const f = await loadFixtures();
    return { land: f.land, coastline: null, seas: f.seas };
  }
  glyphsAvailable() {
    return probeBinary(`/glyphs/${encodeURIComponent(FONTS.title)}/0-255.pbf`);
  }
  async scenarios() {
    return [{ id: 'world-today', name: 'Monde actuel', description: 'Démonstration hors ligne', playableNations: 'all' as const }];
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
