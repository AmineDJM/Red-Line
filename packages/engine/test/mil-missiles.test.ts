import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, battleReportFor, notificationsFor, viewFor } from '../src/index.js';
import { mil } from '../src/modules/mil/state.js';
import { atWar } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf } from './fixtures.js';
import { captureSignals, milSandbox, notesOf } from './mil-fixtures.js';

function salvo(patriots: number) {
  return captureSignals((signals) => {
    const units = [
      { owner: 'aaa', systemId: 'tst.cruise', pos: cityOf('aaa-1'), count: 10 }, // u1
    ];
    for (let i = 0; i < patriots; i++) {
      units.push({ owner: 'bbb', systemId: 'tst.patriot', pos: [7.3, 40 + i * 0.02] as [number, number], count: 1 });
    }
    const s = milSandbox(units);
    const r = applyOrder(s, 'aaa', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'building', provinceId: 'bbb-4', building: 'arms_factory' },
    });
    expect(r.ok).toBe(true);
    const missileId = Object.keys(s.units).find((id) => s.units[id]!.role === 'missile')!;
    const notes = advanceTo(s, 2 * HOUR);
    return { s, notes, signals, missileId };
  });
}

describe('missiles : frappe, interception, saturation', () => {
  it('missile de croisière sur un bâtiment, interception partielle par une défense saturée', () => {
    const { s, notes, signals, missileId } = salvo(1);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(notesOf(notes, 'missile_launch')).toHaveLength(1);
    expect(notificationsFor(s, 'aaa', notes).some((n) => n.kind === 'missile_launch')).toBe(true);
    expect(s.units[missileId]).toBeUndefined();
    const killed = mil(s).stats.bbb?.intercepted ?? 0;
    // Magasin de 4 et 2 canaux par fenêtre : interception partielle.
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(killed).toBeLessThanOrEqual(4);
    const hit = signals.find((x) => x.name === 'building_hit');
    expect(hit).toBeDefined();
    expect(hit!.data).toMatchObject({ pid: 'bbb-4', building: 'arms_factory', by: 'aaa' });
    expect(hit!.data.damage).toBeCloseTo(Math.min(1, ((10 - killed) * 40) / 150), 9);
    const bh = notesOf(notes, 'building_hit')[0]!;
    expect(bh.provinceId).toBe('bbb-4');
    expect(notificationsFor(s, 'bbb', notes).some((n) => n.kind === 'building_hit')).toBe(true);
    expect(signals.some((x) => x.name === 'strike' && x.data.kind === 'missile')).toBe(true);
    // Munitions consommées : la pile a disparu (sans être une perte).
    expect(s.units.u1).toBeUndefined();
    expect(notesOf(notes, 'unit_destroyed').some((n) => n.unitId === 'u1')).toBe(false);
    // Rapport de bataille : interceptions et saturation.
    const bid = Object.keys(mil(s).battles)[0]!;
    const report = battleReportFor(s, 'aaa', bid)!;
    const cm = Object.fromEntries(report.countermeasures.map((c) => [c.kind, c.count]));
    expect(cm.interception).toBe(killed);
    expect(cm.saturation ?? 0).toBeGreaterThan(0);
  });

  it('plus de batteries ⇒ plus d’interceptions (la saturation recule)', () => {
    const one = mil(salvo(1).s).stats.bbb?.intercepted ?? 0;
    const three = mil(salvo(3).s).stats.bbb?.intercepted ?? 0;
    expect(three).toBeGreaterThan(one);
  });

  it('missile en vol : impact prévu dans la vue ; tir balistique vu par un satellite d’alerte avancée', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.ballistic', pos: cityOf('aaa-2'), count: 2 }, // u1
      { owner: 'ddd', systemId: 'tst.ewsat', pos: cityOf('ddd-1') }, // u2
    ]);
    expect(s.units.u2!.off).toBe(true);
    const r = applyOrder(s, 'aaa', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'building', provinceId: 'bbb-2', building: 'air_base' },
    });
    expect(r.ok).toBe(true);
    const mid = Object.keys(s.units).find((id) => s.units[id]!.role === 'missile')!;
    const own = viewFor(s, 'aaa').units[mid]!;
    expect(own.missile?.impactAt).toBeGreaterThan(s.time);
    expect(own.missile?.target).toEqual({ type: 'building', provinceId: 'bbb-2', building: 'air_base' });
    const notes = advanceTo(s, s.time + 1000);
    void notes;
    const dv = viewFor(s, 'ddd').units[mid];
    expect(dv).toBeDefined();
    expect(dv!.missile?.impactAt).toBe(own.missile!.impactAt);
    expect(viewFor(s, 'ccc').units[mid]).toBeUndefined();
  });

  it('cellules de lancement d’un navire : salve, munitions, rechargement au port', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.destroyer', pos: [7.5, 44] }, // u1
      { owner: 'bbb', systemId: 'tst.frigate', pos: [9.5, 44] }, // u2 (≈ 160 km)
      { owner: 'aaa', systemId: 'tst.radar', pos: [8.5, 44.8] }, // u3 : voit la frégate
    ]);
    advanceTo(s, MINUTE);
    const r = applyOrder(s, 'aaa', { kind: 'strike', unitIds: ['u1'], target: { type: 'unit', unitId: 'u2' } });
    expect(r.ok).toBe(true);
    expect(viewFor(s, 'aaa').units.u1!.mission?.ammo).toBe(0);
    const again = applyOrder(s, 'aaa', { kind: 'strike', unitIds: ['u1'], target: { type: 'unit', unitId: 'u2' } });
    expect(again.error).toBe('insufficient_resources');
    advanceTo(s, 2 * HOUR);
    const f = s.units.u2;
    expect(!f || f.hp < f.maxHp).toBe(true);
  });

  it('cible hors de vue ou hors de portée : refusé', () => {
    const s: EngineState = milSandbox([
      { owner: 'aaa', systemId: 'tst.cruise', pos: cityOf('aaa-1') }, // u1
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') }, // u2 : invisible pour aaa
    ]);
    expect(
      applyOrder(s, 'aaa', { kind: 'strike', unitIds: ['u1'], target: { type: 'unit', unitId: 'u2' } }).error,
    ).toBe('invalid_target');
    expect(
      applyOrder(s, 'aaa', { kind: 'strike', unitIds: ['u1'], target: { type: 'point', at: [60, 44] } }).error,
    ).toBe('out_of_range');
  });
});
