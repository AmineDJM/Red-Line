/**
 * Carte animée de l'en-tête (HTML + SVG, sans script) : matrice de points du monde, trajectoires en grand
 * cercle et échos radar sur quelques capitales. Seules des animations « composées » (transform, opacity)
 * sont utilisées : aucun travail du fil principal pendant l'animation (Lighthouse : TBT nul).
 * La boîte garde le rapport de world.svg (360 × 140, 1 unité = 1°) et couvre l'en-tête (unités cq).
 */
import { WORLD } from './world.js';

const W = WORLD.east - WORLD.west;
const H = WORLD.north - WORLD.south;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Points intermédiaires d'un grand cercle (interpolation sphérique). */
export function greatCircle(a: [number, number], b: [number, number], n = 32): [number, number][] {
  const [l1, p1] = [rad(a[0]), rad(a[1])];
  const [l2, p2] = [rad(b[0]), rad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
      ),
    );
  if (d === 0) return [a, b];
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return out;
}

const px = ([lon, lat]: [number, number]) =>
  `${(lon - WORLD.west).toFixed(1)} ${(WORLD.north - lat).toFixed(1)}`;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export interface HeroMapOptions {
  worldUrl: string;
  pings: [number, number][];
  arcs: [[number, number], [number, number]][];
}

export function heroMap(o: HeroMapOptions): string {
  const arcs = o.arcs
    .map(([a, b]) => `<path d="M${greatCircle(a, b).map(px).join('L')}"/>`)
    .join('');
  const pings = o.pings
    .map(([lon, lat], i) => {
      const x = (lon - WORLD.west) / W;
      const y = (WORLD.north - lat) / H;
      return `<i style="left:${pct(x)};top:${pct(y)};animation-delay:${(2.5 + i * 0.45).toFixed(2)}s"></i>`;
    })
    .join('');
  return (
    `<div class="worldmap" aria-hidden="true"><div class="worldmap__box">` +
    `<img class="worldmap__dots" src="${o.worldUrl}" width="${W * 4}" height="${H * 4}" alt="" fetchpriority="high">` +
    `<svg class="worldmap__arcs" viewBox="0 0 ${W} ${H}" focusable="false">${arcs}</svg>` +
    `<div class="worldmap__pings">${pings}</div>` +
    `</div></div>`
  );
}
