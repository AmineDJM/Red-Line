import { describe, expect, it } from 'vitest';
import { distanceKm, interpolate, movementEnd, type LngLat } from '@redline/shared';
import { latLngToCell } from 'h3-js';
import { advanceTo, applyOrder, buildWorld } from '../src/index.js';
import { BALANCE, CATALOG, RES, buildMap, cityOf, sandbox, testWorld } from './fixtures.js';

function samples(legs: { from: LngLat; to: LngLat; medium: string }[], stepKm = 5) {
  const out: { p: LngLat; medium: string }[] = [];
  for (const l of legs) {
    const n = Math.max(1, Math.ceil(distanceKm(l.from, l.to) / stepKm));
    for (let i = 0; i <= n; i++) out.push({ p: interpolate(l.from, l.to, i / n), medium: l.medium });
  }
  return out;
}

describe('navigation', () => {
  it('terre : chemin terrestre lissé en peu de segments', () => {
    const s = sandbox([{ owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }]);
    const r = applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-3') });
    expect(r).toEqual({ ok: true });
    const legs = s.units.u1!.move!.legs;
    expect(legs.every((l) => l.medium === 'land')).toBe(true);
    expect(legs.length).toBeLessThanOrEqual(4);
    const cells = s.world.map.cells.cells;
    const bad = samples(legs).filter(({ p }) => !cells[latLngToCell(p[1], p[0], RES)]);
    expect(bad.length).toBe(0);
    // Durée cohérente avec la vitesse (30 km/h) et la distance (~890 km).
    const hours = (movementEnd(s.units.u1!.move!) - 0) / 3_600_000;
    expect(hours).toBeGreaterThan(885 / 30);
    expect(hours).toBeLessThan(1000 / 30);
    advanceTo(s, movementEnd(s.units.u1!.move!) + 1);
    expect(s.units.u1!.move).toBeNull();
    expect(distanceKm(s.units.u1!.pos, cityOf('aaa-3'))).toBeLessThan(0.01);
  });

  it('embarquement automatique vers une île', () => {
    const s = sandbox([{ owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-2') }]);
    const r = applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u1'], to: cityOf('ddd-1') });
    expect(r.ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    const media = legs.map((l) => l.medium);
    expect(media).toContain('sea');
    expect(media[0]).toBe('land');
    expect(media[media.length - 1]).toBe('land');
    // Attentes d'embarquement et de débarquement (segments immobiles de embarkMinutes).
    const waits = legs.filter((l) => l.from[0] === l.to[0] && l.from[1] === l.to[1]);
    expect(waits.length).toBe(2);
    for (const w of waits) expect(w.t1 - w.t0).toBe(BALANCE.movement.embarkMinutes * 60_000);
    // Vitesse réduite en mer.
    const sea = legs.find((l) => l.medium === 'sea' && l.t1 > l.t0 && distanceKm(l.from, l.to) > 1)!;
    const v = distanceKm(sea.from, sea.to) / ((sea.t1 - sea.t0) / 3_600_000);
    expect(v).toBeCloseTo(30 * BALANCE.movement.embarkedSpeedFactor, 5);
    // Les segments maritimes restent en mer (hors cellules d'extrémité).
    const cells = s.world.map.cells.cells;
    for (const l of legs.filter((x) => x.medium === 'sea' && distanceKm(x.from, x.to) > 1)) {
      const endA = latLngToCell(l.from[1], l.from[0], RES);
      const endB = latLngToCell(l.to[1], l.to[0], RES);
      for (const { p } of samples([l], 3)) {
        const c = latLngToCell(p[1], p[0], RES);
        if (c !== endA && c !== endB) expect(cells[c]).toBeUndefined();
      }
    }
    const view = () => (s.units.u1!.move ? s.units.u1 : null);
    const seaLeg = legs.find((l) => l.medium === 'sea' && distanceKm(l.from, l.to) > 1)!;
    advanceTo(s, (seaLeg.t0 + seaLeg.t1) / 2);
    expect(view()).not.toBeNull();
    advanceTo(s, movementEnd(s.units.u1!.move!) + 1);
    expect(distanceKm(s.units.u1!.pos, cityOf('ddd-1'))).toBeLessThan(0.01);
  });

  it('navire : passage par le détroit, sinon inaccessible', () => {
    const inner: LngLat = [10, 44];
    const ocean: LngLat = [22, 44];
    const s = sandbox([{ owner: 'bbb', systemId: 'tst.frigate', pos: inner }]);
    const r = applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u1'], to: ocean });
    expect(r.ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    const strait = new Set(s.world.map.straits[0]!.seaCells);
    const cells = s.world.map.cells.cells;
    let throughStrait = false;
    for (const { p } of samples(legs, 3)) {
      const c = latLngToCell(p[1], p[0], RES);
      if (strait.has(c)) throughStrait = true;
    }
    expect(throughStrait).toBe(true);
    expect(legs.every((l) => l.medium === 'sea')).toBe(true);
    void cells;

    const noStrait = buildWorld(buildMap({ strait: false }), CATALOG, BALANCE);
    const s2 = sandbox([{ owner: 'bbb', systemId: 'tst.frigate', pos: inner }], { world: noStrait });
    expect(applyOrder(s2, 'bbb', { kind: 'move', unitIds: ['u1'], to: ocean })).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
    // Dans l'autre sens aussi (le petit bassin est épuisé, pas l'océan).
    const s3 = sandbox([{ owner: 'bbb', systemId: 'tst.frigate', pos: ocean }], { world: noStrait });
    expect(applyOrder(s3, 'bbb', { kind: 'move', unitIds: ['u1'], to: inner })).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });

  it("'unreachable' : navire vers l'intérieur des terres, unité terrestre en pleine mer", () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.frigate', pos: [-2, 44] },
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      { owner: 'aaa', systemId: 'tst.radar', pos: cityOf('aaa-2') },
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [2.5, 44] })).toMatchObject({
      error: 'unreachable',
    });
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u2'], to: [-5, 30] })).toMatchObject({
      error: 'unreachable',
    });
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u3'], to: [2, 44] })).toMatchObject({
      error: 'not_allowed',
    });
    // Ordre atomique : rien n'a bougé.
    expect(s.units.u2!.move).toBeNull();
  });

  it("aérien : grand cercle direct limité au rayon d'action autour d'une ville possédée", () => {
    const s = sandbox([{ owner: 'aaa', systemId: 'tst.fighter', pos: cityOf('aaa-2') }]);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [14, 44] })).toMatchObject({
      ok: false,
      error: 'out_of_range',
    });
    const ok = applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [11, 44] });
    expect(ok.ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    expect(legs.length).toBe(1);
    expect(legs[0]!.medium).toBe('air');
  });

  it('chemin transcontinental rapide (carte de test)', () => {
    const w = testWorld();
    const s = sandbox([{ owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }], { world: w });
    const t0 = performance.now();
    const r = applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('bbb-3') });
    const dt = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(dt).toBeLessThan(200);
  });
});
