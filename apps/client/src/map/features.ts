/** Construction des entités GeoJSON affichées (fonctions pures, sans MapLibre). */
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import {
  bearing,
  distanceKm,
  legAt,
  geodesicCircle,
  greatCircleLine,
  movementEnd,
  positionAt,
  type GameTime,
  type LngLat,
  type NationId,
  type NationView,
  type ProvinceDef,
  type ProvinceView,
  type SatellitePassView,
  type SystemId,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { glyphFor, type GlyphId } from './glyphs.js';
import { groupItems, type Group, type GroupItem } from './grouping.js';
import { isMoving, remainingPath, unitPosition } from './interpolation.js';
import { C, relationOf, type Rel } from './palette.js';
import {
  BLD_SIZE,
  PION_H,
  PION_ICON_OFFSET,
  PION_PARTS,
  PION_W,
  compactCount,
  pionKey,
  type BuildingState,
  type PionSpec,
} from './pions.js';

/** Territoire du joueur (violet de la direction artistique). */
export const VIOLET = C.violet;
/** Couleur des forces du joueur dans les panneaux (compatibilité). */
export const VIOLET_UNIT = '#7b4cf0';
export const UNKNOWN_COLOR = '#5b6477';
/** Ambre : portées, trajectoires, valeurs. */
export const ORANGE = C.amber;

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function fc<G extends Point | LineString | Polygon>(
  features: Feature<G>[],
): FeatureCollection<G> {
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

export function nationColor(
  id: NationId,
  ctx: { me: NationId | null; nations: Record<NationId, NationView> },
): string {
  if (id === ctx.me) return VIOLET_UNIT;
  return ctx.nations[id]?.color ?? UNKNOWN_COLOR;
}

// ——— Unités : informations d'affichage ———

export interface UnitInfo extends GroupItem {
  u: UnitView;
  sys: WeaponSystem | undefined;
  rel: Rel;
  glyph: GlyphId;
  flags: string;
  /** Effectif connu (sinon undefined). */
  count: number | undefined;
  hp: number | undefined;
  /** Aéronef en vol : cap (degrés), sinon null. */
  heading: number | null;
  /** Opacité (contacts anciens estompés). */
  op: number;
  /** 1 sélectionnée, 2 cible, 0 sinon. */
  sel: 0 | 1 | 2;
  missile: boolean;
}

const STALE_MS = 10 * 60_000;

const glyphCache = new WeakMap<WeaponSystem, GlyphId>();
function cachedGlyph(sys: WeaponSystem): GlyphId {
  let g = glyphCache.get(sys);
  if (!g) {
    g = glyphFor(sys);
    glyphCache.set(sys, g);
  }
  return g;
}

/** Informations d'affichage de chaque unité à l'instant t (position interpolée, état, relation). */
export function unitInfos(units: Iterable<UnitView>, ctx: UnitCtx): UnitInfo[] {
  const out: UnitInfo[] = [];
  for (const u of units) {
    if (u.status === 'destroyed') continue;
    const legs = u.move?.legs;
    const moving =
      !!legs && legs.length > 0 && legs[legs.length - 1]!.t1 > ctx.t && legs[0]!.t0 <= ctx.t;
    const leg = moving ? legAt(u.move!, ctx.t) : undefined;
    const pos = leg ? positionAt(u.move!, ctx.t) : unitPosition(u, ctx.t);
    const rel = relationOf(u.owner, ctx.me, ctx.nations);
    const sys = u.systemId ? ctx.catalog[u.systemId] : undefined;
    const known = u.level !== 'detected' && !!sys;
    const air = sys?.movement === 'air' || (!!leg && leg.medium === 'air');
    const missile = !!u.missile || (!!sys && sys.category === 'strike_missile' && moving && air);
    let flags = '';
    if (u.status === 'combat') flags += 'c';
    if (u.status === 'embarked') flags += 'e';
    if (u.supply === 'cut') flags += 's';
    else if (u.supply === 'limited') flags += 'l';
    const mk = u.mission?.kind;
    if (air && mk && mk !== 'none' && mk !== 'rtb') flags += 'a';
    if (moving) flags += 'm';
    if (u.decoy) flags += 'd';
    if (sys?.category === 'submarine') flags += rel === 'own' ? 'u' : 'n';
    if (u.jamming) flags += 'j';
    if (!known) flags += 'x';
    const age = ctx.t - u.lastSeen;
    const stale = rel !== 'own' && age > STALE_MS;
    const sel: 0 | 1 | 2 = ctx.selection.has(u.id) ? 1 : ctx.target === u.id ? 2 : 0;
    out.push({
      id: u.id,
      pos,
      key: u.owner,
      priority:
        (rel === 'own' ? 1e6 : rel === 'ally' ? 5e5 : 0) +
        (known ? 1e5 : 0) +
        Math.min(99_999, u.count ?? 1),
      u,
      sys,
      rel,
      glyph: known ? cachedGlyph(sys!) : 'unknown',
      flags,
      count: u.count,
      hp: u.hpRatio,
      heading:
        air && leg
          ? Math.abs(pos[0] - leg.to[0]) + Math.abs(pos[1] - leg.to[1]) < 1e-9
            ? bearing(leg.from, leg.to)
            : bearing(pos, leg.to)
          : null,
      op: stale ? Math.max(0.45, 1 - (age - STALE_MS) / (3 * 3600_000)) : 1,
      sel,
      missile,
    });
  }
  return out;
}

function groupFlags(ms: UnitInfo[]): string {
  if (ms.length === 1) return ms[0]!.flags;
  let f = '';
  const any = (c: string) => ms.some((m) => m.flags.includes(c));
  const all = (c: string) => ms.every((m) => m.flags.includes(c));
  if (any('c')) f += 'c';
  if (all('e')) f += 'e';
  if (any('s')) f += 's';
  else if (any('l')) f += 'l';
  if (all('a')) f += 'a';
  if (all('m')) f += 'm';
  if (all('u')) f += 'u';
  if (all('n')) f += 'n';
  if (all('x')) f += 'x';
  return f;
}

/** Spécification du pion d'une pile (ou d'une unité seule). */
export function pionSpecFor(
  ms: UnitInfo[],
  ctx: { nations: Record<NationId, NationView> },
  sel = false,
): PionSpec {
  const lead = ms.find((m) => m.glyph !== 'unknown') ?? ms[0]!;
  let total = 0;
  let known = 0;
  let hpSum = 0;
  let hpN = 0;
  for (const m of ms) {
    if (m.count !== undefined) {
      total += m.count;
      known++;
    }
    if (m.hp !== undefined) {
      hpSum += m.hp;
      hpN++;
    }
  }
  const owner = lead.u.owner;
  return {
    nation: owner,
    color: (ctx.nations[owner]?.color ?? UNKNOWN_COLOR).toLowerCase(),
    glyph: lead.glyph,
    rel: lead.rel,
    count: known ? compactCount(total) : '',
    hp: hpN ? Math.max(0, Math.min(10, Math.round((hpSum / hpN) * 10))) : -1,
    stack: ms.length,
    flags: groupFlags(ms),
    sel,
  };
}

function pointFeature(id: string, pos: LngLat, props: Record<string, unknown>): Feature<Point> {
  return {
    type: 'Feature',
    properties: { id, ...props },
    geometry: { type: 'Point', coordinates: [pos[0], pos[1]] },
  };
}

/** Rang d'empilement : les forces du joueur au-dessus, puis alliés, puis le reste. */
function sortKey(rel: Rel, sel: number) {
  return (rel === 'own' ? 30 : rel === 'ally' ? 20 : rel === 'enemy' ? 15 : 10) + sel * 50;
}

export interface TokenResult {
  /** Pions (unités seules et piles). */
  tokens: Feature<Point>[];
  /** Pions hors regroupement (sélection, cible). */
  focus: Feature<Point>[];
  /** Flèches de cap des aéronefs en vol. */
  headings: Feature<Point>[];
  /** Missiles en vol. */
  missiles: Feature<Point>[];
  groups: Group<UnitInfo>[];
}

/**
 * Pions à afficher : regroupement selon le zoom (sauf sélection/cible, toujours isolées),
 * missiles en vol à part (marqueur orienté), flèches de cap des aéronefs.
 */
export function tokenFeatures(
  infos: UnitInfo[],
  ctx: { nations: Record<NationId, NationView>; zoom: number; group: boolean },
): TokenResult {
  const free: UnitInfo[] = [];
  const selected: UnitInfo[] = [];
  const focus: Feature<Point>[] = [];
  const headings: Feature<Point>[] = [];
  const missiles: Feature<Point>[] = [];
  for (const i of infos) {
    if (i.missile) {
      missiles.push(
        pointFeature(i.id, i.pos, {
          rot: i.heading ?? 0,
          rel: i.rel,
          sel: i.sel,
          op: i.op,
        }),
      );
      continue;
    }
    if (i.sel) {
      selected.push(i);
      continue;
    }
    free.push(i);
  }
  // Sélection et cible : jamais regroupées, mais écartées si elles se recouvrent.
  const spread = groupItems(
    selected.map((i) => ({ ...i, key: i.id })),
    { zoom: ctx.zoom, w: PION_W, h: PION_H },
  );
  for (const g of spread) {
    const i = g.leader;
    focus.push(
      pointFeature(i.id, i.pos, {
        ...pionProps(pionSpecFor([i], ctx, true), g.off),
        sel: i.sel,
        sort: sortKey(i.rel, i.sel),
        op: i.op,
        foff: g.off,
        n: 1,
        members: i.id,
      }),
    );
    if (i.heading !== null)
      headings.push(
        pointFeature(i.id, i.pos, {
          rot: i.heading,
          rel: i.rel,
          f: 1,
          off: headingOffset(i.heading, g.off),
        }),
      );
  }
  const groups: Group<UnitInfo>[] = ctx.group
    ? groupItems(free, { zoom: ctx.zoom, w: PION_W, h: PION_H })
    : free.map((i) => ({ id: i.id, leader: i, members: [i], off: [0, 0] as [number, number] }));
  const tokens: Feature<Point>[] = [];
  for (const g of groups) {
    const lead = g.leader;
    tokens.push(
      pointFeature(g.id, lead.pos, {
        ...pionProps(pionSpecFor(g.members, ctx), g.off),
        sel: 0,
        sort: sortKey(lead.rel, 0) + (g.members.length > 1 ? 1 : 0),
        op: Math.max(...g.members.map((m) => m.op)),
        n: g.members.length,
        // Pile en mouvement : source dédiée, mise à jour souvent (voir GameMap).
        mv: g.members.some((m) => m.flags.includes('m')) ? 1 : 0,
        members: g.members.length > 1 ? g.members.map((m) => m.id).join(',') : lead.id,
      }),
    );
    if (g.members.length === 1 && lead.heading !== null)
      headings.push(
        pointFeature(g.id, lead.pos, {
          rot: lead.heading,
          rel: lead.rel,
          f: 0,
          off: headingOffset(lead.heading, g.off),
        }),
      );
  }
  return { tokens, focus, headings, missiles, groups };
}

/** Taille (px CSS à l'échelle 1) des textes des pions : effectif et numéro de pile. */
export const COUNT_TEXT = 11;
export const STACK_TEXT = 8.5;

/**
 * Propriétés d'un pion : image (sans effectif ni barre d'état, qui changent souvent), texte
 * d'effectif, barre d'état et numéro de pile, avec leurs décalages (écartement compris).
 */
export function pionProps(spec: PionSpec, off: [number, number]) {
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    img: pionKey(spec),
    off: [r(off[0] + PION_ICON_OFFSET[0]), r(off[1] + PION_ICON_OFFSET[1])],
    cnt: spec.count,
    toff: [r((off[0] + PION_PARTS.count[0]) / COUNT_TEXT), r((off[1] + PION_PARTS.count[1]) / COUNT_TEXT)],
    hp: spec.hp,
    hoff: [r(off[0] + PION_PARTS.hp[0]), r(off[1] + PION_PARTS.hp[1])],
    // Repli sans glyphes (images de texte de 12 px) : décalage exprimé à l'échelle de l'image.
    tpx: [r(((off[0] + PION_PARTS.count[0]) * 12) / COUNT_TEXT), r(((off[1] + PION_PARTS.count[1]) * 12) / COUNT_TEXT)],
    stk: spec.stack > 1 ? (spec.stack > 99 ? '99+' : String(spec.stack)) : '',
    spx: [r(((off[0] + PION_PARTS.stack[0]) * 12) / STACK_TEXT), r(((off[1] + PION_PARTS.stack[1]) * 12) / STACK_TEXT)],
    soff: [r((off[0] + PION_PARTS.stack[0]) / STACK_TEXT), r((off[1] + PION_PARTS.stack[1]) / STACK_TEXT)],
  };
}

/**
 * Décalage de la flèche de cap : sur une ellipse autour du pion, dans la direction du cap.
 * MapLibre applique `icon-offset` dans le repère tourné de l'icône : le décalage d'écartement de
 * la pile est donc ramené dans ce repère (rotation inverse).
 */
export function headingOffset(rot: number, off: [number, number]): [number, number] {
  const th = (rot * Math.PI) / 180;
  const s = Math.sin(th);
  const c = Math.cos(th);
  const a = PION_W / 2 + 7;
  const b = PION_H / 2 + 7;
  const r = 1 / Math.sqrt((s / a) ** 2 + (c / b) ** 2);
  const x = off[0] * c + off[1] * s;
  const y = -off[0] * s + off[1] * c;
  return [Math.round(x * 10) / 10, Math.round((y - r) * 10) / 10];
}

/**
 * Points des unités, un par unité, positions interpolées à l'instant t (sans regroupement).
 * Conservé comme API simple (tests de performance, outils).
 */
export function unitFeatures(units: Iterable<UnitView>, ctx: UnitCtx): FeatureCollection<Point> {
  const infos = unitInfos(units, ctx);
  return fc(
    infos.map((i) =>
      pointFeature(i.id, i.pos, {
        img: pionKey(pionSpecFor([i], ctx, i.sel > 0)),
        mine: i.rel === 'own' ? 1 : 0,
        cmd: i.u.level === 'own' ? 1 : 0,
        lvl: i.u.level,
        sel: i.sel,
        rot: i.heading ?? 0,
        op: i.op,
        sort: sortKey(i.rel, i.sel),
      }),
    ),
  );
}

/** Cercles d'incertitude des contacts anciens ou imprécis (opacité selon l'ancienneté). */
export function uncertaintyFeatures(
  units: Iterable<UnitView>,
  t: GameTime,
  me: NationId | null,
): FeatureCollection<Polygon> {
  const out: Feature<Polygon>[] = [];
  for (const u of units) {
    if (u.owner === me || u.uncertaintyKm < 2) continue;
    const age = Math.max(0, t - u.lastSeen);
    out.push({
      type: 'Feature',
      properties: { id: u.id, age: Math.min(1, age / (3 * 3600_000)) },
      geometry: {
        type: 'Polygon',
        coordinates: [geodesicCircle(unitPosition(u, t), u.uncertaintyKm, 48)],
      },
    });
  }
  return fc(out);
}

// ——— Trajectoires ———

/** Trajectoires restantes des unités du joueur en mouvement (hors missiles). */
export function pathFeatures(
  units: Iterable<UnitView>,
  t: GameTime,
  me: NationId | null,
  selection: ReadonlySet<UnitId>,
) {
  const lines: Feature<LineString>[] = [];
  const heads: Feature<Point>[] = [];
  for (const u of units) {
    if (u.owner !== me || !u.move || !isMoving(u, t) || u.missile) continue;
    const coords = remainingPath(u.move, t);
    if (coords.length < 2) continue;
    const sel = selection.has(u.id) ? 1 : 0;
    const air = u.move.legs.some((l) => l.medium === 'air') ? 1 : 0;
    lines.push({
      type: 'Feature',
      properties: { id: u.id, sel, air },
      geometry: { type: 'LineString', coordinates: coords },
    });
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

/**
 * Missiles en vol : traînée (dégradé, `line-progress`) derrière la position courante et
 * trajectoire prévue jusqu'à l'impact (pointillés), point d'impact.
 */
export function missileFeatures(units: Iterable<UnitView>, t: GameTime, me: NationId | null) {
  const trails: Feature<LineString>[] = [];
  const ahead: Feature<LineString>[] = [];
  const impacts: Feature<Point>[] = [];
  for (const u of units) {
    if (!u.move || !isMoving(u, t)) continue;
    const isMissile = !!u.missile;
    const air = u.move.legs.some((l) => l.medium === 'air');
    if (!isMissile && !air) continue;
    const t0 = u.move.legs[0]!.t0;
    const end = movementEnd(u.move);
    const span = Math.max(1, end - t0);
    // Traînée : dernier 12 % du vol (missile) ou 4 % (aéronef), au plus 20 échantillons.
    const frac = isMissile ? 0.12 : 0.04;
    const from = Math.max(t0, t - span * frac);
    const n = 12;
    const pts: LngLat[] = [];
    for (let i = 0; i <= n; i++) pts.push(positionAt(u.move, from + ((t - from) * i) / n));
    unwrap(pts);
    const own = u.owner === me;
    if (distanceKm(pts[0]!, pts[pts.length - 1]!) > 0.5)
      trails.push({
        type: 'Feature',
        properties: { id: u.id, kind: isMissile ? 'missile' : 'air', own: own ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: pts },
      });
    if (isMissile) {
      const rest = remainingPath(u.move, t, 40);
      if (rest.length >= 2)
        ahead.push({
          type: 'Feature',
          properties: { id: u.id, own: own ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: rest },
        });
      const dest = rest[rest.length - 1];
      if (dest)
        impacts.push({
          type: 'Feature',
          properties: {
            id: u.id,
            own: own ? 1 : 0,
            eta: Math.max(0, (u.missile?.impactAt ?? end) - t),
          },
          geometry: { type: 'Point', coordinates: dest },
        });
    }
  }
  return { trails: fc(trails), ahead: fc(ahead), impacts: fc(impacts) };
}

function unwrap(pts: LngLat[]) {
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]![0] - pts[i - 1]![0];
    if (d > 180) pts[i] = [pts[i]![0] - 360, pts[i]![1]];
    else if (d < -180) pts[i] = [pts[i]![0] + 360, pts[i]![1]];
  }
}

/** Orbites de patrouille (CAP, guet aérien, ravitaillement, blocus) des unités du joueur. */
export function orbitFeatures(
  units: Iterable<UnitView>,
  me: NationId | null,
  selection: ReadonlySet<UnitId>,
) {
  const lines: Feature<LineString>[] = [];
  const centers: Feature<Point>[] = [];
  for (const u of units) {
    if (u.owner !== me) continue;
    const m = u.mission;
    if (!m || !m.at || !m.radiusKm) continue;
    if (!['patrol', 'awacs', 'refuel', 'blockade', 'escort', 'recon'].includes(m.kind)) continue;
    const sel = selection.has(u.id) ? 1 : 0;
    const ring = geodesicCircle(m.at, m.radiusKm, 72);
    lines.push({
      type: 'Feature',
      properties: { id: u.id, sel, kind: m.kind },
      geometry: { type: 'LineString', coordinates: ring },
    });
    // Flèches de sens de rotation (horaire) aux quatre points cardinaux.
    for (let k = 0; k < 4; k++) {
      const i = Math.round((k * (ring.length - 1)) / 4);
      const a = ring[i]!;
      const b = ring[Math.min(ring.length - 1, i + 1)]!;
      centers.push({
        type: 'Feature',
        properties: { id: `${u.id}:${k}`, sel, rot: screenBearing(a, b), kind: 'arrow' },
        geometry: { type: 'Point', coordinates: a },
      });
    }
    centers.push({
      type: 'Feature',
      properties: { id: `${u.id}:c`, sel, kind: 'center' },
      geometry: { type: 'Point', coordinates: m.at },
    });
  }
  return { lines: fc(lines), points: fc(centers) };
}

/** Liens d'attaque en cours : unité du joueur → sa cible (si connue). */
export function attackLinkFeatures(
  units: Record<UnitId, UnitView>,
  positions: ReadonlyMap<UnitId, LngLat>,
  me: NationId | null,
): FeatureCollection<LineString> {
  const out: Feature<LineString>[] = [];
  for (const u of Object.values(units)) {
    if (u.owner !== me || !u.targetId) continue;
    const tgt = units[u.targetId];
    const a = positions.get(u.id) ?? u.pos;
    const b = tgt ? (positions.get(tgt.id) ?? tgt.pos) : undefined;
    if (!b) continue;
    out.push({
      type: 'Feature',
      properties: { id: u.id },
      geometry: { type: 'LineString', coordinates: greatCircleLine(a, b, 40) },
    });
  }
  return fc(out);
}

/** Cap « écran » approximatif (Mercator) entre deux points voisins, pour orienter une flèche. */
export function screenBearing(a: LngLat, b: LngLat): number {
  const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const dx = ((b[0] - a[0]) * Math.PI) / 180;
  const dy = y(b[1]) - y(a[1]);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Anneau de portée entre portée minimale et maximale (polygone percé). */
export function rangeRing(
  center: LngLat,
  minKm: number,
  maxKm: number,
): FeatureCollection<Polygon> {
  if (maxKm <= 0) return fc([]);
  const outer = geodesicCircle(center, maxKm, 128);
  const rings = [outer];
  if (minKm > 0.5 && minKm < maxKm) rings.push(geodesicCircle(center, minKm, 96).reverse());
  return fc([
    {
      type: 'Feature',
      properties: { kind: 'max' },
      geometry: { type: 'Polygon', coordinates: rings },
    },
  ]);
}

export function circleLine(center: LngLat, km: number, kind: string): Feature<LineString> {
  return {
    type: 'Feature',
    properties: { kind },
    geometry: { type: 'LineString', coordinates: geodesicCircle(center, km, 96) },
  };
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
    lines.push({
      type: 'Feature',
      properties: { i, kind: p.kind },
      geometry: { type: 'LineString', coordinates: coords },
    });
    const end = coords[coords.length - 1]!;
    const prev = coords[Math.max(0, coords.length - 2)]!;
    if (p.kind === 'move') {
      pts.push({
        type: 'Feature',
        properties: { kind: 'arrow', rot: screenBearing(prev, end) },
        geometry: { type: 'Point', coordinates: end },
      });
    } else {
      pts.push({
        type: 'Feature',
        properties: { kind: 'launch', n: i + 1 },
        geometry: { type: 'Point', coordinates: f },
      });
    }
  });
  if (p.kind === 'move') {
    pts.push({
      type: 'Feature',
      properties: { kind: 'dest' },
      geometry: { type: 'Point', coordinates: p.to },
    });
  }
  if (p.kind === 'attack') {
    pts.push({
      type: 'Feature',
      properties: { kind: 'target' },
      geometry: { type: 'Point', coordinates: p.to },
    });
    const end = lines[0]?.geometry.coordinates;
    if (end && end.length >= 2) {
      const e = end[end.length - 1] as LngLat;
      const pr = end[end.length - 2] as LngLat;
      pts.push({
        type: 'Feature',
        properties: { kind: 'arrow', rot: screenBearing(pr, e) },
        geometry: { type: 'Point', coordinates: e },
      });
    }
  }
  return {
    lines: fc(lines),
    points: fc(pts),
    distanceKm: p.from[0] ? distanceKm(p.from[0], p.to) : 0,
  };
}

