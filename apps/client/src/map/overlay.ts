/**
 * Surcouche canvas au-dessus de la carte (style terminal) : cartouches à filets coudés (ensemble
 * limité), distance/durée écrites sur les trajectoires, étiquettes des anneaux de portée, pastilles
 * numérotées des sites de lancement. Redessinée à chaque image de la carte (événement `render`),
 * coût négligeable (≤ 40 éléments).
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { LngLat } from '@redline/shared';
import {
  placeCallouts,
  type CalloutInput,
  type PlacedCallout,
  type Point,
  type Rect,
} from './callouts.js';
import { C, MONO } from './palette.js';

export type CalloutTone = 'amber' | 'cyan' | 'red' | 'green';

export interface CalloutContent {
  id: string;
  at: LngLat;
  title: string;
  lines: string[];
  priority: number;
  /** Couleur du liseré gauche et de l'invite (ambre par défaut). */
  tone?: CalloutTone;
  /** Jauge 0..1 (capture, progression) affichée sous le titre. */
  progress?: number;
}

export interface RouteLabel {
  id: string;
  /** Polyligne de la trajectoire (lng/lat). */
  coords: LngLat[];
  text: string;
  tone?: CalloutTone;
}

export interface RingLabel {
  at: LngLat;
  text: string;
  tone?: CalloutTone;
}

export interface LaunchBadge {
  at: LngLat;
  n: number;
}

export interface OverlayContent {
  callouts: CalloutContent[];
  routes: RouteLabel[];
  badges: LaunchBadge[];
  rings?: RingLabel[];
  /** Positions d'icônes (unités) que les étiquettes ne doivent pas recouvrir. */
  icons?: LngLat[];
}

const TITLE_FONT = `700 11px ${MONO}`;
const LINE_FONT = `400 10.5px ${MONO}`;
const LABEL_FONT = `600 10.5px ${MONO}`;
const PAD_X = 8;
const PAD_Y = 5;
const TITLE_H = 14;
const LINE_H = 14;
const PROGRESS_H = 6;
export const TONES: Record<CalloutTone, string> = {
  amber: C.amber,
  cyan: C.cyan,
  red: C.red,
  green: C.green,
};

