/**
 * Gouvernement, logique sans rendu : postes et missions, brouillon de l'assistant (cible, zone,
 * enveloppe), ordre envoyé, estimation des coûts avant validation, couverture de l'enveloppe,
 * commandements du centre de commandement (présents ou non), rendu du journal.
 */
import { describe, expect, it } from 'vitest';
import {
  GovernmentBalanceSchema,
  type GovMissionView,
  type GovernmentView,
  type PlayerView,
  type ProvinceDef,
  type WeaponSystem,
} from '@redline/shared';
import {
  blockedCount,
  budgetDraftOf,
  budgetTotals,
  budgetUsage,
  commandsOf,
  coverCount,
  draftError,
  emptyDraft,
  estimatePlan,
  govText,
  missionIcon,
  missionTypes,
  missionsOf,
  officeHint,
  toBudget,
  toInput,
  vacantWithMissions,
  withType,
} from '../src/lib/government.js';

const B = GovernmentBalanceSchema.parse({});

function gvWith(missions: Partial<GovMissionView>[]): GovernmentView {
  return {
    offices: Object.entries(B.offices).map(([id, d]) => ({
      id: id as never,
      ministry: d.ministry,
      group: d.group,
      head: null,
      candidates: [],
      journal: [],
    })),
    missions: missions.map((m, i) => ({
      id: `m${i + 1}`,
      office: 'economy',
      type: 'resource',
      priority: 2,
      status: 'active',
      budget: { mode: 'amount', amount: 1e9 },
      spent: 0,
      available: 1e9,
      goal: 5,
      done: 0,
      pending: 0,
      progress: 0,
      since: 0,
      ...m,
    })) as GovMissionView[],
    history: [],
    missionDefs: B.missions,
    officeDefs: B.offices,
    salaryPerDay: 0,
    reserveFloor: 0,
    maxMissions: B.maxMissions,
    budgetDay: 1e8,
  };
}

