/**
 * Non-régression « une seule mission puis plus rien » (scénarios synthétiques) : une armée ou un
 * général enchaîne plusieurs missions et opérations ; chaque nouvelle mission est exécutée (ordres
 * réellement émis par le général), les armées d'une opération close ne restent ni captives ni
 * inertes, la mémoire tactique d'une armée close ne bloque plus les cibles des autres, une
 * opération close ne compte plus dans la limite d'opérations, un ordre direct sans fin ne garde pas
 * une pile hors des mains du général après une nouvelle mission.
 */
import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, type Order } from '@redline/shared';
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
import { setAiTracer } from '../src/ai/trace.js';
import { cmd, type OpSt } from '../src/modules/command/state.js';
import { cityOf } from './fixtures.js';
import { milSandbox, milWorld } from './mil-fixtures.js';

const ok = (s: EngineState, n: string, o: Order) => {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
};

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

function cand(s: EngineState, branch: string, skip: string[] = []): string {
  const key = branch === 'air' ? 'air' : branch === 'ad' ? 'defense' : 'offense';
  const b = viewFor(s, 'aaa').command!.branches!.find((x) => x.id === branch)!;
  return b.candidates
    .filter((c) => !skip.includes(c.id))
    .sort((x, y) => y.skills[key] - x.skills[key] || (x.id < y.id ? -1 : 1))[0]!.id;
}

/** Sans frictions : le test porte sur les décisions, pas sur le tirage. */
function noFriction(s: EngineState): void {
  for (const g of Object.values(cmd(s).gens)) {
    g.skills.experience = 100;
    g.traits = [];
  }
}

/** Ordres de mouvement / attaque / frappe émis par les généraux de `n` pendant `fn`. */
function ordersDuring(n: string, fn: () => void): { kind: string; ok: boolean }[] {
  const log: { kind: string; ok: boolean }[] = [];
  setAiTracer((_s, who, o, r) => {
    if (who === n) log.push({ kind: (o as Order).kind, ok: r.ok });
  });
  try {
    fn();
  } finally {
    setAiTracer(null);
  }
  return log.filter((x) => x.ok && ['move', 'attack', 'strike', 'patrol'].includes(x.kind));
}

function lastOp(s: EngineState): OpSt {
  const ops = cmd(s).ops!;
  return ops[
    Object.keys(ops)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .pop()!
  ]!;
}

/** Avance jusqu'à la fin de l'opération (ou `hours`). */
function runOp(s: EngineState, op: OpSt, hours: number): void {
  const t0 = s.time;
  for (let h = 1; h <= hours && op.status !== 'success' && op.status !== 'failed'; h++)
    advanceTo(s, t0 + h * HOUR);
}

