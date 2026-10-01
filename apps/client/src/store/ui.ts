import { create } from 'zustand';
import type { LngLat, ProvinceId, UnitId } from '@redline/shared';
import type { WindowRect } from '@redline/ui';
import { STORAGE } from '../config.js';

export type PendingOrder =
  | { kind: 'move'; unitIds: UnitId[]; to: LngLat }
  | { kind: 'attack'; unitIds: UnitId[]; targetId: UnitId };

/**
 * Fenêtres de la coque de jeu (une par domaine). Une seule est ouverte à la fois : en ouvrir une
 * autre la remplace. `armies` : « Mes armées » (groupes sur la carte) ; `army` : « Arsenal de
 * guerre » (inventaire du matériel possédé).
 */
export const WINDOW_IDS = [
  'armies',
  'army',
  'production',
  'research',
  'economy',
  'intel',
  'diplomacy',
  'council',
  'news',
  'battles',
  'chat',
  'shop',
  'settings',
] as const;
export type WindowId = (typeof WINDOW_IDS)[number];
/**
 * Fenêtre demandée : `encyclopedia` (ancienne section, supprimée) ouvre le catalogue de
 * l'Arsenal de guerre.
 */
export type WindowRequest = WindowId | 'encyclopedia';

/** Résout un alias de fenêtre (ancienne encyclopédie → catalogue de l'Arsenal de guerre). */
export function resolveWindow(
  id: WindowRequest,
  params: WindowParams = {},
): { id: WindowId; params: WindowParams } {
  if (id === 'encyclopedia') return { id: 'army', params: { tab: 'catalog', ...params } };
  return { id, params };
}

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

/** Fiche d'arme seule (fenêtre modale légère, au-dessus de la fenêtre en cours). */
export interface WeaponSheetRequest {
  systemId: string;
  /** Unité d'origine (fiche ouverte depuis une armée). */
  unitId?: UnitId;
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
  /** Fiche d'arme ouverte seule (null si aucune). */
  sheet: WeaponSheetRequest | null;

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

  /** Ouvre une fenêtre ; celle déjà ouverte (autre domaine) est fermée. */
  openWindow(id: WindowRequest, params?: WindowParams): void;
  closeWindow(id: WindowId): void;
  toggleWindow(id: WindowRequest): void;
  focusWindow(id: WindowId): void;
  setWindowRect(id: WindowId, rect: WindowRect): void;
  toggleMaximize(id: WindowId): void;
  closeAllWindows(): void;
  setPaletteOpen(v: boolean, seed?: string): void;
  setAlertsOpen(v: boolean): void;
  setMoreOpen(v: boolean): void;
  /** Fiche d'arme seule, sans ouvrir le catalogue complet. */
  openSheet(systemId: string, unitId?: UnitId): void;
  closeSheet(): void;
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
  armies: { w: 1320, h: 740 },
  army: { w: 1280, h: 760 },
  production: { w: 1280, h: 760 },
  research: { w: 1120, h: 700 },
  economy: { w: 980, h: 680 },
  intel: { w: 1280, h: 760 },
  diplomacy: { w: 1000, h: 680 },
  council: { w: 920, h: 680 },
  news: { w: 620, h: 700 },
  battles: { w: 1120, h: 720 },
  chat: { w: 780, h: 620 },
  shop: { w: 900, h: 640 },
  settings: { w: 520, h: 560 },
};

/** Zone utile des fenêtres flottantes (sous la barre supérieure, à droite du rail). */
export function windowBounds() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const h = typeof window !== 'undefined' ? window.innerHeight : 900;
  return { top: 52, left: 60, right: w - 8, bottom: h - 8 };
}

function defaultRect(id: WindowId) {
  const b = windowBounds();
  const size = WINDOW_SIZE[id];
  const w = Math.min(size.w, b.right - b.left - 16);
  const h = Math.min(size.h, b.bottom - b.top - 16);
  const x = Math.min(b.left + 12, b.right - w);
  const y = Math.min(b.top + 10, b.bottom - h);
  return { x, y, w, h };
}

/** Position, taille et agrandissement retenus par fenêtre (rouverte là où on l'avait laissée). */
const placement = new Map<WindowId, { rect: WindowRect; maximized: boolean }>();

let seq = 0;
let zTop = 20;

const DRAWER_TO_WINDOW: Partial<Record<Exclude<DrawerId, null>, WindowId>> = {
  army: 'armies',
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
  sheet: null,

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

  openWindow(req, rawParams = {}) {
    const { id, params } = resolveWindow(req, rawParams);
    const ws = get().windows;
    const cur = ws.find((w) => w.id === id);
    zTop += 1;
    if (cur) {
      // Même domaine : nouveaux paramètres ; les autres fenêtres (anciennes versions) sont fermées.
      set({
        windows: [{ ...cur, z: zTop, params: { ...cur.params, ...params }, seq: ++seq }],
        moreOpen: false,
        sheet: null,
      });
      return;
    }
    // Une seule fenêtre principale : la nouvelle remplace la précédente.
    const kept = placement.get(id);
    set({
      windows: [
        {
          id,
          rect: kept?.rect ?? defaultRect(id),
          z: zTop,
          maximized: kept?.maximized ?? false,
          params,
          seq: ++seq,
        },
      ],
      moreOpen: false,
      sheet: null,
    });
  },
  closeWindow(id) {
    set({ windows: get().windows.filter((w) => w.id !== id) });
  },
  toggleWindow(req) {
    const { id, params } = resolveWindow(req);
    const ws = get().windows;
    const cur = ws.find((w) => w.id === id);
    const top = ws.reduce((m, w) => Math.max(m, w.z), 0);
    if (cur && cur.z === top && (req === id || cur.params.tab === params.tab))
      get().closeWindow(id);
    else get().openWindow(id, params);
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
    const w = get().windows.find((x) => x.id === id);
    placement.set(id, { rect, maximized: w?.maximized ?? false });
    set({ windows: get().windows.map((x) => (x.id === id ? { ...x, rect } : x)) });
  },
  toggleMaximize(id) {
    const w = get().windows.find((x) => x.id === id);
    if (w) placement.set(id, { rect: w.rect, maximized: !w.maximized });
    set({
      windows: get().windows.map((x) => (x.id === id ? { ...x, maximized: !x.maximized } : x)),
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
  openSheet(systemId, unitId) {
    set({ sheet: { systemId, ...(unitId ? { unitId } : {}) }, moreOpen: false });
  },
  closeSheet() {
    set({ sheet: null });
  },
}));

/** Fenêtre au premier plan (null si aucune). */
export function topWindow(windows: WindowState[]): WindowState | null {
  return windows.reduce<WindowState | null>((m, w) => (!m || w.z > m.z ? w : m), null);
}
