/**
 * Mini-carte réutilisable (rapports de renseignement, replay des batailles, timelapse de fin de
 * partie) : rendu Canvas 2D léger, SANS instance MapLibre (pas de contexte WebGL : on peut en
 * afficher des dizaines). Projection Mercator locale centrée sur `center`, cadrée sur `radiusKm`.
 *
 * Contenu : provinces teintées par propriétaire (joueur en violet), graticule et échelle façon
 * terminal, et des calques simples (points, pions, lignes, cercles, étiquettes).
 *
 * Utilisation :
 *   const mm = new MiniMap(canvas, { center: [3, 36.7], radiusKm: 400, layers: [...] });
 *   mm.update({ owners });          // ex. image suivante d'un timelapse
 *   mm.destroy();
 * ou le composant React `<MiniMapView … />` (MiniMapView.tsx).
 */
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { LngLat, NationId } from '@redline/shared';
import { useWorld } from '../store/world.js';
import { C, MONO, REL_COLOR, alpha, type Rel } from './palette.js';

export type MiniMapShape = 'dot' | 'square' | 'diamond' | 'cross' | 'x' | 'triangle';

export type MiniMapLayer =
  | {
      kind: 'points';
      items: {
        at: LngLat;
        color?: string;
        shape?: MiniMapShape;
        /** Rayon en px CSS (défaut 3). */
        size?: number;
        label?: string;
      }[];
    }
  | {
      /** Pions simplifiés : carré au liseré de relation, effectif optionnel. */
      kind: 'units';
      items: { at: LngLat; rel: Rel; count?: number; label?: string }[];
    }
  | {
      kind: 'lines';
      items: {
        coords: LngLat[];
        color?: string;
        width?: number;
        dashed?: boolean;
        /** Flèche à l'extrémité. */
        arrow?: boolean;
      }[];
    }
  | {
      kind: 'circles';
      items: { at: LngLat; radiusKm: number; color?: string; fill?: boolean; dashed?: boolean }[];
    }
  | { kind: 'labels'; items: { at: LngLat; text: string; color?: string }[] };

export interface MiniMapOptions {
  center: LngLat;
  /** Rayon couvert (km) : le plus petit côté du cadre fait 2 × radiusKm. */
  radiusKm: number;
  /** Propriétaire de chaque province (défaut : propriétaires de départ des données de carte). */
  owners?: Record<string, NationId>;
  /** Nation du joueur (territoire violet). */
  me?: NationId | null;
  /** Couleurs des nations (défaut : données de carte). */
  nationColors?: Record<NationId, string>;
  layers?: MiniMapLayer[];
  /** Graticule et coordonnées (défaut : vrai). */
  grid?: boolean;
  /** Barre d'échelle (défaut : vrai). */
  scaleBar?: boolean;
  /** Réticule central (défaut : faux). */
  crosshair?: boolean;
  /** Géométrie des provinces (défaut : celle du store du monde). */
  geo?: FeatureCollection | null;
}

interface Indexed {
  id: string;
  bbox: [number, number, number, number];
  f: Feature;
}

const indexCache = new WeakMap<FeatureCollection, Indexed[]>();

function bboxOf(g: Geometry): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const visit = (p: Position) => {
    if (p[0]! < x0) x0 = p[0]!;
    if (p[0]! > x1) x1 = p[0]!;
    if (p[1]! < y0) y0 = p[1]!;
    if (p[1]! > y1) y1 = p[1]!;
  };
  if (g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach(visit));
  else if (g.type === 'MultiPolygon')
    g.coordinates.forEach((pl) => pl.forEach((r) => r.forEach(visit)));
  return [x0, y0, x1, y1];
}

