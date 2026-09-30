import { create } from 'zustand';
import type { LngLat, ProvinceId, UnitId } from '@redline/shared';
import { STORAGE } from '../config.js';

export type PendingOrder =
  | { kind: 'move'; unitIds: UnitId[]; to: LngLat }
  | { kind: 'attack'; unitIds: UnitId[]; targetId: UnitId };

export type DrawerId = 'army' | 'production' | 'alerts' | 'layers' | 'sandbox' | null;

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

export interface FocusRequest {
  at: LngLat;
  zoom?: number;
  seq: number;
}

export interface UiStore {
  /** Unités sélectionnées (les ordres s'appliquent à elles). */
  selection: UnitId[];
  /** Unité ennemie inspectée (sans sélection active). */
  inspected: UnitId | null;
  selectedProvince: ProvinceId | null;
  pendingOrder: PendingOrder | null;
  drawer: DrawerId;
  legendOpen: boolean;
  focus: FocusRequest | null;
  toasts: Toast[];
  tutorialStep: number | null;

  select(ids: UnitId[]): void;
  inspect(id: UnitId | null): void;
  selectProvince(id: ProvinceId | null): void;
  setPending(o: PendingOrder | null): void;
  clearSelection(): void;
  openDrawer(d: DrawerId): void;
  toggleDrawer(d: Exclude<DrawerId, null>): void;
  setLegendOpen(v: boolean): void;
  focusOn(at: LngLat, zoom?: number): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  setTutorialStep(step: number | null): void;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

let seq = 0;

export const useUi = create<UiStore>((set, get) => ({
  selection: [],
  inspected: null,
  selectedProvince: null,
  pendingOrder: null,
  drawer: null,
  legendOpen: readBool(
    STORAGE.legendOpen,
    typeof window !== 'undefined' && window.innerWidth >= 768,
  ),
  focus: null,
  toasts: [],
  tutorialStep: null,

  select(ids) {
    set({ selection: ids, inspected: null, pendingOrder: null });
  },
  inspect(id) {
    set({ inspected: id });
  },
  selectProvince(id) {
    set({ selectedProvince: id });
  },
  setPending(o) {
    set({ pendingOrder: o });
  },
  clearSelection() {
    set({ selection: [], inspected: null, pendingOrder: null });
  },
  openDrawer(d) {
    set({ drawer: d });
  },
  toggleDrawer(d) {
    set({ drawer: get().drawer === d ? null : d });
  },
  setLegendOpen(v) {
    try {
      localStorage.setItem(STORAGE.legendOpen, v ? '1' : '0');
    } catch {
      /* stockage indisponible */
    }
    set({ legendOpen: v });
  },
  focusOn(at, zoom) {
    set({ focus: { at, zoom, seq: ++seq } });
  },
  toast(text, tone = 'info') {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 5000 : 3000);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setTutorialStep(step) {
    set({ tutorialStep: step });
  },
}));
