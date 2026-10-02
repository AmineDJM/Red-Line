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
import {
  localizeBasemap,
  localizeCatalog,
  localizeNationInfo,
  localizeNations,
  localizeProvinces,
  localizeProvincesGeo,
  localizeResearch,
} from '../lib/localize.js';
import { isFrench, lang, NON_LATIN_SCRIPT, setMapNames } from '../i18n/index.js';

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
  /**
   * Carte demandée : null = carte courante (nouvelles parties), sinon version épinglée par une partie
   * créée avant un changement d'identifiants de province.
   */
  requestedMap: number | null;
  /** Version de la carte chargée (réponse du serveur), null si inconnue (démo). */
  mapVersion: number | null;
  /** Charge la carte courante, ou la version `map` (partie ancienne). Idempotent. */
  load(api: Api, map?: number): Promise<void>;
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
  requestedMap: null,
  mapVersion: null,
  async loadRoads(api) {
    if (get().roadsStatus !== 'idle' || !api.routes) return;
    set({ roadsStatus: 'loading' });
    const map = get().requestedMap;
    const routes = await api.routes(map ?? undefined).catch(() => null);
    if (get().requestedMap !== map) return; // carte changée entre-temps
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
    set({ research: byId(localizeResearch(nodes)), balance, extras: 'ready' });
  },
  async loadNationInfo(api) {
    if (Object.keys(get().nationInfo).length) return;
    const list = await api.nationsInfo().catch(() => []);
    set({ nationInfo: byId(await localizeNationInfo(list)) });
  },
  async load(api, map) {
    void get().loadExtras(api);
    const want = map ?? null;
    const cur = get();
    const same =
      want === null
        ? cur.requestedMap === null
        : cur.requestedMap === want || (cur.mapVersion !== null && cur.mapVersion === want);
    if (same && (cur.status === 'ready' || cur.status === 'loading')) {
      void get().loadRoads(api);
      return;
    }
    // Autre carte : les données de la précédente (et ses routes) sont remplacées.
    set({
      status: 'loading',
      error: null,
      requestedMap: want,
      routes: null,
      roads: null,
      roadsStatus: 'idle',
    });
    void get().loadRoads(api);
    try {
      // Noms localisés d'une carte archivée (avant la localisation des provinces).
      const archivedNames =
        want !== null && !isFrench && api.mapNames
          ? api.mapNames(want, lang).catch(() => ({ provinces: {}, cities: {} }))
          : Promise.resolve(null);
      // Les éléments facultatifs (fond, tuiles, glyphes) n'échouent jamais.
      const [mapNations, provinces, provincesGeo, catalog, tiles, basemap, glyphs, names] =
        await Promise.all([
          api.nations(map),
          api.provinces(map),
          api.provincesGeoJSON(map),
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
          archivedNames,
        ]);
      if (get().requestedMap !== want) return; // une autre carte a été demandée entre-temps
      // Carte courante servie (même version que demandée) : noms embarqués.
      const archived = want !== null && mapNations.mapVersion !== null && names !== null;
      setMapNames(archived ? names : null);
      const nations = mapNations.nations;
      set({
        status: 'ready',
        mapVersion: mapNations.mapVersion,
        nations: byId(localizeNations(nations)),
        provinces: byId(localizeProvinces(provinces)),
        provincesGeo: localizeProvincesGeo(provincesGeo),
        catalog: byId(localizeCatalog(catalog)),
        tiles,
        basemap: localizeBasemap(basemap),
        // Écritures non latines : étiquettes dessinées par le navigateur (glyphes de carte latins).
        glyphs: glyphs && !NON_LATIN_SCRIPT,
      });
    } catch (e) {
      if (get().requestedMap !== want) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