describe('missions et opérations successives', () => {
  it('trois opérations successives avec les mêmes généraux (comme le propose le QG)', () => {
    const s = theater();
    const l1 = cand(s, 'land');
    const l2 = cand(s, 'land', [l1]);
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      name: 'Un',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: l1 }, { candidateId: l2 }, { candidateId: cand(s, 'air') }],
    });
    noFriction(s);
    const op1 = lastOp(s);
    const o1 = ordersDuring('aaa', () => runOp(s, op1, 72));
    expect(op1.status).toBe('success');
    expect(o1.length).toBeGreaterThan(0);
    const gens = op1.armies.map((id) => cmd(s).armies[id]!.general!);
    // Opérations 2 et 3 : mêmes généraux, forces « d'office » (l'interface n'envoie pas d'armée).
    for (const [i, target] of [
      [2, 'bbb-5'],
      [3, 'bbb-1'],
    ] as const) {
      ok(s, 'aaa', {
        kind: 'campaignCreate',
        name: `Op ${i}`,
        goal: 'occupy',
        nations: [],
        provinces: [target],
        roe: 'free',
        aggr: 'bold',
        commanders: gens.map((generalId) => ({ generalId })),
      });
      const op = lastOp(s);
      expect(op.armies.length).toBe(gens.length);
      const piles = op.armies.reduce((k, id) => k + cmd(s).armies[id]!.units.length, 0);
      expect(piles, `opération ${i} : forces engagées`).toBeGreaterThan(0);
      const o = ordersDuring('aaa', () => runOp(s, op, 96));
      expect(o.length, `opération ${i} : ordres émis`).toBeGreaterThan(0);
      expect(op.status, `opération ${i}`).toBe('success');
      expect(s.provinces[target]!.owner).toBe('aaa');
    }
  });

  it('une armée d’une opération terminée reçoit une mission : elle l’exécute', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      name: 'Un',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op = lastOp(s);
    runOp(s, op, 72);
    expect(op.status).toBe('success');
    const army = op.armies[0]!;
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: army,
      mission: { type: 'conquer', provinceId: 'bbb-5', roe: 'free', aggr: 'bold' },
    });
    const o = ordersDuring('aaa', () => advanceTo(s, s.time + 72 * HOUR));
    expect(o.length).toBeGreaterThan(0);
    expect(s.provinces['bbb-5']!.owner).toBe('aaa');
    expect(cmd(s).armies[army]!.op).toBeUndefined();
  });

  it('trois missions successives sur la même armée (Armées)', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'armyCreate',
      name: 'A',
      unitIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
      candidateId: cand(s, 'land'),
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'free', aggr: 'bold' },
    });
    noFriction(s);
    const id = Object.keys(cmd(s).armies)[0]!;
    const a = cmd(s).armies[id]!;
    for (const target of ['bbb-4', 'bbb-5', 'bbb-1']) {
      if (target !== 'bbb-4')
        ok(s, 'aaa', {
          kind: 'armyMission',
          armyId: id,
          mission: { type: 'conquer', provinceId: target, roe: 'free', aggr: 'bold' },
        });
      const t0 = s.time;
      const o = ordersDuring('aaa', () => {
        for (let h = 1; h <= 96 && a.status !== 'success'; h++) advanceTo(s, t0 + h * HOUR);
      });
      expect(o.length, `${target} : ordres émis`).toBeGreaterThan(0);
      expect(a.status, target).toBe('success');
      expect(s.provinces[target]!.owner).toBe('aaa');
    }
  });

  it('opération échouée : armées libérées, cibles plus réservées, une autre opération agit', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      name: 'Courte',
      goal: 'conquest',
      nations: ['bbb'],
      roe: 'free',
      aggr: 'bold',
      deadlineHours: 7,
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op1 = lastOp(s);
    runOp(s, op1, 24);
    expect(op1.status).toBe('failed');
    // Piles rendues : un nouveau général de l'armée de terre reçoit des forces d'office.
    const l2 = cand(s, 'land');
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      name: 'Reprise',
      goal: 'conquest',
      nations: ['bbb'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: l2 }],
    });
    noFriction(s);
    const op2 = lastOp(s);
    const piles = op2.armies.reduce((k, id) => k + cmd(s).armies[id]!.units.length, 0);
    expect(piles).toBeGreaterThan(0);
    const before = op2.targets.filter((p) => s.provinces[p]!.owner === 'aaa').length;
    const o = ordersDuring('aaa', () => runOp(s, op2, 96));
    expect(o.length).toBeGreaterThan(0);
    expect(op2.targets.filter((p) => s.provinces[p]!.owner === 'aaa').length).toBeGreaterThan(
      before,
    );
  });

  it('les opérations closes ne comptent plus dans la limite d’opérations en cours', () => {
    const s = theater();
    const max = viewFor(s, 'aaa').command!.maxOps!;
    for (let i = 0; i <= max; i++) {
      ok(s, 'aaa', {
        kind: 'campaignCreate',
        name: `Op ${i}`,
        goal: 'sead',
        nations: ['bbb'],
        roe: 'free',
        deadlineHours: 1,
        commanders: [{ candidateId: cand(s, 'air') }],
      });
      const op = lastOp(s);
      runOp(s, op, 3);
      expect(op.status).not.toBe('active');
    }
  });

  it('nouvelle mission : une pile sous ordre direct sans fin (blocus, patrouille) revient au général', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'armyCreate',
      name: 'A',
      unitIds: ['u7', 'u8'],
      candidateId: cand(s, 'air'),
    });
    const id = Object.keys(cmd(s).armies)[0]!;
    ok(s, 'aaa', {
      kind: 'patrol',
      unitIds: ['u7'],
      at: cityOf('aaa-1'),
      radiusKm: 50,
    } as Order);
    advanceTo(s, MINUTE);
    expect(cmd(s).armies[id]!.manual['u7']).toBe(1);
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: id,
      mission: { type: 'air_superiority', at: cityOf('aaa-3'), roe: 'free', aggr: 'bold' },
    });
    expect(cmd(s).armies[id]!.manual['u7']).toBeUndefined();
  });
});

