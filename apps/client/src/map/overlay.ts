/**
 * Surcouche canvas au-dessus de la carte : étiquettes cartouches à filets coudés (ensemble limité),
 * distance écrite le long des trajectoires, pastilles rouges numérotées des sites de lancement.
 * Redessinée à chaque image de la carte (événement `render`), coût négligeable (≤ 40 éléments).
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { LngLat } from '@redline/shared';
import { placeCallouts, type CalloutInput, type PlacedCallout, type Rect } from './callouts.js';

export interface CalloutContent {
  id: string;
  at: LngLat;
  title: string;
  lines: string[];
  priority: number;
  /** Couleur du liseré gauche (orange par défaut, rouge pour les menaces critiques). */
  tone?: 'orange' | 'violet' | 'red';
}

export interface RouteLabel {
  id: string;
  /** Polyligne de la trajectoire (lng/lat). */
  coords: LngLat[];
  text: string;
}

export interface LaunchBadge {
  at: LngLat;
  n: number;
}

export interface OverlayContent {
  callouts: CalloutContent[];
  routes: RouteLabel[];
  badges: LaunchBadge[];
}

const TITLE_FONT = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
const LINE_FONT = '400 11.5px "IBM Plex Sans", system-ui, sans-serif';
const LABEL_FONT = '600 13px "IBM Plex Mono", ui-monospace, monospace';
const PAD_X = 8;
const PAD_Y = 5;
const TITLE_H = 15;
const LINE_H = 15;
const TONES = { orange: '#f39a2b', violet: '#b794ff', red: '#e5343a' } as const;

export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private previous = new Map<string, number>();
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
    const key = `${c.title}\u0001${c.lines.join('\u0002')}`;
    const hit = this.measureCache.get(key);
    if (hit) return hit;
    const ctx = this.ctx;
    ctx.font = TITLE_FONT;
    let w = ctx.measureText(c.title.toLocaleUpperCase('fr')).width * 1.1;
    ctx.font = LINE_FONT;
    for (const l of c.lines) w = Math.max(w, ctx.measureText(l).width + 12);
    const m = { w: Math.ceil(w + PAD_X * 2 + 3), h: PAD_Y * 2 + TITLE_H + c.lines.length * LINE_H };
    if (this.measureCache.size > 500) this.measureCache.clear();
    this.measureCache.set(key, m);
    return m;
  }

  draw(content: OverlayContent) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawRoutes(content.routes);
    this.drawBadges(content.badges);
    this.drawCallouts(content.callouts);
  }

  private project(p: LngLat) {
    const pt = this.map.project(p as [number, number]);
    return { x: pt.x, y: pt.y };
  }

  private drawCallouts(list: CalloutContent[]) {
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
    const placed = placeCallouts(inputs, {
      bounds,
      obstacles: this.obstacles,
      previous: this.previous,
      max: this.maxCallouts,
      anchorBox: 24,
    });
    this.previous = new Map(placed.map((p) => [p.id, p.candidate]));
    for (const p of placed) this.drawCallout(p, byId.get(p.id)!);
  }

  private drawCallout(p: PlacedCallout, c: CalloutContent) {
    const ctx = this.ctx;
    const [a, e, t] = p.leader;
    // Filet : démarre au bord de l'icône, pas en son centre.
    const dx = e.x - a.x;
    const dy = e.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const start = { x: a.x + (dx / len) * 13, y: a.y + (dy / len) * 13 };
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y + 1);
    ctx.lineTo(e.x, e.y + 1);
    ctx.lineTo(t.x, t.y + 1);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(232, 238, 248, 0.9)';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(e.x, e.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232, 238, 248, 0.95)';
    ctx.beginPath();
    ctx.arc(start.x, start.y, 1.6, 0, Math.PI * 2);
    ctx.fill();

    const r = p.rect;
    ctx.fillStyle = 'rgba(13, 26, 54, 0.88)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(140, 170, 220, 0.35)';
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.fillStyle = TONES[c.tone ?? 'orange'];
    ctx.fillRect(r.x, r.y, 2.5, r.h);

    ctx.textBaseline = 'middle';
    ctx.font = TITLE_FONT;
    ctx.fillStyle = '#ffffff';
    const title = c.title.toLocaleUpperCase('fr');
    let x = r.x + PAD_X + 1;
    const ty = r.y + PAD_Y + TITLE_H / 2;
    for (const ch of title) {
      ctx.fillText(ch, x, ty);
      x += ctx.measureText(ch).width + 1.1;
    }
    ctx.font = LINE_FONT;
    c.lines.forEach((l, i) => {
      const y = r.y + PAD_Y + TITLE_H + LINE_H * i + LINE_H / 2;
      ctx.fillStyle = TONES.orange;
      ctx.beginPath();
      ctx.arc(r.x + PAD_X + 3, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#dfe6f2';
      ctx.fillText(l, r.x + PAD_X + 10, y);
    });
  }

  private drawRoutes(routes: RouteLabel[]) {
    const ctx = this.ctx;
    for (const r of routes) {
      if (r.coords.length < 2) continue;
      const pts = r.coords.map((c) => this.project(c));
      // Milieu en longueur écran.
      let total = 0;
      const seg: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        seg.push(d);
        total += d;
      }
      if (total < 60) continue;
      let acc = 0;
      let i = 0;
      while (i < seg.length - 1 && acc + seg[i]! < total / 2) acc += seg[i++]!;
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      const f = seg[i]! > 0 ? (total / 2 - acc) / seg[i]! : 0;
      const mx = p0.x + (p1.x - p0.x) * f;
      const my = p0.y + (p1.y - p0.y) * f;
      let ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(r.text, 0, -6);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(r.text, 0, -6);
      ctx.restore();
    }
    ctx.textAlign = 'left';
  }

  private drawBadges(badges: LaunchBadge[]) {
    const ctx = this.ctx;
    for (const b of badges) {
      const p = this.project(b.at);
      const x = p.x + 11;
      const y = p.y - 13;
      ctx.fillStyle = '#e5343a';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10.5px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.n), x, y + 0.5);
      ctx.textAlign = 'left';
    }
  }
}
