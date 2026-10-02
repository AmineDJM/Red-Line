/**
 * Centre de commandement, logique sans rendu : piles libres et groupées, composition, pastilles,
 * adéquation et cible des missions, estimation avant validation, coût du général, brouillon de
 * l'assistant (désignation sur la carte, ordre de mission), couches de la carte.
 */
import { describe, expect, it } from 'vitest';
import type {
  ArmyView,
  CommandGeneralView,
  CommandView,
  LngLat,
  MissionDef,
  PlayerView,
  ProvinceDef,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import {
  armyOfUnit,
  composition,
  domainFit,
  dominantDomain,
  freePiles,
  groupPiles,
  missionCost,
  missionList,
  nextArmyNumber,
  pill,
  previewEstimate,
  strengthOf,
  supplyOf,
  supplyPill,
  targetReady,
} from '../src/lib/command.js';
import { missionInput, useCommandUi } from '../src/store/command.js';
import { commandFeatures } from '../src/map/commandLayer.js';

const sys = (id: string, movement: WeaponSystem['movement'], category: string, money: number) =>
  ({
    id,
    name: id.toUpperCase(),
    movement,
    category,
    unitSize: 1,
    speedKmh: movement === 'air' ? 900 : 40,
    cost: { money },
  }) as unknown as WeaponSystem;

const catalog: Record<string, WeaponSystem> = {
  tank: sys('tank', 'land', 'tank', 10_000_000),
  inf: sys('inf', 'land', 'infantry', 1_000_000),
  jet: sys('jet', 'air', 'fighter', 80_000_000),
  ship: sys('ship', 'sea', 'surface_ship', 900_000_000),
};

const unit = (id: string, systemId: string, pos: LngLat, o: Partial<UnitView> = {}): UnitView =>
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
    ...o,
  }) as UnitView;

const prov = (id: string, nationId: string, cityPoint: LngLat, isCapital = false): ProvinceDef =>
  ({ id, nationId, name: id, cityName: id.toUpperCase(), cityPoint, isCapital }) as ProvinceDef;

const provinces: Record<string, ProvinceDef> = {
  'fra-1': prov('fra-1', 'fra', [3, 50]),
  'fra-2': prov('fra-2', 'fra', [2.3, 48.8], true),
  'bel-1': prov('bel-1', 'bel', [4.4, 50.4]),
  'bel-2': prov('bel-2', 'bel', [4.35, 50.85], true),
};

const MISSIONS: Record<string, MissionDef> = {
  conquer: {
    brain: 'conquer',
    target: 'province',
    domains: ['land', 'air'],
    radiusKm: 0,
    order: 1,
    continuous: false,
    blockade: false,
  },
  air_superiority: {
    brain: 'air_superiority',
    target: 'zone',
    domains: ['air'],
    radiusKm: 250,
    order: 4,
    continuous: true,
    blockade: false,
  },
  sea_control: {
    brain: 'sea_control',
    target: 'zone',
    domains: ['sea'],
    radiusKm: 300,
    order: 7,
    continuous: true,
    blockade: true,
  },
};

const general = (o: Partial<CommandGeneralView> = {}): CommandGeneralView => ({
  id: 'cand0',
  first: 'Antoine',
  last: 'Marchal',
  culture: 'fr',
  rank: 2,
  skills: {
    offense: 60,
    defense: 50,
    logistics: 50,
    air: 40,
    naval: 30,
    audacity: 50,
    experience: 60,
  },
  traits: [],
  xp: 0,
  salaryPerDay: 80_000,
  hireCost: 400_000,
  severance: 800_000,
  status: 'candidate',
  armyId: null,
  victories: 0,
  ...o,
});

const army = (o: Partial<ArmyView> = {}): ArmyView => ({
  id: 'a1',
  name: '1re Armée',
  generalId: null,
  unitIds: ['u1'],
  manualIds: [],
  mission: null,
  status: 'idle',
  reinforce: 'ask',
  request: null,
  journal: [],
  strength: { start: 0, now: 0 },
  objective: null,
  estimate: null,
  aims: [],
  captures: 0,
  losses: 0,
  createdAt: 0,
  ...o,
});

