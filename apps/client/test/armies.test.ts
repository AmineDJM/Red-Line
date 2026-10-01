import { describe, expect, it } from 'vitest';
import type {
  BattleReportSummary,
  LngLat,
  PlayerView,
  ProvinceDef,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import {
  armyLocation,
  elementPrice,
  filterArmies,
  groupArmies,
  inventory,
  lossesBySystem,
  mergeGroups,
  ownPiles,
  summarizeArmies,
} from '../src/lib/armies.js';

const HOUR = 3_600_000;

const sys = (
  id: string,
  movement: WeaponSystem['movement'],
  category: string,
  money = 1_000_000,
  unitSize = 1,
) =>
  ({
    id,
    name: id.toUpperCase(),
    movement,
    category,
    unitSize,
    cost: { money },
  }) as unknown as WeaponSystem;

const catalog: Record<string, WeaponSystem> = {
  tank: sys('tank', 'land', 'tank', 10_000_000, 10),
  jet: sys('jet', 'air', 'fighter', 80_000_000),
  ship: sys('ship', 'sea', 'surface_ship', 900_000_000),
  sam: sys('sam', 'static', 'air_defense', 50_000_000),
  inf: sys('inf', 'land', 'infantry', 1_000_000),
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

const PARIS: LngLat = [2.35, 48.85];
const NEAR_PARIS: LngLat = [2.5, 48.9]; // ~12 km
const LYON: LngLat = [4.83, 45.76];
const TOULON_SEA: LngLat = [5.9, 42.9];

const moving = (from: LngLat, to: LngLat, t0 = 0, t1 = 10 * HOUR) => ({
  legs: [{ from, to, t0, t1, medium: 'land' as const }],
});

const provinces: Record<string, ProvinceDef> = {
  idf: {
    id: 'idf',
    name: 'Île-de-France',
    cityName: 'Paris',
    cityPoint: PARIS,
  } as unknown as ProvinceDef,
  rha: { id: 'rha', name: 'Rhône', cityName: 'Lyon', cityPoint: LYON } as unknown as ProvinceDef,
};

describe('Mes armées : regroupement', () => {
  it('piles proches du même milieu = une armée ; air et terre séparés ; loin = autre armée', () => {
    const units = [
      unit('u1', 'tank', PARIS),
      unit('u2', 'inf', NEAR_PARIS),
      unit('u3', 'sam', PARIS, { count: 1 }),
      unit('u4', 'jet', PARIS, { count: 12 }),
      unit('u5', 'tank', LYON),
    ];
    const armies = groupArmies(units, catalog, 0);
    expect(armies.map((a) => [a.id, a.domain, a.number, a.unitIds])).toEqual([
      ['u1', 'land', 1, ['u1', 'u2', 'u3']],
      ['u4', 'air', 1, ['u4']],
      ['u5', 'land', 2, ['u5']],
    ]);
    const paris = armies[0]!;
    expect(paris.elements).toBe(21);
    expect(paris.byDomain).toEqual({ land: 20, air: 0, sea: 0, static: 1 });
  });

  it('une colonne en mouvement se détache de la garnison', () => {
    const units = [
      unit('u1', 'tank', PARIS),
      unit('u2', 'tank', PARIS, { status: 'moving', move: moving(PARIS, LYON) }),
      unit('u3', 'inf', PARIS, { status: 'moving', move: moving(PARIS, LYON) }),
    ];
    const armies = groupArmies(units, catalog, HOUR);
    expect(armies).toHaveLength(2);
    const col = armies.find((a) => a.id === 'u2')!;
    expect(col.state).toBe('moving');
    expect(col.unitIds).toEqual(['u2', 'u3']);
    expect(col.order).toMatchObject({ kind: 'move', to: LYON, eta: 10 * HOUR });
  });

  it('état : combat prioritaire, remise en œuvre = ravitaillement, embarquées suivent la flotte', () => {
    const now = HOUR;
    const a = groupArmies(
      [unit('u1', 'tank', PARIS), unit('u2', 'tank', PARIS, { status: 'combat', hpRatio: 0.5 })],
      catalog,
      now,
    )[0]!;
    expect(a.state).toBe('combat');
    expect(a.hp).toBeCloseTo(0.75);
    const air = groupArmies(
      [unit('u3', 'jet', PARIS, { mission: { kind: 'none', readyAt: 2 * HOUR } })],
      catalog,
      now,
    )[0]!;
    expect(air.state).toBe('resupply');
    const fleet = groupArmies(
      [
        unit('u4', 'ship', TOULON_SEA, { count: 2 }),
        unit('u5', 'tank', TOULON_SEA, { status: 'embarked' }),
      ],
      catalog,
      now,
    );
    expect(fleet).toHaveLength(1);
    expect(fleet[0]!.domain).toBe('sea');
    expect(fleet[0]!.state).toBe('idle');
  });

  it('général affecté, valeur au prix catalogue', () => {
    const view = {
      generals: [
        {
          id: 'g1',
          name: 'Gal. Leclerc',
          traits: [],
          unitIds: ['u1'],
          directive: 'defend',
          area: null,
        },
      ],
    } as unknown as PlayerView;
    const a = groupArmies([unit('u1', 'tank', PARIS)], catalog, 0, view)[0]!;
    expect(a.generalId).toBe('g1');
    expect(a.order).toEqual({ kind: 'delegated', directive: 'defend' });
    // Lot de 10 chars à 10 M$ : 1 M$ l'élément.
    expect(elementPrice(catalog.tank)).toBe(1_000_000);
    expect(a.value).toBe(10_000_000);
  });

  it('localisation : ville, province, en mer', () => {
    const [land] = groupArmies([unit('u1', 'tank', NEAR_PARIS)], catalog, 0);
    expect(armyLocation(land!, catalog, provinces, 0)).toMatchObject({
      kind: 'city',
      city: 'Paris',
      province: 'Île-de-France',
      provinceId: 'idf',
    });
    const [sea] = groupArmies([unit('u2', 'ship', TOULON_SEA)], catalog, 0);
    expect(armyLocation(sea!, catalog, provinces, 0).kind).toBe('sea');
  });

  it('résumé, filtres, fusion possible', () => {
    const units = [
      unit('u1', 'tank', PARIS),
      unit('u2', 'tank', NEAR_PARIS),
      unit('u3', 'jet', LYON, { status: 'combat' }),
      unit('u4', 'ship', TOULON_SEA, { count: 1 }),
    ];
    const armies = groupArmies(units, catalog, 0);
    const s = summarizeArmies(armies, catalog);
    expect(s.armies).toBe(3);
    expect(s.inCombat).toBe(1);
    expect(s.byDomain.land).toEqual({ piles: 2, elements: 20 });
    expect(s.byDomain.sea).toEqual({ piles: 1, elements: 1 });
    const text = (a: (typeof armies)[number]) => a.units.map((u) => u.systemId).join(' ');
    expect(filterArmies(armies, { domain: 'air', state: 'all', query: '' }, text)).toHaveLength(1);
    expect(filterArmies(armies, { domain: 'all', state: 'combat', query: '' }, text)[0]!.id).toBe(
      'u3',
    );
    expect(filterArmies(armies, { domain: 'all', state: 'all', query: 'SHIP' }, text)).toHaveLength(
      1,
    );
    // Deux piles de chars à 12 km : fusionnables (moteur : 10 km de la première → non).
    expect(mergeGroups(armies[0]!, catalog)).toEqual([]);
    const close = groupArmies(
      [unit('u1', 'tank', PARIS), unit('u2', 'tank', [2.4, 48.86])],
      catalog,
      0,
    );
    expect(mergeGroups(close[0]!, catalog)).toEqual([['u1', 'u2']]);
  });

  it('ownPiles : unités du joueur, hors munitions en vol et détruites', () => {
    const view = {
      units: {
        u1: unit('u1', 'tank', PARIS),
        u2: unit('u2', 'tank', PARIS, { status: 'destroyed' }),
        u3: unit('u3', 'jet', PARIS, { owner: 'deu' }),
        u4: unit('u4', 'jet', PARIS, {
          missile: { target: { type: 'point', at: LYON }, impactAt: 1 },
        }),
      },
    } as unknown as PlayerView;
    expect(ownPiles(view, 'fra').map((u) => u.id)).toEqual(['u1']);
  });
});

describe('Arsenal de guerre : inventaire', () => {
  it('par matériel : en service, disponibles, engagés, en production, pertes, valeur', () => {
    const report = {
      attacker: { nations: ['fra'], engaged: [], losses: [{ systemId: 'tank', count: 4 }] },
      defender: { nations: ['deu'], engaged: [], losses: [{ systemId: 'jet', count: 9 }] },
    } as unknown as BattleReportSummary;
    const view = {
      units: {
        u1: unit('u1', 'tank', PARIS),
        u2: unit('u2', 'tank', LYON, { status: 'combat', hpRatio: 0.5 }),
        u3: unit('u3', 'tank', LYON, { status: 'moving', move: moving(LYON, PARIS) }),
        u4: unit('u4', 'jet', PARIS, { count: 6 }),
      },
      economy: {
        production: [
          { id: 'b1', provinceId: 'idf', systemId: 'jet', startedAt: 0, completesAt: 9, count: 2 },
          { id: 'b2', provinceId: 'idf', systemId: 'ship', startedAt: 0, completesAt: 9 },
        ],
      },
      battleReports: [report],
    } as unknown as PlayerView;
    expect(lossesBySystem([report], 'fra')).toEqual({ tank: 4 });
    const rows = Object.fromEntries(
      inventory(view, 'fra', catalog, HOUR).map((r) => [r.systemId, r]),
    );
    expect(rows.tank).toMatchObject({
      elements: 30,
      piles: 3,
      available: 10,
      engaged: 10,
      deployed: 10,
      losses: 4,
      value: 30_000_000,
    });
    expect(rows.tank!.hp).toBeCloseTo(25 / 30);
    expect(rows.jet).toMatchObject({ elements: 6, available: 6, inProduction: 2 });
    expect(rows.ship).toMatchObject({ elements: 0, inProduction: 1 });
  });
});
