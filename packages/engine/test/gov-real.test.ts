/**
 * Gouvernement sur les VRAIES données (monde 2025, ORBAT, ressources des provinces) : chaque mission
 * principale produit des actions réelles dans son enveloppe, les compétences du titulaire comptent,
 * le coût des titulaires est prélevé, la partie reste déterministe (rejeu, sérialisation), les
 * anciennes sauvegardes se chargent et la vue ne montre que son propre gouvernement. Provinces
 * désignées par des villes (real-places), jamais par identifiant.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  type GovHeadView,
  type GovMissionInput,
  type GovOffice,
  type NationId,
  type Order,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  applySystem,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { eco, ecoNation } from '../src/modules/eco/state.js';
import { levelOf } from '../src/modules/eco/buildings.js';
import { nat } from '../src/modules/intel/state.js';
import { gov } from '../src/modules/gov/state.js';
import { nextGeneration, researchClosure } from '../src/modules/gov/exec.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
}, 120_000);

function game(players: NationId[], seed = 3): EngineState {
  return createGame(world, {
    seed,
    players: players.map((nationId) => ({ nationId, isAi: false })),
    scenario: data.scenario,
  }) as EngineState;
}

function ok(s: EngineState, n: NationId, o: Order): void {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
}

const gv = (s: EngineState, n: NationId) => viewFor(s, n).government!;

/** Nomme le candidat du vivier qui maximise `score` (le premier sinon). */
function appoint(
  s: EngineState,
  n: NationId,
  office: GovOffice,
  score: (h: GovHeadView) => number = () => 0,
): GovHeadView {
  const cands = gv(s, n)
    .offices.find((o) => o.id === office)!
    .candidates.slice()
    .sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1));
  ok(s, n, { kind: 'govAppoint', office, candidateId: cands[0]!.id });
  return cands[0]!;
}

function mission(s: EngineState, n: NationId, m: GovMissionInput) {
  ok(s, n, { kind: 'govMission', mission: m });
  const list = gv(s, n).missions;
  return list[list.length - 1]!;
}

const missionOf = (s: EngineState, n: NationId, id: string) =>
  gv(s, n).missions.find((m) => m.id === id) ?? gv(s, n).history.find((m) => m.id === id)!;

/** Chantiers de la nation (en cours). */
function jobs(s: EngineState, n: NationId) {
  const es = eco(s);
  return Object.keys(es.jobs)
    .sort()
    .map((k) => es.jobs[k]!)
    .filter((j) => j.n === n);
}

