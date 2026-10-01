import { lazy, Suspense, useCallback, type ComponentType, type LazyExoticComponent } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner, Window, type WindowProps } from '@redline/ui';
import { useUi, windowBounds, type WindowId, type WindowState } from '../store/ui.js';
import { sectionOf } from './sections.js';
import { useIsMobile } from './useMedia.js';

export interface WindowContentProps {
  win: WindowState;
  /** Propriétés communes du cadre (à étaler sur <Window>). */
  frame: Omit<WindowProps, 'children'>;
  mobile: boolean;
}

// Chaque domaine est un morceau chargé à la première ouverture.
const CONTENT: Record<WindowId, LazyExoticComponent<ComponentType<WindowContentProps>>> = {
  armies: lazy(() =>
    import('../windows/ArmiesWindow.js').then((m) => ({ default: m.ArmiesWindow })),
  ),
  army: lazy(() => import('../windows/ArmyWindow.js').then((m) => ({ default: m.ArmyWindow }))),
  production: lazy(() =>
    import('../windows/ProductionWindow.js').then((m) => ({ default: m.ProductionWindow })),
  ),
  research: lazy(() =>
    import('../windows/ResearchWindow.js').then((m) => ({ default: m.ResearchWindow })),
  ),
  economy: lazy(() =>
    import('../windows/EconomyWindow.js').then((m) => ({ default: m.EconomyWindow })),
  ),
  intel: lazy(() => import('../windows/IntelWindow.js').then((m) => ({ default: m.IntelWindow }))),
  diplomacy: lazy(() =>
    import('../windows/DiplomacyWindow.js').then((m) => ({ default: m.DiplomacyWindow })),
  ),
  council: lazy(() =>
    import('../windows/CouncilWindow.js').then((m) => ({ default: m.CouncilWindow })),
  ),
  news: lazy(() => import('../windows/NewsWindow.js').then((m) => ({ default: m.NewsWindow }))),
  battles: lazy(() =>
    import('../windows/BattlesWindow.js').then((m) => ({ default: m.BattlesWindow })),
  ),
  chat: lazy(() => import('../windows/ChatWindow.js').then((m) => ({ default: m.ChatWindow }))),
  shop: lazy(() => import('../windows/ShopWindow.js').then((m) => ({ default: m.ShopWindow }))),
  settings: lazy(() =>
    import('../windows/SettingsWindow.js').then((m) => ({ default: m.SettingsWindow })),
  ),
};

function Host({ win, top, mobile }: { win: WindowState; top: boolean; mobile: boolean }) {
  const { t } = useTranslation();
  const closeWindow = useUi((s) => s.closeWindow);
  const focusWindow = useUi((s) => s.focusWindow);
  const setWindowRect = useUi((s) => s.setWindowRect);
  const toggleMaximize = useUi((s) => s.toggleMaximize);
  const onClose = useCallback(() => closeWindow(win.id), [closeWindow, win.id]);
  const s = sectionOf(win.id);
  const title = t(`sections.${win.id}`);
  const frame: Omit<WindowProps, 'children'> = {
    id: `win-${win.id}`,
    title,
    path: [t(`sections.path.${win.id}`)],
    shortcut: mobile ? undefined : s.key,
    mode: mobile ? 'sheet' : 'floating',
    rect: win.rect,
    onRectChange: (r) => setWindowRect(win.id, r),
    minSize: { w: 420, h: 280 },
    bounds: windowBounds(),
    zIndex: mobile ? 60 : win.z,
    focused: top,
    onFocus: () => focusWindow(win.id),
    onClose,
    closeLabel: t('app.close'),
    maximized: win.maximized,
    onToggleMaximize: () => toggleMaximize(win.id),
    maximizeLabel: t('app.maximize'),
  };
  const Content = CONTENT[win.id];
  return (
    <Suspense
      fallback={
        <Window {...frame}>
          <Spinner label={t('app.loading')} />
        </Window>
      }
    >
      <Content win={win} frame={frame} mobile={mobile} />
    </Suspense>
  );
}

/**
 * Fenêtre ouverte (une seule à la fois : en ouvrir une autre la remplace) : flottante sur
 * ordinateur, plein écran sur mobile.
 */
export function WindowHost() {
  const windows = useUi((s) => s.windows);
  const mobile = useIsMobile();
  if (!windows.length) return null;
  const top = windows.reduce((m, w) => (w.z > m.z ? w : m), windows[0]!);
  const shown = mobile ? [top] : windows;
  return (
    <>
      {shown.map((w) => (
        <Host key={w.id} win={w} top={w.id === top.id} mobile={mobile} />
      ))}
    </>
  );
}