describe('gouvernement : postes et missions', () => {
  it('missions d’un poste par priorité, types dans l’ordre des données, alertes', () => {
    const gv = gvWith([
      { id: 'a', priority: 1, since: 0 },
      { id: 'b', priority: 3, since: 5, status: 'blocked' },
      { id: 'c', priority: 3, since: 1 },
      { id: 'd', office: 'defense', type: 'air_bases', status: 'blocked' },
    ]);
    expect(missionsOf(gv, 'economy').map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(missionTypes(gv, 'economy').map(([t]) => t)[0]).toBe('resource');
    expect(missionTypes(gv, 'research').map(([t]) => t)).toEqual([
      'research_next',
      'research_branch',
      'research_labs',
    ]);
    expect(blockedCount(gv)).toBe(2);
    expect(blockedCount(gv, ['economy'])).toBe(1);
    expect(blockedCount(undefined)).toBe(0);
    expect(vacantWithMissions(gv)).toEqual(['defense', 'economy']);
    const eco = gv.offices.find((o) => o.id === 'economy')!;
    expect(officeHint(eco, missionsOf(gv, 'economy'))).toBe('gov.hint.vacantMissions');
    expect(officeHint(eco, [])).toBe('gov.hint.vacant');
    expect(missionIcon({ type: 'resource', resource: 'metals' })).toBe('metals');
    expect(missionIcon({ type: 'inconnue' })).toBe('target');
  });

  it('enveloppes : dépensé, plafond, totaux', () => {
    expect(
      budgetUsage({ budget: { mode: 'amount', amount: 4e9 }, spent: 1e9, available: 3e9 }),
    ).toEqual({ spent: 1e9, cap: 4e9, ratio: 0.25 });
    expect(
      budgetUsage({ budget: { mode: 'share', pct: 10 }, spent: 2e8, available: 1e8 }).cap,
    ).toBeNull();
    const tot = budgetTotals(
      gvWith([
        { spent: 1e8, budget: { mode: 'amount', amount: 1e9 } },
        { spent: 2e8, budget: { mode: 'share', pct: 5, cap: 5e8 } },
        { spent: 3e8, budget: { mode: 'share', pct: 5 } },
      ]).missions,
    );
    expect(tot).toEqual({ spent: 6e8, allocated: 1.5e9 });
  });
});

describe('gouvernement : assistant', () => {
  it('type, cible et zone par défaut ; ordre envoyé ; erreurs expliquées', () => {
    const d0 = emptyDraft('economy');
    expect(draftError(d0, undefined)).toBe('gov.wizard.err.type');
    const d = withType(d0, 'resource', B.missions.resource!);
    expect(d.resource).toBe('oil');
    expect(d.goal).toBe(B.missions.resource!.goal);
    expect(draftError(d, B.missions.resource)).toBeNull();
    const input = toInput({ ...d, resource: 'metals' }, B.missions.resource!, 1e8);
    expect(input).toEqual({
      type: 'resource',
      priority: 2,
      goal: B.missions.resource!.goal,
      resource: 'metals',
      budget: { mode: 'amount', amount: 2e9 },
    });
    // Zone : frontière avec un pays (choix obligatoire), autour d'une province (rayon).
    const f = withType(emptyDraft('defense'), 'fortify', B.missions.fortify!);
    expect(draftError({ ...f, zone: 'border' }, B.missions.fortify)).toBe('gov.wizard.err.border');
    expect(
      toInput({ ...f, zone: 'border', nationId: 'mar' }, B.missions.fortify!, 1e8).nationId,
    ).toBe('mar');
    const around = toInput(
      { ...f, zone: 'around', provinceId: 'p1', radiusKm: 300 },
      B.missions.fortify!,
      1e8,
    );
    expect(around).toMatchObject({ provinceId: 'p1', radiusKm: 300 });
    expect(around.nationId).toBeUndefined();
    // Renseignement : pays visé obligatoire ; prochaine génération : objectif fixé par le moteur.
    const w = withType(emptyDraft('intel_exterior'), 'watch', B.missions.watch!);
    expect(draftError(w, B.missions.watch)).toBe('gov.wizard.err.nation');
    const r = withType(emptyDraft('research'), 'research_next', B.missions.research_next!);
    expect(toInput(r, B.missions.research_next!, 1e8).goal).toBeUndefined();
    expect(toInput(r, B.missions.research_next!, 1e8).category).toBe('fighter');
  });

  it('enveloppe : montant en jours de budget, part des revenus avec ou sans plafond', () => {
    const unit = 7e7;
    expect(
      toBudget({ mode: 'amount', days: 10, pct: 10, capOn: false, capDays: 60 }, unit),
    ).toEqual({ mode: 'amount', amount: 7e8 });
    expect(toBudget({ mode: 'share', days: 10, pct: 15, capOn: true, capDays: 30 }, unit)).toEqual({
      mode: 'share',
      pct: 15,
      cap: 2.1e9,
    });
    expect(toBudget({ mode: 'share', days: 10, pct: 15, capOn: false, capDays: 30 }, unit)).toEqual(
      { mode: 'share', pct: 15 },
    );
    expect(budgetDraftOf({ mode: 'amount', amount: 7e8 }, unit).days).toBe(10);
    expect(budgetDraftOf({ mode: 'share', pct: 12, cap: 2.1e9 }, unit)).toMatchObject({
      mode: 'share',
      pct: 12,
      capOn: true,
      capDays: 30,
    });
  });
});

describe('gouvernement : prévisions avant validation', () => {
  const provinces: Record<string, ProvinceDef> = {
    a: { id: 'a', neighbors: ['b', 'x'], cityPoint: [0, 0] } as unknown as ProvinceDef,
    b: { id: 'b', neighbors: ['a'], cityPoint: [1, 0] } as unknown as ProvinceDef,
    x: { id: 'x', neighbors: ['a'], cityPoint: [-1, 0] } as unknown as ProvinceDef,
  };
  const view = {
    provinces: {
      a: {
        owner: 'me',
        buildOptions: [
          { type: 'oil_field', level: 1, cost: 8e7, hours: 240 },
          { type: 'fortification', level: 1, cost: 2e7, hours: 72 },
        ],
        buildingState: [],
      },
      b: {
        owner: 'me',
        buildOptions: [
          { type: 'oil_field', level: 1, cost: 8e7, hours: 240, blocked: 'no_resource' },
        ],
        buildingState: [
          { type: 'mine', level: 4, health: 1, next: { level: 5, cost: 4e8, hours: 300 } },
        ],
      },
      x: { owner: 'foe' },
    },
    research: { current: null, queue: [], done: [], modifiers: {} },
  } as unknown as PlayerView;
  const ctx = {
    view,
    me: 'me',
    provinces,
    catalog: {} as Record<string, WeaponSystem>,
    research: {},
    balance: null,
  };

  it('chantiers : niveaux restants de chaque emplacement, objectif, avertissements', () => {
    const d = withType(emptyDraft('economy'), 'resource', B.missions.resource!);
    const est = estimatePlan(ctx, { ...d, goal: 3 }, B.missions.resource)!;
    // Puits neuf à « a » : niveaux 1 à 5 (8e7 × 1,6^k) ; « b » sans pétrole.
    expect(est.options).toBe(5);
    expect(est.first).toBe(8e7);
    expect(est.total).toBeCloseTo(8e7 * (1 + 1.6 + 2.56), -3);
    expect(est.warn).toBeUndefined();
    expect(coverCount(est, 2e8)).toBe(1);
    expect(coverCount(est, 4.2e8)).toBe(3);
    const metals = estimatePlan(ctx, { ...d, resource: 'metals', goal: 5 }, B.missions.resource)!;
    expect(metals.options).toBe(1);
    expect(metals.warn).toBe('gov.estimate.few');
    const food = estimatePlan(ctx, { ...d, resource: 'food' }, B.missions.resource)!;
    expect(food.options).toBe(0);
    expect(food.warn).toBe('gov.estimate.noDeposit');
    // Fortification à la frontière : seulement « a » (voisine d'une province étrangère), 3 niveaux.
    const f = withType(emptyDraft('defense'), 'fortify', B.missions.fortify!);
    const fe = estimatePlan(ctx, f, B.missions.fortify)!;
    expect(fe.options).toBe(3 + 0);
  });

  it('production : prix du matériel le plus récent accessible ; réserve sans dépense', () => {
    const sys = (id: string, gen: number, money: number, requires: string[] = []) =>
      ({
        id,
        category: 'air_defense',
        enabled: true,
        exportable: true,
        generation: gen,
        requires,
        cost: { money, resources: {} },
        buildTimeH: 100,
      }) as unknown as WeaponSystem;
    const catalog = {
      a: sys('a', 3, 5e7),
      b: sys('b', 4, 9e7),
      c: sys('c', 5, 3e8, ['research.x']),
    };
    const research = { 'research.x': { id: 'research.x' } } as never;
    const d = withType(emptyDraft('production'), 'produce', B.missions.produce!);
    const est = estimatePlan({ ...ctx, catalog, research }, { ...d, goal: 4 }, B.missions.produce)!;
    expect(est.first).toBe(9e7);
    expect(est.total).toBe(3.6e8);
    const res = estimatePlan(
      ctx,
      withType(emptyDraft('economy'), 'reserves', B.missions.reserves!),
      B.missions.reserves,
    )!;
    expect(res.free).toBe(true);
  });
});

describe('gouvernement : commandements et journal', () => {
  it('commandements lus s’ils existent, sinon emplacement « en préparation »', () => {
    expect(commandsOf(null)).toBeNull();
    expect(commandsOf({ command: { armies: [] } } as unknown as PlayerView)).toBeNull();
    const view = {
      command: {
        commands: [
          { id: 'c2', domain: 'air', chief: { first: 'Ana', last: 'Lopez' }, operations: [1, 2] },
          { id: 'c1', domain: 'land', chief: null, operations: [] },
          { id: 'c4', domain: 'air_defense', generals: ['g1'] },
          { id: 'c3', domain: 'sea' },
        ],
      },
    } as unknown as PlayerView;
    const list = commandsOf(view)!;
    expect(list.map((c) => c.domain)).toEqual(['land', 'air', 'sea', 'air_defense']);
    expect(list[1]).toMatchObject({ chief: 'Ana Lopez', operations: 2 });
    expect(list[3]!.generals).toBe(1);
  });

  it('journal : sommes en dollars, nœuds de recherche, lieux et clés imbriquées', () => {
    const t = (k: string, o?: Record<string, unknown>) =>
      `${k}(${Object.entries(o ?? {})
        .map(([a, b]) => `${a}=${String(b)}`)
        .join(',')})`;
    const ctx = {
      money: (v: number) => `$${v / 1e6}M`,
      nation: (id: string) => `N:${id}`,
      province: (id: string) => `P:${id}`,
      system: (id: string) => `S:${id}`,
      node: (id: string) => `R:${id}`,
    };
    expect(
      govText(
        {
          key: 'engine.gov.j.built',
          params: {
            building: { key: 'buildings.oil_field' },
            level: 2,
            place: { province: 'p1' },
            cost: 1.2e9,
          },
        },
        t,
        ctx,
      ),
    ).toBe('engine.gov.j.built(building=buildings.oil_field(),level=2,place=P:p1,cost=$1200M)');
    expect(govText({ key: 'k', params: { node: 'research.x' } }, t, ctx)).toBe(
      'k(node=R:research.x)',
    );
    expect(
      govText(
        { key: 'engine.gov.j.blocked', params: { why: { key: 'w', params: { cost: 5e6 } } } },
        t,
        ctx,
      ),
    ).toBe('engine.gov.j.blocked(why=w(cost=$5M))');
  });
});
