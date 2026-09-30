import { describe, expect, it } from 'vitest';
import { gridDisk, latLngToCell } from 'h3-js';
import { NavGraph } from '../src/nav/graph.js';

describe('cellules infranchissables', () => {
  it('ne sont ni de la terre ni de la mer (Antarctique, zones tampons)', () => {
    const land = latLngToCell(10, 10, 4);
    const ice = latLngToCell(-80, 0, 4);
    const g = new NavGraph(4, new Map([[land, 'aaa-1']]), new Set(), new Set([ice]));
    expect(g.isLandCell(land)).toBe(true);
    expect(g.isShipCell(ice)).toBe(false);
    expect(g.isSeaCell(ice)).toBe(false);
    const open = gridDisk(latLngToCell(0, -30, 4), 1)[0]!;
    expect(g.isShipCell(open)).toBe(true);
    const id = g.node(ice);
    expect(g.ship[id]).toBe(0);
    expect(g.land[id]).toBe(0);
    expect(g.blocked[id]).toBe(1);
  });

  it('un détroit reste navigable même marqué infranchissable', () => {
    const c = latLngToCell(41.1, 29.05, 4);
    const g = new NavGraph(4, new Map(), new Set([c]), new Set([c]));
    expect(g.isShipCell(c)).toBe(true);
  });
});
