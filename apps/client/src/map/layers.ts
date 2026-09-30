/**
 * Visibilité des groupes de calques de la carte (renseignement, radars, villes…), partagée avec
 * l'interface : un panneau « Calques » peut lire et modifier ce store ; la carte s'y abonne.
 * Préférence mémorisée localement (confort, jamais indispensable).
 */
import { create } from 'zustand';
import { HIDDEN_BY_DEFAULT, LAYER_GROUPS, type MapLayerGroup } from './style.js';

const KEY = 'rl.map.layers';

export const MAP_LAYER_GROUPS = Object.keys(LAYER_GROUPS) as MapLayerGroup[];

function initial(): Record<MapLayerGroup, boolean> {
  const out = Object.fromEntries(
    MAP_LAYER_GROUPS.map((g) => [g, !HIDDEN_BY_DEFAULT.includes(g)]),
  ) as Record<MapLayerGroup, boolean>;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<MapLayerGroup, boolean>>;
      for (const g of MAP_LAYER_GROUPS) if (typeof saved[g] === 'boolean') out[g] = saved[g]!;
    }
  } catch {
    /* stockage indisponible */
  }
  return out;
}

export interface MapLayersStore {
  visible: Record<MapLayerGroup, boolean>;
  set(group: MapLayerGroup, on: boolean): void;
  toggle(group: MapLayerGroup): void;
}

export const useMapLayers = create<MapLayersStore>((set, get) => ({
  visible: initial(),
  set(group, on) {
    const visible = { ...get().visible, [group]: on };
    try {
      localStorage.setItem(KEY, JSON.stringify(visible));
    } catch {
      /* stockage indisponible */
    }
    set({ visible });
  },
  toggle(group) {
    get().set(group, !get().visible[group]);
  },
}));
