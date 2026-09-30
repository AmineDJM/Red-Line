/**
 * Mini-carte canvas (rapports de renseignement, replay de bataille, chronologie des frontières).
 * Projection équirectangulaire locale ; géométries des provinces mises en cache une fois.
 */
import { useEffect, useRef } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import type { LngLat, NationId } from '@redline/shared';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

interface ProvShape {
  id: string;
  rings: number[][][];
  bbox: [number, number, number, number];
}

let cache: { geo: FeatureCollection; shapes: ProvShape[] } | null = null;

function shapesOf(geo: FeatureCollection): ProvShape[] {
  if (cache?.geo === geo) return cache.shapes;
  const shapes: ProvShape[] = [];
  for (const f of geo.features) {
    const g = f.geometry as Geometry;
    const polys =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const rings: number[][][] = [];
    let x0 = 180;
    let y0 = 90;
    let x1 = -180;
    let y1 = -90;
    for (const poly of polys) {
      const outer = poly[0] as number[][] | undefined;
      if (!outer) continue;
      rings.push(outer);
      for (const [x, y] of outer as [number, number][]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const id = String(f.properties?.id ?? f.id ?? '');
    if (id && rings.length) shapes.push({ id, rings, bbox: [x0, y0, x1, y1] });
  }
  cache = { geo, shapes };
  return shapes;
}

export interface MiniMapMarker {
  at: LngLat;
  /** Rayon en km (cercle) ; sinon point. */
  radiusKm?: number;
  color: string;
  /** Taille du point en px. */
  size?: number;
  label?: string;
  shape?: 'dot' | 'square' | 'cross' | 'ring';
}

export interface MiniMapLine {
  from: LngLat;
  to: LngLat;
  color: string;
  dashed?: boolean;
  width?: number;
}

export interface MiniMapProps {
  /** Centre et étendue (km de demi-largeur). Absents : monde entier. */
  center?: LngLat;
  spanKm?: number;
  /** Propriétaires à afficher (chronologie) ; défaut : vue courante. */
  owners?: Record<string, NationId>;
  markers?: MiniMapMarker[];
  lines?: MiniMapLine[];
  height?: number;
  className?: string;
  /** Texte alternatif. */
  label?: string;
}

const KM_PER_DEG = 111.32;

export function drawMiniMap(
  canvas: HTMLCanvasElement,
  shapes: ProvShape[],
  colorOf: (pid: string) => string,
  p: Pick<MiniMapProps, 'center' | 'spanKm' | 'markers' | 'lines'>,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070b10';
  ctx.fillRect(0, 0, w, h);

  let cx: number, cy: number, sx: number, sy: number;
  if (p.center) {
    const span = p.spanKm ?? 300;
    const cos = Math.max(0.2, Math.cos((p.center[1] * Math.PI) / 180));
    [cx, cy] = p.center;
    const pxPerKm = w / 2 / span;
    sx = pxPerKm * KM_PER_DEG * cos;
    sy = pxPerKm * KM_PER_DEG;
  } else {
    cx = 10;
    cy = 20;
    sx = w / 340;
    sy = sx;
    if (h / 150 < sy) {
      sy = h / 150;
      sx = sy;
    }
  }
  const X = (lng: number) => w / 2 + (lng - cx) * sx;
  const Y = (lat: number) => h / 2 - (lat - cy) * sy;
  const vx0 = cx - w / 2 / sx,
    vx1 = cx + w / 2 / sx,
    vy0 = cy - h / 2 / sy,
    vy1 = cy + h / 2 / sy;

  ctx.lineJoin = 'round';
  for (const s of shapes) {
    const [x0, y0, x1, y1] = s.bbox;
    if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
    ctx.beginPath();
    for (const ring of s.rings) {
      ring.forEach(([lng, lat], i) => {
        const x = X(lng!),
          y = Y(lat!);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fillStyle = colorOf(s.id);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10, 14, 19, 0.85)';
    ctx.lineWidth = p.center ? 0.8 : 0.35;
    ctx.stroke();
  }
  // Graticule discret.
  ctx.strokeStyle = 'rgba(125, 139, 153, 0.08)';
  ctx.lineWidth = 1;
  const step = p.center ? (sx > 40 ? 1 : 5) : 30;
  for (let g = Math.ceil(vx0 / step) * step; g < vx1; g += step) {
    ctx.beginPath();
    ctx.moveTo(X(g), 0);
    ctx.lineTo(X(g), h);
    ctx.stroke();
  }
  for (let g = Math.ceil(vy0 / step) * step; g < vy1; g += step) {
    ctx.beginPath();
    ctx.moveTo(0, Y(g));
    ctx.lineTo(w, Y(g));
    ctx.stroke();
  }
  for (const l of p.lines ?? []) {
    ctx.beginPath();
    ctx.moveTo(X(l.from[0]), Y(l.from[1]));
    ctx.lineTo(X(l.to[0]), Y(l.to[1]));
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width ?? 1.2;
    ctx.setLineDash(l.dashed ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const m of p.markers ?? []) {
    const x = X(m.at[0]),
      y = Y(m.at[1]);
    if (m.radiusKm) {
      const r = (m.radiusKm / KM_PER_DEG) * sy;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, r), 0, Math.PI * 2);
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const sz = m.size ?? 4;
    ctx.fillStyle = m.color;
    ctx.strokeStyle = m.color;
    if (m.shape === 'cross') {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - sz * 2, y);
      ctx.lineTo(x + sz * 2, y);
      ctx.moveTo(x, y - sz * 2);
      ctx.lineTo(x, y + sz * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.shape === 'square') {
      ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeRect(x - sz, y - sz, sz * 2, sz * 2);
    } else if (m.shape === 'ring') {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, Math.PI * 2);
      ctx.fill();
    }
    if (m.label) {
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(214, 221, 230, 0.9)';
      ctx.fillText(m.label, x + sz + 4, y + 3);
    }
  }
}

/** Assombrit une couleur hexadécimale (fond de carte). */
export function tint(hex: string, f = 0.55): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

export function useOwnerColor(owners?: Record<string, NationId>) {
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const nations = useWorld((s) => s.nations);
  const provinces = useWorld((s) => s.provinces);
  return (pid: string) => {
    const owner = owners?.[pid] ?? view?.provinces[pid]?.owner ?? provinces[pid]?.nationId;
    if (!owner) return '#151c24';
    if (owner === me) return '#5b3fa8';
    return tint(view?.nations[owner]?.color ?? nations[owner]?.color ?? '#3a4252', 0.5);
  };
}

/** Mini-carte React (redessinée quand les props changent). */
export function MiniMap({
  center,
  spanKm,
  owners,
  markers,
  lines,
  height = 120,
  className,
  label,
}: MiniMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useWorld((s) => s.provincesGeo);
  const colorOf = useOwnerColor(owners);
  useEffect(() => {
    const c = ref.current;
    if (!c || !geo) return;
    const draw = () => drawMiniMap(c, shapesOf(geo), colorOf, { center, spanKm, markers, lines });
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  });
  return (
    <canvas
      ref={ref}
      className={className ? `minimap ${className}` : 'minimap'}
      style={{ height }}
      role="img"
      aria-label={label}
    />
  );
}

export { shapesOf };
