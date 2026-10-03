/**
 * Opérations du centre de commandement (scénarios synthétiques) : ordre d'opération multi-généraux
 * (rôles tirés des commandements, forces d'office par arme, secteurs), validations, chef de
 * commandement, conquête menée jusqu'au bout, changement d'objectif, renforts et retrait, annulation,
 * autorisation de guerre (règles strictes), rejeu et reprise après sérialisation, anciennes
 * sauvegardes (sans commandements ni opérations).
 */
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  applySystem,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { atWar } from '../src/state/access.js';
import { cmd } from '../src/modules/command/state.js';
import { effectiveSkills, salaryOf } from '../src/modules/command/generals.js';
import { cityOf } from './fixtures.js';
import { milSandbox, milWorld } from './mil-fixtures.js';

const ok = (s: EngineState, n: string, o: Order) => {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
};
const ko = (s: EngineState, n: string, o: Order) => {
  const r = applyOrder(s, n, o);
  expect(r.ok, `${o.kind} devait être refusé`).toBe(false);
  return r;
};

/** Forces de aaa (terre, air, DCA) face à bbb ; trésorerie pour les primes. */
function theater(seed = 1): EngineState {
  const s = milSandbox(
    [
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u2
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u3
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-3') }, // u4
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-3') }, // u5
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-3') }, // u6
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u7
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u8
      { owner: 'aaa', systemId: 'tst.sam', pos: cityOf('aaa-2') }, // u9
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4'), count: 1 }, // u10
    ],
    { seed },
  );
  for (const n of ['aaa', 'bbb']) applySystem(s, { kind: 'grant', nationId: n, money: 1e10 });
  return s;
}

/** Meilleur candidat d'un commandement (compétence maîtresse), parmi ceux non retenus. */
function cand(s: EngineState, branch: string, skip: string[] = []): string {
  const key = branch === 'air' ? 'air' : branch === 'ad' ? 'defense' : 'offense';
  const b = viewFor(s, 'aaa').command!.branches!.find((x) => x.id === branch)!;
  return b.candidates
    .filter((c) => !skip.includes(c.id))
    .sort((x, y) => y.skills[key] - x.skills[key] || (x.id < y.id ? -1 : 1))[0]!.id;
}

function conquest(s: EngineState, extra: Partial<Extract<Order, { kind: 'campaignCreate' }>> = {}) {
  const l1 = cand(s, 'land');
  const l2 = cand(s, 'land', [l1]);
  ok(s, 'aaa', {
    kind: 'campaignCreate',
    name: 'Tempête',
    goal: 'conquest',
    nations: ['bbb'],
    roe: 'free',
    aggr: 'bold',
    commanders: [
      { candidateId: l1 },
      { candidateId: l2 },
      { candidateId: cand(s, 'air') },
      { candidateId: cand(s, 'ad') },
    ],
    ...extra,
  });
  // Pas de frictions : le test porte sur les décisions, pas sur le tirage.
  for (const g of Object.values(cmd(s).gens)) {
    g.skills.experience = 100;
    g.traits = [];
  }
  return Object.values(cmd(s).ops!)[0]!;
}

