/**
 * Effets visuels des combats, dessinés sur un canevas au-dessus de la carte : traceurs, obus
 * d'artillerie en cloche, éclairs de départ, explosions, fumée, interceptions de missiles.
 *
 * - `FxSystem` (pur, testé) : file d'effets bornée (budget), effets différés, expiration ;
 * - `queueShot` / `queueBlast`… : composition d'un fait d'armes en effets élémentaires ;
 * - `FxRenderer` : boucle requestAnimationFrame active seulement tant qu'il reste des effets,
 *   projection des positions à chaque image (la carte peut bouger), effets hors champ ignorés.
 *
 * Coupés par « réduire les animations » (aucun effet créé) et invisibles à l'échelle du monde.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { distanceKm, type LngLat, type TargetClass } from '@redline/shared';

export type FxKind =
  'tracer' | 'streak' | 'shell' | 'flash' | 'blast' | 'bigblast' | 'intercept' | 'fizz' | 'smoke';

export interface Fx {
  kind: FxKind;
  /** Début (ms, horloge de performance). */
  t0: number;
  dur: number;
  from: LngLat;
  to: LngLat;
  color: string;
  /** Graine des variations (débris, dispersion). */
  seed: number;
}

/** Couleurs des effets (jetons de la carte, éclaircis pour la lumière). */
export const FX_COLORS = {
  own: '#ffd98a',
  foe: '#ff7a68',
  intercept: '#c9f5ff',
  aa: '#ffe2a8',
} as const;

/** Priorité de conservation quand le budget est atteint (les explosions d'abord). */
const PRIORITY: Record<FxKind, number> = {
  bigblast: 5,
  intercept: 4,
  blast: 3,
  shell: 2,
  streak: 2,
  tracer: 1,
  flash: 1,
  fizz: 0,
  smoke: 0,
};

export class FxSystem {
  readonly list: Fx[] = [];
  private pending: Fx[] = [];
  private seed = 1;
  /** Effets refusés faute de budget (diagnostic). */
  dropped = 0;

  constructor(public max = 160) {}

  /** Ajoute un effet (éventuellement différé : `delay` ms). Faux s'il est refusé (budget). */
  add(kind: FxKind, now: number, dur: number, from: LngLat, to: LngLat, color: string, delay = 0) {
    const fx: Fx = { kind, t0: now + delay, dur, from, to, color, seed: this.seed++ };
    if (this.list.length + this.pending.length >= this.max) {
      // Budget atteint : un effet plus prioritaire remplace le moins prioritaire en attente.
      let worst = -1;
      for (let i = 0; i < this.pending.length; i++)
        if (worst < 0 || PRIORITY[this.pending[i]!.kind] < PRIORITY[this.pending[worst]!.kind])
          worst = i;
      if (worst >= 0 && PRIORITY[this.pending[worst]!.kind] < PRIORITY[kind]) {
        this.pending.splice(worst, 1);
      } else {
        this.dropped++;
        return false;
      }
    }
    if (delay > 0) this.pending.push(fx);
    else this.list.push(fx);
    return true;
  }

  /** Avance l'horloge : effets différés démarrés, effets terminés retirés. */
  update(now: number) {
    if (this.pending.length) {
      const keep: Fx[] = [];
      for (const fx of this.pending) (fx.t0 <= now ? this.list : keep).push(fx);
      this.pending = keep;
    }
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const fx = this.list[i]!;
      if (now - fx.t0 < fx.dur) this.list[w++] = fx;
    }
    this.list.length = w;
  }

  get busy() {
    return this.list.length > 0 || this.pending.length > 0;
  }

  get size() {
    return this.list.length + this.pending.length;
  }

  /** Tous les effets, en cours puis différés (diagnostic, tests). */
  all(): readonly Fx[] {
    return [...this.list, ...this.pending];
  }

  clear() {
    this.list.length = 0;
    this.pending = [];
  }
}

const AIR: TargetClass[] = ['aircraft', 'helicopter', 'drone'];

/** Écart (degrés) pour un impact manqué : à côté de la cible. */
function miss(to: LngLat, seed: number, km: number): LngLat {
  const a = (seed * 2.399) % (Math.PI * 2);
  const d = km / 111;
  return [to[0] + Math.cos(a) * d, to[1] + Math.sin(a) * d * 0.8];
}

