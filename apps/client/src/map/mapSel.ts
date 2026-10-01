/**
 * Sélections propres à la carte, hors du store d'interface général : bataille inspectée (panneau de
 * détail des combats). La carte la renseigne au clic sur un marqueur de bataille ; le panneau de
 * sélection l'affiche (priorité : unités, puis bataille, puis province).
 */
import { create } from 'zustand';
import type { LngLat, UnitId } from '@redline/shared';

export interface BattleSelection {
  /** Identifiant du marqueur (`b:<rapport>` ou `s:<unité>` pour un accrochage). */
  id: string;
  reportId: string | null;
  at: LngLat;
  /** Accrochage sans rapport : unités au combat rattachées. */
  unitIds: UnitId[];
}

export interface MapSelStore {
  battle: BattleSelection | null;
  selectBattle(b: BattleSelection | null): void;
}

export const useMapSel = create<MapSelStore>((set) => ({
  battle: null,
  selectBattle(b) {
    set({ battle: b });
  },
}));
