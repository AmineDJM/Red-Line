/** Construction des entités GeoJSON affichées (fonctions pures, sans MapLibre). */
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import {
  distanceKm,
  geodesicCircle,
  greatCircleLine,
  type GameTime,
  type LngLat,
  type NationId,
  type NationView,
  type ProvinceDef,
  type ProvinceView,
  type SystemId,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { pictogramFor, pictogramForBuilding } from '@redline/ui';
import { isMoving, remainingPath, unitHeading, unitPosition } from './interpolation.js';

export const VIOLET = '#8b5cf6';
export const VIOLET_UNIT = '#7b4cf0';
export const UNKNOWN_COLOR = '#5b6477';
export const ORANGE = '#f39a2b';

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function fc<G extends Point | LineString | Polygon>(features: Feature<G>[]): FeatureCollection<G> {
  return { type: 'FeatureCollection', features };
}

export interface UnitCtx {
  me: NationId | null;
  nations: Record<NationId, NationView>;
  catalog: Record<SystemId, WeaponSystem>;
  selection: ReadonlySet<UnitId>;
  target: UnitId | null;
  t: GameTime;
}

export function nationColor(id: NationId, ctx: { me: NationId | null; nations: Record<NationId, NationView> }): string {
  if (id === ctx.me) return VIOLET_UNIT;
  return ctx.nations[id]?.color ?? UNKNOWN_COLOR;
}

/** Points des unités, positions interpolées à l'instant t. */
export function unitFeatures(units: Iterable<UnitView>, ctx: UnitCtx): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  for (const u of units) {
    if (u.status === 'destroyed') continue;
    const pos = unitPosition(u, ctx.t);
    const mine = u.owner === ctx.me;
    const sys = u.systemId ? ctx.catalog[u.systemId] : undefined;
    const known = u.level !== 'detected' && !!sys;
    const pic = known ? pictogramFor(sys) : 'unknown';
    const heading = sys?.movement === 'air' ? unitHeading(u, ctx.t) : null;
    const stale = u.level === 'detected' && ctx.t - u.lastSeen > 10 * 60_000;
    out.push({
      type: 'Feature',
      properties: {
        id: u.id,
        mine: mine ? 1 : 0,
        cmd: u.level === 'own' ? 1 : 0,
        color: known || mine ? nationColor(u.owner, ctx) : UNKNOWN_COLOR,
        pic,
        lvl: u.level,
        sel: ctx.selection.has(u.id) ? 1 : ctx.target === u.id ? 2 : 0,
        rot: heading ?? 0,
        op: stale ? 0.7 : 1,
        sort: (mine ? 10 : 0) + (ctx.selection.has(u.id) ? 20 : 0),
      },
      geometry: { type: 'Point', coordinates: [pos[0], pos[1]] },
    });
  }
  return fc(out);
}

/** Cercles d'incertitude des contacts anciens ou imprécis. */
export function uncertaintyFeatures(units: Iterable<UnitView>, t: GameTime, me: NationId | null): FeatureCollection<Polygon> {
  const out: Feature<Polygon>[] = [];
  for (const u of units) {
    if (u.owner === me || u.uncertaintyKm < 2) continue;
    out.push({
      type: 'Feature',
      properties: { id: u.id },
      geometry: { type: 'Polygon', coordinates: [geodesicCircle(unitPosition(u, t), u.uncertaintyKm, 48)] },
    });
  }
  return fc(out);
}

/** Trajectoires restantes des unités du joueur en mouvement. */
export function pathFeatures(units: Iterable<UnitView>, t: GameTime, me: NationId | null, selection: ReadonlySet<UnitId>) {
  const lines: Feature<LineString>[] = [];
  const heads: Feature<Point>[] = [];
  for (const u of units) {
    if (u.owner !== me || !u.move || !isMoving(u, t)) continue;
    const coords = remainingPath(u.move, t);
    if (coords.length < 2) continue;
    const sel = selection.has(u.id) ? 1 : 0;
    lines.push({ type: 'Feature', properties: { id: u.id, sel }, geometry: { type: 'LineString', coordinates: coords } });
    const end = coords[coords.length - 1]!;
    const prev = coords[coords.length - 2]!;
    heads.push({
      type: 'Feature',
      properties: { id: u.id, sel, rot: screenBearing(prev, end) },
      geometry: { type: 'Point', coordinates: end },
    });
  }
  return { lines: fc(lines), heads: fc(heads) };
}

/** Cap « écran » approximatif (Mercator) entre deux points voisins, pour orienter une flèche. */
export function screenBearing(a: LngLat, b: LngLat): number {
  const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const dx = ((b[0] - a[0]) * Math.PI) / 180;
  const dy = y(b[1]) - y(a[1]);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Anneau de portée entre portée minimale et maximale (polygone percé). */
export function rangeRing(center: LngLat, minKm: number, maxKm: number): FeatureCollection<Polygon> {
  if (maxKm <= 0) return fc([]);
  const outer = geodesicCircle(center, maxKm, 128);
  const rings = [outer];
  if (minKm > 0.5 && minKm < maxKm) rings.push(geodesicCircle(center, minKm, 96).reverse());
  return fc([
    { type: 'Feature', properties: { kind: 'max' }, geometry: { type: 'Polygon', coordinates: rings } },
  ]);
}

export function circleLine(center: LngLat, km: number, kind: string): Feature<LineString> {
  return { type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: geodesicCircle(center, km, 96) } };
}

