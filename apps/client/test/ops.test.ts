/**
 * Opérations (fenêtre QG), logique sans rendu : arme d'une pile, forces libres par commandement,
 * état-major proposé selon l'objectif, estimation avant validation, mesure principale du tableau de
 * bord, brouillon de l'assistant (pays et provinces désignés sur la carte), couche de la carte
 * (flèches des généraux, pays visés).
 */
import { describe, expect, it } from 'vitest';
import type {
  ArmyView,
  CampaignView,
  CommandBranchView,
  CommandGeneralView,
  CommandView,
  DefenseCommandView,
  LngLat,
  OpGoalDef,
  PlayerView,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import {
  branchFit,
  branchOfPile,
  chainDef,
  chainGoal,
  chainOf,
  freeByBranch,
  freeGenerals,
  goalByProvinces,
  goalCatalog,
  goalList,
  liveOps,
  opHeadline,
  previewOp,
  sparePiles,
  suggestStaff,
  targetsOk,
} from '../src/lib/ops.js';
import { commandsOf } from '../src/lib/government.js';
import { useCommandUi } from '../src/store/command.js';
import { commandFeatures, targetNations } from '../src/map/commandLayer.js';

const sys = (id: string, movement: string, category: string, money: number) =>
  ({
    id,
    name: id,
    movement,
    category,
    unitSize: 1,
    speedKmh: movement === 'air' ? 900 : 40,
    cost: { money },
  }) as unknown as WeaponSystem;

const catalog: Record<string, WeaponSystem> = {
  tank: sys('tank', 'land', 'tank', 10_000_000),
  jet: sys('jet', 'air', 'fighter', 80_000_000),
  ship: sys('ship', 'sea', 'surface_ship', 900_000_000),
  sam: sys('sam', 'land', 'air_defense', 50_000_000),
};

const unit = (id: string, systemId: string, pos: LngLat = [3, 50]): UnitView =>
  ({
    id,
    owner: 'fra',
    level: 'own',
    pos,
    lastSeen: 0,
    uncertaintyKm: 0,
    systemId,
    count: 10,
    hpRatio: 1,
    status: 'idle',
  }) as UnitView;

const gen = (
  id: string,
  branch: CommandGeneralView['branch'],
  o: Partial<CommandGeneralView> = {},
) =>
  ({
    id,
    first: 'Jean',
    last: id,
    culture: 'fr',
    rank: 2,
    skills: {
      offense: 50,
      defense: 50,
      logistics: 50,
      air: 50,
      naval: 50,
      audacity: 50,
      experience: 50,
    },
    traits: [],
    xp: 0,
    salaryPerDay: 100_000,
    hireCost: 500_000,
    severance: 1_000_000,
    status: 'candidate',
    armyId: null,
    victories: 0,
    branch,
    ...o,
  }) as CommandGeneralView;

const GOALS: Record<string, OpGoalDef> = {
  conquest: {
    order: 3,
    branches: ['land', 'air', 'ad', 'sea'],
    target: 'nation',
    continuous: false,
    success: 1,
  },
  attrition: {
    order: 1,
    branches: ['air', 'land', 'sea'],
    target: 'nation',
    continuous: false,
    success: 0.5,
  },
};

function branches(): CommandBranchView[] {
  const forces = { piles: 0, free: 0, elements: 0, value: 0 };
  return [
    {
      id: 'land',
      chiefId: null,
      generalIds: [],
      candidates: [
        gen('cand0', 'land', {
          skills: {
            offense: 80,
            defense: 50,
            logistics: 50,
            air: 20,
            naval: 20,
            audacity: 50,
            experience: 50,
          },
        }),
        gen('cand1', 'land'),
        gen('cand2', 'land', {
          skills: {
            offense: 70,
            defense: 50,
            logistics: 50,
            air: 20,
            naval: 20,
            audacity: 50,
            experience: 50,
          },
        }),
      ],
      forces,
      opIds: [],
    },
    {
      id: 'air',
      chiefId: null,
      generalIds: [],
      candidates: [gen('cand-air-0', 'air')],
      forces,
      opIds: [],
    },
    {
      id: 'sea',
      chiefId: null,
      generalIds: [],
      candidates: [gen('cand-sea-0', 'sea')],
      forces,
      opIds: [],
    },
    {
      id: 'ad',
      chiefId: null,
      generalIds: [],
      candidates: [gen('cand-ad-0', 'ad')],
      forces,
      opIds: [],
    },
  ];
}

function view(units: UnitView[], command: Partial<CommandView> = {}): PlayerView {
  return {
    time: 0,
    me: 'fra',
    nations: { fra: { id: 'fra', relation: 'self' }, bel: { id: 'bel', relation: 'peace' } },
    provinces: {
      'fra-1': { id: 'fra-1', owner: 'fra' },
      'bel-1': { id: 'bel-1', owner: 'bel' },
      'bel-2': { id: 'bel-2', owner: 'bel' },
    },
    units: Object.fromEntries(units.map((u) => [u.id, u])),
    economy: {},
    victory: {},
    command: {
      armies: [],
      generals: [],
      candidates: [],
      salaryPerDay: 0,
      maxArmies: 12,
      maxPiles: 120,
      missions: {},
      estimates: { bel: 1_000_000_000 },
      ops: [],
      maxOps: 8,
      goals: GOALS,
      branches: branches(),
      ...command,
    },
  } as unknown as PlayerView;
}

const op = (o: Partial<CampaignView> = {}): CampaignView => ({
  id: 'o1',
  name: 'Tempête',
  goal: 'conquest',
  nations: ['bel'],
  status: 'active',
  phase: 'offensive',
  aggr: 'balanced',
  roe: 'standard',
  deadline: null,
  since: 0,
  commanders: [],
  progress: [
    { key: 'provinces', done: 7, total: 18 },
    { key: 'capital', done: 0, total: 1 },
  ],
  pct: 7 / 18,
  journal: [],
  request: null,
  estimate: null,
  stats: { strikes: 0, captures: 0, losses: 0, kills: 0 },
  value: { start: 1, now: 1 },
  ...o,
});

describe('opérations : forces et état-major', () => {
  it('arme d’une pile et forces libres par commandement', () => {
    expect(branchOfPile(unit('u1', 'tank'), catalog)).toBe('land');
    expect(branchOfPile(unit('u2', 'jet'), catalog)).toBe('air');
    expect(branchOfPile(unit('u3', 'ship'), catalog)).toBe('sea');
    expect(branchOfPile(unit('u4', 'sam'), catalog)).toBe('ad');
    const v = view([unit('u1', 'tank'), unit('u2', 'jet'), unit('u3', 'ship'), unit('u4', 'sam')], {
      armies: [{ id: 'a1', unitIds: ['u3'] } as ArmyView],
    });
    const f = freeByBranch(v, 'fra', catalog);
    expect(f.land.map((u) => u.id)).toEqual(['u1']);
    expect(f.air.map((u) => u.id)).toEqual(['u2']);
    expect(f.sea).toEqual([]);
    expect(f.ad.map((u) => u.id)).toEqual(['u4']);
  });

  it('état-major proposé : un général par commandement recommandé (forces présentes), deux de terre pour une conquête', () => {
    const v = view([]);
    const staff = suggestStaff(v.command, GOALS.conquest!, 'conquest', {
      land: 6,
      air: 2,
      sea: 0,
      ad: 1,
    });
    expect(staff.map((p) => [p.id, p.role])).toEqual([
      ['cand0', 'land'],
      ['cand-air-0', 'air'],
      ['cand-ad-0', 'ad'],
      ['cand2', 'land'],
    ]);
    expect(branchFit(GOALS.conquest!, staff)).toEqual([
      { b: 'land', ok: true },
      { b: 'air', ok: true },
      { b: 'ad', ok: true },
      { b: 'sea', ok: false },
    ]);
    // Un général recruté libre passe avant le vivier ; un général engagé ailleurs n'est pas proposé.
    const hired = gen('g1', 'air', { status: 'active', opId: null });
    const busy = gen('g2', 'land', { status: 'active', opId: 'o9' });
    const v2 = view([], { generals: [hired, busy], ops: [op({ id: 'o9' })] });
    expect(freeGenerals(v2.command).map((g) => g.id)).toEqual(['g1']);
    const s2 = suggestStaff(v2.command, GOALS.attrition!, 'attrition', {
      land: 1,
      air: 1,
      sea: 0,
      ad: 0,
    });
    expect(s2.map((p) => p.id)).toEqual(['g1', 'cand0']);
    expect(goalList(v.command).map(([id]) => id)).toEqual(['attrition', 'conquest']);
  });

  it('estimation : forces engagées, ennemi estimé, rapport, durée, chances, coût', () => {
    const v = view([unit('u1', 'tank'), unit('u2', 'tank'), unit('u3', 'jet')]);
    const p = previewOp({
      view: v,
      me: 'fra',
      catalog,
      goal: 'conquest',
      nations: ['bel'],
      staff: [
        { id: 'cand0', role: 'land' },
        { id: 'cand-air-0', role: 'air' },
      ],
      aggr: 'bold',
      share: 1,
      attackRatio: 1.1,
    });
    expect(p.forces).toBe(2 * 10 * 10_000_000 + 10 * 80_000_000);
    expect(p.enemy).toBe(1_000_000_000);
    expect(p.ratio).toBe(1);
    expect(p.etaHours).toBe(12 + 10 * 2);
    expect(p.costPerDay).toBe(200_000);
    expect(p.hireCost).toBe(1_000_000);
    expect(p.chance).toBeGreaterThan(0.3);
    expect(p.chance).toBeLessThan(0.8);
  });
});

describe('opérations : tableau de bord, assistant et carte', () => {
  it('mesure principale par objectif', () => {
    expect(opHeadline(op())).toEqual({
      key: 'command.ops.metric.provinces',
      params: { done: 7, total: 18 },
    });
    expect(
      opHeadline(op({ goal: 'attrition', progress: [{ key: 'forces', done: 42, total: 100 }] })),
    ).toEqual({ key: 'command.ops.metric.forces', params: { pct: 42 } });
    expect(
      opHeadline(
        op({
          goal: 'air_control',
          progress: [
            { key: 'sams', done: 6, total: 9 },
            { key: 'aircraft', done: 4, total: 4 },
          ],
        }),
      ),
    ).toEqual({ key: 'command.ops.metric.sky', params: { sams: 3, air: 0 } });
  });

  it('brouillon : pays désignés sur la carte, provinces pour une occupation', () => {
    const s = useCommandUi.getState();
    s.startOp({ steps: ['targets', 'goal', 'staff', 'confirm'] });
    useCommandUi.getState().setPicking('nation');
    useCommandUi.getState().pickNation({ provinceId: 'bel-1', nationId: 'bel' });
    expect(useCommandUi.getState().opDraft!.nations).toEqual(['bel']);
    expect(useCommandUi.getState().picking).toBeNull();
    // Deuxième clic sur le même pays : pas de doublon.
    useCommandUi.getState().pickNation({ provinceId: 'bel-2', nationId: 'bel' });
    expect(useCommandUi.getState().opDraft!.nations).toEqual(['bel']);
    useCommandUi.getState().patchOp({ goal: 'occupy' });
    useCommandUi.getState().pickNation({ provinceId: 'bel-1', nationId: 'bel' });
    useCommandUi.getState().pickNation({ provinceId: 'bel-2', nationId: 'bel' });
    useCommandUi.getState().pickNation({ provinceId: 'bel-1', nationId: 'bel' });
    expect(useCommandUi.getState().opDraft!.provinces).toEqual(['bel-2']);
    useCommandUi.getState().closeOp();
    expect(useCommandUi.getState().opDraft).toBeNull();
  });

  it('carte : flèches des généraux de l’opération (teinte du rôle), pays visés', () => {
    const v = view([unit('u1', 'tank', [3, 50]), unit('u2', 'jet', [2, 49])], {
      armies: [
        {
          id: 'a1',
          name: 'Terre',
          unitIds: ['u1'],
          aims: [[4.4, 50.4]],
          opId: 'o1',
          role: 'land',
          mission: null,
          status: 'active',
        } as unknown as ArmyView,
        {
          id: 'a2',
          name: 'Air',
          unitIds: ['u2'],
          aims: [[4.3, 50.8]],
          opId: 'o1',
          role: 'air',
          mission: null,
          status: 'active',
        } as unknown as ArmyView,
      ],
      ops: [op()],
    });
    const fc = commandFeatures(v, null, 0, 'o1');
    const arrows = fc.features.filter((f) => f.properties?.kind === 'arrow');
    expect(arrows.map((f) => f.properties?.role).sort()).toEqual(['air', 'land']);
    expect(arrows.every((f) => f.properties?.sel === 1)).toBe(true);
    const label = fc.features.find((f) => f.properties?.kind === 'label');
    expect(String(label?.properties?.text)).toContain('Terre');
    expect(targetNations(v)).toEqual(['bel']);
    expect(targetNations(view([], { ops: [op({ status: 'success' })] }))).toEqual([]);
  });
});

describe('opérations : catalogue, chaîne de phases, piles reprises', () => {
  const GOALS2: Record<string, OpGoalDef> = {
    ...GOALS,
    sead: {
      order: 5,
      branches: ['air', 'sea'],
      target: 'nation',
      continuous: false,
      success: 0.8,
      category: 'air',
    },
    naval_supremacy: {
      order: 20,
      branches: ['sea', 'air'],
      target: 'nation',
      continuous: false,
      success: 0.6,
      category: 'sea',
    },
    defend_capital: {
      order: 12,
      branches: ['land', 'ad', 'air'],
      target: 'self',
      continuous: true,
      success: 1,
      category: 'land',
      war: false,
    },
    siege: {
      order: 9,
      branches: ['land', 'air'],
      target: 'place',
      continuous: false,
      success: 1,
      category: 'land',
    },
    blitz: {
      order: 30,
      branches: ['air', 'land'],
      target: 'nation',
      continuous: false,
      success: 1,
      category: 'joint',
      chain: ['sead', 'conquest'],
      chainHours: [36, 0],
    },
  };
  const cmd = () => view([], { goals: GOALS2 }).command!;

  it('catalogue par catégorie, dans l’ordre des données ; catégories vides omises', () => {
    const cat = goalCatalog(cmd());
    expect(cat.map((c) => c.cat)).toEqual(['land', 'air', 'sea', 'joint']);
    // Sans catégorie (anciennes données) : terre.
    expect(cat[0]!.goals.map(([g]) => g)).toEqual([
      'attrition',
      'conquest',
      'siege',
      'defend_capital',
    ]);
    expect(cat[3]!.goals.map(([g]) => g)).toEqual(['blitz']);
  });

  it('chaîne : objectif composé déplié, phases ajoutées, échéances ; commandements de toute la chaîne', () => {
    expect(chainOf(cmd(), 'blitz', [{ goal: 'naval_supremacy', hours: 12 }])).toEqual([
      { goal: 'sead', hours: 36, preset: 'blitz' },
      { goal: 'conquest', hours: undefined, preset: 'blitz' },
      { goal: 'naval_supremacy', hours: 12 },
    ]);
    expect(chainOf(cmd(), null, [])).toEqual([]);
    const d = chainDef(cmd(), GOALS2.sead!, 'sead', [{ goal: 'conquest' }]);
    expect(d.branches).toEqual(['air', 'sea', 'land', 'ad']);
    // Conquête dans la chaîne : l'état-major proposé suit la conquête (deux généraux de terre).
    expect(chainGoal(cmd(), 'sead', [{ goal: 'conquest' }])).toBe('conquest');
    expect(chainGoal(cmd(), 'sead', [])).toBe('sead');
  });

  it('cibles valides selon le genre de l’objectif (pays, lieu, son propre territoire)', () => {
    expect(targetsOk(GOALS2.conquest, [], [])).toBe(false);
    expect(targetsOk(GOALS2.conquest, ['bel'], [])).toBe(true);
    expect(targetsOk(GOALS2.siege, [], ['bel-1'])).toBe(true);
    expect(targetsOk(GOALS2.siege, [], [])).toBe(false);
    expect(targetsOk(GOALS2.defend_capital, [], [])).toBe(true);
    expect(targetsOk(null, ['bel'], [])).toBe(false);
    expect(goalByProvinces(GOALS2.siege)).toBe(true);
    expect(goalByProvinces(GOALS2.conquest)).toBe(false);
  });

  it('mesure principale des objectifs ajoutés : « libellé : fait/total »', () => {
    expect(
      opHeadline(op({ goal: 'naval_supremacy', progress: [{ key: 'ships', done: 2, total: 5 }] })),
    ).toEqual({
      key: 'command.ops.metric.ratio',
      params: { done: 2, total: 5 },
      label: 'command.ops.metrics.ships',
    });
    expect(opHeadline(op({ goal: 'interdiction', progress: [] }))).toEqual({
      key: 'command.ops.metric.none',
      params: {},
    });
  });

  it('piles d’une opération close reprises d’office ; celles d’une opération en cours, non', () => {
    const units = [unit('u1', 'tank'), unit('u2', 'tank'), unit('u3', 'jet')];
    const army = (id: string, opId: string, unitIds: string[]) =>
      ({ id, name: id, unitIds, auto: true, opId }) as unknown as ArmyView;
    const v = view(units, {
      armies: [army('a1', 'o1', ['u1']), army('a2', 'o2', ['u2', 'u3'])],
      ops: [op({ id: 'o1', status: 'success' }), op({ id: 'o2' })],
    });
    expect(sparePiles(v).map((u) => u.id)).toEqual(['u1']);
    expect(sparePiles(null)).toEqual([]);
    expect(liveOps(v.command).map((o) => o.id)).toEqual(['o2']);
  });
});

describe('ministère de la Défense : contrat des commandements', () => {
  it('commandsOf lit la vue typée du moteur (chef, généraux, opérations en cours)', () => {
    const forces = { piles: 3, free: 1, elements: 9, value: 1e9 };
    const cmd = (b: DefenseCommandView['id'], d: DefenseCommandView['domain']) => ({
      id: b,
      domain: d,
      chief: null,
      generalIds: [],
      generals: [],
      operationIds: [],
      operations: [],
      forces,
    });
    const commands: DefenseCommandView[] = [
      {
        ...cmd('land', 'land'),
        chief: { id: 'g1', name: 'Rémi Hamon' },
        generalIds: ['g1', 'g2'],
        generals: [
          { id: 'g1', name: 'Rémi Hamon', status: 'active' },
          { id: 'g2', name: 'Florent Abadie', status: 'active', opId: 'op1' },
        ],
        operationIds: ['op1'],
        operations: [{ id: 'op1', name: 'Tempête', goal: 'conquest', status: 'active', pct: 0.5 }],
      },
      cmd('air', 'air'),
      cmd('sea', 'sea'),
      cmd('ad', 'air_defense'),
    ];
    const v = { command: { commands } } as unknown as PlayerView;
    const list = commandsOf(v)!;
    expect(list.map((c) => [c.id, c.domain])).toEqual([
      ['land', 'land'],
      ['air', 'air'],
      ['sea', 'sea'],
      ['ad', 'air_defense'],
    ]);
    expect(list[0]).toEqual({
      id: 'land',
      domain: 'land',
      chief: 'Rémi Hamon',
      generals: 2,
      operations: 1,
    });
    expect(list[3]!.chief).toBeNull();
  });
});
