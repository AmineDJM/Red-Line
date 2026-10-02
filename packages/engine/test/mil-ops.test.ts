import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '@redline/shared';
import { advanceTo, applyOrder, battleReportFor, notificationsFor, viewFor } from '../src/index.js';
import { mil } from '../src/modules/mil/state.js';
import { cityOf } from './fixtures.js';
import { captureSignals, milSandbox, notesOf } from './mil-fixtures.js';

describe('opérations combinées (heure H)', () => {
  it('étapes décalées par rapport à H, appliquées au bon moment ; étape en échec conservée', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] }, // u1
      { owner: 'aaa', systemId: 'tst.cruise', pos: cityOf('aaa-1'), count: 2 }, // u2
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u3
    ]);
    const H = 2 * HOUR;
    const r = applyOrder(s, 'aaa', {
      kind: 'operation',
      name: 'Tempête',
      hHour: H,
      steps: [
        {
          offsetMin: -60,
          label: 'Approche',
          order: { kind: 'move', unitIds: ['u1'], to: [5.3, 40] },
        },
        {
          offsetMin: 0,
          label: 'Frappe',
          order: {
            kind: 'strike',
            unitIds: ['u2'],
            target: { type: 'building', provinceId: 'bbb-4', building: 'refinery' },
          },
        },
        {
          offsetMin: 30,
          label: 'Couverture',
          order: { kind: 'patrol', unitIds: ['u3'], at: [6, 41], radiusKm: 80 },
        },
        {
          offsetMin: 45,
          label: 'Invalide',
          order: { kind: 'move', unitIds: ['u999'], to: [1, 41] },
        },
      ],
    });
    expect(r.ok).toBe(true);
    let op = viewFor(s, 'aaa').operations![0]!;
    expect(op.status).toBe('planned');
    expect(op.steps.map((x) => x.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const all = [];
    all.push(...advanceTo(s, H - 61 * MINUTE));
    expect(s.units.u1!.move).toBeNull();
    all.push(...advanceTo(s, H - 59 * MINUTE));
    expect(s.units.u1!.move).not.toBeNull();
    op = viewFor(s, 'aaa').operations![0]!;
    expect(op.status).toBe('running');
    all.push(...advanceTo(s, H + MINUTE));
    expect(Object.values(s.units).some((u) => u.role === 'missile')).toBe(true);
    all.push(...advanceTo(s, H + 46 * MINUTE));
    expect(mil(s).ms.u3!.mis).toBe('patrol');
    op = viewFor(s, 'aaa').operations![0]!;
    expect(op.steps.map((x) => x.status)).toEqual(['done', 'done', 'done', 'failed']);
    expect(op.steps[3]!.error).toBeDefined();
    expect(op.status).toBe('done');
    const statuses = notesOf(all, 'operation').map((n) => n.status);
    expect(statuses).toEqual(['planned', 'running', 'step_failed:3', 'done']);
    expect(notificationsFor(s, 'bbb', all).some((n) => n.kind === 'operation')).toBe(false);
  });

  it('heure H passée refusée ; annulation : les étapes restantes ne sont pas jouées', () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }]);
    advanceTo(s, HOUR);
    const late = applyOrder(s, 'aaa', {
      kind: 'operation',
      name: 'Trop tard',
      hHour: HOUR,
      steps: [{ offsetMin: -10, order: { kind: 'stop', unitIds: ['u1'] } }],
    });
    expect(late.error).toBe('invalid_target');
    expect(
      applyOrder(s, 'aaa', {
        kind: 'operation',
        name: 'Annulée',
        hHour: 3 * HOUR,
        steps: [{ offsetMin: 0, order: { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-3') } }],
      }).ok,
    ).toBe(true);
    const id = viewFor(s, 'aaa').operations![0]!.id;
    expect(applyOrder(s, 'bbb', { kind: 'cancelOperation', operationId: id }).error).toBe(
      'not_owner',
    );
    expect(applyOrder(s, 'aaa', { kind: 'cancelOperation', operationId: id }).ok).toBe(true);
    advanceTo(s, 4 * HOUR);
    expect(s.units.u1!.move).toBeNull();
    const op = viewFor(s, 'aaa').operations![0]!;
    expect(op.status).toBe('cancelled');
    expect(op.steps[0]!.status).toBe('pending');
  });
});

