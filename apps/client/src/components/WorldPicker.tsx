/**
 * Carte du monde colorée par nation (écran de sélection façon Conflict of Nations) : clic = choix,
 * survol = nom et joueur, molette = zoom, glisser = déplacement. Canvas 2D, géométries en cache.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NationId } from '@redline/shared';
import { useWorld } from '../store/world.js';
import { shapesOf } from './MiniMap.js';

interface Props {
  picked: NationId | null;
  onPick: (id: NationId) => void;
  takenBy?: Record<NationId, string>;
  playable?: (id: NationId) => boolean;
  label: string;
}

const X0 = -170;
const X1 = 190;
const Y0 = -57;
const Y1 = 80;

function lighten(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const c = (v: number) => Math.round(v + (255 - v) * f);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
function darken(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const c = (v: number) => Math.round(v * f);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function WorldPicker({ picked, onPick, takenBy = {}, playable, label }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const geo = useWorld((s) => s.provincesGeo);
  const provinces = useWorld((s) => s.provinces);
  const nations = useWorld((s) => s.nations);
  const [hover, setHover] = useState<{ id: NationId; x: number; y: number } | null>(null);
  const [cam, setCam] = useState({ z: 1, cx: (X0 + X1) / 2, cy: (Y0 + Y1) / 2 + 8 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });

  const shapes = useMemo(() => (geo ? shapesOf(geo) : []), [geo]);
  const paths = useMemo(() => {
    const out: { id: string; nation: string; path: Path2D; bbox: [number, number, number, number]; rings: number[][][] }[] = [];
    for (const s of shapes) {
      const nation = provinces[s.id]?.nationId;
      if (!nation) continue;
      const p = new Path2D();
      for (const ring of s.rings) {
        ring.forEach(([x, y], i) => (i ? p.lineTo(x!, -y!) : p.moveTo(x!, -y!)));
        p.closePath();
      }
      out.push({ id: s.id, nation, path: p, bbox: s.bbox, rings: s.rings });
    }
    return out;
  }, [shapes, provinces]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const baseScale = Math.min(size.w / (X1 - X0), size.h / (Y1 - Y0));
  const scale = baseScale * cam.z;
  const toWorld = (px: number, py: number): [number, number] => [
    cam.cx + (px - size.w / 2) / scale,
    cam.cy - (py - size.h / 2) / scale,
  ];

  // Recentrage sur la nation choisie depuis la liste.
  useEffect(() => {
    if (!picked || drag.current) return;
    const cap = provinces[nations[picked]?.capitalProvinceId ?? '']?.cityPoint;
    // Territoire principal : provinces à moins de ~35° de la capitale (sans l'outre-mer).
    const own = paths.filter(
      (p) =>
        p.nation === picked &&
        (!cap || Math.hypot((p.bbox[0] + p.bbox[2]) / 2 - cap[0], (p.bbox[1] + p.bbox[3]) / 2 - cap[1]) < 35),
    );
    if (!own.length) return;
    let x0 = 180;
    let y0 = 90;
    let x1 = -180;
    let y1 = -90;
    for (const p of own) {
      x0 = Math.min(x0, p.bbox[0]);
      y0 = Math.min(y0, p.bbox[1]);
      x1 = Math.max(x1, p.bbox[2]);
      y1 = Math.max(y1, p.bbox[3]);
    }
    if (x1 - x0 > 180) return; // nation à cheval sur l'antiméridien : pas de recentrage
    const fit = Math.min((X1 - X0) / Math.max(8, (x1 - x0) * 3.2), (Y1 - Y0) / Math.max(6, (y1 - y0) * 3.2));
    setCam({ z: Math.max(1, Math.min(6, fit)), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }, [picked, paths, provinces, nations]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !paths.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, size.h);
    bg.addColorStop(0, '#0a1119');
    bg.addColorStop(1, '#070b10');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size.w, size.h);
    // Graticule.
    ctx.strokeStyle = 'rgba(125, 139, 153, 0.07)';
    ctx.lineWidth = 1;
    for (let g = -180; g <= 180; g += 30) {
      const x = size.w / 2 + (g - cam.cx) * scale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.h);
      ctx.stroke();
    }
    for (let g = -60; g <= 90; g += 30) {
      const y = size.h / 2 - (g - cam.cy) * scale;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.w, y);
      ctx.stroke();
    }
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (size.w / 2 - cam.cx * scale), dpr * (size.h / 2 + cam.cy * scale));
    ctx.lineJoin = 'round';
    for (const p of paths) {
      const n = nations[p.nation];
      const taken = !!takenBy[p.nation];
      const off = playable && !playable(p.nation);
      const base = n?.color ?? '#3a4252';
      ctx.fillStyle =
        p.nation === picked
          ? '#9b6bff'
          : hover?.id === p.nation
            ? lighten(base, 0.35)
            : taken || off
              ? '#1f2630'
              : darken(base, 0.82);
      ctx.fill(p.path);
      ctx.strokeStyle = 'rgba(7, 11, 16, 0.75)';
      ctx.lineWidth = 0.6 / scale;
      ctx.stroke(p.path);
    }
    // Contour lumineux de la sélection.
    if (picked) {
      ctx.shadowColor = 'rgba(155, 107, 255, 0.8)';
      ctx.shadowBlur = 10;
      ctx.strokeStyle = '#d7c6ff';
      ctx.lineWidth = 1.4 / scale;
      for (const p of paths) if (p.nation === picked) ctx.stroke(p.path);
      ctx.shadowBlur = 0;
    }
  }, [paths, size, cam, picked, hover?.id, takenBy, nations, playable, scale]);

  const hit = (px: number, py: number): NationId | null => {
    const [x, y] = toWorld(px, py);
    for (const p of paths) {
      const b = p.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (p.rings.some((r) => inRing(x, y, r))) return p.nation;
    }
    return null;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const hovered = hover ? nations[hover.id] : null;
  return (
    <div ref={wrap} className="worldpicker">
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        style={{ width: size.w, height: size.h, cursor: hover ? 'pointer' : drag.current ? 'grabbing' : 'grab' }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, cx: cam.cx, cy: cam.cy, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
            if (d.moved) setCam((c) => ({ ...c, cx: d.cx - dx / scale, cy: d.cy + dy / scale }));
            return;
          }
          if (e.pointerType !== 'mouse') return;
          const [px, py] = local(e);
          const id = hit(px, py);
          setHover(id ? { id, x: px, y: py } : null);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const [px, py] = local(e);
            const id = hit(px, py);
            if (id && !takenBy[id] && (!playable || playable(id))) onPick(id);
          }
        }}
        onPointerLeave={() => setHover(null)}
        onWheel={(e) => {
          const [px, py] = local(e);
          const [wx, wy] = toWorld(px, py);
          const z = Math.max(1, Math.min(10, cam.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
          const s = baseScale * z;
          setCam({ z, cx: wx - (px - size.w / 2) / s, cy: wy + (py - size.h / 2) / s });
        }}
      />
      {hovered && hover ? (
        <div className="worldpicker__tip" style={{ left: hover.x + 14, top: hover.y + 12 }}>
          <b>{hovered.name}</b>
          {takenBy[hover.id] ? <span className="nation-row__player">{takenBy[hover.id]}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
