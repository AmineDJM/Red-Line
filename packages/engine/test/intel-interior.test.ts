import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { board, modifier, signal } from '../src/modules/registry.js';
import { ist } from '../src/modules/intel/state.js';
import { successFactor } from '../src/modules/intel/interior.js';
import { transferProvince } from '../src/combat/capture.js';
import { BALANCE, CATALOG, buildMap } from './fixtures.js';
import { BBB2, BBB5, intelGame, opStatus } from './intel-helpers.js';

const ok = (s: EngineState, n: string, o: Order) => {
  const r = applyOrder(s, n, o);
  if (!r.ok) throw new Error(`${o.kind} refusé : ${r.message}`);
};

/** Monde où la sécurité intérieure repère toujours les opérations (détection certaine). */
function alertGame(): EngineState {
  const map = buildMap();
  const provinces = map.provinces.map((p) =>
    p.id === 'bbb-2'
      ? { ...p, buildings: [...BBB2] }
      : p.id === 'bbb-5'
        ? { ...p, buildings: [...BBB5] }
        : p,
  );
  const balance = BalanceSchema.parse({
    ...BALANCE,
    intel: { flashBorderKm: 300, interior: { opDetectBase: 1, opDetectMax: 1 } },
    buildings: { distribute: false },
  });
  const s = createGame(buildWorld({ ...map, provinces }, CATALOG, balance), {
    seed: 3,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
    ],
  }) as EngineState;
  for (const n of s.nationIds) s.nations[n]!.money = 1e10;
  return s;
}

