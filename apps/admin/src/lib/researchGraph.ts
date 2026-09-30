/** Mise en page de l'arbre de recherche (couloirs par branche, colonnes par rang) et analyse du graphe. */
import { RESEARCH_BRANCHES, type ResearchNode } from '@redline/shared';

export const NODE_W = 184;
export const NODE_H = 42;
export const COL_GAP = 46;
export const ROW_GAP = 10;
export const LANE_PAD = 14;
export const LABEL_W = 128;
export const TOP = 26;

export interface Placed {
  node: ResearchNode;
  x: number;
  y: number;
}
export interface Lane {
  branch: string;
  y: number;
  h: number;
}

export function layout(nodes: readonly ResearchNode[]) {
  const branches = [
    ...RESEARCH_BRANCHES.filter((b) => nodes.some((n) => n.branch === b)),
    ...[...new Set(nodes.map((n) => n.branch))].filter(
      (b) => !(RESEARCH_BRANCHES as readonly string[]).includes(b),
    ),
  ];
  const placed = new Map<string, Placed>();
  const lanes: Lane[] = [];
  let y = TOP;
  let maxTier = 0;
  for (const b of branches) {
    const inLane = nodes
      .filter((n) => n.branch === b)
      .sort((a, c) => a.tier - c.tier || a.id.localeCompare(c.id));
    const byTier = new Map<number, ResearchNode[]>();
    for (const n of inLane) {
      byTier.set(n.tier, [...(byTier.get(n.tier) ?? []), n]);
      maxTier = Math.max(maxTier, n.tier);
    }
    const rows = Math.max(1, ...[...byTier.values()].map((l) => l.length));
    const h = rows * (NODE_H + ROW_GAP) - ROW_GAP + LANE_PAD * 2;
    for (const [tier, list] of byTier)
      list.forEach((n, i) =>
        placed.set(n.id, {
          node: n,
          x: LABEL_W + tier * (NODE_W + COL_GAP),
          y: y + LANE_PAD + i * (NODE_H + ROW_GAP),
        }),
      );
    lanes.push({ branch: b, y, h });
    y += h + 8;
  }
  return {
    placed,
    lanes,
    width: LABEL_W + (maxTier + 1) * (NODE_W + COL_GAP) + 20,
    height: y + 10,
    maxTier,
  };
}

/** Ancêtres (prérequis transitifs) et descendants d'un nœud. */
export function relatives(nodes: readonly ResearchNode[], id: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes)
    for (const r of n.requires) children.set(r, [...(children.get(r) ?? []), n.id]);
  const walk = (start: string, next: (x: string) => string[]) => {
    const seen = new Set<string>();
    const stack = [...next(start)];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...next(x));
    }
    return seen;
  };
  return {
    ancestors: walk(id, (x) => byId.get(x)?.requires ?? []),
    descendants: walk(id, (x) => children.get(x) ?? []),
    children: children.get(id) ?? [],
  };
}

/** Cycle introduit par les prérequis d'un nœud (chemin), ou null. */
export function findCycle(nodes: readonly ResearchNode[], edited: ResearchNode): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  byId.set(edited.id, edited);
  const path: string[] = [];
  const onPath = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    onPath.add(id);
    path.push(id);
    for (const r of byId.get(id)?.requires ?? []) {
      const c = visit(r);
      if (c) return c;
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
    return null;
  };
  return visit(edited.id);
}

/** Courbe entre deux nœuds (sortie à droite, entrée à gauche). */
export function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  if (x2 <= x1) {
    // Prérequis au même rang ou après : boucle par le dessus.
    const top = Math.min(a.y, b.y) - 12;
    return `M${x1},${y1} C${x1 + 30},${top} ${x2 - 30},${top} ${x2},${y2}`;
  }
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
