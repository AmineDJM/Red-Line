/**
 * Drapeaux des nations pour les sprites de la carte : SVG (flag-icons, /flags) chargés à la demande
 * et rastérisés une fois pour toutes à la taille des pions (un `drawImage` de SVG à chaque dessin
 * serait coûteux). Nation sans drapeau : rectangle à sa couleur.
 */
import { flagUrl } from '@redline/ui';

/** Taille de rastérisation (px physiques, rapport 4:3). */
export const FLAG_W = 36;
export const FLAG_H = 27;

type Entry =
  | { state: 'loading'; promise: Promise<void> }
  | { state: 'ready'; canvas: HTMLCanvasElement }
  | { state: 'none' };

export class FlagCache {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(nation: string) => void>();

  /** Appelé quand le drapeau d'une nation devient disponible (pour redessiner les sprites). */
  onReady(fn: (nation: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Bitmap du drapeau s'il est prêt ; lance son chargement sinon. */
  get(nation: string): HTMLCanvasElement | null {
    const e = this.entries.get(nation);
    if (e?.state === 'ready') return e.canvas;
    if (!e) void this.load(nation);
    return null;
  }

  isSettled(nation: string): boolean {
    const e = this.entries.get(nation);
    return !!e && e.state !== 'loading';
  }

  /** Promesse résolue quand le drapeau est prêt (ou définitivement absent). */
  load(nation: string): Promise<void> {
    const e = this.entries.get(nation);
    if (e?.state === 'loading') return e.promise;
    if (e) return Promise.resolve();
    const url = typeof document !== 'undefined' ? flagUrl(nation) : null;
    if (!url) {
      this.entries.set(nation, { state: 'none' });
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = FLAG_W;
        c.height = FLAG_H;
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, FLAG_W, FLAG_H);
        this.entries.set(nation, { state: 'ready', canvas: c });
        this.listeners.forEach((fn) => fn(nation));
        resolve();
      };
      img.onerror = () => {
        this.entries.set(nation, { state: 'none' });
        resolve();
      };
      img.src = url;
    });
    this.entries.set(nation, { state: 'loading', promise });
    return promise;
  }
}

export const flags = new FlagCache();