describe('opérations : ordre et généraux', () => {
  it('commandements : viviers par arme, rôles tirés de l’arme, forces d’office par arme', () => {
    const s = theater();
    const v = viewFor(s, 'aaa').command!;
    expect(v.branches!.map((b) => b.id)).toEqual(['land', 'air', 'sea', 'ad']);
    for (const b of v.branches!) {
      expect(b.candidates.length).toBe(6);
      for (const c of b.candidates) expect(c.branch).toBe(b.id);
    }
    // Compétences adaptées : la spécialité d'un vivier domine en moyenne.
    const mean = (b: string, k: 'air' | 'naval' | 'offense') => {
      const cs = v.branches!.find((x) => x.id === b)!.candidates;
      return cs.reduce((a, c) => a + c.skills[k], 0) / cs.length;
    };
    expect(mean('air', 'air')).toBeGreaterThan(mean('land', 'air'));
    expect(mean('sea', 'naval')).toBeGreaterThan(mean('land', 'naval'));
    expect(v.branches!.find((b) => b.id === 'land')!.forces.piles).toBe(6);
    expect(v.branches!.find((b) => b.id === 'air')!.forces.piles).toBe(2);
    expect(v.branches!.find((b) => b.id === 'ad')!.forces.piles).toBe(1);

    const op = conquest(s);
    const c = cmd(s);
    expect(op.armies).toHaveLength(4);
    const roles = op.armies.map((id) => op.roles[id]);
    expect(roles).toEqual(['land', 'land', 'air', 'ad']);
    const sysOfArmy = (id: string) => c.armies[id]!.units.map((u) => s.units[u]!.sys).sort();
    // Engagement total (audacieux) : toutes les piles de l'arme, réparties entre les deux généraux.
    const land = [...sysOfArmy(op.armies[0]!), ...sysOfArmy(op.armies[1]!)];
    expect(land.length).toBe(6);
    expect(sysOfArmy(op.armies[0]!).length).toBeGreaterThan(0);
    expect(sysOfArmy(op.armies[1]!).length).toBeGreaterThan(0);
    expect(sysOfArmy(op.armies[2]!)).toEqual(['tst.jet', 'tst.jet']);
    expect(sysOfArmy(op.armies[3]!)).toEqual(['tst.sam']);
    // Secteurs : un par général de l'armée de terre, disjoints, couvrant toutes les cibles.
    const s1 = op.sectors[op.armies[0]!]!;
    const s2 = op.sectors[op.armies[1]!]!;
    expect([...s1.pids, ...s2.pids].sort()).toEqual([...op.targets].sort());
    expect(s1.pids.some((p) => s2.pids.includes(p))).toBe(false);
    const view = viewFor(s, 'aaa').command!;
    expect(view.ops).toHaveLength(1);
    expect(view.ops![0]!.commanders.map((x) => x.role)).toEqual(['land', 'land', 'air', 'ad']);
    for (const g of view.generals) expect(g.opId).toBe(op.id);
    expect(view.armies.every((a) => a.opId === op.id)).toBe(true);
  });

  it('validations : objectif, cibles, généraux, capacité', () => {
    const s = theater();
    const base = {
      kind: 'campaignCreate' as const,
      goal: 'conquest',
      nations: ['bbb'],
      commanders: [{ candidateId: cand(s, 'land') }],
    };
    ko(s, 'aaa', { ...base, goal: 'nope' });
    ko(s, 'aaa', { ...base, nations: ['aaa'] });
    ko(s, 'aaa', { ...base, nations: [] });
    ko(s, 'aaa', { ...base, goal: 'occupy', nations: ['bbb'] });
    ko(s, 'aaa', { ...base, commanders: [{}] });
    const l = cand(s, 'land');
    ko(s, 'aaa', { ...base, commanders: [{ candidateId: l }, { candidateId: l }] });
    ko(s, 'aaa', { ...base, commanders: Array.from({ length: 7 }, () => ({ candidateId: l })) });
    expect(cmd(s).ops ?? {}).toEqual({});
    // Occuper une région : provinces désignées.
    ok(s, 'aaa', {
      ...base,
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4', 'bbb-5'],
    });
    const op = Object.values(cmd(s).ops!)[0]!;
    expect(op.targets).toEqual(['bbb-4', 'bbb-5']);
  });

  it('général en chef : solde majorée, compétences des généraux de son arme relevées', () => {
    const s = theater();
    const op = conquest(s);
    const c = cmd(s);
    const gens = op.armies.map((id) => c.gens[c.armies[id]!.general!]!);
    const [g1, g2] = gens;
    const before = effectiveSkills(s, g2!).offense;
    const pay = salaryOf(s, 'aaa', g1!.skills, g1!.traits);
    ok(s, 'aaa', { kind: 'commandChief', branch: 'land', generalId: g1!.id });
    ko(s, 'aaa', { kind: 'commandChief', branch: 'air', generalId: g1!.id });
    const v = viewFor(s, 'aaa').command!;
    const chief = v.generals.find((g) => g.id === g1!.id)!;
    expect(chief.chief).toBe(true);
    expect(chief.salaryPerDay).toBe(salaryOf(s, 'aaa', g1!.skills, g1!.traits, true));
    expect(chief.salaryPerDay).toBeGreaterThan(pay);
    expect(v.branches!.find((b) => b.id === 'land')!.chiefId).toBe(g1!.id);
    // Contrat du ministère de la Défense : commandements → chef → généraux → opérations en cours.
    expect(v.commands!.map((x) => x.domain)).toEqual(['land', 'air', 'sea', 'air_defense']);
    const land = v.commands![0]!;
    expect(land.chief).toEqual({ id: g1!.id, name: `${g1!.first} ${g1!.last}` });
    expect(land.generalIds).toEqual(expect.arrayContaining([g1!.id, g2!.id]));
    expect(land.generals.find((x) => x.id === g2!.id)).toMatchObject({ opId: op.id });
    expect(land.operationIds).toEqual([op.id]);
    expect(land.operations[0]).toMatchObject({ id: op.id, goal: 'conquest' });
    expect(v.commands![3]!.chief).toBeNull();
    if (g1!.skills.offense > 50 || g1!.skills.defense > 50)
      expect(effectiveSkills(s, g2!).offense).toBeGreaterThanOrEqual(before);
    ok(s, 'aaa', { kind: 'commandChief', branch: 'land', generalId: null });
    expect(viewFor(s, 'aaa').command!.branches![0]!.chiefId).toBeNull();
  });
});

