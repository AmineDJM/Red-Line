/**
 * Événements visuels de la carte, exposés au reste du client (son, haptique, statistiques) sans
 * dépendance : la carte émet, les abonnés écoutent. Émis seulement pour les effets réellement
 * joués (à l'écran, animations actives) — un module de son peut s'y abonner :
 *
 *   import { onMapEvent } from '../map/events.js';
 *   const off = onMapEvent((e) => { if (e.kind === 'blast') play('explosion', e.big); });
 *
 * Aussi diffusés en `CustomEvent('redline:map-fx', { detail })` sur `window`.
 */
import type { LngLat } from '@redline/shared';

export type MapEvent =
  /** Tir (traceur, obus, missile intercepteur) : `own` = forces du joueur ou alliées. */
  | { kind: 'shot'; at: LngLat; own: boolean; heavy: boolean }
  /** Explosion : `big` pour une destruction d'unité ou un impact de missile. */
  | { kind: 'blast'; at: LngLat; big: boolean }
  | { kind: 'intercept'; at: LngLat }
  | { kind: 'launch'; at: LngLat }
  /** Menu de pile ouvert / fermé (retour sonore discret). */
  | { kind: 'stack-menu'; open: boolean };

type Listener = (e: MapEvent) => void;
const listeners = new Set<Listener>();

export function onMapEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitMapEvent(e: MapEvent) {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.warn('[carte] abonné aux événements', err);
    }
  }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined')
    window.dispatchEvent(new CustomEvent('redline:map-fx', { detail: e }));
}
