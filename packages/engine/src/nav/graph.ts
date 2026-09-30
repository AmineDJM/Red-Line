import { cellToLatLng, gridDisk, latLngToCell, getHexagonEdgeLengthAvg } from 'h3-js';
import type { LngLat, ProvinceId } from '@redline/shared';

/**
 * Graphe de navigation sur la grille H3 de la carte. Les cellules terrestres viennent de `map.cells`
 * (précalculées à la construction du monde) ; toute autre cellule est de la mer et n'est créée qu'à
 * la demande (le cache ne change jamais le résultat d'une recherche : ordre et départage intrinsèques).
 */
export class NavGraph {
  readonly res: number;
  readonly edgeKm: number;
  readonly cellProv: ReadonlyMap<string, ProvinceId>;
  readonly strait: ReadonlySet<string>;

  private readonly ids = new Map<string, number>();
  readonly cells: string[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly z: number[] = [];
  /** 1 = cellule terrestre. */
  readonly land: number[] = [];
  /** 1 = navigable pour un navire (mer ou détroit). */
  readonly ship: number[] = [];
  /** Clé de départage intrinsèque (bits de l'index H3). */
  readonly keyHi: number[] = [];
  readonly keyLo: number[] = [];
  private readonly nbr: (Int32Array | undefined)[] = [];
  /** Composantes connexes navales (étiquetées à la demande, -1 = inconnue). */
  private readonly shipComp: number[] = [];
  private nextComp = 0;

  constructor(res: number, cellProv: Map<string, ProvinceId>, strait: Set<string>) {
    this.res = res;
    this.edgeKm = getHexagonEdgeLengthAvg(res, 'km');
    this.cellProv = cellProv;
    this.strait = strait;
    const landCells = [...cellProv.keys()].sort();
    for (const c of landCells) this.node(c);
    for (let i = 0; i < landCells.length; i++) this.neighbors(i);
  }

  get size(): number {
    return this.cells.length;
  }

  cellAt(p: LngLat): string {
    return latLngToCell(p[1], p[0], this.res);
  }

  isLandCell(cell: string): boolean {
    return this.cellProv.has(cell);
  }

  isShipCell(cell: string): boolean {
    return !this.cellProv.has(cell) || this.strait.has(cell);
  }

  node(cell: string): number {
    const found = this.ids.get(cell);
    if (found !== undefined) return found;
    const id = this.cells.length;
    this.ids.set(cell, id);
    this.cells.push(cell);
    const [lat, lng] = cellToLatLng(cell);
    const la = (lat * Math.PI) / 180;
    const lo = (lng * Math.PI) / 180;
    const c = Math.cos(la);
    this.x.push(c * Math.cos(lo));
    this.y.push(c * Math.sin(lo));
    this.z.push(Math.sin(la));
    const isLand = this.cellProv.has(cell);
    this.land.push(isLand ? 1 : 0);
    this.ship.push(!isLand || this.strait.has(cell) ? 1 : 0);
    this.keyHi.push(parseInt(cell.slice(0, 7), 16));
    this.keyLo.push(parseInt(cell.slice(7), 16));
    this.shipComp.push(-1);
    return id;
  }

  center(id: number): LngLat {
    return [
      (Math.atan2(this.y[id]!, this.x[id]!) * 180) / Math.PI,
      (Math.asin(Math.max(-1, Math.min(1, this.z[id]!))) * 180) / Math.PI,
    ];
  }

  neighbors(id: number): Int32Array {
    const cached = this.nbr[id];
    if (cached) return cached;
    const cell = this.cells[id]!;
    const ring = gridDisk(cell, 1).filter((c) => c !== cell);
    const arr = new Int32Array(ring.length);
    for (let i = 0; i < ring.length; i++) arr[i] = this.node(ring[i]!);
    this.nbr[id] = arr;
    return arr;
  }

  /** Angle central (rad) entre deux nœuds. */
  angle(a: number, b: number): number {
    const d = this.x[a]! * this.x[b]! + this.y[a]! * this.y[b]! + this.z[a]! * this.z[b]!;
    return Math.acos(Math.max(-1, Math.min(1, d)));
  }

  /** Vrai si a précède b dans l'ordre intrinsèque des cellules. */
  keyLess(a: number, b: number): boolean {
    const ha = this.keyHi[a]!;
    const hb = this.keyHi[b]!;
    if (ha !== hb) return ha < hb;
    return this.keyLo[a]! < this.keyLo[b]!;
  }

  /**
   * Deux cellules navigables sont-elles reliées par la mer ? Parcours en largeur simultané depuis les
   * deux côtés : le plus petit bassin est épuisé vite et étiqueté ; au-delà d'un budget, on considère
   * les deux grands bassins comme reliés (l'A* tranchera).
   */
  shipConnected(a: number, b: number, budget = 20000): boolean {
    if (a === b) return true;
    const ca = this.shipComp[a]!;
    const cb = this.shipComp[b]!;
    if (ca >= 0 || cb >= 0) return ca === cb;
    const seenA = new Set<number>([a]);
    const seenB = new Set<number>([b]);
    const qa = [a];
    const qb = [b];
    let ia = 0;
    let ib = 0;
    while (seenA.size + seenB.size < budget * 2) {
      if (ia >= qa.length) {
        this.label(seenA);
        return false;
      }
      if (ib >= qb.length) {
        this.label(seenB);
        return false;
      }
      const u = qa[ia++]!;
      for (const v of this.neighbors(u)) {
        if (!this.ship[v] || seenA.has(v)) continue;
        if (seenB.has(v)) return true;
        seenA.add(v);
        qa.push(v);
      }
      const w = qb[ib++]!;
      for (const v of this.neighbors(w)) {
        if (!this.ship[v] || seenB.has(v)) continue;
        if (seenA.has(v)) return true;
        seenB.add(v);
        qb.push(v);
      }
    }
    return true;
  }

  private label(set: Set<number>): void {
    const c = this.nextComp++;
    for (const n of set) this.shipComp[n] = c;
  }
}