describe('renseignement intérieur : priorité et effets mesurables', () => {
  it('la priorité change la détection des agents, des opérations et la réduction des troubles', () => {
    const s = intelGame();
    const base = viewFor(s, 'bbb').intel!.interior!;
    expect(base.focus).toBe('balanced');
    expect(base.metrics.quality).toBeGreaterThan(0);
    ok(s, 'bbb', { kind: 'interiorFocus', focus: 'counterintel' });
    const ci = viewFor(s, 'bbb').intel!.interior!;
    expect(ci.metrics.agentDetectPerDay).toBeGreaterThan(base.metrics.agentDetectPerDay);
    expect(ci.metrics.opDetect).toBeGreaterThan(base.metrics.opDetect);
    ok(s, 'bbb', { kind: 'interiorFocus', focus: 'surveillance' });
    const sv = viewFor(s, 'bbb').intel!.interior!;
    expect(sv.metrics.unrestReduction).toBeGreaterThan(base.metrics.unrestReduction);
    expect(modifier(s, 'bbb', 'unrest.risk')).toBeCloseTo(1 - sv.metrics.unrestReduction, 2);
    // Le budget compte : budget nul, effets réduits.
    ok(s, 'bbb', { kind: 'intelBudget', dept: 'interior', budgetPerDay: 0 });
    expect(viewFor(s, 'bbb').intel!.interior!.metrics.unrestReduction).toBeLessThan(
      sv.metrics.unrestReduction,
    );
  });

  it('sites protégés : capacité, propriété, protection, perte à la capture', () => {
    const s = intelGame();
    expect(viewFor(s, 'bbb').intel!.interior!.maxProtected).toBe(2);
    ok(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-5', on: true });
    ok(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-2', on: true });
    expect(applyOrder(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-3', on: true }).error).toBe(
      'capacity',
    );
    expect(applyOrder(s, 'bbb', { kind: 'protectSite', provinceId: 'aaa-1', on: true }).error).toBe(
      'invalid_target',
    );
    // Priorité « protection » : deux sites de plus.
    ok(s, 'bbb', { kind: 'interiorFocus', focus: 'protection' });
    ok(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-3', on: true });
    expect(board(s).protectedSites).toEqual({ 'bbb-5': 'bbb', 'bbb-2': 'bbb', 'bbb-3': 'bbb' });
    // Retour à l'équilibre : les sites au-delà de la limite sont levés.
    ok(s, 'bbb', { kind: 'interiorFocus', focus: 'balanced' });
    expect(viewFor(s, 'bbb').intel!.interior!.protected).toEqual(['bbb-5', 'bbb-2']);
    expect(board(s).protectedSites!['bbb-3']).toBeUndefined();

    // Sabotage contre un site protégé : réussite réduite (pas ailleurs).
    ok(s, 'aaa', { kind: 'intelOp', op: 'sabotage_factory', target: { provinceId: 'bbb-5' } });
    const op = ist(s).nations.aaa!.ops.at(-1)!;
    delete op.dt;
    const prot = viewFor(s, 'bbb').intel!.interior!.metrics.protection;
    expect(prot).toBeGreaterThan(0);
    expect(successFactor(s, op)).toBeCloseTo(1 - prot, 5);
    ok(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-5', on: false });
    expect(successFactor(s, op)).toBe(1);

    // Province perdue : protection levée.
    transferProvince(s, 'bbb-2', 'aaa');
    expect(viewFor(s, 'bbb').intel!.interior!.protected).toEqual([]);
    expect(board(s).protectedSites).toBeUndefined();
  });
});

describe('renseignement intérieur : alertes et opérations déjouées', () => {
  it('opération étrangère repérée : alerte cotée, réussite réduite, échec signalé', () => {
    const s = alertGame();
    ok(s, 'aaa', { kind: 'intelOp', op: 'sabotage_factory', target: { provinceId: 'bbb-5' } });
    const op = ist(s).nations.aaa!.ops.at(-1)!;
    expect(op.dt).toBe(1);
    expect(successFactor(s, op)).toBeCloseTo(0.5);
    const rep = viewFor(s, 'bbb').intel!.reports[0]!;
    expect(rep.title).toBe('ALERTE — Sabotage en préparation');
    expect(rep.dept).toBe('interior');
    expect('ABCDEF').toContain(rep.reliability);
    expect([1, 2, 3, 4, 5, 6]).toContain(rep.credibility);
    expect(rep.subject?.provinceId).toBe('bbb-5');
    // Le secret ne fuit pas chez l'attaquant.
    const atk = viewFor(s, 'aaa').intel!.operations.find((o) => o.id === op.id)!;
    expect(atk).not.toHaveProperty('dt');
    op.estimate = 0;
    advanceTo(s, op.completesAt);
    expect(['failed', 'compromised']).toContain(opStatus(s, 'aaa', op.id));
    const iv = viewFor(s, 'bbb').intel!.interior!;
    expect(iv.stats).toMatchObject({ alerts: 1, foiled: 1 });
    expect(
      viewFor(s, 'bbb').intel!.reports.some((r) => r.title === 'Opération étrangère déjouée'),
    ).toBe(true);
    // Menace : la province visée porte l'incident.
    const t5 = iv.threats.find((t) => t.provinceId === 'bbb-5')!;
    expect(t5.factors).toContain('Incidents récents');
    expect(t5.level).toBeGreaterThanOrEqual(20);
  });

  it('menace par province : incidents, décroissance, grade', () => {
    const s = intelGame();
    signal(s, 'sabotage', {
      by: 'aaa',
      victim: 'bbb',
      pid: 'bbb-3',
      building: 'farm',
      damage: 0.2,
    });
    let t = viewFor(s, 'bbb').intel!.interior!.threats.find((x) => x.provinceId === 'bbb-3')!;
    expect(t.level).toBe(30);
    expect(t.grade).toBe('moderate');
    advanceTo(s, 5 * DAY);
    t = viewFor(s, 'bbb').intel!.interior!.threats.find((x) => x.provinceId === 'bbb-3')!;
    expect(t.level).toBeLessThan(30);
    expect(viewFor(s, 'bbb').intel!.interior!.threatLevel).toBeGreaterThan(0);
  });

  it('sérialisation et rejeu identiques', () => {
    const play = () => {
      const s = alertGame();
      ok(s, 'bbb', { kind: 'interiorFocus', focus: 'counterintel' });
      ok(s, 'bbb', { kind: 'protectSite', provinceId: 'bbb-5', on: true });
      ok(s, 'aaa', { kind: 'intelOp', op: 'fund_rebels', target: { provinceId: 'bbb-5' } });
      advanceTo(s, 3 * DAY);
      return s;
    };
    const a = play();
    expect(stateHash(play())).toBe(stateHash(a));
    const b = deserializeState(a.world, serializeState(a)) as EngineState;
    expect(stateHash(b)).toBe(stateHash(a));
    expect(viewFor(b, 'bbb').intel!.interior).toEqual(viewFor(a, 'bbb').intel!.interior);
    advanceTo(a, 6 * DAY);
    advanceTo(b, 6 * DAY);
    expect(stateHash(b)).toBe(stateHash(a));
  });
});
