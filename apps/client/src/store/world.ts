import { create } from 'zustand';
import type { FeatureCollection } from 'geojson';
import type { NationDef, NationId, ProvinceDef, ProvinceId, SystemId, WeaponSystem } from '@redline/shared';
import type { Api, BasemapData, TilesInfo } from '../api/types.js';

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
  load(api: Api): Promise<void>;
}

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

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
  async load(api) {
    if (get().status === 'ready' || get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      // Les éléments facultatifs (fond, tuiles, glyphes) n'échouent jamais.
      const [nations, provinces, provincesGeo, catalog, tiles, basemap, glyphs] = await Promise.all([
        api.nations(),
        api.provinces(),
        api.provincesGeoJSON(),
        api.catalog(),
        api.tiles().catch(() => null),
        api.basemap().catch(() => ({ land: null, coastline: null, seas: null })),
        api.glyphsAvailable().catch(() => false),
      ]);
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
