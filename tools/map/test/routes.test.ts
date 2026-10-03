/** Vérifications du réseau de routes généré (data/map/routes.json). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridDisk } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  CellsFileSchema,
  distanceKm,
  interpolate,
  ProvinceDefSchema,
  RoadNet,
  RoutesFileSchema,
  StraitSchema,
  type LngLat,
} from '@redline/shared';
import { cellOf } from '../src/cells.js';
import { formatRoutes, generateRoutes, ROUTES } from '../src/routes.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'data', 'map');
const text = readFileSync(join(ROOT, 'routes.json'), 'utf8');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as unknown;
const routes = RoutesFileSchema.parse(JSON.parse(text));
const provinces = ProvinceDefSchema.array().parse(read('provinces.json'));
const cells = CellsFileSchema.parse(read('cells.json'));
const land = new Map(Object.entries(cells.cells));
const impassable = new Set(cells.impassable ?? []);
/** Cellules des détroits et canaux : navigables (grille navale du moteur). */
const strait = new Set(
  StraitSchema.array()
    .parse(read('straits.json'))
    .flatMap((s) => s.seaCells),
);
const net = new RoadNet(routes);
const res = cells.res;

/** Tracé complet d'une arête (extrémités comprises). */
const line = (i: number): LngLat[] => {
  const e = routes.edges[i]!;
  return [routes.nodes[e.a]!.pos, ...e.pts, routes.nodes[e.b]!.pos];
};