// ——— Provinces : villes, bâtiments, fortifications ———

export interface BuildingCtx {
  me: NationId | null;
  nations: Record<NationId, NationView>;
  defs: Record<string, ProvinceDef>;
  /** Temps de jeu (vieillissement du renseignement). */
  t?: GameTime;
}

/** Au-delà de cet âge (temps de jeu), une information de renseignement est estompée. */
export const INTEL_STALE_MS = 24 * 3600_000;

function buildingState(p: ProvinceView, type: string, t: GameTime) {
  const s = p.buildingState?.find((b) => b.type === type);
  const level = s?.level ?? 1;
  let st: BuildingState = 'ok';
  if (s) {
    if (s.health <= 0.02) st = 'down';
    else if (s.repairUntil && s.repairUntil > t) st = 'rep';
    else if (s.upgradeUntil && s.upgradeUntil > t) st = 'up';
    else if (s.health < 0.95) st = 'dmg';
  }
  return { st, level };
}

/**
 * Bâtiments génériques : petites tuiles alignées sous le marqueur de ville (zoom proche), sur deux
 * rangées au-delà de six. Pour une province étrangère, seuls les bâtiments révélés par le
 * renseignement figurent dans la vue ; une connaissance ancienne est estompée (`op`).
 */
export function buildingFeatures(
  provinces: Iterable<ProvinceView>,
  ctx: BuildingCtx,
): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  const gap = BLD_SIZE + 3;
  const t = ctx.t ?? 0;
  for (const p of provinces) {
    if (!p.buildings.length) continue;
    const def = ctx.defs[p.id];
    if (!def) continue;
    const n = p.buildings.length;
    const perRow = n > 6 ? Math.ceil(n / 2) : n;
    const rel = relationOf(p.owner, ctx.me, ctx.nations);
    const old = p.intel && t - p.intel.updatedAt > INTEL_STALE_MS ? 1 : 0;
    p.buildings.forEach((b, i) => {
      const { st, level } = buildingState(p, b, t);
      const row = Math.floor(i / perRow);
      const inRow = row === 0 ? Math.min(perRow, n) : n - perRow;
      const col = i - row * perRow;
      out.push({
        type: 'Feature',
        properties: {
          id: `${p.id}:${b}`,
          prov: p.id,
          type: b,
          mine: p.owner === ctx.me ? 1 : 0,
          img: `bld|${b}|${rel}|${st}|${level}`,
          st,
          op: old ? 0.5 : 1,
          // Rangées centrées sous la ville (px CSS).
          off: [(col - (inRow - 1) / 2) * gap, 19 + row * gap],
          roff: [((col - (inRow - 1) / 2) * gap) / 0.62, (19 + row * gap) / 0.62],
        },
        geometry: { type: 'Point', coordinates: def.cityPoint },
      });
    });
  }
  return fc(out);
}

