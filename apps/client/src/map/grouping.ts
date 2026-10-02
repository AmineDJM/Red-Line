/**
 * Regroupement des pions selon le zoom (LOD), calculé en coordonnées « pixel monde » Mercator :
 * deux pions d'une même nation qui se recouvriraient à l'écran forment une pile (un seul pion avec
 * le nombre de piles). À l'échelle du monde, le seuil est élargi (regroupement par région) ; de près,
 * seules les unités réellement superposées restent empilées. Les piles de nations différentes qui se
 * recouvrent (front, bataille) sont écartées côte à côte au lieu d'être fusionnées.
 *
 * Fonctions pures (aucune dépendance à MapLibre), testées dans test/map.grouping.test.ts.
 */
import type { LngLat } from '@redline/shared';

export interface GroupItem {
  id: string;
  pos: LngLat;
  /** Clé de fusion : seuls les éléments de même clé se regroupent (nation propriétaire). */
  key: string;
  /** Priorité du chef de pile (le plus prioritaire donne sa position et son pictogramme). */
  priority: number;
}

export interface Group<T extends GroupItem = GroupItem> {
  id: string;
  leader: T;
  members: T[];
  /** Décalage d'écartement (px CSS à l'échelle 1 du pion), [0, 0] sinon. */
  off: [number, number];
  /**
   * Piles écartées côte à côte (nations différentes au même endroit : front, bataille) : identifiant
   * commun du groupe d'écartement (menu de pile « à proximité »), absent sinon.
   */
  cluster?: string;
}

export const TILE = 512;

