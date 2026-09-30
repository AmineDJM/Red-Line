import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  deserializeState,
  publicView,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import { signal } from '../src/modules/registry.js';
import { catchQuietly } from '../src/modules/intel/agents.js';
import { ist } from '../src/modules/intel/state.js';
import { declareWar } from '../src/state/war.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf } from './fixtures.js';
import { intelGame, intelWorld, runOp } from './intel-helpers.js';

/** Partie riche en secrets : agent retourné, intoxication, leurres, opérations en cours. */
function secretGame(seed = 7): EngineState {
  const s = intelGame(
    [
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') },
    ],
    { seed },
  );
  runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb' });
  const agent = Object.values(ist(s).agents)[0]!;
  catchQuietly(s, agent);
  applyOrder(s, 'bbb', { kind: 'turnAgent', agentId: agent.id });
  ist(s).nations.bbb!.ops.at(-1)!.estimate = 1;
  advanceTo(s, s.time + 13 * HOUR);
  for (let i = 0; i < 4 && !ist(s).nations.bbb!.reports.some((r) => r.fk); i++)
    runOp(s, 'aaa', 'plant_fake_report', { nationId: 'bbb', at: cityOf('bbb-5') });
  runOp(s, 'bbb', 'deploy_decoys', { at: cityOf('bbb-4'), nationId: 'aaa' });
  applyOrder(s, 'aaa', { kind: 'intelOp', op: 'steal_research', target: { nationId: 'bbb' } });
  signal(s, 'strike', { by: 'bbb', victim: 'aaa', at: cityOf('aaa-2'), kind: 'artillery' });
  return s;
}

describe('renseignement : vues', () => {
  it('aucune fuite de secret dans les vues des joueurs ni dans la vue publique', () => {
    const s = secretGame();
    expect(Object.values(ist(s).agents).some((a) => a.state === 'double')).toBe(true);
    expect(ist(s).nations.bbb!.reports.some((r) => r.fk)).toBe(true);
    const agent = Object.values(ist(s).agents)[0]!;
    const va = JSON.stringify(viewFor(s, 'aaa'));
    const vb = JSON.stringify(viewFor(s, 'bbb'));
    const vc = JSON.stringify(viewFor(s, 'ccc'));
    const pub = JSON.stringify(publicView(s));
    for (const json of [va, vb, vc, pub]) {
      expect(json).not.toContain('"fk"');
      expect(json).not.toContain('"victim"');
      expect(json).not.toContain('"agentId"');
      expect(json).not.toContain('"deceived"');
      expect(json).not.toContain('"exposed"');
    }
    // Agent retourné : son propriétaire ne le sait pas ; son nom de code reste inconnu des tiers.
    expect(va).not.toContain('"double"');
    expect(vc).not.toContain(agent.codename);
    expect(pub).not.toContain(agent.codename);
    // Leurres : marqués seulement chez leur propriétaire.
    expect(va).not.toContain('"decoy"');
    expect(vb).toContain('"decoy":true');
    // Une nation tierce ne voit ni les rapports ni les opérations des autres.
    const ic = viewFor(s, 'ccc').intel!;
    expect(ic.reports.every((r) => !r.title.includes('réussite'))).toBe(true);
    const own = new Set(ist(s).nations.ccc!.ops.map((o) => o.id));
    expect(ic.operations.every((o) => own.has(o.id))).toBe(true);
    expect(ic.agents.every((a) => ist(s).agents[a.id]!.owner === 'ccc')).toBe(true);
    expect(ic.caughtAgents).toEqual([]);
    expect(publicView(s).intel).toBeUndefined();
  });

  it('vue intel : départements, rapports récents triés et marqués anciens, opérations', () => {
    const s = secretGame();
    const v = viewFor(s, 'aaa').intel!;
    expect(v.departments.map((d) => d.id)).toEqual(['interior', 'exterior', 'military']);
    for (const d of v.departments) {
      expect(d.level).toBe(1);
      expect(d.capacity).toBe(2);
      expect(d.budgetPerDay).toBeGreaterThan(0);
    }
    expect(v.departments.find((d) => d.id === 'exterior')!.running).toBe(1);
    const times = v.reports.map((r) => r.time);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const r of v.reports) expect(!!r.stale).toBe(s.time - r.time > 24 * HOUR);
    const flash = v.reports.find((r) => r.kind === 'flash')!;
    advanceTo(s, s.time + 30 * HOUR);
    const later = viewFor(s, 'aaa').intel!.reports.find((r) => r.id === flash.id)!;
    expect(later.stale).toBe(true);
    // Position de forces : l'incertitude croît avec l'âge du rapport.
    expect(later.radiusKm).toBeGreaterThan(flash.radiusKm);
    expect(viewFor(s, 'aaa').intel!.reports.length).toBeLessThanOrEqual(40);
  });

  it('partage : un rapport partagé arrive chez le destinataire, marqué, jamais chez un ennemi', () => {
    const s = secretGame();
    const rep = viewFor(s, 'aaa').intel!.reports[0]!;
    expect(applyOrder(s, 'aaa', { kind: 'shareReport', reportId: rep.id, to: 'ccc' }).ok).toBe(
      true,
    );
    const got = viewFor(s, 'ccc').intel!.reports.find((r) => r.sharedBy === 'aaa');
    expect(got?.title).toBe(rep.title);
    declareWar(s, 'aaa', 'ddd');
    expect(applyOrder(s, 'aaa', { kind: 'shareReport', reportId: rep.id, to: 'ddd' }).ok).toBe(
      false,
    );
    expect(applyOrder(s, 'aaa', { kind: 'shareReport', reportId: 'r9999', to: 'ccc' }).ok).toBe(
      false,
    );
  });

  it('la vue ne modifie pas l’état', () => {
    const s = secretGame();
    const h = stateHash(s);
    for (const n of s.nationIds) viewFor(s, n);
    publicView(s);
    expect(stateHash(s)).toBe(h);
  });
});