function indexOf(geo: FeatureCollection): Indexed[] {
  let idx = indexCache.get(geo);
  if (!idx) {
    idx = geo.features
      .filter(
        (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
      )
      .map((f) => ({ id: String(f.properties?.id ?? f.id ?? ''), bbox: bboxOf(f.geometry), f }));
    indexCache.set(geo, idx);
  }
  return idx;
}

const TILE = 512;

/** Projection Mercator locale : lng/lat → px CSS du cadre. */
export function miniProjection(center: LngLat, radiusKm: number, w: number, h: number) {
  const lat = (center[1] * Math.PI) / 180;
  const half = Math.max(1, Math.min(w, h) / 2);
  const kmPerWorldPx = (40075 * Math.cos(lat)) / TILE;
  const scale = (half * kmPerWorldPx) / Math.max(1, radiusKm); // px par unité monde (zoom 0)
  const mx = (lng: number) => ((lng + 180) / 360) * TILE;
  const my = (la: number) => {
    const s = Math.sin((Math.max(-85, Math.min(85, la)) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
  };
  const cx = mx(center[0]);
  const cy = my(center[1]);
  const project = (p: LngLat | Position): [number, number] => {
    let dx = mx(p[0]!) - cx;
    // Chemin le plus court autour de l'antiméridien.
    if (dx > TILE / 2) dx -= TILE;
    if (dx < -TILE / 2) dx += TILE;
    return [w / 2 + dx * scale, h / 2 + (my(p[1]!) - cy) * scale];
  };
  const unproject = (x: number, y: number): LngLat => {
    const wx = cx + (x - w / 2) / scale;
    const wy = cy + (y - h / 2) / scale;
    const lng = (wx / TILE) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * wy) / TILE;
    const la = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, la];
  };
  /** px CSS par km au centre. */
  const pxPerKm = half / Math.max(1, radiusKm);
  return { project, unproject, pxPerKm };
}

export class MiniMap {
  private opts: MiniMapOptions;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private ro: ResizeObserver | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: MiniMapOptions,
  ) {
    this.opts = { grid: true, scaleBar: true, ...opts };
    this.ctx = canvas.getContext('2d')!;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(canvas);
    }
    this.render();
  }

  /** Met à jour tout ou partie des options et redessine (à la prochaine image). */
  update(patch: Partial<MiniMapOptions>) {
    this.opts = { ...this.opts, ...patch };
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /** Position géographique d'un point du cadre (px CSS) — pour les clics. */
  lngLatAt(x: number, y: number): LngLat {
    return miniProjection(this.opts.center, this.opts.radiusKm, this.w, this.h).unproject(x, y);
  }

  /** Image PNG du rendu courant (exports, partages de rapport). */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  render() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width || c.width));
    this.h = Math.max(1, Math.round(r.height || c.height));
    if (c.width !== this.w * this.dpr || c.height !== this.h * this.dpr) {
      c.width = this.w * this.dpr;
      c.height = this.h * this.dpr;
    }
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#070c14';
    ctx.fillRect(0, 0, w, h);
    const o = this.opts;
    const proj = miniProjection(o.center, o.radiusKm, w, h);
    this.drawProvinces(proj.project, proj.unproject);
    if (o.grid) this.drawGrid(proj.project, proj.unproject);
    for (const l of o.layers ?? []) this.drawLayer(l, proj.project, proj.pxPerKm);
    if (o.crosshair) {
      ctx.strokeStyle = alpha(C.cyan, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 8, h / 2);
      ctx.lineTo(w / 2 + 8, h / 2);
      ctx.moveTo(w / 2, h / 2 - 8);
      ctx.lineTo(w / 2, h / 2 + 8);
      ctx.stroke();
    }
    if (o.scaleBar) this.drawScale(proj.pxPerKm);
    this.drawFrame();
  }

  private drawProvinces(
    project: (p: Position) => [number, number],
    unproject: (x: number, y: number) => LngLat,
  ) {
    const w = useWorld.getState();
    const geo = this.opts.geo ?? w.provincesGeo;
    if (!geo) return;
    const a = unproject(0, 0);
    const b = unproject(this.w, this.h);
    const margin = 1;
    const x0 = Math.min(a[0], b[0]) - margin;
    const x1 = Math.max(a[0], b[0]) + margin;
    const y0 = Math.min(a[1], b[1]) - margin;
    const y1 = Math.max(a[1], b[1]) + margin;
    const ctx = this.ctx;
    const owners = this.opts.owners;
    const me = this.opts.me ?? null;
    const colors = this.opts.nationColors;
    const items = indexOf(geo).filter(
      (it) => it.bbox[2] >= x0 && it.bbox[0] <= x1 && it.bbox[3] >= y0 && it.bbox[1] <= y1,
    );
    const pathOf = (g: Geometry) => {
      const path = new Path2D();
      const polys =
        g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys)
        for (const ring of poly) {
          ring.forEach((pt, i) => {
            const [x, y] = project(pt);
            if (i === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
          });
          path.closePath();
        }
      return path;
    };
    const paths = items.map((it) => ({ it, path: pathOf(it.f.geometry) }));
    // Terre, puis teinte du propriétaire.
    for (const { it, path } of paths) {
      const owner = owners?.[it.id] ?? w.provinces[it.id]?.nationId ?? '';
      ctx.fillStyle = '#121b27';
      ctx.fill(path);
      const col =
        owner === me ? C.violet : (colors?.[owner] ?? w.nations[owner]?.color ?? '#3a4252');
      ctx.fillStyle = alpha(col, owner === me ? 0.42 : 0.3);
      ctx.fill(path);
    }
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = 'rgba(214,221,230,0.14)';
    for (const { path } of paths) ctx.stroke(path);
    if (me) {
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = alpha(C.violet, 0.9);
      for (const { it, path } of paths) {
        const owner = owners?.[it.id] ?? w.provinces[it.id]?.nationId;
        if (owner === me) ctx.stroke(path);
      }
    }
  }

  private drawGrid(
    project: (p: Position) => [number, number],
    unproject: (x: number, y: number) => LngLat,
  ) {
    const ctx = this.ctx;
    const a = unproject(0, 0);
    const b = unproject(this.w, this.h);
    const span = Math.abs(b[0] - a[0]);
    const step = [0.5, 1, 2, 5, 10, 15, 30].find((s) => span / s <= 6) ?? 30;
    ctx.strokeStyle = 'rgba(76,201,240,0.08)';
    ctx.lineWidth = 1;
    ctx.font = `400 9px ${MONO}`;
    ctx.fillStyle = C.dim;
    ctx.textBaseline = 'top';
    for (
      let lng = Math.ceil(Math.min(a[0], b[0]) / step) * step;
      lng <= Math.max(a[0], b[0]);
      lng += step
    ) {
      const [x] = project([lng, a[1]]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.h);
      ctx.stroke();
      ctx.fillText(`${Math.abs(lng)}°${lng >= 0 ? 'E' : 'O'}`, x + 3, 3);
    }
    for (
      let lat = Math.ceil(Math.min(a[1], b[1]) / step) * step;
      lat <= Math.max(a[1], b[1]);
      lat += step
    ) {
      const [, y] = project([a[0], lat]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(`${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'}`, 3, y + 2);
    }
  }

  private drawLayer(l: MiniMapLayer, project: (p: LngLat) => [number, number], pxPerKm: number) {
    const ctx = this.ctx;
    switch (l.kind) {
      case 'circles':
        for (const it of l.items) {
          const [x, y] = project(it.at);
          const r = it.radiusKm * pxPerKm;
          const col = it.color ?? C.amber;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          if (it.fill) {
            ctx.fillStyle = alpha(col, 0.1);
            ctx.fill();
          }
          ctx.setLineDash(it.dashed ? [4, 3] : []);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        break;
      case 'lines':
        for (const it of l.items) {
          if (it.coords.length < 2) continue;
          const pts = it.coords.map(project);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = (it.width ?? 1.6) + 2;
          ctx.setLineDash([]);
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
          ctx.strokeStyle = it.color ?? C.amber;
          ctx.lineWidth = it.width ?? 1.6;
          ctx.setLineDash(it.dashed ? [5, 4] : []);
          ctx.stroke();
          ctx.setLineDash([]);
          if (it.arrow) {
            const [x1, y1] = pts[pts.length - 1]!;
            const [x0, y0] = pts[pts.length - 2]!;
            const a = Math.atan2(y1 - y0, x1 - x0);
            ctx.fillStyle = it.color ?? C.amber;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x1 - 8 * Math.cos(a - 0.45), y1 - 8 * Math.sin(a - 0.45));
            ctx.lineTo(x1 - 8 * Math.cos(a + 0.45), y1 - 8 * Math.sin(a + 0.45));
            ctx.closePath();
            ctx.fill();
          }
        }
        break;
      case 'points':
        for (const it of l.items) {
          const [x, y] = project(it.at);
          const s = it.size ?? 3;
          ctx.fillStyle = it.color ?? C.text;
          ctx.strokeStyle = it.color ?? C.text;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          switch (it.shape ?? 'dot') {
            case 'square':
              ctx.rect(x - s, y - s, s * 2, s * 2);
              ctx.fill();
              break;
            case 'diamond':
              ctx.moveTo(x, y - s * 1.3);
              ctx.lineTo(x + s * 1.3, y);
              ctx.lineTo(x, y + s * 1.3);
              ctx.lineTo(x - s * 1.3, y);
              ctx.closePath();
              ctx.fill();
              break;
            case 'triangle':
              ctx.moveTo(x, y - s * 1.3);
              ctx.lineTo(x + s * 1.2, y + s);
              ctx.lineTo(x - s * 1.2, y + s);
              ctx.closePath();
              ctx.fill();
              break;
            case 'cross':
              ctx.moveTo(x - s, y);
              ctx.lineTo(x + s, y);
              ctx.moveTo(x, y - s);
              ctx.lineTo(x, y + s);
              ctx.stroke();
              break;
            case 'x':
              ctx.moveTo(x - s, y - s);
              ctx.lineTo(x + s, y + s);
              ctx.moveTo(x + s, y - s);
              ctx.lineTo(x - s, y + s);
              ctx.stroke();
              break;
            default:
              ctx.arc(x, y, s, 0, Math.PI * 2);
              ctx.fill();
          }
          if (it.label) this.text(it.label, x + s + 4, y, it.color ?? C.text);
        }
        break;
      case 'units':
        for (const it of l.items) {
          const [x, y] = project(it.at);
          const col = REL_COLOR[it.rel];
          ctx.fillStyle = 'rgba(14,20,27,0.92)';
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.roundRect(x - 7, y - 5, 14, 10, 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(x - 7, y - 5, 2, 10);
          const t = it.label ?? (it.count !== undefined ? String(it.count) : '');
          if (t) this.text(t, x + 10, y, C.text);
        }
        break;
      case 'labels':
        for (const it of l.items) {
          const [x, y] = project(it.at);
          this.text(it.text, x, y, it.color ?? C.text, 'center');
        }
        break;
    }
  }

  private text(s: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') {
    const ctx = this.ctx;
    ctx.font = `600 10px ${MONO}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(3,6,10,0.9)';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.textAlign = 'left';
  }

  private drawScale(pxPerKm: number) {
    const ctx = this.ctx;
    const target = this.w * 0.22;
    const km =
      [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(
        (k) => k * pxPerKm >= target / 2,
      ) ?? 5000;
    const len = km * pxPerKm;
    const x = 10;
    const y = this.h - 12;
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.lineTo(x + len, y - 4);
    ctx.stroke();
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = C.text;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${km.toLocaleString('fr-FR')} km`, x + 4, y - 3);
  }

  /** Coins en crochets (cadre de terminal). */
  private drawFrame() {
    const ctx = this.ctx;
    const L = 10;
    ctx.strokeStyle = alpha(C.cyan, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [x, y, sx, sy] of [
      [1, 1, 1, 1],
      [this.w - 1, 1, -1, 1],
      [1, this.h - 1, 1, -1],
      [this.w - 1, this.h - 1, -1, -1],
    ] as const) {
      ctx.moveTo(x + sx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * L);
    }
    ctx.stroke();
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }
}