function viewWith(units: UnitView[], command: Partial<CommandView> = {}): PlayerView {
  return {
    time: 0,
    me: 'fra',
    nations: {
      fra: { id: 'fra', relation: 'self' },
      bel: { id: 'bel', relation: 'war' },
    } as unknown as PlayerView['nations'],
    provinces: {
      'fra-1': { id: 'fra-1', owner: 'fra' },
      'fra-2': { id: 'fra-2', owner: 'fra' },
      'bel-1': { id: 'bel-1', owner: 'bel' },
      'bel-2': { id: 'bel-2', owner: 'bel' },
    } as unknown as PlayerView['provinces'],
    units: Object.fromEntries(units.map((u) => [u.id, u])),
    economy: {} as PlayerView['economy'],
    victory: {} as PlayerView['victory'],
    command: {
      armies: [],
      generals: [],
      candidates: [general()],
      salaryPerDay: 0,
      maxArmies: 12,
      maxPiles: 120,
      missions: MISSIONS,
      estimates: { bel: 4_000_000_000 },
      ...command,
    },
  };
}

describe('centre de commandement : piles et composition', () => {
  const units = [
    unit('u1', 'tank', [3.01, 50.02]),
    unit('u2', 'inf', [3.02, 50.01], { count: 30 }),
    unit('u3', 'jet', [2.31, 48.81], { count: 12 }),
    unit('u4', 'ship', [-1.6, 49.6], { count: 1 }),
    unit('e1', 'tank', [4.4, 50.4], { owner: 'bel', level: 'identified' }),
  ];

  it('piles libres : hors armée, groupées par milieu puis par région', () => {
    const v = viewWith(units, { armies: [army({ unitIds: ['u4'] })] });
    const free = freePiles(v, 'fra').map((u) => u.id);
    expect(free).toEqual(['u1', 'u2', 'u3']);
    const groups = groupPiles(freePiles(v, 'fra'), catalog, provinces);
    expect(groups.map((g) => [g.domain, g.region, g.piles.length])).toEqual([
      ['land', 'FRA-1', 2],
      ['air', 'FRA-2', 1],
    ]);
    expect(groups[0]!.elements).toBe(40);
    expect(groups[0]!.value).toBe(10 * 10_000_000 + 30 * 1_000_000);
    expect(armyOfUnit(v.command, 'u4')?.id).toBe('a1');
    expect(armyOfUnit(v.command, 'u1')).toBeNull();
  });

  it('composition par catégorie (piles mixtes détaillées) et milieu dominant', () => {
    const mixed = unit('m1', 'tank', [3, 50], {
      parts: [
        { systemId: 'tank', count: 4 },
        { systemId: 'inf', count: 20 },
      ],
      count: 24,
    });
    const rows = composition([mixed, units[2]!], catalog);
    expect(rows.map((r) => [r.category, r.elements, r.piles])).toEqual([
      ['tank', 4, 1],
      ['infantry', 20, 1],
      ['fighter', 12, 1],
    ]);
    expect(dominantDomain([units[0]!, units[2]!], catalog)).toBe('air');
  });

  it('pastilles : santé, effectifs, logistique', () => {
    expect(pill(0.9)).toBe('good');
    expect(pill(0.5)).toBe('warn');
    expect(pill(0.2)).toBe('bad');
    expect(supplyPill(supplyOf([unit('a', 'tank', [0, 0], { supply: 'limited' })]))).toBe('warn');
    expect(supplyPill(supplyOf([unit('a', 'tank', [0, 0], { supply: 'cut' })]))).toBe('bad');
    expect(strengthOf(army({ strength: { start: 100, now: 40 } }))).toBeCloseTo(0.4);
    expect(strengthOf(army())).toBe(1);
  });
});