/**
 * Classe de ville (0 capitale, 1 grande, 2 moyenne, 3 petite) : `cityRank` des données de carte
 * (1 à 4) ; à défaut, capitale ou quantiles de revenu.
 */
export function cityClass(d: ProvinceDef, thresholds: [number, number]): number {
  if (d.cityRank) return d.cityRank - 1;
  if (d.isCapital) return 0;
  return d.income.money >= thresholds[0] ? 1 : d.income.money >= thresholds[1] ? 2 : 3;
}

/** Seuils de classe de ville (revenu) calculés une fois pour le monde (repli sans `cityRank`). */
export function cityClassThresholds(defs: Iterable<ProvinceDef>): [number, number] {
  const incomes = [...defs].map((d) => d.income.money).sort((a, b) => b - a);
  if (!incomes.length) return [Infinity, Infinity];
  return [
    incomes[Math.floor(incomes.length * 0.12)] ?? Infinity,
    incomes[Math.floor(incomes.length * 0.45)] ?? Infinity,
  ];
}

/** Villes des provinces : marqueur proportionné (capitale distinguée) et nom. */
export function cityFeatures(
  defs: Record<string, ProvinceDef>,
  provinces: Record<string, ProvinceView> | null,
  ctx: { me: NationId | null; nations: Record<NationId, NationView>; thresholds: [number, number] },
): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  for (const d of Object.values(defs)) {
    const owner = provinces?.[d.id]?.owner ?? d.nationId;
    const cls = cityClass(d, ctx.thresholds);
    const rel = provinces ? relationOf(owner, ctx.me, ctx.nations) : 'none';
    const pop = d.population ?? 0;
    out.push({
      type: 'Feature',
      properties: {
        id: d.id,
        name: d.cityName ?? d.name,
        cls,
        img: `city|${cls}|${rel}`,
        mine: owner === ctx.me ? 1 : 0,
        // Rang de collision : capitales et grandes villes d'abord, puis la population.
        rank: cls * 100 - Math.min(99, Math.log10(1 + pop) * 10),
      },
      geometry: { type: 'Point', coordinates: d.cityPoint },
    });
  }
  return fc(out);
}

