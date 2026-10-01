import { describe, expect, it } from 'vitest';
import { HOUR, type BattleReport } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  battleReportFor,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import { mil } from '../src/modules/mil/state.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf } from './fixtures.js';
import { milSandbox, milWorld } from './mil-fixtures.js';

/**
 * Rapport après action : un char aaa attaque l'infanterie bbb devant sa ville ; bbb tire des missiles
 * de croisière depuis sa capitale lointaine (lanceur u4, jamais vu par aaa) sur le char.
 */
function scenario(): EngineState {
  const s = milSandbox([
    { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] }, // u1
    { owner: 'bbb', systemId: 'tst.infantry', pos: [7.5, 40.0] }, // u2
    { owner: 'bbb', systemId: 'tst.infantry', pos: [7.52, 40.0] }, // u3
    { owner: 'bbb', systemId: 'tst.cruise', pos: cityOf('bbb-2'), count: 4 }, // u4
  ]);
  expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
  advanceTo(s, 20 * 60_000);
  expect(
    applyOrder(s, 'bbb', {
      kind: 'strike',
      unitIds: ['u4'],
      target: { type: 'unit', unitId: 'u1' },
    }).ok,
  ).toBe(true);
  return s;
}

function reports(s: EngineState): { id: string; a: BattleReport; b: BattleReport } {
  const id = Object.keys(mil(s).battles).sort()[0]!;
  return { id, a: battleReportFor(s, 'aaa', id)!, b: battleReportFor(s, 'bbb', id)! };
}

describe('rapport de bataille après action', { timeout: 60_000 }, () => {
  it('rapport complet : lieu, camps, effectifs, pertes humaines et matérielles, feux, phases, facteurs, issue', () => {
    const s = scenario();
    advanceTo(s, 12 * HOUR);
    const { a } = reports(s);
    const aar = a.aar!;
    expect(aar).toBeDefined();
    expect(a.endedAt).not.toBeNull();
    expect(aar.place.provinceId).toBe('bbb-4');
    expect(aar.place.owner).toBe('bbb');
    expect(aar.place.domain).toBe('land');
    expect(aar.mySide).toBe('attacker');
    expect(aar.result.verdict).not.toBe('ongoing');
    const [att, def] = aar.sides;
    expect(att.own).toBe(true);
    expect(def.own).toBe(false);
    expect(def.grade).toBeDefined();
    // Son camp : exact, cohérent avec le résumé.
    const tank = att.forces.find((f) => f.systemId === 'tst.tank')!;
    expect(tank.engaged.min).toBe(tank.engaged.max);
    expect(tank.engaged.best).toBe(a.attacker.engaged[0]!.count);
    expect(tank.munitions.best).toBeGreaterThan(0);
    expect(att.totals.vehicles.best).toBe(tank.engaged.best);
    expect(att.totals.personnel.best).toBeGreaterThan(0);
    // L'adversaire : infanterie vue, pertes confirmées par ses tirs, personnels en fourchette.
    const inf = def.forces.find((f) => f.systemId === 'tst.infantry')!;
    expect(inf).toBeDefined();
    expect(inf.destroyed.best).toBeGreaterThan(0);
    expect(inf.destroyed.min).toBeLessThanOrEqual(inf.destroyed.best);
    expect(inf.destroyed.max).toBeGreaterThanOrEqual(inf.destroyed.best);
    const human = def.casualties;
    expect(human.killed.best + human.wounded.best + human.missing.best).toBeGreaterThan(0);
    // Missiles de bbb : abattus ou encaissés, vus par aaa.
    expect(def.missiles.launched.best).toBeGreaterThanOrEqual(0);
    expect(aar.phases.length).toBeGreaterThan(0);
    expect(aar.phases.every((p) => p.t1 >= p.t0)).toBe(true);
    // Courbe des pertes : cumulée, croissante, du début à la fin des combats.
    expect(aar.losses[0]!.t).toBe(a.startedAt);
    for (let i = 1; i < aar.losses.length; i++) {
      expect(aar.losses[i]!.t).toBeGreaterThanOrEqual(aar.losses[i - 1]!.t);
      expect(aar.losses[i]!.attacker).toBeGreaterThanOrEqual(aar.losses[i - 1]!.attacker);
      expect(aar.losses[i]!.defender).toBeGreaterThanOrEqual(aar.losses[i - 1]!.defender);
    }
    expect(aar.losses[aar.losses.length - 1]!.defender).toBe(inf.destroyed.best);
    for (const f of aar.factors) expect(f.weight).toBeGreaterThanOrEqual(0);
  });

  it('rien de caché divulgué : le lanceur jamais vu n’apparaît nulle part dans le rapport de aaa', () => {
    const s = scenario();
    advanceTo(s, 12 * HOUR);
    const { a, b } = reports(s);
    expect(mil(s).battles[a.id]!.units.u4).toBeDefined(); // il a bien pris part aux combats
    const json = JSON.stringify(a);
    expect(json).not.toContain('"u4"');
    expect(a.aar!.sides[1].forces.some((f) => f.systemId === 'tst.cruise')).toBe(false);
    expect(a.timeline.some((x) => x.text.startsWith('Tir de'))).toBe(false);
    const launcher = cityOf('bbb-2');
    for (const sh of a.replay.shots)
      expect(Math.abs(sh.from[0] - launcher[0]) + Math.abs(sh.from[1] - launcher[1])).toBeGreaterThan(0.5);
    // Le résumé de la vue (camp adverse) ne cite que les matériels identifiés.
    const sum = viewFor(s, 'aaa').battleReports!.find((x) => x.id === a.id)!;
    expect(sum.defender.engaged.every((e) => e.systemId !== 'tst.cruise')).toBe(true);
    // bbb, lui, connaît son lanceur et ses tirs.
    expect(b.aar!.sides[1].own).toBe(true);
    expect(b.aar!.sides[1].missiles.launched.best).toBeGreaterThan(0);
    expect(b.timeline.some((x) => x.text.startsWith('Tir de'))).toBe(true);
  });

  it('déterministe, rejeu identique (reprise d’un instantané en pleine bataille), lecture sans effet', () => {
    const s1 = scenario();
    advanceTo(s1, HOUR);
    const snap = serializeState(s1);
    advanceTo(s1, 12 * HOUR);
    const s2 = deserializeState(milWorld(), snap) as EngineState;
    advanceTo(s2, 12 * HOUR);
    const s3 = scenario();
    advanceTo(s3, 12 * HOUR);
    const h = stateHash(s1);
    const r1 = reports(s1);
    expect(stateHash(s1)).toBe(h); // le rapport ne modifie pas l'état
    const j1 = JSON.stringify(r1);
    const j2 = JSON.stringify(reports(s2));
    expect(j2).toBe(j1);
    expect(JSON.stringify(reports(s3))).toBe(JSON.stringify(r1));
    expect(stateHash(s2)).toBe(h);
  });
});