/** Théâtre avec défense sol-air ennemie (SEAD possible), aviation, intercepteurs. */
function theater2(seed = 2): EngineState {
  const s = milSandbox(
    [
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u2
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u3
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-3') }, // u4
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-3') }, // u5
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u6
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u7
      { owner: 'aaa', systemId: 'tst.bomber', pos: cityOf('aaa-2') }, // u8
      { owner: 'aaa', systemId: 'tst.patriot', pos: cityOf('aaa-2') }, // u9
      { owner: 'bbb', systemId: 'tst.sam', pos: cityOf('bbb-4') }, // u10
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4'), count: 1 }, // u11
    ],
    { seed },
  );
  for (const n of ['aaa', 'bbb']) applySystem(s, { kind: 'grant', nationId: n, money: 1e10 });
  return s;
}

describe('enchaînement de phases et fin d’opération', () => {
  it('chaîne de 3 phases (SEAD → contrôle aérien → occupation) : chaque phase émet ses ordres', () => {
    const s = theater2();
    const l1 = cand(s, 'land');
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      name: 'Chaîne',
      goal: 'sead',
      nations: ['bbb'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: cand(s, 'air') }, { candidateId: l1 }],
      phaseHours: 8,
      phases: [
        { goal: 'air_control', hours: 12 },
        { goal: 'occupy', nations: [], provinces: ['bbb-4'] },
      ],
    });
    noFriction(s);
    const op = lastOp(s);
    expect(op.chain!.map((p) => p.goal)).toEqual(['sead', 'air_control', 'occupy']);
    const perPhase: Record<number, { kind: string; ok: boolean }[]> = {};
    const t0 = s.time;
    for (let h = 1; h <= 8 * 24 && op.status !== 'success' && op.status !== 'failed'; h++) {
      const step = op.step ?? 0;
      const o = ordersDuring('aaa', () => advanceTo(s, t0 + h * HOUR));
      (perPhase[step] ??= []).push(...o);
    }
    expect(op.status).toBe('success');
    expect(op.step).toBe(2);
    const phaseResult = expect.stringMatching(/success|timeout/);
    expect(op.results).toEqual([phaseResult, phaseResult, 'success']);
    expect(s.provinces['bbb-4']!.owner).toBe('aaa');
    // Ordres réellement émis à chaque phase : frappes (SEAD), patrouilles (ciel), mouvements (occupation).
    expect(perPhase[0]!.some((x) => x.kind === 'strike' || x.kind === 'patrol')).toBe(true);
    expect(perPhase[1]!.some((x) => x.kind === 'patrol' || x.kind === 'strike')).toBe(true);
    expect(perPhase[2]!.some((x) => x.kind === 'move' || x.kind === 'attack')).toBe(true);
    const keys = op.journal.map((e) => e.text.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'engine.cmd.op.phaseStart',
        'engine.cmd.op.phaseDone',
        'engine.cmd.op.success',
        'engine.cmd.op.after_hold',
      ]),
    );
    const v = viewFor(s, 'aaa').command!.ops![0]!;
    expect(v.phases!.map((p) => p.state)).toEqual(['done', 'done', 'done']);
    // Après la fin : les forces tiennent les gains (le général réfléchit encore).
    const land = op.armies.find((id) => op.roles[id] === 'land')!;
    expect(cmd(s).armies[land]!.post).toBe('hold');
    expect(v.commanders.find((c) => c.armyId === land)!.posture).toBe('hold');
  });

  it('guerre éclair : objectif composé développé en phases', () => {
    const s = theater2();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'blitz',
      nations: ['bbb'],
      roe: 'free',
      commanders: [{ candidateId: cand(s, 'air') }, { candidateId: cand(s, 'land') }],
    });
    const op = lastOp(s);
    expect(op.preset).toBe('blitz');
    expect(op.chain!.map((p) => p.goal)).toEqual([
      'sead',
      'air_control',
      'breakthrough',
      'decapitation',
    ]);
    expect(op.goal).toBe('sead');
    expect(viewFor(s, 'aaa').command!.ops![0]!.preset).toBe('blitz');
  });

  it('« rentrer à la base » puis « réserve » : forces rendues, piles libres pour la suite', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4'],
      roe: 'free',
      aggr: 'bold',
      after: 'home',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op = lastOp(s);
    runOp(s, op, 72);
    expect(op.status).toBe('success');
    expect(op.post).toBe('home');
    const army = op.armies[0]!;
    const o = ordersDuring('aaa', () => advanceTo(s, s.time + 60 * HOUR));
    expect(o.some((x) => x.kind === 'move')).toBe(true);
    // Rentrée (ou délai écoulé) : armée d'office dissoute, piles rendues au joueur.
    expect(cmd(s).armies[army]).toBeUndefined();
    expect(op.journal.some((e) => e.text.key === 'engine.cmd.op.returned')).toBe(true);
    // Réserve : rendu immédiat.
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-5'],
      roe: 'free',
      aggr: 'bold',
      after: 'reserve',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op2 = lastOp(s);
    runOp(s, op2, 96);
    expect(op2.status).toBe('success');
    expect(op2.armies).toEqual([]);
    expect(Object.keys(cmd(s).unitArmy)).toEqual([]);
  });

  it('opération close (tenir les gains) : un nouveau général reprend ses piles d’office', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op1 = lastOp(s);
    runOp(s, op1, 72);
    expect(op1.status).toBe('success');
    const piles = cmd(s).armies[op1.armies[0]!]!.units.length;
    expect(piles).toBeGreaterThan(0);
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-5'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    const op2 = lastOp(s);
    const got = cmd(s).armies[op2.armies[0]!]!.units.length;
    expect(got).toBeGreaterThan(0);
    const o = ordersDuring('aaa', () => runOp(s, op2, 96));
    expect(o.length).toBeGreaterThan(0);
    expect(op2.status).toBe('success');
  });

  it('mission échouée : sa mémoire ne réserve plus les cibles, une autre armée les attaque', () => {
    const s = theater();
    ok(s, 'aaa', {
      kind: 'armyCreate',
      name: 'X',
      unitIds: ['u1', 'u2', 'u3'],
      candidateId: cand(s, 'land'),
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'free', aggr: 'bold' },
    });
    noFriction(s);
    const x = Object.values(cmd(s).armies)[0]!;
    // L'assaut part (mémoire tactique remplie), puis la mission échoue (enlisement forcé).
    for (let m = 10; m <= 240 && !Object.keys(x.mem.ops ?? {}).length; m += 10)
      advanceTo(s, m * MINUTE);
    expect(
      Object.keys(x.mem.ops ?? {}).length + Object.keys(x.mem.commit ?? {}).length,
    ).toBeGreaterThan(0);
    x.mission!.progressAt = -1e12;
    advanceTo(s, s.time + 60 * MINUTE);
    expect(x.status).toBe('failed');
    ok(s, 'aaa', {
      kind: 'armyCreate',
      name: 'Y',
      unitIds: ['u4', 'u5', 'u6'],
      candidateId: cand(s, 'land'),
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'free', aggr: 'bold' },
    });
    noFriction(s);
    const y = Object.values(cmd(s).armies).find((a) => a.name === 'Y')!;
    const t0 = s.time;
    for (let h = 1; h <= 72 && y.status !== 'success'; h++) advanceTo(s, t0 + h * HOUR);
    expect(y.status).toBe('success');
    expect(s.provinces['bbb-4']!.owner).toBe('aaa');
  });
});

