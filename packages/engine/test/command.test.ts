/**
 * Centre de commandement (module cmd), scénarios synthétiques : armées (création, affectation,
 * transfert, retrait, renforts, dissolution), généraux (vivier fictif déterministe, barème des soldes,
 * recrutement, solde journalière, limogeage, démission faute de paiement, bonus), missions (Défendre,
 * Supériorité aérienne, Réserve), influence du général (prudent ou audacieux), règle de l'ordre
 * manuel, autorisation avant la guerre, rejeu, reprise après sérialisation et confidentialité de la vue.
 */
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, distanceKm, generalRating, type Order } from '@redline/shared';
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
import { atWar, unitPosAt } from '../src/state/access.js';
import { cmd } from '../src/modules/command/state.js';
import { candidate, commandModifier, salaryOf } from '../src/modules/command/generals.js';
import { CULTURES } from '../src/modules/command/names.js';
import { mil } from '../src/modules/mil/state.js';
import { ecoNation } from '../src/modules/eco/state.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cityOf } from './fixtures.js';
import { milSandbox, milWorld, notesOf } from './mil-fixtures.js';

const ok = (s: EngineState, n: string, o: Order) => {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
};

/** Partie avec trésorerie (les soldes sont en dollars réels). */
function game(units: Parameters<typeof milSandbox>[0], seed = 1): EngineState {
  const s = milSandbox(units, { seed });
  for (const n of ['aaa', 'bbb']) applySystem(s, { kind: 'grant', nationId: n, money: 1e9 });
  return s;
}

function armyOf(s: EngineState, n: string, i = 0) {
  return viewFor(s, n).command!.armies[i]!;
}

/** Recrute le candidat d'indice `k` et lui confie l'armée. */
function hire(s: EngineState, n: string, armyId: string, k = 0): string {
  const c = viewFor(s, n).command!.candidates[k]!;
  ok(s, n, { kind: 'generalHire', candidateId: c.id, armyId });
  return Object.keys(cmd(s).gens).sort().pop()!;
}

describe('centre de commandement : armées', () => {
  it('créer, transférer, retirer, renforcer, dissoudre ; une pile n’appartient qu’à une armée', () => {
    const s = game([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }, // u2
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u3
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') }, // u4
    ]);
    ok(s, 'aaa', { kind: 'armyCreate', name: '1re Armée', unitIds: ['u1', 'u2'] });
    const a1 = armyOf(s, 'aaa');
    expect(a1).toMatchObject({ name: '1re Armée', unitIds: ['u1', 'u2'], status: 'idle' });
    expect(a1.strength.now).toBeGreaterThan(0);
    expect(applyOrder(s, 'aaa', { kind: 'armyCreate', name: 'X', unitIds: ['u4'] }).error).toBe(
      'not_owner',
    );
    // u2 rejoint le groupe aérien : elle quitte la 1re Armée.
    ok(s, 'aaa', { kind: 'armyCreate', name: 'Groupe aérien Sud', unitIds: ['u3', 'u2'] });
    const [x1, x2] = viewFor(s, 'aaa').command!.armies;
    expect(x1!.unitIds).toEqual(['u1']);
    expect(x2!.unitIds).toEqual(['u2', 'u3']);
    ok(s, 'aaa', { kind: 'armyEdit', armyId: x1!.id, add: ['u2'], name: '1re Armée blindée' });
    expect(armyOf(s, 'aaa').unitIds).toEqual(['u1', 'u2']);
    expect(armyOf(s, 'aaa').name).toBe('1re Armée blindée');
    expect(armyOf(s, 'aaa', 1).unitIds).toEqual(['u3']);
    ok(s, 'aaa', { kind: 'armyEdit', armyId: x1!.id, remove: ['u1'], reinforce: 'auto' });
    expect(armyOf(s, 'aaa')).toMatchObject({ unitIds: ['u2'], reinforce: 'auto' });
    ok(s, 'aaa', { kind: 'armyDissolve', armyId: x2!.id });
    expect(viewFor(s, 'aaa').command!.armies.map((a) => a.id)).toEqual([x1!.id]);
    expect(cmd(s).unitArmy.u3).toBeUndefined();
    // Une pile détruite quitte son armée.
    ok(s, 'aaa', { kind: 'armyEdit', armyId: x1!.id, add: ['u1'] });
    expect(applyOrder(s, 'bbb', { kind: 'armyEdit', armyId: x1!.id, remove: ['u1'] }).error).toBe(
      'invalid_target',
    );
    // Confidentialité : l'autre joueur ne voit ni armée ni général, seulement son propre vivier.
    const vb = viewFor(s, 'bbb').command!;
    expect(vb.armies).toEqual([]);
    expect(vb.generals).toEqual([]);
    expect(JSON.stringify(viewFor(s, 'bbb'))).not.toContain('1re Armée');
  });
});

