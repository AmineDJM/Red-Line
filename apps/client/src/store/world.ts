import { create } from 'zustand';
import type { FeatureCollection } from 'geojson';
import type {
  Balance,
  NationDef,
  NationId,
  NationInfo,
  ProvinceDef,
  ProvinceId,
  ResearchNode,
  SystemId,
  RoutesFile,
  WeaponSystem,
} from '@redline/shared';
import { RoadNet } from '@redline/shared';
import type { Api, BasemapData, TilesInfo } from '../api/types.js';
import { bundledBalance } from '../lib/staticData.js';

/** Données statiques de la carte et du catalogue (chargées une fois). */
export interface WorldState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  nations: Record<NationId, NationDef>;
  provinces: Record<ProvinceId, ProvinceDef>;
  provincesGeo: FeatureCollection | null;
  catalog: Record<SystemId, WeaponSystem>;
  tiles: TilesInfo | null;
  basemap: BasemapData | null;
  glyphs: boolean;
  /** Arbre technologique (chargé après la carte, non bloquant). */
  research: Record<string, ResearchNode>;
  /** Équilibrage embarqué (coûts des bâtiments, opérations…), null si indisponible. */
  balance: Balance | null;
  /** Fiches nations (écran de sélection), chargées à la demande. */
  nationInfo: Record<NationId, NationInfo>;
  extras: 'idle' | 'loading' | 'ready';
  /** Réseau de routes des unités terrestres (chargé après la carte, non bloquant). */
  routes: RoutesFile | null;
  roads: RoadNet | null;
  roadsStatus: 'idle' | 'loading' | 'ready';
  load(api: Api): Promise<void>;
  loadRoads(api: Api): Promise<void>;
  loadExtras(api: Api): Promise<void>;
  loadNationInfo(api: Api): Promise<void>;
}

const byId = <T extends { id: string }>(list: T[]): Record<string, T> =>
  Object.fromEntries(list.map((x) => [x.id, x]));

export const useWorld = create<WorldState>((set, get) => ({
  status: 'idle',
  error: null,
  nations: {},
  provinces: {},
  provincesGeo: null,
  catalog: {},
  tiles: null,
  basemap: null,
  glyphs: false,
  research: {},
  balance: null,
  nationInfo: {},
  extras: 'idle',
  routes: null,
  roads: null,
  roadsStatus: 'idle',
  async loadRoads(api) {
    if (get().roadsStatus !== 'idle' || !api.routes) return;
    set({ roadsStatus: 'loading' });
    const routes = await api.routes().catch(() => null);
    let roads: RoadNet | null = null;
    try {
      roads = routes ? new RoadNet(routes) : null;
    } catch (e) {
      console.warn('[routes]', e);
    }
    set({ routes: roads ? routes : null, roads, roadsStatus: 'ready' });
  },
  async loadExtras(api) {
    if (get().extras !== 'idle') return;
    set({ extras: 'loading' });
    const [nodes, balance] = await Promise.all([
      api.researchNodes().catch(() => []),
      (api.balance ? api.balance() : bundledBalance()).catch(() => null),
    ]);
    set({ research: byId(nodes), balance, extras: 'ready' });
  },
  async loadNationInfo(api) {
    if (Object.keys(get().nationInfo).length) return;
    const list = await api.nationsInfo().catch(() => []);
    set({ nationInfo: byId(list) });
  },
  async load(api) {
    void get().loadExtras(api);
    void get().loadRoads(api);
    if (get().status === 'ready' || get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      // Les éléments facultatifs (fond, tuiles, glyphes) n'échouent jamais.
      const [nations, provinces, provincesGeo, catalog, tiles, basemap, glyphs] = await Promise.all(
        [
          api.nations(),
          api.provinces(),
          api.provincesGeoJSON(),
          api.catalog(),
          api.tiles().catch(() => null),
          api.basemap().catch(() => ({
            land: null,
            coastline: null,
            seas: null,
            countries: null,
            cities: null,
          })),
          api.glyphsAvailable().catch(() => false),
        ],
      );
      set({
        status: 'ready',
        nations: byId(nations),
        provinces: byId(provinces),
        provincesGeo,
        catalog: byId(catalog),
        tiles,
        basemap,
        glyphs,
      });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