describe('renseignement : déterminisme et sérialisation', () => {
  it('rejeu identique, et reprise après sérialisation au même état', () => {
    const a = secretGame(11);
    const b = secretGame(11);
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(intelWorld(), serializeState(a)) as unknown as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    for (const s of [a, c]) {
      runOp(s, 'aaa', 'listen_area', { at: cityOf('bbb-2'), radiusKm: 200 }, 'natural');
      advanceTo(s, s.time + 3 * DAY);
    }
    expect(stateHash(c)).toBe(stateHash(a));
    expect(JSON.stringify(viewFor(c, 'bbb'))).toBe(JSON.stringify(viewFor(a, 'bbb')));
    expect(JSON.stringify(viewFor(c, 'aaa'))).toBe(JSON.stringify(viewFor(a, 'aaa')));
  });
});

describe('renseignement : IA', () => {
  it('une décision par jour et par nation au plus, contre-espionnage d’abord', () => {
    const s = intelGame([
      { owner: 'ccc', systemId: 'tst.infantry', pos: cityOf('ccc-1') },
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
    ]);
    declareWar(s, 'aaa', 'ccc');
    advanceTo(s, 3 * DAY);
    const ops = ist(s).nations.ccc!.ops;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.length).toBeLessThanOrEqual(3);
    expect(ops[0]!.kind).toBe('counterintel_sweep');
    const days = ops.map((o) => Math.floor((o.startedAt - (ops[0]!.startedAt % DAY)) / DAY));
    expect(new Set(days).size).toBe(days.length);
    // Les nations IA en paix et neutres (ddd) restent discrètes.
    expect(ist(s).nations.ddd!.ops.length).toBeLessThanOrEqual(3);
    // Les joueurs humains ne sont jamais pilotés par l'IA.
    expect(ist(s).nations.bbb!.ops).toHaveLength(0);
  });

  it('retourne en priorité un agent ennemi démasqué', () => {
    const s = intelGame();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'ccc' });
    const agent = Object.values(ist(s).agents).find((a) => a.host === 'ccc')!;
    catchQuietly(s, agent);
    ist(s).nations.ccc!.aiNext = 0;
    advanceTo(s, s.time + HOUR);
    expect(ist(s).nations.ccc!.ops.at(-1)?.kind).toBe('turn_agent');
  });
});