export function worldPx(p: LngLat, zoom: number): [number, number] {
  const scale = TILE * Math.pow(2, zoom);
  const lat = Math.max(-85.05, Math.min(85.05, p[1]));
  const s = Math.sin((lat * Math.PI) / 180);
  const x = ((p[0] + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Échelle d'affichage du pion selon le zoom (même courbe que `icon-size` dans le style). */
export const PION_SCALE_STOPS: [number, number][] = [
  [1.5, 0.68],
  [3.5, 0.8],
  [6, 0.98],
  [9, 1.12],
];

export function pionScale(zoom: number): number {
  const s = PION_SCALE_STOPS;
  if (zoom <= s[0]![0]) return s[0]![1];
  for (let i = 1; i < s.length; i++) {
    const [z1, v1] = s[i]!;
    const [z0, v0] = s[i - 1]!;
    if (zoom <= z1) return v0 + ((v1 - v0) * (zoom - z0)) / (z1 - z0);
  }
  return s[s.length - 1]![1];
}

export interface GroupOptions {
  zoom: number;
  /** Taille du pion à l'échelle 1 (px CSS). */
  w: number;
  h: number;
  /**
   * Hystérésis : pile d'appartenance précédente de chaque élément (identifiant de pile). Un élément
   * reste dans sa pile tant qu'il est à moins de 1,3 seuil de son chef : les piles ne « sautent »
   * pas quand une unité oscille autour du seuil (déplacements, zoom).
   */
  prev?: ReadonlyMap<string, string>;
}

/** Marge de l'hystérésis de regroupement (multiplicateur du seuil). */
export const STICKY = 1.3;

/** Multiplicateur du seuil de regroupement selon le zoom : monde → région → ville. */
export function lodFactor(zoom: number): number {
  if (zoom < 2.6) return 2.2;
  if (zoom < 4) return 1.5;
  if (zoom < 5.5) return 1.15;
  return 1;
}

export function groupItems<T extends GroupItem>(items: T[], o: GroupOptions): Group<T>[] {
  const s = pionScale(o.zoom);
  const f = lodFactor(o.zoom);
  const tx = o.w * s * 0.92 * f;
  const ty = o.h * s * 1.25 * f;
  const sorted = [...items].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const grid = new Map<string, { g: Group<T>; x: number; y: number }[]>();
  const groups: Group<T>[] = [];
  const cellOf = (x: number, y: number) => [Math.floor(x / tx), Math.floor(y / ty)] as const;
  for (const it of sorted) {
    const [x, y] = worldPx(it.pos, o.zoom);
    const sticky = o.prev?.get(it.id);
    const [cx, cy] = cellOf(x, y);
    let found: Group<T> | null = null;
    let best = Infinity;
    const span = sticky ? 2 : 1;
    for (let i = -span; i <= span && (!found || !!sticky); i++) {
      for (let j = -span; j <= span; j++) {
        const list = grid.get(`${it.key}|${cx + i}|${cy + j}`);
        if (!list) continue;
        for (const c of list) {
          const dx = Math.abs(c.x - x);
          const dy = Math.abs(c.y - y);
          const k = sticky && c.g.id === sticky ? STICKY : 1;
          if (dx < tx * k && dy < ty * k) {
            // La pile précédente l'emporte à distance comparable (stabilité).
            const d = (dx / tx + dy / ty) / (k > 1 ? 2 : 1);
            if (d < best) {
              best = d;
              found = c.g;
            }
          }
        }
      }
    }
    if (found) {
      found.members.push(it);
      continue;
    }
    const g: Group<T> = {
      id: it.id,
      leader: it,
      members: [it],
      off: [0, 0],
    };
    groups.push(g);
    const k = `${it.key}|${cx}|${cy}`;
    const list = grid.get(k) ?? [];
    list.push({ g, x, y });
    grid.set(k, list);
  }
  spreadOverlapping(groups, o, s);
  return groups;
}

/**
 * Écarte les piles de nations différentes qui se recouvrent : elles sont disposées en rangée
 * centrée sur leur barycentre (décalage d'icône, sans toucher aux positions réelles).
 */
function spreadOverlapping<T extends GroupItem>(groups: Group<T>[], o: GroupOptions, s: number) {
  if (groups.length < 2) return;
  const tx = o.w * s * 0.95;
  const ty = o.h * s * 1.15;
  const pts = groups.map((g) => worldPx(g.leader.pos, o.zoom));
  // Union-find sur les recouvrements (grille de hachage).
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const grid = new Map<string, number[]>();
  pts.forEach(([x, y], i) => {
    const cx = Math.floor(x / tx);
    const cy = Math.floor(y / ty);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const j of grid.get(`${cx + a}|${cy + b}`) ?? []) {
          const [x2, y2] = pts[j]!;
          if (Math.abs(x2 - x) < tx && Math.abs(y2 - y) < ty) parent[find(i)] = find(j);
        }
    const k = `${cx}|${cy}`;
    const l = grid.get(k) ?? [];
    l.push(i);
    grid.set(k, l);
  });
  const clusters = new Map<number, number[]>();
  groups.forEach((_, i) => {
    const r = find(i);
    const l = clusters.get(r) ?? [];
    l.push(i);
    clusters.set(r, l);
  });
  for (const idx of clusters.values()) {
    if (idx.length < 2) continue;
    // Ordre stable : les forces du joueur (priorité la plus haute) à gauche.
    idx.sort(
      (a, b) =>
        groups[b]!.leader.priority - groups[a]!.leader.priority ||
        (groups[a]!.id < groups[b]!.id ? -1 : 1),
    );
    let mx = 0;
    let my = 0;
    for (const i of idx) {
      mx += pts[i]![0];
      my += pts[i]![1];
    }
    mx /= idx.length;
    my /= idx.length;
    const cid = groups[idx[0]!]!.id;
    for (const i of idx) groups[i]!.cluster = cid;
    const cols = Math.min(3, idx.length);
    const rows = Math.ceil(idx.length / cols);
    const gx = o.w + 8;
    const gy = o.h + 9;
    idx.forEach((i, k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const inRow = row === rows - 1 ? idx.length - row * cols : cols;
      const tx0 = (col - (inRow - 1) / 2) * gx;
      // Plusieurs rangées : la première au niveau du point, les suivantes en dessous (le nom de la
      // ville, au-dessus du point, reste lisible).
      const ty0 = rows > 1 ? row * gy : 0;
      // Position cible écran (centre commun + grille) exprimée en décalage depuis la vraie position.
      const [px, py] = pts[i]!;
      groups[i]!.off = [(mx - px) / s + tx0, (my - py) / s + ty0];
    });
  }
}