/** Pastilles du calque « Renseignement » : niveau de connaissance des provinces étrangères. */
export function intelFeatures(
  provinces: Iterable<ProvinceView>,
  defs: Record<string, ProvinceDef>,
  t: GameTime,
): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  for (const p of provinces) {
    if (!p.intel) continue;
    const def = defs[p.id];
    if (!def) continue;
    out.push({
      type: 'Feature',
      properties: {
        id: p.id,
        img: `intel|${p.intel.level}`,
        lvl: p.intel.level,
        op: t - p.intel.updatedAt > INTEL_STALE_MS ? 0.55 : 1,
      },
      geometry: { type: 'Point', coordinates: def.centroid },
    });
  }
  return fc(out);
}

/** Marqueurs de province : fortification, blocus, capture (à côté de la ville). */
export function provinceMarkerFeatures(
  provinces: Iterable<ProvinceView>,
  defs: Record<string, ProvinceDef>,
  fortifications?: { provinceId: string; level: number }[],
): FeatureCollection<Point> {
  const out: Feature<Point>[] = [];
  const forts = new Map<string, number>();
  for (const f of fortifications ?? []) forts.set(f.provinceId, f.level);
  for (const p of provinces) {
    const def = defs[p.id];
    if (!def) continue;
    const level = p.fortification?.level ?? forts.get(p.id) ?? 0;
    if (level > 0)
      out.push({
        type: 'Feature',
        properties: { id: `${p.id}:fort`, kind: 'fort', img: `fort|${Math.round(level)}` },
        geometry: { type: 'Point', coordinates: def.cityPoint },
      });
    if (p.blockaded)
      out.push({
        type: 'Feature',
        properties: { id: `${p.id}:blk`, kind: 'blockade' },
        geometry: { type: 'Point', coordinates: def.cityPoint },
      });
  }
  return fc(out);
}

