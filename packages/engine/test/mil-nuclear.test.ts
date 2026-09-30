import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, notificationsFor, viewFor } from '../src/index.js';
import { board } from '../src/modules/kit.js';
import { signal } from '../src/modules/registry.js';
import { atWar } from '../src/state/access.js';
import { cityOf } from './fixtures.js';
import { captureSignals, milSandbox, notesOf } from './mil-fixtures.js';

describe('nucléaire et niveau d’alerte mondial', () => {
  it('nucléaire interdit sans autorisation ; autorisation et frappe selon le niveau d’alerte', () => {
    captureSignals((signals) => {
      const s = milSandbox([
        { owner: 'aaa', systemId: 'tst.icbm', pos: cityOf('aaa-2') }, // u1
        { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-5') }, // u2 : au point d'impact
        { owner: 'bbb', systemId: 'tst.infantry', pos: [12.5, 40.5] }, // u3 : ≈ 55 km, dans l'anneau
        { owner: 'ccc', systemId: 'tst.infantry', pos: cityOf('ccc-1') }, // u4 : loin
      ]);
      const strike = () =>
        applyOrder(s, 'aaa', {
          kind: 'strike',
          unitIds: ['u1'],
          target: { type: 'point', at: cityOf('bbb-5') },
        });
      expect(board(s).alertLevel).toBe(5);
      let r = strike();
      expect(r.error).toBe('locked');
      expect(applyOrder(s, 'aaa', { kind: 'nuclearAuth', on: true }).error).toBe('locked');
      // Crise : la tension monte (signal `alert` d'autres modules).
      signal(s, 'alert', { amount: 50, reason: 'test' });
      expect(board(s).alertLevel).toBe(3);
      expect(applyOrder(s, 'aaa', { kind: 'nuclearAuth', on: true }).ok).toBe(true);
      expect(board(s).nuclearAuth.aaa).toBe(true);
      r = strike();
      expect(r.error).toBe('locked'); // niveau 3 : autorisé mais pas encore permis
      signal(s, 'alert', { amount: 10, reason: 'test' });
      expect(board(s).alertLevel).toBe(2);
      r = strike();
      expect(r.ok).toBe(true);
      expect(atWar(s, 'aaa', 'bbb')).toBe(true);
      const notes = advanceTo(s, s.time + 30 * MINUTE);
      expect(s.units.u2).toBeUndefined();
      expect(s.units.u3).toBeDefined();
      expect(s.units.u3!.hp).toBeLessThan(s.units.u3!.maxHp);
      expect(s.units.u4).toBeDefined();
      expect(board(s).alertLevel).toBe(1);
      const det = signals.find((x) => x.name === 'nuclear_detonation');
      expect(det?.data).toMatchObject({ by: 'aaa', victim: 'bbb', pid: 'bbb-5' });
      expect(signals.some((x) => x.name === 'strike' && x.data.nuclear === true)).toBe(true);
      expect(signals.some((x) => x.name === 'news')).toBe(true);
      expect(signals.some((x) => x.name === 'stability' && x.data.nation === 'bbb')).toBe(true);
      // Bâtiments de la province détruits (eco, sur nuclear_detonation).
      expect(notesOf(notes, 'building_hit').some((n) => n.provinceId === 'bbb-5' && n.health === 0)).toBe(true);
      const g = notesOf(notes, 'generic').find((n) => n.category === 'nuclear');
      expect(g).toBeDefined();
      expect(notificationsFor(s, 'ddd', notes).some((n) => n.kind === 'generic' && n.category === 'nuclear')).toBe(
        true,
      );
      expect(notificationsFor(s, 'ddd', notes).some((n) => n.kind === 'alert_level' && n.level === 1)).toBe(true);
    });
  });

  it("niveau d'alerte : guerre et signaux, décroissance quotidienne, notification à tous", () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] }]);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [5.3, 40] });
    advanceTo(s, HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(board(s).tension).toBeCloseTo(6, 9);
    expect(board(s).alertLevel).toBe(5);
    signal(s, 'alert', { amount: 20, reason: 'test' });
    expect(board(s).alertLevel).toBe(4);
    let notes = advanceTo(s, s.time + MINUTE);
    const lvl = notesOf(notes, 'alert_level');
    expect(lvl.map((n) => n.level)).toEqual([4]);
    expect(notificationsFor(s, 'ccc', notes).some((n) => n.kind === 'alert_level')).toBe(true);
    expect(viewFor(s, 'ddd').alertLevel).toBe(4);
    // Décroissance : 5 par jour (26 → 21 → 16 : retour au calme).
    advanceTo(s, DAY + MINUTE);
    expect(board(s).tension).toBeCloseTo(21, 9);
    expect(board(s).alertLevel).toBe(4);
    notes = advanceTo(s, 2 * DAY + MINUTE);
    expect(board(s).alertLevel).toBe(5);
    expect(notesOf(notes, 'alert_level').map((n) => n.level)).toEqual([5]);
  });

  it('arme antisatellite : seulement à un niveau d’alerte ≤ 3', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.asat', pos: cityOf('aaa-2'), count: 10 }, // u1
      { owner: 'bbb', systemId: 'tst.optsat', pos: cityOf('bbb-2') }, // u2
    ]);
    const shoot = () =>
      applyOrder(s, 'aaa', { kind: 'strike', unitIds: ['u1'], target: { type: 'unit', unitId: 'u2' } });
    expect(shoot().error).toBe('locked');
    signal(s, 'alert', { amount: 50, reason: 'test' });
    let tries = 0;
    while (s.units.u2 && tries++ < 10) expect(shoot().ok).toBe(true);
    expect(s.units.u2).toBeUndefined();
  });
});