describe('enchaînement : déterminisme et sauvegardes', () => {
  const chainOrder = (s: EngineState): Order => ({
    kind: 'campaignCreate',
    name: 'Chaîne',
    goal: 'sead',
    nations: ['bbb'],
    roe: 'free',
    aggr: 'bold',
    phaseHours: 6,
    phases: [{ goal: 'occupy', nations: [], provinces: ['bbb-4'] }],
    after: 'home',
    commanders: [{ candidateId: cand(s, 'air') }, { candidateId: cand(s, 'land') }],
  });

  it('rejeu identique et reprise après sérialisation au milieu d’une chaîne de phases', () => {
    const a = theater2(9);
    const b = theater2(9);
    ok(a, 'aaa', chainOrder(a));
    ok(b, 'aaa', chainOrder(b));
    advanceTo(a, 8 * HOUR);
    advanceTo(b, 8 * HOUR);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(lastOp(a).step).toBe(1);
    const c = deserializeState(milWorld(), serializeState(a)) as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    for (const s of [a, c]) advanceTo(s, 4 * 24 * HOUR);
    expect(stateHash(c)).toBe(stateHash(a));
    expect(viewFor(c, 'aaa').command).toEqual(viewFor(a, 'aaa').command);
  });

  it('ancienne sauvegarde (opération et armées sans phases ni posture) : lisible, elle continue', () => {
    const s = theater(3);
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'occupy',
      nations: [],
      provinces: ['bbb-4'],
      roe: 'free',
      aggr: 'bold',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    noFriction(s);
    advanceTo(s, HOUR);
    // Instantané d'avant l'enchaînement : aucun des champs ajoutés.
    const op0 = lastOp(s);
    for (const k of [
      'chain',
      'step',
      'results',
      'after',
      'post',
      'postUntil',
      'gd',
      'cnt',
      'ships',
      'preset',
      'phaseAt',
    ])
      delete (op0 as unknown as Record<string, unknown>)[k];
    for (const a of Object.values(cmd(s).armies)) {
      delete a.post;
      delete a.home;
      delete a.why;
    }
    const old = deserializeState(milWorld(), serializeState(s)) as EngineState;
    const v = viewFor(old, 'aaa').command!;
    expect(v.ops![0]!.after).toBe('hold');
    expect(v.ops![0]!.phases).toBeUndefined();
    const op = lastOp(old);
    runOp(old, op, 72);
    expect(op.status).toBe('success');
    expect(old.provinces['bbb-4']!.owner).toBe('aaa');
    // Après la fin : posture par défaut (tenir les gains).
    expect(cmd(old).armies[op.armies[0]!]!.post).toBe('hold');
  });

  it('modifier les phases et « quand c’est fini » d’une opération en cours, passer à la suivante', () => {
    const s = theater2();
    ok(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'sead',
      nations: ['bbb'],
      roe: 'free',
      commanders: [{ candidateId: cand(s, 'air') }, { candidateId: cand(s, 'land') }],
    });
    const op = lastOp(s);
    expect(op.chain).toBeUndefined();
    ok(s, 'aaa', {
      kind: 'campaignEdit',
      opId: op.id,
      phases: [{ goal: 'air_control' }, { goal: 'occupy', nations: [], provinces: ['bbb-5'] }],
      after: 'reserve',
    });
    expect(op.chain!.map((p) => p.goal)).toEqual(['sead', 'air_control', 'occupy']);
    expect(op.after).toBe('reserve');
    ok(s, 'aaa', { kind: 'campaignEdit', opId: op.id, nextPhase: true });
    expect(op.step).toBe(1);
    expect(op.goal).toBe('air_control');
    expect(op.results).toEqual(['skipped']);
    ok(s, 'aaa', { kind: 'campaignEdit', opId: op.id, stageNow: true });
    expect(op.stageUntil).toBe(s.time);
    // Une phase sans cible est sautée : occuper une province déjà à soi.
    const r = applyOrder(s, 'aaa', {
      kind: 'campaignCreate',
      goal: 'counteroffensive',
      nations: [],
      roe: 'free',
      commanders: [{ candidateId: cand(s, 'land') }],
    });
    expect(r.ok).toBe(false);
  });
});