export interface PreviewInput {
  kind: 'move' | 'attack';
  from: LngLat[];
  to: LngLat;
}

/** Aperçu d'un ordre : lignes en grand cercle, flèche orientée à l'arrivée, triangles de lancement. */
export function previewFeatures(p: PreviewInput) {
  const lines: Feature<LineString>[] = [];
  const pts: Feature<Point>[] = [];
  p.from.forEach((f, i) => {
    const coords = greatCircleLine(f, p.to, 40);
    if (coords.length < 2) return;
    lines.push({ type: 'Feature', properties: { i, kind: p.kind }, geometry: { type: 'LineString', coordinates: coords } });
    const end = coords[coords.length - 1]!;
    const prev = coords[Math.max(0, coords.length - 2)]!;
    if (p.kind === 'move') {
      pts.push({ type: 'Feature', properties: { kind: 'arrow', rot: screenBearing(prev, end) }, geometry: { type: 'Point', coordinates: end } });
    } else {
      pts.push({ type: 'Feature', properties: { kind: 'launch', n: i + 1 }, geometry: { type: 'Point', coordinates: f } });
    }
  });
  if (p.kind === 'attack') {
    pts.push({ type: 'Feature', properties: { kind: 'target' }, geometry: { type: 'Point', coordinates: p.to } });
    const end = lines[0]?.geometry.coordinates;
    if (end && end.length >= 2) {
      const e = end[end.length - 1] as LngLat;
      const pr = end[end.length - 2] as LngLat;
      pts.push({ type: 'Feature', properties: { kind: 'arrow', rot: screenBearing(pr, e) }, geometry: { type: 'Point', coordinates: e } });
    }
  }
  return { lines: fc(lines), points: fc(pts), distanceKm: p.from[0] ? distanceKm(p.from[0], p.to) : 0 };
}

export interface BuildingCtx {
  me: NationId | null;
  nations: Record<NationId, NationView>;
  defs: Record<string, ProvinceDef>;
}

/** Bâtiments génériques : une icône par bâtiment, alignées sous le point de ville. */
export function buildingFeatures(provinces: Iterable<ProvinceView>, ctx: BuildingCtx): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  for (const p of provinces) {
    if (!p.buildings.length) continue;
    const def = ctx.defs[p.id];
    if (!def) continue;
    const n = p.buildings.length;
    p.buildings.forEach((b, i) => {
      out.push({
        type: 'Feature',
        properties: {
          id: `${p.id}:${b}`,
          prov: p.id,
          mine: p.owner === ctx.me ? 1 : 0,
          color: p.owner === ctx.me ? '#4d2ea8' : nationColor(p.owner, ctx),
          pic: pictogramForBuilding(b),
          // Décalage en unités d'icône (multiplié par icon-size) : rangée centrée sous la ville.
          off: [(i - (n - 1) / 2) * 104, 70],
        },
        geometry: { type: 'Point', coordinates: def.cityPoint },
      });
    });
  }
  return fc(out);
}

/** Points d'étiquette des nations : centre pondéré de leurs provinces, recalé sur la province la plus proche. */
export function nationLabelFeatures(defs: Iterable<ProvinceDef>, names: Record<NationId, string>): FeatureCollection<Point> {
  const acc = new Map<NationId, { x: number; y: number; w: number; list: ProvinceDef[] }>();
  for (const p of defs) {
    const a = acc.get(p.nationId) ?? { x: 0, y: 0, w: 0, list: [] };
    const w = Math.max(1, p.areaKm2);
    a.x += p.centroid[0] * w;
    a.y += p.centroid[1] * w;
    a.w += w;
    a.list.push(p);
    acc.set(p.nationId, a);
  }
  const out: Feature<Point>[] = [];
  for (const [id, a] of acc) {
    const name = names[id];
    if (!name) continue;
    const c: LngLat = [a.x / a.w, a.y / a.w];
    let best = a.list[0]!;
    let bd = Infinity;
    for (const p of a.list) {
      const d = distanceKm(p.centroid, c);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    // Si le barycentre tombe dans une province de la nation (distance faible), on le garde.
    const pt = bd < Math.sqrt(best.areaKm2) * 0.6 ? c : best.centroid;
    // Même schéma que basemap/countries.geojson : rang et zoom d'apparition selon la superficie.
    const minzoom = a.w > 1_500_000 ? 1.7 : a.w > 400_000 ? 2.5 : a.w > 60_000 ? 3.5 : 5;
    const rank = a.w > 1_500_000 ? 2 : a.w > 400_000 ? 3 : a.w > 60_000 ? 4 : 6;
    out.push({ type: 'Feature', properties: { id, name, rank, minzoom }, geometry: { type: 'Point', coordinates: pt } });
  }
  return fc(out);
}