/**
 * Compose un tir en effets élémentaires : interception (missile), tir antiaérien, frappe sur un
 * bâtiment, obus d'artillerie (longue distance) ou rafale de traceurs (contact).
 * Renvoie la durée totale (ms) jusqu'à l'impact.
 */
export function queueShot(
  fx: FxSystem,
  now: number,
  shot: { from: LngLat; to: LngLat; cls: TargetClass; hit: boolean },
  own: boolean,
  delay = 0,
): number {
  const color = own ? FX_COLORS.own : FX_COLORS.foe;
  const km = distanceKm(shot.from, shot.to);
  const to = shot.hit ? shot.to : miss(shot.to, now + delay, Math.max(0.6, Math.min(4, km * 0.08)));
  if (shot.cls === 'missile') {
    const d = 420;
    fx.add('flash', now, 160, shot.from, shot.from, FX_COLORS.intercept, delay);
    fx.add('streak', now, d, shot.from, shot.to, FX_COLORS.intercept, delay);
    fx.add(
      shot.hit ? 'intercept' : 'fizz',
      now,
      shot.hit ? 900 : 500,
      shot.to,
      shot.to,
      FX_COLORS.intercept,
      delay + d,
    );
    return d;
  }
  if (AIR.includes(shot.cls)) {
    const d = 380;
    fx.add('streak', now, d, shot.from, to, FX_COLORS.aa, delay);
    fx.add(shot.hit ? 'blast' : 'fizz', now, shot.hit ? 650 : 400, to, to, FX_COLORS.aa, delay + d);
    return d;
  }
  if (km > 18 || shot.cls === 'building') {
    // Tir indirect : départ, obus en cloche, explosion (et fumée si touché).
    const d = Math.round(Math.min(1300, 650 + km * 3));
    fx.add('flash', now, 200, shot.from, shot.from, color, delay);
    fx.add('shell', now, d, shot.from, to, color, delay);
    fx.add('blast', now, 750, to, to, color, delay + d);
    if (shot.hit) fx.add('smoke', now, 1900, to, to, color, delay + d + 120);
    return d;
  }
  // Contact : rafale de trois traceurs, petite explosion si touché.
  const d = 260;
  for (let k = 0; k < 3; k++) {
    fx.add(
      'tracer',
      now,
      d,
      shot.from,
      k === 2 ? to : miss(to, now + k, 0.4),
      color,
      delay + k * 90,
    );
  }
  fx.add('flash', now, 140, shot.from, shot.from, color, delay);
  fx.add(shot.hit ? 'blast' : 'fizz', now, shot.hit ? 600 : 380, to, to, color, delay + d + 180);
  return d + 180;
}

/** Explosion (destruction d'unité, impact de missile, bâtiment touché). */
export function queueBlast(fx: FxSystem, now: number, at: LngLat, big: boolean, delay = 0) {
  fx.add(big ? 'bigblast' : 'blast', now, big ? 1400 : 800, at, at, FX_COLORS.own, delay);
  fx.add('smoke', now, big ? 2600 : 1800, at, at, FX_COLORS.own, delay + 150);
}

/** Interception d'un missile en vol (disparu avant l'impact prévu). */
export function queueIntercept(fx: FxSystem, now: number, at: LngLat) {
  fx.add('intercept', now, 1000, at, at, FX_COLORS.intercept);
  fx.add('smoke', now, 1500, at, at, FX_COLORS.intercept, 200);
}

/** Départ de missile : éclair et panache. */
export function queueLaunch(fx: FxSystem, now: number, at: LngLat) {
  fx.add('flash', now, 260, at, at, FX_COLORS.own);
  fx.add('smoke', now, 2200, at, at, FX_COLORS.own, 80);
}

// ——— Rendu ———

const ease = (p: number) => 1 - (1 - p) * (1 - p);

