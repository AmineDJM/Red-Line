/**
 * Préférences d'affichage de la carte (confort, mémorisées localement) : « réduire les animations »
 * coupe les effets de combat, pulsations et tirets qui défilent. Activé d'office si le système
 * demande moins d'animations (prefers-reduced-motion).
 */
import { create } from 'zustand';

const KEY = 'rl.map.reduceMotion';

function systemReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function initial(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) return v === '1';
  } catch {
    /* stockage indisponible */
  }
  return systemReduced();
}

export interface MapPrefs {
  reduceMotion: boolean;
  setReduceMotion(on: boolean): void;
}

export const useMapPrefs = create<MapPrefs>((set) => ({
  reduceMotion: initial(),
  setReduceMotion(on) {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* stockage indisponible */
    }
    set({ reduceMotion: on });
  },
}));