describe('opérations : conduite', () => {
  it('conquête totale : guerre, offensives par secteur, provinces prises, opération réussie', () => {
    const s = theater();
    const op = conquest(s);
    advanceTo(s, MINUTE);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    const taken: number[] = [];
    for (let h = 2; h <= 6 * 24 && op.status !== 'success'; h += 2) {
      advanceTo(s, h * HOUR);
      taken.push(op.targets.filter((p) => s.provinces[p]!.owner === 'aaa').length);
    }
    expect(op.status).toBe('success');
    expect(op.targets.every((p) => s.provinces[p]!.owner === 'aaa')).toBe(true);
    // Progression réelle au fil du temps (pas tout d'un coup à la fin).
    expect(new Set(taken).size).toBeGreaterThan(2);
    const keys = op.journal.map((e) => e.text.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'engine.cmd.op.created',
        'engine.cmd.op.declaredWar',
        'engine.cmd.op.offensive',
        'engine.cmd.op.captured',
        'engine.cmd.op.success',
      ]),
    );
    // Les deux généraux de l'armée de terre ont mené des offensives.
    const leaders = new Set(
      op.journal
        .filter((e) => e.text.key === 'engine.cmd.op.offensive')
        .map((e) => JSON.stringify(e.text.params?.army)),
    );
    expect(leaders.size).toBe(2);
    const v = viewFor(s, 'aaa').command!.ops![0]!;
    expect(v.status).toBe('success');
    expect(v.progress.find((p) => p.key === 'provinces')).toEqual({
      key: 'provinces',
      done: op.targets.length,
      total: op.targets.length,
    });
    // La capitale reste comptée après la chute du pays visé (1/1, pas 0/0).
    expect(v.progress.find((p) => p.key === 'capital')).toEqual({
      key: 'capital',
      done: 1,
      total: 1,
    });
    expect(v.pct).toBe(1);
  });

  it('changer d’objectif, retirer un général, changer un rôle, annuler', () => {
    const s = theater();
    const op = conquest(s);
    advanceTo(s, HOUR);
    ok(s, 'aaa', { kind: 'campaignEdit', opId: op.id, goal: 'attrition' });
    expect(op.goal).toBe('attrition');
    expect(op.targets).toEqual([]);
    expect(op.journal.some((e) => e.text.key === 'engine.cmd.op.goalChanged')).toBe(true);
    const [, second, air] = op.armies;
    ok(s, 'aaa', { kind: 'campaignForces', opId: op.id, roles: [{ armyId: air!, role: 'land' }] });
    expect(op.roles[air!]).toBe('land');
    ok(s, 'aaa', { kind: 'campaignForces', opId: op.id, remove: [second!] });
    expect(op.armies).not.toContain(second);
    // Armée formée d'office : dissoute en quittant l'opération (le général reste en réserve).
    expect(cmd(s).armies[second!]).toBeUndefined();
    const gens = Object.keys(cmd(s).gens).length;
    ok(s, 'aaa', { kind: 'campaignCancel', opId: op.id });
    expect(cmd(s).ops![op.id]).toBeUndefined();
    expect(Object.keys(cmd(s).armies)).toEqual([]);
    expect(Object.keys(cmd(s).gens).length).toBe(gens);
    expect(Object.values(cmd(s).gens).every((g) => g.army === null)).toBe(true);
    // Les piles reviennent sous le commandement direct du joueur.
    expect(cmd(s).unitArmy).toEqual({});
  });

  it('règles strictes : autorisation de guerre demandée, puis accordée', () => {
    const s = theater();
    const op = conquest(s, { roe: 'strict' });
    advanceTo(s, MINUTE);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(op.status).toBe('awaiting');
    const rq = viewFor(s, 'aaa').command!.ops![0]!.request!;
    expect(rq).toMatchObject({ kind: 'declare_war', nationId: 'bbb' });
    ok(s, 'aaa', { kind: 'campaignAnswer', opId: op.id, requestId: rq.id, accept: true });
    advanceTo(s, 2 * MINUTE);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(op.status === 'planning' || op.status === 'active').toBe(true);
  });
});