describe('rapports de bataille', () => {
  it('rapport cohérent : camps, pertes, unités engagées, chronologie, replay ; signal battle_end', () => {
    captureSignals((signals) => {
      const s = milSandbox([
        { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] }, // u1
        { owner: 'bbb', systemId: 'tst.infantry', pos: [7.5, 40.0] }, // u2
        { owner: 'bbb', systemId: 'tst.infantry', pos: [7.52, 40.0] }, // u3
      ]);
      const before = { u2: s.units.u2!.count, u3: s.units.u3!.count, u1: s.units.u1!.count };
      expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(
        true,
      );
      const notes = advanceTo(s, 12 * HOUR);
      const br = notesOf(notes, 'battle_report');
      expect(br).toHaveLength(1);
      const id = br[0]!.reportId;
      expect(notificationsFor(s, 'aaa', notes).some((n) => n.kind === 'battle_report')).toBe(true);
      expect(notificationsFor(s, 'bbb', notes).some((n) => n.kind === 'battle_report')).toBe(true);
      expect(notificationsFor(s, 'ccc', notes).some((n) => n.kind === 'battle_report')).toBe(false);
      const r = battleReportFor(s, 'aaa', id)!;
      expect(r).not.toBeNull();
      expect(battleReportFor(s, 'ccc', id)).toBeNull();
      expect(r.attacker.nations).toEqual(['aaa']);
      expect(r.defender.nations).toEqual(['bbb']);
      expect(r.endedAt).not.toBeNull();
      expect(r.provinceId).toBe('bbb-4');
      const lostInf = before.u2 - (s.units.u2?.count ?? 0) + (before.u3 - (s.units.u3?.count ?? 0));
      const lostTank = before.u1 - (s.units.u1?.count ?? 0);
      const dl = r.defender.losses.find((x) => x.systemId === 'tst.infantry')?.count ?? 0;
      const al = r.attacker.losses.find((x) => x.systemId === 'tst.tank')?.count ?? 0;
      expect(dl).toBe(lostInf);
      expect(al).toBe(lostTank);
      expect(dl).toBeGreaterThan(0);
      expect(r.attacker.engaged).toEqual([{ systemId: 'tst.tank', count: 2 }]);
      expect(r.defender.engaged[0]!.systemId).toBe('tst.infantry');
      expect(r.outcome).toBe(dl > 0 && al === 0 ? 'attacker' : r.outcome);
      expect(r.timeline.length).toBeGreaterThan(1);
      expect(r.replay.frames.length).toBeGreaterThan(0);
      expect(r.replay.shots.length).toBeGreaterThan(0);
      expect(r.replay.shots.every((x) => x.t >= r.startedAt && x.t <= r.replay.t1)).toBe(true);
      const end = signals.find((x) => x.name === 'battle_end');
      expect(end?.data).toMatchObject({ reportId: id, nations: ['aaa', 'bbb'] });
      const view = viewFor(s, 'bbb').battleReports!;
      expect(view.map((x) => x.id)).toContain(id);
    });
  });

  it('activité en direct : derniers tirs joints au résumé pendant la bataille, participants seuls', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] }, // u1
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.5, 40.0] }, // u2
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.52, 40.0] }, // u3
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
    advanceTo(s, 40 * MINUTE);
    const cur = viewFor(s, 'aaa').battleReports?.find((b) => b.outcome === 'ongoing');
    expect(cur?.live).toBeDefined();
    const shots = cur!.live!.shots;
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.length).toBeLessThanOrEqual(16);
    expect(shots.every((x) => x.t <= 40 * MINUTE && x.t >= 20 * MINUTE)).toBe(true);
    expect(shots.map((x) => x.t)).toEqual([...shots.map((x) => x.t)].sort((a, b) => a - b));
    expect(cur!.live!.lastAt).toBeGreaterThanOrEqual(shots[shots.length - 1]!.t);
    // Même activité pour le défenseur ; rien pour une nation étrangère au combat.
    expect(viewFor(s, 'bbb').battleReports?.find((b) => b.id === cur!.id)?.live).toBeDefined();
    expect(viewFor(s, 'ccc').battleReports ?? []).toHaveLength(0);
    advanceTo(s, 12 * HOUR);
    const done = viewFor(s, 'aaa').battleReports!.find((b) => b.id === cur!.id)!;
    expect(done.outcome).not.toBe('ongoing');
    expect(done.live).toBeUndefined();
  });
});
