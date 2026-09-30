import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { mil } from '../src/modules/mil/state.js';
import { atWar, sightLevel } from '../src/state/access.js';
import { captureSignals, milSandbox } from './mil-fixtures.js';

describe('marine : sous-marins, sonar, blocus', () => {
  it('sous-marin en plongée invisible sans sonar ; vu par une frégate ASM', () => {
    const s = milSandbox([
      { owner: 'bbb', systemId: 'tst.sub', pos: [8, 44] }, // u1
      { owner: 'aaa', systemId: 'tst.frigate', pos: [8.1, 44] }, // u2 : ≈ 8 km, sans sonar
      { owner: 'aaa', systemId: 'tst.radar', pos: [8, 44.3] }, // u3 : radar à 33 km
    ]);
    advanceTo(s, HOUR);
    expect(sightLevel(s, 'aaa', 'u1')).toBe(0);
    expect(s.know.aaa?.u1).toBeUndefined();
    expect(viewFor(s, 'aaa').units.u1).toBeUndefined();
    // Le sous-marin, lui, voit la frégate.
    expect(sightLevel(s, 'bbb', 'u2')).toBeGreaterThan(0);

    const t = milSandbox([
      { owner: 'bbb', systemId: 'tst.sub', pos: [8, 44] }, // u1
      { owner: 'aaa', systemId: 'tst.aswfrigate', pos: [8.5, 44] }, // u2 : ≈ 40 km, sonar
    ]);
    advanceTo(t, HOUR);
    expect(sightLevel(t, 'aaa', 'u1')).toBeGreaterThan(0);
  });

  it('un sous-marin qui tire se découvre, puis replonge', () => {
    const s = milSandbox([
      { owner: 'bbb', systemId: 'tst.sub', pos: [8, 44] }, // u1
      { owner: 'aaa', systemId: 'tst.radar', pos: [8, 44.3] }, // u2
    ]);
    advanceTo(s, MINUTE);
    expect(sightLevel(s, 'aaa', 'u1')).toBe(0);
    const r = applyOrder(s, 'bbb', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'building', provinceId: 'aaa-2', building: 'air_base' },
    });
    expect(r.ok).toBe(true);
    expect(sightLevel(s, 'aaa', 'u1')).toBeGreaterThan(0);
    advanceTo(s, s.time + 31 * MINUTE);
    expect(sightLevel(s, 'aaa', 'u1')).toBe(0);
    expect(mil(s).exposed.u1).toBeUndefined();
  });

  it('blocus d’un port : effectif à l’arrivée, vue, signal ; levé quand les navires partent', () => {
    captureSignals((signals) => {
      const s = milSandbox([{ owner: 'aaa', systemId: 'tst.destroyer', pos: [7.5, 43.5] }]);
      const r = applyOrder(s, 'aaa', {
        kind: 'blockade',
        unitIds: ['u1'],
        target: { provinceId: 'bbb-4' },
      });
      expect(r.ok).toBe(true);
      expect(atWar(s, 'aaa', 'bbb')).toBe(true);
      expect(viewFor(s, 'aaa').blockades).toEqual([]);
      advanceTo(s, 5 * DAY);
      const v = viewFor(s, 'bbb');
      expect(v.blockades).toHaveLength(1);
      expect(v.blockades![0]).toMatchObject({ by: 'aaa', target: { provinceId: 'bbb-4' } });
      expect(v.provinces['bbb-4']!.blockaded).toBe(true);
      expect(viewFor(s, 'aaa').units.u1!.mission?.kind).toBe('blockade');
      const on = signals.find((x) => x.name === 'blockade' && x.data.on === true);
      expect(on?.data).toMatchObject({ by: 'aaa', pid: 'bbb-4' });
      // Départ : blocus levé.
      expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [7.5, 45.5] }).ok).toBe(
        true,
      );
      expect(signals.some((x) => x.name === 'blockade' && x.data.on === false)).toBe(true);
      expect(viewFor(s, 'bbb').blockades).toEqual([]);
      expect(viewFor(s, 'bbb').provinces['bbb-4']!.blockaded).toBeUndefined();
    });
  });
});
