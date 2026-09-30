/** Réglages techniques du client (aucun chiffre d'équilibrage ici : ceux-ci viennent du serveur / de data/). */

function readMockFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get('mock');
    if (q === '1') sessionStorage.setItem('rl.mock', '1');
    if (q === '0') sessionStorage.removeItem('rl.mock');
    return sessionStorage.getItem('rl.mock') === '1';
  } catch {
    return false;
  }
}

/** Mode de démonstration sans serveur (?mock=1) : données de test et connexion simulée. */
export const IS_MOCK = readMockFlag();

/** Fréquence de mise à jour des positions interpolées sur la carte (Hz). */
export const UNIT_TICK_HZ = 12;

/** Nombre maximal d'étiquettes cartouches à filets affichées (critique 6.4). */
export const MAX_CALLOUTS = 32;

/** Fichiers du fond vectoriel servis sous /basemap (tous facultatifs). */
export const BASEMAP_FILES = {
  land: 'land.geojson',
  coastline: 'coastline.geojson',
  seas: 'seas.geojson',
  countries: 'countries.geojson',
  cities: 'cities.geojson',
} as const;

/** Fontstacks exacts des glyphes MapLibre (voir docs/agents-brief.md). */
export const FONTS = {
  title: 'Barlow Condensed Bold',
  regular: 'IBM Plex Sans Regular',
  semibold: 'IBM Plex Sans SemiBold',
  italic: 'IBM Plex Sans Italic',
} as const;

/** Tuiles par défaut si /api/map/tiles ne répond pas. */
export const FALLBACK_TILES = { satellite: '/tiles/satellite-lowzoom.pmtiles', maxzoom: 5 } as const;

/** Clés de stockage local. */
export const STORAGE = {
  tutorialDone: 'rl.tutorial.done',
  legendOpen: 'rl.legend.open',
} as const;