/** Fauchées de passage des satellites du joueur. */
export function satelliteFeatures(
  passes: SatellitePassView[] | undefined,
  t: GameTime,
): FeatureCollection<Polygon> {
  const out: Feature<Polygon>[] = [];
  for (const s of passes ?? []) {
    if (s.footprint.length < 3) continue;
    const ring = [...s.footprint];
    const a = ring[0]!;
    const b = ring[ring.length - 1]!;
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
    out.push({
      type: 'Feature',
      properties: { id: s.unitId, soon: s.nextPassAt - t < 3600_000 ? 1 : 0, next: s.nextPassAt },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  return fc(out);
}

/** Points d'étiquette des nations : centre pondéré de leurs provinces, recalé sur la province la plus proche. */
export function nationLabelFeatures(
  defs: Iterable<ProvinceDef>,
  names: Record<NationId, string>,
): FeatureCollection<Point> {
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
    out.push({
      type: 'Feature',
      properties: { id, name, rank, minzoom },
      geometry: { type: 'Point', coordinates: pt },
    });
  }
  return fc(out);
}

/**
 * Couverture des radars (catégorie `radar`, ou capteur radar / alerte avancée) : anneaux de portée.
 * Forces du joueur (calque militaire) et radars étrangers identifiés (calque renseignement).
 */
export function radarFeatures(
  units: Iterable<UnitView>,
  ctx: { me: NationId | null; catalog: Record<SystemId, WeaponSystem>; t: GameTime },
): FeatureCollection<LineString> {
  const out: Feature<LineString>[] = [];
  for (const u of units) {
    if (u.status === 'destroyed' || u.level === 'detected' || !u.systemId) continue;
    const sys = ctx.catalog[u.systemId];
    if (!sys || !isRadarSystem(sys)) continue;
    const r = sys.sensor?.rangeKm ?? sys.detectionRangeKm;
    if (!r || r < 50) continue;
    out.push({
      type: 'Feature',
      properties: { id: u.id, own: u.owner === ctx.me ? 1 : 0, km: Math.round(r) },
      geometry: {
        type: 'LineString',
        coordinates: geodesicCircle(unitPosition(u, ctx.t), r, r > 1500 ? 160 : 96),
      },
    });
  }
  return fc(out);
}

export function isRadarSystem(sys: WeaponSystem): boolean {
  const kind = sys.sensor?.kind;
  return (
    (sys.category as string) === 'radar' ||
    kind === 'radar' ||
    kind === 'early_warning' ||
    kind === 'aew'
  );
}
