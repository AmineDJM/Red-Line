import { useCallback, useState, type ReactNode } from 'react';
import type { LngLat } from '@redline/shared';
import { AudioBridge } from '../audio/AudioBridge.js';
import { MapView } from '../map/MapView.js';
import { navigate } from '../router.js';
import { isRtl } from '../i18n/index.js';
import { useUi } from '../store/ui.js';
import { CommandConsole } from './CommandConsole.js';
import { MobileNav, SideNav } from './Nav.js';
import {
  AlertCenter,
  AlertTicker,
  ConnectionBanner,
  EndOverlay,
  LegendPanel,
  OrderBar,
  ShortcutsHelp,
  Toasts,
} from './Overlays.js';
import { useMapSel } from '../map/mapSel.js';
import { useStackMenu } from '../map/stackMenu.js';
import { SelectionPanel } from './SelectionPanel.js';
import { StackMenu } from './StackMenu.js';
import { useShortcuts } from './shortcuts.js';
import { TopBar } from './TopBar.js';
import { Tutorial } from './Tutorial.js';
import { useIsMobile } from './useMedia.js';
import { WeaponSheet } from './WeaponSheet.js';
import { WindowHost } from './WindowHost.js';

export interface GameShellProps {
  mode: 'game' | 'sandbox';
  fog: boolean;
  tutorial: boolean;
  /** Contenu additionnel (panneau du bac à sable). */
  children?: ReactNode;
  placing?: boolean;
  onPlace?: (at: LngLat) => void;
  /** Badge à droite de la barre supérieure (démonstration). */
  badge?: ReactNode;
}

/**
 * Coque de jeu : carte plein écran, barre supérieure, barre latérale (ordinateur) ou barre de
 * navigation (mobile), fenêtres, sélection, confirmation d'ordre, alertes, console.
 */
export function GameShell({
  mode,
  fog,
  tutorial,
  children,
  placing,
  onPlace,
  badge,
}: GameShellProps) {
  const mobile = useIsMobile();
  const [help, setHelp] = useState(false);
  const toggleHelp = useCallback(() => setHelp((h) => !h), []);
  useShortcuts(toggleHelp);
  const pending = useUi((s) => s.pendingOrder !== null);
  const battle = useMapSel((s) => s.battle !== null);
  const stackOpen = useStackMenu((s) => s.open !== null);
  const hasSelection =
    useUi((s) => s.selection.length > 0 || s.inspected !== null || s.selectedProvince !== null) ||
    battle;
  const sheetOpen = useUi((s) => mobile && (s.windows.length > 0 || s.moreOpen));
  const insets = mobile
    ? { top: 78, right: 0, bottom: 64, left: 0 }
    : { top: 44, right: isRtl ? 52 : 0, bottom: 0, left: isRtl ? 0 : 52 };
  return (
    <div className={mobile ? 'game game--mobile' : 'game game--desktop'} data-mode={mode}>
      <MapView mode={mode} fog={fog} insets={insets} placing={placing} onPlace={onPlace} />
      <TopBar mobile={mobile} onExit={() => navigate('/')} />
      {badge ? <div className="game__badge">{badge}</div> : null}
      {mobile ? <MobileNav /> : <SideNav />}
      {!mobile ? <AlertTicker /> : null}
      <ConnectionBanner />
      {!sheetOpen && !(mobile && (pending || stackOpen)) ? (
        <div className="game__sel">
          <SelectionPanel compact={mobile} />
        </div>
      ) : null}
      {!sheetOpen && !(mobile && (hasSelection || pending)) ? (
        <div className="game__legend">
          <LegendPanel fog={fog} />
        </div>
      ) : null}
      {!sheetOpen ? <OrderBar /> : null}
      {!sheetOpen ? <StackMenu /> : null}
      <WindowHost />
      <WeaponSheet />
      <AlertCenter mobile={mobile} />
      {children}
      <CommandConsole />
      <Tutorial enabled={tutorial} />
      {help ? <ShortcutsHelp onClose={() => setHelp(false)} /> : null}
      <Toasts />
      <EndOverlay />
      <AudioBridge />
    </div>
  );
}
