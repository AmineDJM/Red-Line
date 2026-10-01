import { useEffect } from 'react';
import { useGame } from '../store/game.js';
import { topWindow, useUi } from '../store/ui.js';
import { SECTIONS } from './sections.js';

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!(
    el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'SELECT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable)
  );
}

/**
 * Raccourcis clavier (ordinateur) :
 *  Ctrl+K ou « : » console · Espace pause · 1-5 vitesses · lettres : fenêtres (A, G, P, R, E, I, D, C,
 *  N, B, M, O, « , ») · L légende · « ? » aide · Échap : annule l'ordre, ferme la fiche,
 *  désélectionne, ferme la fenêtre.
 */
export function useShortcuts(onHelp: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || ui.paletteOpen) return;
      if (e.defaultPrevented) return;
      const { connection, clock, meta, view } = useGame.getState();
      const solo = meta?.mode === 'solo' && !view?.spectator;
      if (e.key === ':') {
        e.preventDefault();
        ui.setPaletteOpen(true);
      } else if (e.key === ' ' || e.code === 'Space') {
        if (!solo || !connection) return;
        e.preventDefault();
        connection.setPaused(!clock?.paused);
      } else if (/^[1-5]$/.test(e.key)) {
        const s = meta?.speeds[Number(e.key) - 1];
        if (!solo || !connection || s === undefined) return;
        connection.setSpeed(s);
        if (clock?.paused) connection.setPaused(false);
      } else if (e.key === 'Escape') {
        if (ui.pendingOrder) ui.setPending(null);
        else if (ui.sheet) ui.closeSheet();
        else if (ui.alertsOpen) ui.setAlertsOpen(false);
        else if (ui.selection.length || ui.inspected) ui.clearSelection();
        else if (ui.selectedProvince) ui.selectProvince(null);
        else {
          const w = topWindow(ui.windows);
          if (w) ui.closeWindow(w.id);
        }
      } else if (e.key === '?') {
        onHelp();
      } else if (e.key.toLowerCase() === 'l') {
        ui.setLegendOpen(!ui.legendOpen);
      } else {
        const s = SECTIONS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (s) {
          e.preventDefault();
          ui.toggleWindow(s.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHelp]);
}