describe('centre de commandement : généraux', () => {
  it('vivier fictif et déterministe, soldes selon le grade, recrutement, solde, limogeage', () => {
    const s = game([{ owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') }]);
    const v = viewFor(s, 'aaa').command!;
    expect(v.candidates.length).toBe(6);
    // Même graine : mêmes candidats ; noms tirés des listes fictives de l'aire culturelle.
    const again = game([{ owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') }]);
    expect(viewFor(again, 'aaa').command!.candidates).toEqual(v.candidates);
    const all = Object.values(CULTURES);
    for (const c of v.candidates) {
      expect(all.some((x) => x.first.includes(c.first) && x.last.includes(c.last))).toBe(true);
      expect(c.salaryPerDay).toBeGreaterThan(0);
      expect(c.hireCost).toBe(c.salaryPerDay * 5);
    }
    // Barème : sur 200 candidats, le grade et la solde croissent avec la note globale.
    const pool = [...Array(200).keys()].map((i) => candidate(s, 'aaa', i));
    const rated = pool
      .map((c) => ({ r: generalRating(c.skills), pay: salaryOf(s, 'aaa', c.skills, []) }))
      .sort((a, b) => a.r - b.r);
    const low = rated.slice(0, 40).reduce((x, y) => x + y.pay, 0) / 40;
    const high = rated.slice(-40).reduce((x, y) => x + y.pay, 0) / 40;
    expect(high).toBeGreaterThan(2.5 * low);
    expect(rated[0]!.pay).toBeGreaterThanOrEqual(35_000);
    expect(rated[rated.length - 1]!.pay).toBeLessThanOrEqual(400_000 * 1.3 * 1.2);

    ok(s, 'aaa', { kind: 'armyCreate', name: '1re Armée', unitIds: ['u1'] });
    const a = armyOf(s, 'aaa');
    const c0 = v.candidates[0]!;
    const before = s.nations.aaa!.money;
    ok(s, 'aaa', { kind: 'generalHire', candidateId: c0.id, armyId: a.id });
    expect(before - s.nations.aaa!.money).toBe(c0.hireCost);
    expect(ecoNation(s, 'aaa').today.command).toBe(-c0.hireCost);
    const v2 = viewFor(s, 'aaa').command!;
    expect(v2.generals).toHaveLength(1);
    expect(v2.generals[0]).toMatchObject({ first: c0.first, last: c0.last, armyId: a.id });
    expect(v2.armies[0]!.generalId).toBe(v2.generals[0]!.id);
    expect(v2.salaryPerDay).toBe(c0.salaryPerDay);
    // Le candidat recruté est remplacé dans le vivier.
    expect(v2.candidates.map((x) => x.id)).not.toContain(c0.id);
    expect(v2.candidates).toHaveLength(6);
    // Solde journalière (grand livre « command »).
    const l0 = ecoNation(s, 'aaa').today.command ?? 0;
    advanceTo(s, DAY + MINUTE);
    const en = ecoNation(s, 'aaa');
    expect((en.today.command ?? 0) + (en.lastDay.command ?? 0) - l0).toBe(-c0.salaryPerDay);
    // Limogeage : indemnité de 10 jours ; l'armée devient passive.
    const gid = v2.generals[0]!.id;
    const m1 = s.nations.aaa!.money;
    ok(s, 'aaa', { kind: 'generalDismiss', generalId: gid });
    expect(m1 - s.nations.aaa!.money).toBe(c0.salaryPerDay * 10);
    expect(viewFor(s, 'aaa').command!.generals).toEqual([]);
    expect(armyOf(s, 'aaa').generalId).toBeNull();
  });

  it('solde impayée : démission après 3 jours ; bonus modestes du général', () => {
    const s = game([{ owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-2') }]);
    ok(s, 'aaa', { kind: 'armyCreate', name: 'A', unitIds: ['u1'] });
    const gid = hire(s, 'aaa', armyOf(s, 'aaa').id);
    const g = cmd(s).gens[gid]!;
    g.skills.defense = 100;
    g.skills.offense = 100;
    g.skills.experience = 100;
    g.traits = [];
    const u = s.units.u1!;
    // Bonus réalistes : quelques pour cent (5 % au maximum de compétence et d'expérience).
    expect(commandModifier(s, u, 'combat.armor')).toBeCloseTo(1.05, 9);
    expect(commandModifier(s, u, 'combat.damage')).toBe(1);
    expect(commandModifier(s, u, 'naval.sonar')).toBe(1);
    s.nations.aaa!.money = 0;
    const notes = advanceTo(s, 2 * DAY + MINUTE);
    expect(cmd(s).gens[gid]?.unpaid).toBe(2);
    notes.push(...advanceTo(s, 3 * DAY + MINUTE));
    expect(cmd(s).gens[gid]).toBeUndefined();
    expect(armyOf(s, 'aaa').generalId).toBeNull();
    const gen = notesOf(notes, 'generic').filter((x) => x.category === 'command');
    expect(gen.some((x) => x.loc?.title.key === 'engine.note.cmd_generalResigned.title')).toBe(
      true,
    );
  });
});

describe('centre de commandement : missions', () => {
  it('Défendre : le général fait venir les piles dans la zone et tient la ville', () => {
    const s = game([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u2
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u3
    ]);
    ok(s, 'aaa', { kind: 'armyCreate', name: 'Défense Nord', unitIds: ['u1', 'u2', 'u3'] });
    const a = armyOf(s, 'aaa');
    // Sans général : mission passive (aucun ordre).
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: a.id,
      mission: { type: 'defend', at: cityOf('aaa-3'), radiusKm: 100 },
    });
    advanceTo(s, HOUR);
    expect(armyOf(s, 'aaa').status).toBe('passive');
    expect(s.units.u1!.move).toBeNull();
    hire(s, 'aaa', a.id);
    cmd(s).gens[Object.keys(cmd(s).gens)[0]!]!.skills.experience = 100; // pas de frictions
    advanceTo(s, 2 * HOUR);
    const moving = ['u1', 'u2', 'u3'].filter((id) => s.units[id]!.move);
    expect(moving.length).toBeGreaterThan(0);
    advanceTo(s, 2 * DAY);
    const there = ['u1', 'u2', 'u3'].filter(
      (id) => distanceKm(unitPosAt(s, s.units[id]!, s.time), cityOf('aaa-3')) <= 10,
    );
    expect(there.length).toBeGreaterThanOrEqual(1);
    const v = armyOf(s, 'aaa');
    expect(v.status).toBe('active');
    expect(v.objective).toEqual({ done: 1, total: 1 });
    expect(v.mission).toMatchObject({ type: 'defend', brain: 'defend', aggr: 'balanced' });
  });

  it('Supériorité aérienne : des chasseurs en patrouille au-dessus de la zone', () => {
    const s = game([
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u1
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u2
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u3
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u4
    ]);
    ok(s, 'aaa', { kind: 'armyCreate', name: 'Groupe aérien', unitIds: ['u1', 'u2', 'u3', 'u4'] });
    const a = armyOf(s, 'aaa');
    const gid = hire(s, 'aaa', a.id);
    cmd(s).gens[gid]!.skills.experience = 100;
    cmd(s).gens[gid]!.traits = [];
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: a.id,
      mission: { type: 'air_superiority', at: cityOf('aaa-3'), radiusKm: 150, aggr: 'balanced' },
    });
    advanceTo(s, 10 * MINUTE);
    const ms = mil(s).ms;
    const on = ['u1', 'u2', 'u3', 'u4'].filter((id) => ms[id]?.mis === 'patrol');
    // Équilibré : trois quarts de la chasse en l'air, le reste en alerte au sol.
    expect(on.length).toBe(3);
    for (const id of on) expect(distanceKm(ms[id]!.at!, cityOf('aaa-3'))).toBeLessThan(1);
    expect(armyOf(s, 'aaa').objective).toEqual({ done: 1, total: 1 });
  });

  it('Conquérir : autorisation demandée avant la guerre (règles standard), puis offensive', () => {
    const s = game([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u2
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u3
    ]);
    ok(s, 'aaa', { kind: 'armyCreate', name: '1re Armée', unitIds: ['u1', 'u2', 'u3'] });
    const a = armyOf(s, 'aaa');
    const gid = hire(s, 'aaa', a.id);
    cmd(s).gens[gid]!.skills.experience = 100;
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: a.id,
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'standard' },
    });
    const notes = advanceTo(s, 10 * MINUTE);
    const v = armyOf(s, 'aaa');
    expect(v.status).toBe('awaiting');
    expect(v.request).toMatchObject({ kind: 'declare_war', nationId: 'bbb' });
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(s.units.u1!.move).toBeNull();
    expect(notesOf(notes, 'generic').some((x) => x.category === 'command')).toBe(true);
    ok(s, 'aaa', { kind: 'armyAnswer', armyId: a.id, requestId: v.request!.id, accept: true });
    advanceTo(s, 20 * MINUTE);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(['u1', 'u2', 'u3'].some((id) => s.units[id]!.move)).toBe(true);
    let t = s.time;
    while (s.provinces['bbb-4']!.owner !== 'aaa' && t < 6 * DAY) advanceTo(s, (t += HOUR));
    expect(s.provinces['bbb-4']!.owner).toBe('aaa');
    advanceTo(s, s.time + HOUR);
    const end = armyOf(s, 'aaa');
    expect(end.status).toBe('success');
    expect(end.objective).toEqual({ done: 1, total: 1 });
    expect(end.journal.some((e) => e.text.key === 'engine.cmd.j.captured')).toBe(true);
    expect(viewFor(s, 'aaa').command!.generals[0]!.victories).toBe(1);
  });

  it('influence du général : un prudent n’attaque pas une ville tenue, un audacieux si', () => {
    const run = (audacity: number, aggr: 'cautious' | 'bold') => {
      const s = game([
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u2
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u3
        { owner: 'aaa', systemId: 'tst.drone', pos: [4.95, 40] }, // u4 : voit la ville visée
        { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-4') }, // u5
        { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') }, // u6
      ]);
      ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
      advanceTo(s, 5 * MINUTE);
      ok(s, 'aaa', { kind: 'armyCreate', name: 'A', unitIds: ['u1', 'u2', 'u3'] });
      const a = armyOf(s, 'aaa');
      const gid = hire(s, 'aaa', a.id);
      const g = cmd(s).gens[gid]!;
      g.skills = { ...g.skills, audacity, offense: 60, experience: 100, logistics: 20 };
      g.traits = [];
      ok(s, 'aaa', {
        kind: 'armyMission',
        armyId: a.id,
        mission: { type: 'conquer', provinceId: 'bbb-4', aggr, roe: 'free' },
      });
      advanceTo(s, 15 * MINUTE);
      return ['u1', 'u2', 'u3'].filter((id) => s.units[id]!.move).length;
    };
    expect(run(10, 'cautious')).toBe(0);
    expect(run(90, 'bold')).toBeGreaterThanOrEqual(2);
  });

  it('ordre manuel : la pile obéit au joueur jusqu’à la fin de l’ordre, puis le général la reprend', () => {
    const s = game([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') }, // u1
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') }, // u2
    ]);
    ok(s, 'aaa', { kind: 'armyCreate', name: 'Réserve', unitIds: ['u1', 'u2'] });
    const a = armyOf(s, 'aaa');
    const gid = hire(s, 'aaa', a.id);
    cmd(s).gens[gid]!.skills.experience = 100;
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: a.id,
      mission: { type: 'defend', at: cityOf('aaa-3'), radiusKm: 80 },
    });
    advanceTo(s, 5 * MINUTE);
    // Le joueur reprend u1 : direction aaa-2.
    ok(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-2') });
    expect(armyOf(s, 'aaa').manualIds).toEqual(['u1']);
    advanceTo(s, 2 * HOUR);
    const dest = s.units.u1!.move?.legs.at(-1)?.to;
    if (dest) expect(distanceKm(dest, cityOf('aaa-2'))).toBeLessThan(15);
    // Arrivée : le général reprend la pile et l'envoie dans la zone.
    let t = s.time;
    while (s.units.u1!.move && t < 3 * DAY) advanceTo(s, (t += HOUR));
    advanceTo(s, s.time + HOUR);
    expect(armyOf(s, 'aaa').manualIds).toEqual([]);
    advanceTo(s, s.time + DAY * 2);
    expect(distanceKm(unitPosAt(s, s.units.u1!, s.time), cityOf('aaa-3'))).toBeLessThan(20);
  });
});

describe('centre de commandement : déterminisme', () => {
  function scripted(seed: number): EngineState {
    const s = game(
      [
        { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') },
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
        { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
        { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') },
        { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
      ],
      seed,
    );
    ok(s, 'aaa', { kind: 'armyCreate', name: 'A', unitIds: ['u1', 'u2', 'u3', 'u4'] });
    const a = armyOf(s, 'aaa');
    hire(s, 'aaa', a.id, 2);
    ok(s, 'aaa', {
      kind: 'armyMission',
      armyId: a.id,
      mission: { type: 'conquer', provinceId: 'bbb-4', roe: 'free', aggr: 'bold' },
    });
    return s;
  }

  it('rejeu identique et reprise après sérialisation au milieu de la mission', () => {
    const log: string[] = [];
    setAiTracer((_st, n, o) => log.push(`${n}:${o.kind}`));
    const a = scripted(7);
    const b = scripted(7);
    advanceTo(a, 12 * HOUR);
    advanceTo(b, 12 * HOUR);
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(milWorld(), serializeState(a)) as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    for (const s of [a, c]) advanceTo(s, 3 * DAY);
    setAiTracer(null);
    expect(stateHash(c)).toBe(stateHash(a));
    expect(viewFor(c, 'aaa').command).toEqual(viewFor(a, 'aaa').command);
    expect(log.some((x) => x === 'aaa:move')).toBe(true);
  });
});
