import type { ReactNode } from 'react';
import { MapView } from '../map/MapView.js';
import { AlertsDrawer, ArmyDrawer, LayersDrawer, ProductionDrawer } from './Drawers.js';
import { LegendPanel } from './LegendPanel.js';
import {
  ConnectionBanner,
  EndScreen,
  Toasts,
  Toolbar,
  Tutorial,
  useKeyboardShortcuts,
} from './Misc.js';
import { OrderBar } from './OrderBar.js';
import { ResourceBar } from './ResourceBar.js';
import { SelectionPanel } from './SelectionPanel.js';
import { TopBar } from './TopBar.js';
import { useIsMobile } from './useMedia.js';
import { useUi, type DrawerId } from '../store/ui.js';
import type { LngLat } from '@redline/shared';

export interface GameHudProps {
  title: string;
  subtitle: string;
  mode: 'game' | 'sandbox';
  fog: boolean;
  tutorial: boolean;
  /** Contenu additionnel (panneau du bac à sable). */
  children?: ReactNode;
  extraTools?: { id: Exclude<DrawerId, null>; label: string; icon: ReactNode }[];
  placing?: boolean;
  onPlace?: (at: LngLat) => void;
  badge?: ReactNode;
}

/** Écran de jeu : carte plein écran + interface superposée, responsive. */
export function GameHud({
  title,
  subtitle,
  mode,
  fog,
  tutorial,
  children,
  extraTools,
  placing,
  onPlace,
  badge,
}: GameHudProps) {
  const mobile = useIsMobile();
  useKeyboardShortcuts();
  const hasSelection = useUi((s) => s.selection.length > 0 || s.inspected !== null);
  const pending = useUi((s) => s.pendingOrder !== null);
  const insets = mobile
    ? { top: 112, right: 0, bottom: 72, left: 0 }
    : { top: 104, right: 0, bottom: 0, left: 72 };
  return (
    <div className={mobile ? 'game game--mobile' : 'game game--desktop'}>
      <MapView mode={mode} fog={fog} insets={insets} placing={placing} onPlace={onPlace} />
      <div className="hud-top">
        <TopBar title={title} subtitle={subtitle} compact={mobile} />
        <div className="hud-top__row">
          <ResourceBar />
          {badge}
        </div>
      </div>
      <ConnectionBanner />
      <Toolbar mobile={mobile} extra={extraTools} />
      {/* Sur mobile, l'ordre en attente remplace la fiche, et la légende cède la place à la sélection. */}
      {!(mobile && pending) ? (
        <div className="hud-bottom-left">
          <SelectionPanel compact={mobile} />
        </div>
      ) : null}
      {!(mobile && (hasSelection || pending)) ? (
        <div className="hud-bottom-right">
          <LegendPanel fog={fog} />
        </div>
      ) : null}
      <OrderBar />
      <ArmyDrawer />
      <ProductionDrawer />
      <AlertsDrawer />
      <LayersDrawer />
      {children}
      <Tutorial enabled={tutorial} />
      <Toasts />
      <EndScreen />
    </div>
  );
}