export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private previous = new Map<string, number>();
  /** La dernière image a dessiné quelque chose. */
  private hasInk = false;
  private measureCache = new Map<string, { w: number; h: number }>();
  /** Zones d'interface à éviter (px CSS, relatives au canvas). */
  insets = { top: 0, right: 0, bottom: 0, left: 0 };
  obstacles: Rect[] = [];
  maxCallouts = 32;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MlMap,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.round(r?.width ?? this.canvas.clientWidth);
    this.h = Math.round(r?.height ?? this.canvas.clientHeight);
    this.canvas.width = Math.max(1, this.w * this.dpr);
    this.canvas.height = Math.max(1, this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  private measure(c: CalloutContent) {
    const key = `${c.title}\u0001${c.lines.join('\u0002')}\u0003${c.progress !== undefined}`;
    const hit = this.measureCache.get(key);
    if (hit) return hit;
    const ctx = this.ctx;
    ctx.font = TITLE_FONT;
    let w = ctx.measureText(`› ${c.title.toLocaleUpperCase('fr')}`).width;
    ctx.font = LINE_FONT;
    for (const l of c.lines) w = Math.max(w, ctx.measureText(l).width + 10);
    const m = {
      w: Math.ceil(Math.max(w, c.progress !== undefined ? 96 : 0) + PAD_X * 2 + 3),
      h:
        PAD_Y * 2 +
        TITLE_H +
        c.lines.length * LINE_H +
        (c.progress !== undefined ? PROGRESS_H + 2 : 0),
    };
    if (this.measureCache.size > 500) this.measureCache.clear();
    this.measureCache.set(key, m);
    return m;
  }

  draw(content: OverlayContent) {
    const ctx = this.ctx;
    const empty =
      !content.routes.length &&
      !content.badges.length &&
      !content.callouts.length &&
      !content.rings?.length;
    if (empty) {
      // Chromium n'applique pas toujours un clearRect seul (aucun dessin ensuite) : sans cette remise
      // à zéro explicite, les dernières étiquettes resteraient figées à l'écran après un saut de caméra.
      if (this.hasInk) {
        this.canvas.width = this.canvas.width;
        this.hasInk = false;
      }
      this.previous.clear();
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.hasInk = true;
    const segments = this.drawRoutes(content.routes);
    this.drawRings(content.rings ?? []);
    this.drawBadges(content.badges);
    this.drawCallouts(content.callouts, segments, content.icons ?? []);
  }

  private project(p: LngLat) {
    const pt = this.map.project(p as [number, number]);
    return { x: pt.x, y: pt.y };
  }

  private drawCallouts(list: CalloutContent[], segments: [Point, Point][], icons: LngLat[]) {
    if (!list.length) {
      this.previous.clear();
      return;
    }
    const byId = new Map(list.map((c) => [c.id, c]));
    const inputs: CalloutInput[] = [];
    for (const c of list) {
      const a = this.project(c.at);
      if (a.x < -50 || a.y < -50 || a.x > this.w + 50 || a.y > this.h + 50) continue;
      const m = this.measure(c);
      inputs.push({ id: c.id, anchor: a, w: m.w, h: m.h, priority: c.priority });
    }
    const bounds = {
      x: this.insets.left + 4,
      y: this.insets.top + 4,
      w: Math.max(0, this.w - this.insets.left - this.insets.right - 8),
      h: Math.max(0, this.h - this.insets.top - this.insets.bottom - 8),
    };
    const iconRects: Rect[] = [];
    for (const ic of icons) {
      const p = this.project(ic);
      if (p.x < -30 || p.y < -20 || p.x > this.w + 30 || p.y > this.h + 20) continue;
      iconRects.push({ x: p.x - 24, y: p.y - 12, w: 48, h: 24 });
      if (iconRects.length > 400) break;
    }
    const placed = placeCallouts(inputs, {
      bounds,
      obstacles: [...this.obstacles, ...iconRects],
      avoidSegments: segments,
      previous: this.previous,
      max: this.maxCallouts,
      anchorBox: 30,
    });
    this.previous = new Map(placed.map((p) => [p.id, p.candidate]));
    for (const p of placed) this.drawCallout(p, byId.get(p.id)!);
  }

  private drawCallout(p: PlacedCallout, c: CalloutContent) {
    const ctx = this.ctx;
    const tone = TONES[c.tone ?? 'amber'];
    const [a, e, t] = p.leader;
    // Filet : démarre au bord du pion, pas en son centre.
    const dx = e.x - a.x;
    const dy = e.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const start = { x: a.x + (dx / len) * 16, y: a.y + (dy / len) * 16 };
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y + 1);
    ctx.lineTo(e.x, e.y + 1);
    ctx.lineTo(t.x, t.y + 1);
    ctx.stroke();
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(e.x, e.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone;
    ctx.fillRect(start.x - 1.5, start.y - 1.5, 3, 3);

    const r = p.rect;
    ctx.fillStyle = 'rgba(10,14,19,0.94)';
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 3);
    ctx.fill();
    ctx.strokeStyle = C.rule;
    ctx.beginPath();
    ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 3);
    ctx.stroke();
    ctx.fillStyle = tone;
    ctx.fillRect(r.x, r.y + 2, 2, r.h - 4);

    ctx.textBaseline = 'middle';
    ctx.font = TITLE_FONT;
    const ty = r.y + PAD_Y + TITLE_H / 2;
    ctx.fillStyle = tone;
    ctx.fillText('›', r.x + PAD_X, ty);
    ctx.fillStyle = C.text;
    ctx.fillText(c.title.toLocaleUpperCase('fr'), r.x + PAD_X + 10, ty);
    let y = r.y + PAD_Y + TITLE_H;
    if (c.progress !== undefined) {
      const bx = r.x + PAD_X;
      const bw = r.w - PAD_X * 2;
      ctx.fillStyle = '#1e2a36';
      ctx.fillRect(bx, y + 2, bw, 3);
      ctx.fillStyle = tone;
      ctx.fillRect(bx, y + 2, bw * Math.max(0, Math.min(1, c.progress)), 3);
      y += PROGRESS_H + 2;
    }
    ctx.font = LINE_FONT;
    c.lines.forEach((l, i) => {
      const ly = y + LINE_H * i + LINE_H / 2;
      ctx.fillStyle = C.dim;
      ctx.fillText('·', r.x + PAD_X + 1, ly);
      ctx.fillStyle = C.text;
      ctx.fillText(l, r.x + PAD_X + 10, ly);
    });
  }

  /** Étiquette en pastille (fond sombre, texte teinté), centrée sur (x, y). */
  private pill(text: string, x: number, y: number, tone: string, font = LABEL_FONT) {
    const ctx = this.ctx;
    ctx.font = font;
    const w = ctx.measureText(text).width + 10;
    const h = 15;
    ctx.fillStyle = 'rgba(10,14,19,0.9)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 2.5);
    ctx.fill();
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + 0.5, y - h / 2 + 0.5, w - 1, h - 1, 2.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.textAlign = 'left';
    return { w, h };
  }

  private drawRoutes(routes: RouteLabel[]): [Point, Point][] {
    const segments: [Point, Point][] = [];
    for (const r of routes) {
      if (r.coords.length < 2) continue;
      const pts = r.coords.map((c) => this.project(c));
      for (let k = 1; k < pts.length; k++) segments.push([pts[k - 1]!, pts[k]!]);
      // Milieu en longueur écran.
      let total = 0;
      const seg: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        seg.push(d);
        total += d;
      }
      if (total < 70) continue;
      let acc = 0;
      let i = 0;
      while (i < seg.length - 1 && acc + seg[i]! < total / 2) acc += seg[i++]!;
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      const f = seg[i]! > 0 ? (total / 2 - acc) / seg[i]! : 0;
      const mx = p0.x + (p1.x - p0.x) * f;
      const my = p0.y + (p1.y - p0.y) * f;
      const { w, h } = this.pill(r.text, mx, my, TONES[r.tone ?? 'amber']);
      // Zone de l'étiquette de distance, à ne pas recouvrir non plus.
      segments.push([
        { x: mx - w / 2, y: my - h / 2 },
        { x: mx + w / 2, y: my + h / 2 },
      ]);
    }
    return segments;
  }

  private drawRings(rings: RingLabel[]) {
    for (const r of rings) {
      const p = this.project(r.at);
      if (p.x < -60 || p.y < -20 || p.x > this.w + 60 || p.y > this.h + 20) continue;
      this.pill(r.text, p.x, p.y, TONES[r.tone ?? 'amber'], `600 9.5px ${MONO}`);
    }
  }

  private drawBadges(badges: LaunchBadge[]) {
    const ctx = this.ctx;
    for (const b of badges) {
      const p = this.project(b.at);
      // Pastille à droite du triangle de lancement (dessiné sous le pion).
      const x = p.x + 14;
      const y = p.y + 22;
      ctx.fillStyle = C.amber;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x - 7, y - 7, 14, 14, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = C.bg;
      ctx.font = `700 10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.n), x, y + 0.5);
      ctx.textAlign = 'left';
    }
  }
}