describe('gouvernement : vraies données', { timeout: 600_000 }, () => {
  it('Économie « maximiser le pétrole » : puits lancés là où est le pétrole, jamais à Alger', () => {
    const s = game(['dza']);
    const alger = provinceAt(data.map, PLACES.alger).id;
    appoint(s, 'dza', 'economy');
    const budget = 1e9;
    const m = mission(s, 'dza', {
      type: 'resource',
      resource: 'oil',
      goal: 4,
      budget: { mode: 'amount', amount: budget },
    });
    advanceTo(s, s.time + HOUR);
    const js = jobs(s, 'dza').filter((j) => j.kind === 'oil_field');
    expect(js.length).toBeGreaterThan(0);
    const W = wi(world);
    for (const j of js) {
      expect(j.pid).not.toBe(alger);
      expect(W.provById.get(j.pid)!.resources?.some((r) => r.type === 'oil')).toBe(true);
    }
    const v = missionOf(s, 'dza', m.id);
    expect(v.spent).toBeGreaterThan(0);
    expect(v.spent).toBeLessThanOrEqual(budget);
    const office = gv(s, 'dza').offices.find((o) => o.id === 'economy')!;
    expect(office.journal.some((e) => e.text.key === 'engine.gov.j.built')).toBe(true);
    // Les chantiers aboutissent : niveaux relevés, progression comptée.
    const before = js.map((j) => ({ pid: j.pid, lvl: j.lvl }));
    advanceTo(s, s.time + 14 * DAY);
    for (const b of before) expect(levelOf(s, b.pid, 'oil_field')).toBeGreaterThanOrEqual(b.lvl);
    const v2 = missionOf(s, 'dza', m.id);
    expect(v2.done).toBeGreaterThan(0);
    expect(v2.spent).toBeLessThanOrEqual(budget);
  });

  it('enveloppe jamais dépassée, blocage expliqué (enveloppe, poste vacant, aucun gisement)', () => {
    const s = game(['dza', 'bel']);
    // Poste vacant : la mission attend un titulaire et le dit.
    const m0 = mission(s, 'dza', {
      type: 'resource',
      resource: 'oil',
      budget: { mode: 'amount', amount: 2.5e8 },
    });
    advanceTo(s, s.time + HOUR);
    expect(missionOf(s, 'dza', m0.id).status).toBe('blocked');
    expect(missionOf(s, 'dza', m0.id).why?.key).toBe('engine.gov.why.noHead');
    expect(jobs(s, 'dza')).toHaveLength(0);
    // Petite enveloppe : un chantier tient dedans, pas deux ; puis « enveloppe épuisée ».
    appoint(s, 'dza', 'economy');
    for (let h = 0; h < 48; h++) {
      advanceTo(s, s.time + HOUR);
      expect(missionOf(s, 'dza', m0.id).spent).toBeLessThanOrEqual(2.5e8);
    }
    const v = missionOf(s, 'dza', m0.id);
    expect(v.spent).toBeGreaterThan(0);
    expect(v.status).toBe('active');
    advanceTo(s, s.time + 12 * DAY);
    const v2 = missionOf(s, 'dza', m0.id);
    expect(v2.spent).toBeLessThanOrEqual(2.5e8);
    expect(['blocked', 'done']).toContain(v2.status);
    if (v2.status === 'blocked') expect(v2.why?.key).toBe('engine.gov.why.envelope');
    // Aucun gisement de pétrole en Belgique : la mission le dit, rien n'est lancé.
    expect(
      data.map.provinces.some(
        (p) => p.nationId === 'bel' && p.resources?.some((r) => r.type === 'oil'),
      ),
    ).toBe(false);
    appoint(s, 'bel', 'economy');
    const mb = mission(s, 'bel', {
      type: 'resource',
      resource: 'oil',
      budget: { mode: 'share', pct: 20 },
    });
    advanceTo(s, s.time + HOUR);
    const vb = missionOf(s, 'bel', mb.id);
    expect(vb.status).toBe('blocked');
    expect(vb.why?.key).toBe('engine.gov.why.noDeposit');
    expect(jobs(s, 'bel').filter((j) => j.kind === 'oil_field')).toHaveLength(0);
  });

  it('Défense « bases aériennes » : base aérienne lancée ou améliorée là où c’est permis', () => {
    const s = game(['dza']);
    appoint(s, 'dza', 'defense');
    const budget = 2e9;
    const m = mission(s, 'dza', {
      type: 'air_bases',
      goal: 2,
      budget: { mode: 'amount', amount: budget },
    });
    advanceTo(s, s.time + HOUR);
    const js = jobs(s, 'dza').filter((j) => j.kind === 'air_base');
    expect(js.length).toBeGreaterThan(0);
    for (const j of js) expect(s.provinces[j.pid]!.owner).toBe('dza');
    const v = missionOf(s, 'dza', m.id);
    expect(v.spent).toBeGreaterThan(0);
    expect(v.spent).toBeLessThanOrEqual(budget);
    // Fortifier la frontière avec le Maroc : provinces frontalières seulement.
    const f = mission(s, 'dza', {
      type: 'fortify',
      nationId: 'mar',
      goal: 2,
      budget: { mode: 'amount', amount: 2e8 },
    });
    advanceTo(s, s.time + HOUR);
    const W = wi(world);
    const forts = jobs(s, 'dza').filter((j) => j.kind === 'fortification' || j.kind === 'bunker');
    expect(forts.length).toBeGreaterThan(0);
    for (const j of forts)
      expect(W.provById.get(j.pid)!.neighbors.some((q) => s.provinces[q]?.owner === 'mar')).toBe(
        true,
      );
    expect(missionOf(s, 'dza', f.id).spent).toBeLessThanOrEqual(2e8);
  });

  it('Direction de la recherche : prochaine génération de chasseurs, recherche par domaine', () => {
    const s = game(['dza', 'fra']);
    // Trésorerie portée à 20 Md$ : la génération suivante (nœuds de 4 à 15 Md$) devient abordable
    // au-dessus de la réserve de prudence.
    applySystem(s, { kind: 'grant', nationId: 'fra', money: 2e10 });
    appoint(s, 'fra', 'research', (h) => h.effects.speed);
    const m = mission(s, 'fra', {
      type: 'research_next',
      category: 'fighter',
      budget: { mode: 'amount', amount: 6e9 },
    });
    advanceTo(s, s.time + HOUR);
    const next = nextGeneration(s, 'fra', 'fighter');
    expect(next).not.toBeNull();
    const closure = researchClosure(s, 'fra', next!.gates);
    const en = ecoNation(s, 'fra');
    const started = [en.cur?.id, ...en.queue.map((q) => q.id)].filter((x): x is string => !!x);
    expect(started.some((id) => closure.has(id))).toBe(true);
    const v = missionOf(s, 'fra', m.id);
    expect(v.goal).toBeGreaterThan(0);
    expect(v.spent).toBeGreaterThan(0);
    expect(v.spent).toBeLessThanOrEqual(6e9);
    expect(v.pending).toBeGreaterThan(0);
    // Algérie : la génération suivante coûte plus que sa trésorerie ; la mission le dit.
    appoint(s, 'dza', 'research');
    const a = mission(s, 'dza', {
      type: 'research_next',
      category: 'fighter',
      budget: { mode: 'amount', amount: 5e10 },
    });
    advanceTo(s, s.time + HOUR);
    const va = missionOf(s, 'dza', a.id);
    if (va.pending === 0) {
      expect(va.status).toBe('blocked');
      expect(['engine.gov.why.funds', 'engine.gov.why.reserve']).toContain(va.why?.key);
    }
    // Recherche par domaine : deux nœuds de la branche navale.
    const b = mission(s, 'fra', {
      type: 'research_branch',
      branch: 'naval',
      goal: 2,
      budget: { mode: 'amount', amount: 5e9 },
    });
    advanceTo(s, s.time + HOUR);
    const ef = ecoNation(s, 'fra');
    const ids = [ef.cur?.id, ...ef.queue.map((q) => q.id)].filter((x): x is string => !!x);
    expect(ids.some((id) => world.research!.get(id)?.branch === 'naval')).toBe(true);
    expect(missionOf(s, 'fra', b.id).spent).toBeLessThanOrEqual(5e9);
  });

  it('Direction de la production : batteries antiaériennes commandées puis livrées', () => {
    const s = game(['fra']);
    appoint(s, 'fra', 'production');
    const budget = 3e9;
    const m = mission(s, 'fra', {
      type: 'produce',
      category: 'air_defense',
      goal: 4,
      budget: { mode: 'amount', amount: budget },
    });
    advanceTo(s, s.time + HOUR);
    const items = s.nations.fra!.production.filter(
      (it) => world.catalog.get(it.systemId)!.category === 'air_defense',
    );
    expect(items.length).toBeGreaterThan(0);
    const v = missionOf(s, 'fra', m.id);
    expect(v.spent).toBeGreaterThan(0);
    expect(v.spent).toBeLessThanOrEqual(budget);
    for (let d = 0; d < 30 && missionOf(s, 'fra', m.id).status !== 'done'; d++)
      advanceTo(s, s.time + DAY);
    const v2 = missionOf(s, 'fra', m.id);
    expect(v2.done).toBeGreaterThanOrEqual(1);
    expect(v2.spent).toBeLessThanOrEqual(budget);
  });

  it('Directions du renseignement : surveillance de la Belgique, contre-espionnage', () => {
    const s = game(['fra', 'bel']);
    appoint(s, 'fra', 'intel_exterior');
    const m = mission(s, 'fra', {
      type: 'watch',
      nationId: 'bel',
      goal: 2,
      budget: { mode: 'amount', amount: 5e8 },
    });
    advanceTo(s, s.time + HOUR);
    const ops = nat(s, 'fra').ops.filter((o) => o.victim === 'bel');
    expect(ops.length).toBeGreaterThan(0);
    expect(missionOf(s, 'fra', m.id).spent).toBeLessThanOrEqual(5e8);
    expect(missionOf(s, 'fra', m.id).pending).toBeGreaterThan(0);
    appoint(s, 'fra', 'intel_interior');
    mission(s, 'fra', {
      type: 'counterintel',
      goal: 1,
      budget: { mode: 'amount', amount: 2e8 },
    });
    advanceTo(s, s.time + HOUR);
    expect(viewFor(s, 'fra').intel!.interior!.focus).toBe('counterintel');
    expect(nat(s, 'fra').ops.some((o) => o.kind === 'counterintel_sweep')).toBe(true);
    // Le joueur garde la main : ses propres opérations restent possibles.
    const r = applyOrder(s, 'fra', {
      kind: 'intelOp',
      op: 'recon_economic',
      target: { nationId: 'bel' },
    });
    expect(r.error).not.toBe('not_allowed');
  });

  it('compétences du titulaire : rabais et vitesse modestes, mesurés sur les chantiers', () => {
    const run = (best: boolean) => {
      const s = game(['dza']);
      const h = appoint(s, 'dza', 'economy', (x) =>
        best ? x.effects.discount + x.effects.speed : -(x.effects.discount + x.effects.speed),
      );
      const m = mission(s, 'dza', {
        type: 'industry',
        goal: 3,
        budget: { mode: 'amount', amount: 3e9 },
      });
      advanceTo(s, s.time + HOUR);
      const js = jobs(s, 'dza');
      const paid = js.reduce((a, j) => a + j.paid, 0);
      return { h, js, paid, spent: missionOf(s, 'dza', m.id).spent };
    };
    const best = run(true);
    const worst = run(false);
    expect(best.h.effects.discount).toBeGreaterThan(worst.h.effects.discount);
    expect(best.paid).toBeGreaterThan(0);
    // Dépense nette = coût des chantiers moins le rabais négocié.
    expect(best.spent).toBeCloseTo(best.paid * (1 - best.h.effects.discount), -2);
    expect(worst.spent).toBeCloseTo(worst.paid * (1 - worst.h.effects.discount), -2);
    // Effets modestes et réalistes.
    expect(best.h.effects.discount).toBeLessThanOrEqual(0.1);
    expect(best.h.effects.speed).toBeLessThanOrEqual(0.15);
  });

  it('coût des titulaires prélevé chaque jour (grand livre « government »)', () => {
    const s = game(['fra']);
    appoint(s, 'fra', 'economy');
    appoint(s, 'fra', 'defense');
    const salary = gv(s, 'fra').salaryPerDay;
    expect(salary).toBeGreaterThan(0);
    // Jour 1 : primes de nomination ; jour 2 : coût journalier seul.
    advanceTo(s, s.time + 2 * DAY + HOUR);
    expect(ecoNation(s, 'fra').lastDay.government).toBeCloseTo(-salary, 0);
  });

  it('déterminisme : rejeu identique, reprise d’un instantané, ancienne sauvegarde', () => {
    const play = () => {
      const s = game(['dza', 'fra'], 9);
      appoint(s, 'dza', 'economy');
      appoint(s, 'fra', 'production');
      mission(s, 'dza', { type: 'resource', resource: 'oil', budget: { mode: 'share', pct: 30 } });
      mission(s, 'fra', {
        type: 'stockpile',
        category: 'strike_missile',
        budget: { mode: 'share', pct: 10 },
      });
      advanceTo(s, s.time + DAY);
      return s;
    };
    const a = play();
    const b = play();
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(world, serializeState(a)) as EngineState;
    expect(stateHash(c)).toBe(stateHash(a));
    advanceTo(a, a.time + 2 * DAY);
    advanceTo(c, c.time + 2 * DAY);
    expect(stateHash(c)).toBe(stateHash(a));
    expect(gv(c, 'dza').missions).toEqual(gv(a, 'dza').missions);
    // Ancienne sauvegarde sans gouvernement : la vue se construit, les ordres marchent.
    const old = game(['fra']);
    delete (old.mods as Record<string, unknown>).gov;
    const back = deserializeState(world, serializeState(old)) as EngineState;
    const v = gv(back, 'fra');
    expect(v.missions).toEqual([]);
    expect(v.offices.find((o) => o.id === 'economy')!.candidates.length).toBeGreaterThan(0);
    appoint(back, 'fra', 'economy');
    expect(gov(back).nations.fra!.heads.economy).toBeDefined();
  });

  it('suspendre, modifier, retirer ; aucune fuite dans la vue des autres', () => {
    const s = game(['fra', 'bel']);
    appoint(s, 'fra', 'economy');
    const m = mission(s, 'fra', {
      type: 'revenue',
      goal: 6,
      budget: { mode: 'amount', amount: 2e9 },
    });
    ok(s, 'fra', { kind: 'govMissionSuspend', missionId: m.id, on: true });
    const n0 = jobs(s, 'fra').length;
    advanceTo(s, s.time + 6 * HOUR);
    expect(jobs(s, 'fra').length).toBe(n0);
    expect(missionOf(s, 'fra', m.id).status).toBe('suspended');
    ok(s, 'fra', { kind: 'govMissionEdit', missionId: m.id, priority: 3, goal: 2 });
    ok(s, 'fra', { kind: 'govMissionSuspend', missionId: m.id, on: false });
    advanceTo(s, s.time + HOUR);
    expect(jobs(s, 'fra').length).toBeGreaterThan(n0);
    expect(missionOf(s, 'fra', m.id).priority).toBe(3);
    // Vue de la Belgique : ni les missions ni le ministre français.
    const vb = viewFor(s, 'bel');
    expect(vb.government!.missions).toEqual([]);
    const fraHead = gv(s, 'fra').offices.find((o) => o.id === 'economy')!.head!;
    expect(vb.government!.offices.find((o) => o.id === 'economy')!.head).toBeNull();
    expect(JSON.stringify(vb.government)).not.toContain(`"${fraHead.id}"`);
    // Retrait : la mission passe à l'historique, ce qui est lancé continue.
    ok(s, 'fra', { kind: 'govMissionCancel', missionId: m.id });
    expect(gv(s, 'fra').missions.find((x) => x.id === m.id)).toBeUndefined();
    expect(gv(s, 'fra').history[0]!.id).toBe(m.id);
    expect(jobs(s, 'fra').length).toBeGreaterThan(n0);
  });
});