/** Pseudo-aléa déterministe par effet (dispersion des débris). */
function rand(seed: number, k: number) {
  const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class FxRenderer {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ink = false;
  /** Images dessinées (diagnostic). */
  frames = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MlMap,
    readonly system: FxSystem,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    // Effets brefs et flous par nature : résolution plafonnée (coût de remplissage sur mobile).
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = Math.round(r?.width ?? this.canvas.clientWidth);
    this.h = Math.round(r?.height ?? this.canvas.clientHeight);
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  /** Démarre la boucle si besoin (après l'ajout d'effets). */
  wake() {
    if (this.raf || typeof requestAnimationFrame === 'undefined') return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    const now = performance.now();
    // Cadence adaptative : sur un appareil lent (images espacées de plus de 30 ms en moyenne),
    // les effets sont redessinés au plus toutes les 50 ms (le reste de la carte garde la main).
    if (this.lastFrame) this.ema = this.ema * 0.9 + (now - this.lastFrame) * 0.1;
    this.lastFrame = now;
    this.system.update(now);
    if (this.ema < 30 || now - this.lastDraw >= 50 || !this.system.list.length) {
      this.lastDraw = now;
      this.draw(now);
    }
    if (this.system.busy) this.raf = requestAnimationFrame(this.frame);
    else this.lastFrame = 0;
  };
  private ema = 16;
  private lastFrame = 0;
  private lastDraw = 0;
  /** Zone dessinée à l'image précédente (px CSS) : seule elle est effacée. */
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  private clear() {
    if (!this.ink) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = this.dirty;
    if (d) {
      const k = this.dpr;
      const x0 = Math.max(0, Math.floor(d.x0 * k) - 2);
      const y0 = Math.max(0, Math.floor(d.y0 * k) - 2);
      this.ctx.clearRect(x0, y0, Math.ceil(d.x1 * k) + 4 - x0, Math.ceil(d.y1 * k) + 4 - y0);
    } else this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ink = false;
    this.dirty = null;
  }

  private mark(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty;
    if (!d) this.dirty = { x0, y0, x1, y1 };
    else {
      d.x0 = Math.min(d.x0, x0);
      d.y0 = Math.min(d.y0, y0);
      d.x1 = Math.max(d.x1, x1);
      d.y1 = Math.max(d.y1, y1);
    }
  }

  private draw(now: number) {
    this.clear();
    const list = this.system.list;
    if (!list.length) return;
    const zoom = this.map.getZoom();
    // Invisibles à l'échelle du monde (des milliers de km par écran) : les marqueurs suffisent.
    if (zoom < 3.4) return;
    const s = Math.max(0.55, Math.min(1.35, 0.35 + zoom * 0.12));
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ink = true;
    this.frames++;
    const m = 60;
    for (const fx of list) {
      const p = Math.max(0, Math.min(1, (now - fx.t0) / fx.dur));
      const a = this.map.project(fx.from as [number, number]);
      const b = fx.from === fx.to ? a : this.map.project(fx.to as [number, number]);
      if (
        Math.max(a.x, b.x) < -m ||
        Math.min(a.x, b.x) > this.w + m ||
        Math.max(a.y, b.y) < -m ||
        Math.min(a.y, b.y) > this.h + m
      )
        continue;
      // Marge : rayon maximal d'un effet (onde de choc, cloche d'obus, fumée).
      const pad = 70 * s;
      this.mark(
        Math.min(a.x, b.x) - pad,
        Math.min(a.y, b.y) - pad - 90,
        Math.max(a.x, b.x) + pad,
        Math.max(a.y, b.y) + pad,
      );
      this.drawFx(fx, p, a, b, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private glow(x: number, y: number, r: number, color: string, alpha: number) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fffbe8';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFx(
    fx: Fx,
    p: number,
    a: { x: number; y: number },
    b: { x: number; y: number },
    s: number,
  ) {
    const ctx = this.ctx;
    switch (fx.kind) {
      case 'tracer':
      case 'streak': {
        const e = fx.kind === 'streak' ? ease(p) : p;
        const tail = Math.max(0, e - (fx.kind === 'streak' ? 0.35 : 0.22));
        const hx = a.x + (b.x - a.x) * e;
        const hy = a.y + (b.y - a.y) * e;
        const tx = a.x + (b.x - a.x) * tail;
        const ty = a.y + (b.y - a.y) * tail;
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createLinearGradient(tx, ty, hx, hy);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, fx.color);
        ctx.strokeStyle = g;
        ctx.globalAlpha = 1;
        ctx.lineWidth = (fx.kind === 'streak' ? 1.8 : 1.4) * s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        this.glow(hx, hy, 1.3 * s, fx.color, 0.95);
        break;
      }
      case 'shell': {
        // Trajectoire en cloche dans le plan de l'écran (hauteur proportionnelle à la portée).
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const h = Math.min(90, Math.hypot(dx, dy) * 0.38) + 6 * s;
        const pt = (q: number) => ({
          x: a.x + dx * q,
          y: a.y + dy * q - 4 * h * q * (1 - q),
        });
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = fx.color;
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.1 * s;
        let prev = pt(Math.max(0, p - 0.18));
        for (let k = 1; k <= 4; k++) {
          const q = Math.max(0, p - 0.18 + (0.18 * k) / 4);
          const c = pt(q);
          ctx.globalAlpha = (k / 4) * 0.55;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(c.x, c.y);
          ctx.stroke();
          prev = c;
        }
        this.glow(prev.x, prev.y, 1.5 * s, fx.color, 1);
        break;
      }
      case 'flash': {
        ctx.globalCompositeOperation = 'lighter';
        this.glow(a.x, a.y, (2.5 + 3 * p) * s, fx.color, 1 - p);
        break;
      }
      case 'blast':
      case 'bigblast': {
        const k = fx.kind === 'bigblast' ? 1.8 : 1;
        const e = ease(p);
        ctx.globalCompositeOperation = 'lighter';
        // Boule de feu.
        ctx.globalAlpha = Math.pow(1 - p, 1.6);
        ctx.fillStyle = '#ff8a3d';
        ctx.beginPath();
        ctx.arc(a.x, a.y, (3 + 9 * e) * s * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.pow(1 - p, 2.4);
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(a.x, a.y, (2 + 4.5 * e) * s * k, 0, Math.PI * 2);
        ctx.fill();
        // Onde de choc.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = (1 - p) * 0.75;
        ctx.strokeStyle = fx.kind === 'bigblast' ? '#ffd27a' : '#ffb020';
        ctx.lineWidth = 1.2 * s;
        ctx.beginPath();
        ctx.arc(a.x, a.y, (5 + 20 * e) * s * k, 0, Math.PI * 2);
        ctx.stroke();
        // Débris.
        ctx.fillStyle = '#ffd9a0';
        const n = fx.kind === 'bigblast' ? 10 : 6;
        for (let i = 0; i < n; i++) {
          const ang = rand(fx.seed, i) * Math.PI * 2;
          const dist = (6 + 14 * rand(fx.seed, i + 20)) * e * s * k;
          ctx.globalAlpha = (1 - p) * 0.9;
          ctx.fillRect(
            a.x + Math.cos(ang) * dist - 0.8,
            a.y + Math.sin(ang) * dist - 0.8 + 6 * p * p * s,
            1.6,
            1.6,
          );
        }
        break;
      }
      case 'intercept': {
        const e = ease(p);
        ctx.globalCompositeOperation = 'lighter';
        this.glow(a.x, a.y, (2 + 4 * (1 - p)) * s, fx.color, 1 - p);
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = 1.2 * s;
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + fx.seed;
          const r0 = 3 * s + 6 * e * s;
          const r1 = r0 + 7 * s * (1 - p);
          ctx.moveTo(a.x + Math.cos(ang) * r0, a.y + Math.sin(ang) * r0);
          ctx.lineTo(a.x + Math.cos(ang) * r1, a.y + Math.sin(ang) * r1);
        }
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = (1 - p) * 0.8;
        ctx.strokeStyle = '#4cc9f0';
        ctx.beginPath();
        ctx.arc(a.x, a.y, (6 + 18 * e) * s, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'fizz': {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = (1 - p) * 0.5;
        ctx.fillStyle = '#9aa6b2';
        ctx.beginPath();
        ctx.arc(a.x, a.y - 3 * p * s, (1.5 + 3 * p) * s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'smoke': {
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 3; i++) {
          const q = Math.max(0, Math.min(1, p * 1.1 - i * 0.08));
          ctx.globalAlpha = 0.3 * (1 - q) * Math.min(1, q * 6);
          ctx.fillStyle = i === 0 ? '#59616b' : '#6f7882';
          ctx.beginPath();
          ctx.arc(
            a.x + (rand(fx.seed, i) - 0.5) * 8 * s + 5 * q * s,
            a.y - (4 + 14 * q) * s - i * 3 * s,
            (3 + 9 * q) * s * (1 - i * 0.18),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        break;
      }
    }
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.system.clear();
  }
}