describe('centre de commandement : missions et estimation', () => {
  it('liste ordonnée, adéquation de la composition, cible requise', () => {
    const v = viewWith([]);
    expect(missionList(v.command).map(([id]) => id)).toEqual([
      'conquer',
      'air_superiority',
      'sea_control',
    ]);
    expect(domainFit(MISSIONS.conquer!, new Set(['land']))).toBe('ok');
    expect(domainFit(MISSIONS.conquer!, new Set(['air']))).toBe('partial');
    expect(domainFit(MISSIONS.sea_control!, new Set(['land']))).toBe('missing');
    expect(targetReady(MISSIONS.conquer!, {})).toBe(false);
    expect(targetReady(MISSIONS.conquer!, { provinceId: 'bel-1' })).toBe(true);
    expect(targetReady(MISSIONS.air_superiority!, { at: [3, 50] })).toBe(true);
  });

  it('estimation : contacts vus près de l’objectif, sinon estimation du renseignement', () => {
    const own = [unit('u1', 'tank', [3, 50]), unit('u2', 'inf', [3, 50], { count: 30 })];
    const seen = unit('e1', 'tank', [4.41, 50.41], { owner: 'bel', level: 'identified', count: 4 });
    const v = viewWith([...own, seen]);
    const base = {
      view: v,
      catalog,
      provinces,
      units: own,
      def: MISSIONS.conquer!,
      general: general(),
      captureMinutes: 60,
    };
    const e1 = previewEstimate({ ...base, mission: { provinceId: 'bel-1' } });
    expect(e1.source).toBe('seen');
    expect(e1.ratio).toBeCloseTo((100e6 + 30e6) / 40e6, 1);
    expect(e1.chance).toBeGreaterThan(0.5);
    expect(e1.etaHours).toBeGreaterThan(1);
    // Province non vue : part de l'estimation publique (4 Md$ / 2 provinces × 25 %).
    const e2 = previewEstimate({ ...base, mission: { provinceId: 'bel-2' } });
    expect(e2.source).toBe('estimate');
    expect(e2.enemy).toBe(500_000_000);
    expect(e2.chance).toBeLessThan(0.2);
    // Un général offensif et expérimenté a de meilleures chances, à forces égales.
    const strong = previewEstimate({
      ...base,
      mission: { provinceId: 'bel-1' },
      general: general({
        skills: { ...general().skills, offense: 95, experience: 95, audacity: 70 },
      }),
    });
    const weak = previewEstimate({
      ...base,
      mission: { provinceId: 'bel-1' },
      general: general({ skills: { ...general().skills, offense: 15, experience: 10 } }),
    });
    expect(strong.chance).toBeGreaterThan(weak.chance);
  });

  it('coût prévisionnel : prime du candidat + solde sur la durée estimée', () => {
    expect(missionCost(general(), 30)).toBe(400_000 + 2 * 80_000);
    expect(missionCost(general({ status: 'active' }), null)).toBe(80_000);
  });

  it('noms par défaut : numéro libre suivant', () => {
    const v = viewWith([], { armies: [army({ name: '1re Armée' }), army({ name: '3e Armée' })] });
    const land = (n: number) => (n === 1 ? '1re Armée' : `${n}e Armée`);
    expect(nextArmyNumber(v.command, land)).toBe(2);
    expect(nextArmyNumber(v.command, (n) => `Groupe aérien ${n}`)).toBe(1);
  });
});

describe('centre de commandement : assistant et carte', () => {
  it('brouillon : désignation de la cible sur la carte, ordre de mission normalisé', () => {
    const s = useCommandUi.getState();
    s.startWizard({ steps: ['compose', 'mission', 'general'], unitIds: ['u1'] });
    s.patchMission({ type: 'conquer', scope: 'nation' });
    s.setPicking('target');
    useCommandUi.getState().pickTarget({ provinceId: 'bel-1', at: [4.4, 50.4] });
    const d = useCommandUi.getState().draft!;
    expect(useCommandUi.getState().picking).toBeNull();
    expect(d.mission.provinceId).toBe('bel-1');
    const nationOf = (p: string) => (p.startsWith('bel') ? 'bel' : 'fra');
    expect(missionInput(d.mission, nationOf)).toEqual({
      type: 'conquer',
      aggr: 'balanced',
      roe: 'standard',
      nationId: 'bel',
      at: [4.4, 50.4],
    });
    expect(missionInput({ ...d.mission, scope: 'province' }, nationOf)).toMatchObject({
      provinceId: 'bel-1',
      radiusKm: 0,
    });
    s.closeWizard();
    expect(useCommandUi.getState().draft).toBeNull();
  });

  it('carte : étiquette, zone hachurée et flèches d’offensive de chaque armée', () => {
    const units = [unit('u1', 'tank', [3, 50]), unit('u2', 'jet', [2, 49])];
    const v = viewWith(units, {
      armies: [
        army({
          unitIds: ['u1'],
          status: 'active',
          mission: {
            type: 'conquer',
            brain: 'conquer',
            provinceId: 'bel-1',
            aggr: 'balanced',
            roe: 'standard',
            retreatAt: 0.35,
            since: 0,
          },
          aims: [[4.4, 50.4]],
        }),
        army({
          id: 'a2',
          name: 'Groupe aérien',
          unitIds: ['u2'],
          status: 'active',
          mission: {
            type: 'air_superiority',
            brain: 'air_superiority',
            at: [2, 49],
            radiusKm: 200,
            aggr: 'bold',
            roe: 'standard',
            retreatAt: 0.2,
            since: 0,
          },
        }),
      ],
    });
    const fc = commandFeatures(v, 'a2', 0);
    const kinds = fc.features.map((f) => `${f.properties!.kind}:${f.properties!.sel}`);
    expect(kinds).toEqual(['arrow:0', 'aim:0', 'label:0', 'zone:1', 'label:1']);
    const label = fc.features.find((f) => f.properties!.kind === 'label')!;
    expect(String(label.properties!.text)).toContain('1re Armée');
  });
});
