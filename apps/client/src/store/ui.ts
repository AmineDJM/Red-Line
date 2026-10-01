import { create } from 'zustand';
import type { LngLat, ProvinceId, UnitId } from '@redline/shared';
import type { WindowRect } from '@redline/ui';
import { STORAGE } from '../config.js';

export type PendingOrder =
  | { kind: 'move'; unitIds: UnitId[]; to: LngLat }
  | { kind: 'attack'; unitIds: UnitId[]; targetId: UnitId };

/** Fenêtres de la coque de jeu (une par domaine). */
export const WINDOW_IDS = [
  'army',
  'production',
  'research',
  'economy',
  'intel',
  'diplomacy',
  'council',
  'news',
  'battles',
  'encyclopedia',
  'chat',
  'shop',
  'settings',
] as const;
export type WindowId = (typeof WINDOW_IDS)[number];

/** Paramètres d'ouverture (fiche à afficher, onglet, élément ciblé). */
export interface WindowParams {
  tab?: string;
  systemId?: string;
  reportId?: string;
  nationId?: string;
  provinceId?: string;
  channel?: string;
  /** Nœud de recherche à afficher. */
  nodeId?: string;
}

export interface WindowState {
  id: WindowId;
  rect: WindowRect;
  z: number;
  maximized: boolean;
  params: WindowParams;
  /** Incrémenté à chaque ouverture ciblée (les fenêtres réagissent aux nouveaux paramètres). */
  seq: number;
}