describe('réseau de routes', () => {
  it('nœuds : identifiants uniques, une ville par province à son point de capture', () => {
    expect(new Set(routes.nodes.map((n) => n.id)).size).toBe(routes.nodes.length);
    const byId = new Map(routes.nodes.map((n) => [n.id, n]));
    for (const p of provinces) {
      const c = byId.get(`c:${p.id}`);
      expect(c, p.id).toBeDefined();
      expect(c!.pos).toEqual(p.cityPoint);
      expect(c!.province).toBe(p.id);
    }
    // Densité lisible : quelques milliers de nœuds pour le monde (~1 300 provinces).
    expect(routes.nodes.length).toBeGreaterThan(2500);
    expect(routes.nodes.length).toBeLessThan(9000);
    for (const n of routes.nodes) expect(land.has(cellOf(n.pos, res)), n.id).toBe(true);
  });

  it('arêtes : jamais sur la mer ni sur une zone infranchissable', { timeout: 60_000 }, () => {
    const bad: string[] = [];
    for (let i = 0; i < routes.edges.length; i++) {
      if (routes.edges[i]!.kind === 'ferry') continue;
      const pts = line(i);
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        const n = Math.max(1, Math.ceil(distanceKm(a, b) / ROUTES.sampleKm));
        for (let j = 0; j <= n; j++) {
          const c = cellOf(j === 0 ? a : j === n ? b : interpolate(a, b, j / n), res);
          if (land.has(c) && !impassable.has(c)) continue;
          const where = `${routes.nodes[routes.edges[i]!.a]!.id} → ${routes.nodes[routes.edges[i]!.b]!.id}`;
          bad.push(`${where} : ${impassable.has(c) ? 'zone infranchissable' : 'mer'}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('pays tiers : une route ne traverse que les nations de ses extrémités (sauf enclaves)', () => {
    const nationOf = new Map(provinces.map((p) => [p.id, p.nationId]));
    const nationAt = (p: LngLat) => nationOf.get(land.get(cellOf(p, res)) ?? '') ?? '';
    const bad: string[] = [];
    routes.edges.forEach((e, i) => {
      const ok = new Set(
        [routes.nodes[e.a]!.province, routes.nodes[e.b]!.province].map((p) => nationOf.get(p)),
      );
      const pts = line(i);
      const seen = new Set<string>();
      for (let k = 0; k + 1 < pts.length; k++) {
        const n = Math.max(1, Math.ceil(distanceKm(pts[k]!, pts[k + 1]!) / ROUTES.sampleKm));
        for (let j = 1; j < n; j++) {
          const x = nationAt(interpolate(pts[k]!, pts[k + 1]!, j / n));
          if (x && !ok.has(x)) seen.add(x);
        }
      }
      if (seen.size) bad.push(`${routes.nodes[e.a]!.id} → ${routes.nodes[e.b]!.id} : ${[...seen]}`);
    });
    // Enclaves, exclaves et frontières découpées (Nakhitchevan, Neum…) : quelques cas inévitables.
    expect(bad.length, bad.join('\n')).toBeLessThanOrEqual(30);
  });

  it('ports : au bord d’une mer navigable', () => {
    const ports = routes.nodes.filter((n) => n.port);
    // Un port au plus par province côtière (~1 300 provinces après fusion).
    expect(ports.length).toBeGreaterThan(500);
    for (const p of ports) {
      const c = cellOf(p.pos, res);
      const sea = gridDisk(c, 1).some((x) => strait.has(x) || (!land.has(x) && !impassable.has(x)));
      expect(sea, p.id).toBe(true);
    }
  });

  it('connexité : une seule composante routière par masse continentale', () => {
    // Masses continentales de la grille (cellules terrestres praticables contiguës).
    const comp = new Map<string, number>();
    let k = 0;
    for (const start of [...land.keys()].sort()) {
      if (comp.has(start)) continue;
      const q = [start];
      comp.set(start, k);
      for (let i = 0; i < q.length; i++)
        for (const n of gridDisk(q[i]!, 1))
          if (land.has(n) && !comp.has(n)) {
            comp.set(n, k);
            q.push(n);
          }
      k++;
    }
    const roadComps = new Map<number, Set<number>>();
    routes.nodes.forEach((n, i) => {
      const lc = comp.get(cellOf(n.pos, res))!;
      let s = roadComps.get(lc);
      if (!s) roadComps.set(lc, (s = new Set()));
      s.add(net.comp[i]!);
    });
    const split = [...roadComps].filter(([, s]) => s.size > 1);
    expect(split.map(([lc, s]) => `masse ${lc} : ${s.size} composantes`)).toEqual([]);
  });

  it('pas de toile d’araignée : aucun croisement de tracés, degré borné', () => {
    const deg = new Array<number>(routes.nodes.length).fill(0);
    for (const e of routes.edges) {
      deg[e.a]!++;
      deg[e.b]!++;
    }
    expect(Math.max(...deg)).toBeLessThanOrEqual(12);
    // Croisements propres de segments (projection plane, hors antiméridien).
    const segs: [number, LngLat, LngLat][] = [];
    routes.edges.forEach((_, i) => {
      const pts = line(i);
      for (let k = 0; k + 1 < pts.length; k++)
        if (Math.abs(pts[k + 1]![0] - pts[k]![0]) <= 180) segs.push([i, pts[k]!, pts[k + 1]!]);
    });
    const grid = new Map<string, number[]>();
    segs.forEach(([, a, b], j) => {
      for (let x = Math.floor(Math.min(a[0], b[0])); x <= Math.floor(Math.max(a[0], b[0])); x++)
        for (let y = Math.floor(Math.min(a[1], b[1])); y <= Math.floor(Math.max(a[1], b[1])); y++) {
          const key = `${x},${y}`;
          const l = grid.get(key) ?? [];
          l.push(j);
          grid.set(key, l);
        }
    });
    const o = (p: LngLat, q: LngLat, r: LngLat) =>
      Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    const crossings = new Set<string>();
    for (const l of grid.values())
      for (let i = 0; i < l.length; i++)
        for (let j = i + 1; j < l.length; j++) {
          const A = segs[l[i]!]!;
          const B = segs[l[j]!]!;
          if (A[0] === B[0]) continue;
          if (
            o(A[1], A[2], B[1]) * o(A[1], A[2], B[2]) < 0 &&
            o(B[1], B[2], A[1]) * o(B[1], B[2], A[2]) < 0
          )
            crossings.add(`${Math.min(A[0], B[0])}|${Math.max(A[0], B[0])}`);
        }
    // Tolérance : quelques croisements sans carrefour possible (le carrefour sortirait des nations
    // reliées ou de la terre praticable).
    expect(crossings.size).toBeLessThanOrEqual(15);
  });

  it('graphe partagé : plus court chemin Paris → Lyon le long des routes', () => {
    const city = (name: string) =>
      provinces.find((p) => p.nationId === 'fra' && p.cityName === name)!.id;
    const paris = net.nodePoint(net.nodeIndex(`c:${city('Paris')}`)!);
    const lyon = net.nodePoint(net.nodeIndex(`c:${city('Lyon')}`)!);
    const r = net.route(paris, lyon)!;
    expect(r).not.toBeNull();
    const gc = distanceKm(paris.pos, lyon.pos);
    expect(r.km).toBeGreaterThan(gc);
    expect(r.km).toBeLessThan(gc * 1.5);
    expect(r.pts[0]).toEqual(paris.pos);
    expect(r.pts[r.pts.length - 1]).toEqual(lyon.pos);
  });

  it('pipeline reproductible : régénérer donne le même fichier', () => {
    const { file } = generateRoutes({
      provinces,
      cells,
      straits: StraitSchema.array().parse(read('straits.json')),
    });
    expect(formatRoutes(RoutesFileSchema.parse(file))).toBe(text);
  }, 180_000);
});
