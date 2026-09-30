import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { generalModifier } from '../src/modules/mil/generals.js';
import { mil } from '../src/modules/mil/state.js';
import { atWar } from '../src/state/access.js';
import { cityOf } from './fixtures.js';
import { milSandbox, notesOf } from './mil-fixtures.js';

describe('généraux', () => {
  it('2 à 4 généraux par nation active, traits, nomination et bonus', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') }, // u1
    ]);
    for (const n of ['aaa', 'bbb', 'ccc', 'ddd']) {
      const g = viewFor(s, n).generals!;
      expect(g.length).toBeGreaterThanOrEqual(2);
      expect(g.length).toBeLessThanOrEqual(4);
      for (const x of g) {
        expect(x.traits.length).toBeGreaterThanOrEqual(1);
        expect(x.name.startsWith('Gén.')).toBe(true);
      }
    }
    const g = viewFor(s, 'aaa').generals![0]!;
    expect(
      applyOrder(s, 'bbb', { kind: 'appointGeneral', generalId: g.id, unitIds: [] }).error,
    ).toBe('not_owner');
    expect(
      applyOrder(s, 'aaa', { kind: 'appointGeneral', generalId: g.id, unitIds: ['u1'] }).ok,
    ).toBe(true);
    expect(viewFor(s, 'aaa').units.u1!.generalId).toBe(g.id);
    // Un trait de défenseur protège une unité à l'arrêt ; un offensif renforce une unité qui attaque.
    const gs = mil(s).gens[g.id]!;
    gs.traits = ['defender'];
    expect(generalModifier(s, s.units.u1!, 'combat.armor')).toBeCloseTo(1.15, 9);
    expect(generalModifier(s, s.units.u1!, 'combat.damage')).toBe(1);
    gs.traits = ['offensive'];
    expect(generalModifier(s, s.units.u1!, 'combat.damage')).toBe(1);
  });

  it('général délégué qui défend : engage l’ennemi entré dans sa zone ; ordre direct = reprise en main', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [2.5, 44] }, // u1
      { owner: 'aaa', systemId: 'tst.tank', pos: [2.6, 44.1] }, // u2
      { owner: 'aaa', systemId: 'tst.radar', pos: [2.5, 43.5] }, // u3 : couverture
      { owner: 'bbb', systemId: 'tst.infantry', pos: [5.2, 41.9] }, // u4
    ]);
    const gid = viewFor(s, 'aaa').generals![0]!.id;
    expect(
      applyOrder(s, 'aaa', { kind: 'appointGeneral', generalId: gid, unitIds: ['u1', 'u2'] }).ok,
    ).toBe(true);
    expect(
      applyOrder(s, 'aaa', {
        kind: 'delegate',
        generalId: gid,
        directive: 'defend',
        area: [2.5, 44],
      }).ok,
    ).toBe(true);
    // L'infanterie ennemie entre en territoire aaa (guerre) et s'approche.
    expect(applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u4'], to: [3.8, 43.2] }).ok).toBe(true);
    advanceTo(s, 8 * HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    const engaged = ['u1', 'u2'].some((id) => s.units[id]?.target === 'u4') || !s.units.u4;
    expect(engaged).toBe(true);
    expect(viewFor(s, 'aaa').generals!.find((x) => x.id === gid)!.directive).toBe('defend');
    // Reprise en main : un ordre direct du joueur sur une unité du groupe efface la consigne.
    const notes = [] as ReturnType<typeof advanceTo>;
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [2.2, 44.2] }).ok).toBe(true);
    notes.push(...advanceTo(s, s.time + MINUTE));
    expect(viewFor(s, 'aaa').generals!.find((x) => x.id === gid)!.directive).toBeNull();
    expect(notesOf(notes, 'generic').some((n) => n.category === 'general')).toBe(true);
  });
});