describe('opérations : déterminisme et sauvegardes', () => {
  it('rejeu identique et reprise après sérialisation au milieu de l’opération', () => {
    const a = theater(9);
    const b = theater(9);
    conquest(a);
    conquest(b);
    advanceTo(a, 10 * HOUR);
    advanceTo(b, 10 * HOUR);
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(milWorld(), serializeState(a)) as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    for (const s of [a, c]) advanceTo(s, 3 * DAY);
    expect(stateHash(c)).toBe(stateHash(a));
    expect(viewFor(c, 'aaa').command).toEqual(viewFor(a, 'aaa').command);
  });

  it('ancienne sauvegarde (sans commandements ni opérations) : lisible, missions intactes', () => {
    const s = theater(3);
    ok(s, 'aaa', { kind: 'armyCreate', name: 'A', unitIds: ['u1', 'u2', 'u3'] });
    const army = viewFor(s, 'aaa').command!.armies[0]!;
    ok(s, 'aaa', {
      kind: 'generalHire',
      candidateId: viewFor(s, 'aaa').command!.candidates[0]!.id,
      armyId: army.id,
    });
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: army.id,
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'free', aggr: 'bold' },
    });
    // Instantané d'avant les opérations : ni viviers par arme, ni chefs, ni opérations, ni arme.
    const c = cmd(s);
    delete c.ops;
    delete c.bpools;
    delete c.chiefs;
    for (const g of Object.values(c.gens)) delete g.branch;
    const old = deserializeState(milWorld(), serializeState(s)) as EngineState;
    const v = viewFor(old, 'aaa').command!;
    expect(v.ops).toEqual([]);
    expect(v.generals[0]!.branch).toBeDefined();
    expect(v.armies[0]!.mission?.type).toBe('conquer');
    advanceTo(old, 2 * DAY);
    expect(old.provinces['bbb-4']!.owner).toBe('aaa');
  });
});