/** @deprecated Ancien système de tiroirs (phase 1) : redirigé vers les fenêtres. */
export type DrawerId = 'army' | 'production' | 'alerts' | 'layers' | 'sandbox' | null;

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info' | 'warn';
  action?: { label: string; onClick: () => void };
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
  /** @deprecated voir `windows`. */
  drawer: DrawerId;
  legendOpen: boolean;
  focus: FocusRequest | null;
  toasts: Toast[];
  tutorialStep: number | null;
  windows: WindowState[];
  /** Console de commande (Ctrl+K ou « : »). */
  paletteOpen: boolean;
  paletteSeed: string;
  alertsOpen: boolean;
  /** Menu « Plus » de la barre de navigation mobile. */
  moreOpen: boolean;

  select(ids: UnitId[]): void;
  inspect(id: UnitId | null): void;
  selectProvince(id: ProvinceId | null): void;
  setPending(o: PendingOrder | null): void;
  clearSelection(): void;
  /** @deprecated voir `openWindow`. */
  openDrawer(d: DrawerId): void;
  /** @deprecated voir `toggleWindow`. */
  toggleDrawer(d: Exclude<DrawerId, null>): void;
  setLegendOpen(v: boolean): void;
  focusOn(at: LngLat, zoom?: number): void;
  toast(text: string, tone?: Toast['tone'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  setTutorialStep(step: number | null): void;

  openWindow(id: WindowId, params?: WindowParams): void;
  closeWindow(id: WindowId): void;
  toggleWindow(id: WindowId): void;
  focusWindow(id: WindowId): void;
  setWindowRect(id: WindowId, rect: WindowRect): void;
  toggleMaximize(id: WindowId): void;
  closeAllWindows(): void;
  setPaletteOpen(v: boolean, seed?: string): void;
  setAlertsOpen(v: boolean): void;
  setMoreOpen(v: boolean): void;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** Tailles par défaut des fenêtres (ordinateur). */
const WINDOW_SIZE: Record<WindowId, { w: number; h: number }> = {
  army: { w: 1060, h: 680 },
  production: { w: 1280, h: 760 },
  research: { w: 1120, h: 700 },
  economy: { w: 980, h: 680 },
  intel: { w: 1280, h: 760 },
  diplomacy: { w: 1000, h: 680 },
  council: { w: 920, h: 680 },
  news: { w: 620, h: 700 },
  battles: { w: 1120, h: 720 },
  encyclopedia: { w: 1280, h: 760 },
  chat: { w: 780, h: 620 },
  shop: { w: 900, h: 640 },
  settings: { w: 520, h: 720 },
};

/** Zone utile des fenêtres flottantes (sous la barre supérieure, à droite du rail). */
export function windowBounds() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const h = typeof window !== 'undefined' ? window.innerHeight : 900;
  return { top: 52, left: 60, right: w - 8, bottom: h - 8 };
}

function defaultRect(id: WindowId, index: number) {
  const b = windowBounds();
  const size = WINDOW_SIZE[id];
  const w = Math.min(size.w, b.right - b.left - 16);
  const h = Math.min(size.h, b.bottom - b.top - 16);
  const cascade = (index % 5) * 28;
  const x = Math.min(b.left + 12 + cascade, b.right - w);
  const y = Math.min(b.top + 10 + cascade, b.bottom - h);
  return { x, y, w, h };
}

let seq = 0;
let zTop = 20;

const DRAWER_TO_WINDOW: Partial<Record<Exclude<DrawerId, null>, WindowId>> = {
  army: 'army',
  production: 'production',
  layers: 'settings',
};

export const useUi = create<UiStore>((set, get) => ({
  selection: [],
  inspected: null,
  selectedProvince: null,
  pendingOrder: null,
  drawer: null,
  legendOpen: readBool(
    STORAGE.legendOpen,
    typeof window !== 'undefined' && window.innerWidth >= 1100,
  ),
  focus: null,
  toasts: [],
  tutorialStep: null,
  windows: [],
  paletteOpen: false,
  paletteSeed: '',
  alertsOpen: false,
  moreOpen: false,

  select(ids) {
    set({ selection: ids, inspected: null, pendingOrder: null, selectedProvince: null });
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
    if (d === 'alerts') return set({ alertsOpen: true, drawer: d });
    const w = d ? DRAWER_TO_WINDOW[d] : undefined;
    if (w) get().openWindow(w);
    else if (d === null) set({ drawer: null });
    set({ drawer: d });
  },
  toggleDrawer(d) {
    if (d === 'alerts') return set({ alertsOpen: !get().alertsOpen });
    const w = DRAWER_TO_WINDOW[d];
    if (w) get().toggleWindow(w);
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
  toast(text, tone = 'info', action) {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : action ? 6000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setTutorialStep(step) {
    set({ tutorialStep: step });
  },

  openWindow(id, params = {}) {
    const ws = get().windows;
    const cur = ws.find((w) => w.id === id);
    zTop += 1;
    if (cur) {
      set({
        windows: ws.map((w) =>
          w.id === id ? { ...w, z: zTop, params: { ...w.params, ...params }, seq: ++seq } : w,
        ),
        moreOpen: false,
      });
      return;
    }
    set({
      windows: [
        ...ws,
        {
          id,
          rect: defaultRect(id, ws.length),
          z: zTop,
          maximized: false,
          params,
          seq: ++seq,
        },
      ],
      moreOpen: false,
    });
  },
  closeWindow(id) {
    set({ windows: get().windows.filter((w) => w.id !== id) });
  },
  toggleWindow(id) {
    const ws = get().windows;
    const cur = ws.find((w) => w.id === id);
    const top = ws.reduce((m, w) => Math.max(m, w.z), 0);
    // Fenêtre ouverte mais cachée derrière une autre : on la ramène au premier plan.
    if (cur && cur.z === top) get().closeWindow(id);
    else get().openWindow(id);
  },
  focusWindow(id) {
    const ws = get().windows;
    const top = ws.reduce((m, w) => Math.max(m, w.z), 0);
    const cur = ws.find((w) => w.id === id);
    if (!cur || cur.z === top) return;
    zTop += 1;
    set({ windows: ws.map((w) => (w.id === id ? { ...w, z: zTop } : w)) });
  },
  setWindowRect(id, rect) {
    set({ windows: get().windows.map((w) => (w.id === id ? { ...w, rect } : w)) });
  },
  toggleMaximize(id) {
    set({
      windows: get().windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)),
    });
  },
  closeAllWindows() {
    set({ windows: [] });
  },
  setPaletteOpen(v, seedText = '') {
    set({ paletteOpen: v, paletteSeed: seedText });
  },
  setAlertsOpen(v) {
    set({ alertsOpen: v });
  },
  setMoreOpen(v) {
    set({ moreOpen: v });
  },
}));

/** Fenêtre au premier plan (null si aucune). */
export function topWindow(windows: WindowState[]): WindowState | null {
  return windows.reduce<WindowState | null>((m, w) => (!m || w.z > m.z ? w : m), null);
}
