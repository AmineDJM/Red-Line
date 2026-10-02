/**
 * Audit de la conquête sur les VRAIES données : scénario « monde 2025 » (ORBAT réels regroupés en piles
 * mixtes), réseau de routes (les unités terrestres capturent en occupant la ville, point de capture de
 * la province). Province voisine, capitale défendue, province lointaine, île, pile sans unité capable
 * de capturer, province alliée, arrivée simultanée avec l'ennemi, et captures des IA en guerre.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  distanceKm,
  type GameNotification,
  type LngLat,
  type NationId,
  type ProvinceDef,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type GameSetup,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { sysOf, unitPosAt } from '../src/state/access.js';
import { board } from '../src/modules/kit.js';
import { CAPTURE_RADIUS_KM } from '../src/state/world.js';
import { loadRealData, type RealData } from '../bench/load.js';

let data: RealData;
let world: World;
let prov: (id: string) => ProvinceDef;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
  prov = (id) => data.map.provinces.find((p) => p.id === id)!;
}, 120_000);

const CAPTURE = () => data.balance.time.captureMinutes * MINUTE;

/** Partie du scénario monde 2025 (ORBAT), ou unités explicites (`units`). */
function game(players: GameSetup['players'], units?: GameSetup['units']): EngineState {
  return createGame(world, {
    seed: 3,
    players,
    scenario: data.scenario,
    ...(units
      ? { units, nationIds: ['fra', 'bel', 'deu', 'pol', 'ita', 'lux', 'nld', 'che'] }
      : {}),
  }) as EngineState;
}

/** Avance par pas d'une heure jusqu'à la prise de `pid` par `n` (ou l'échéance) ; notifications vues. */
function until(s: EngineState, pid: string, n: NationId, maxMs: number): GameNotification[] {
  const notes: GameNotification[] = [];
  const end = s.time + maxMs;
  while (s.time < end && s.provinces[pid]!.owner !== n) {
    notes.push(...advanceTo(s, Math.min(end, s.time + HOUR)));
  }
  return notes;
}

/** Portées de tir (min, max) des unités d'une paire : seuils de la paire. */
function weaponRangesOf(s: EngineState, units: Unit[]): number[] {
  const out = new Set<number>();
  for (const u of units) {
    const w = sysOf(s, u).weaponRangeKm;
    if (w.max > 0) out.add(w.max).add(w.min);
  }
  return [...out].filter((r) => r > 0);
}

/** Pile terrestre capable de capturer d'une nation, la plus proche d'un point. */
function capturerNear(s: EngineState, n: NationId, p: LngLat): Unit {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const u of Object.values(s.units)) {
    if (u.owner !== n || u.off || u.role || !sysOf(s, u).canCapture) continue;
    const d = Math.hypot(u.pos[0] - p[0], u.pos[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = u;
    }
  }
  return best!;
}

describe('conquête : monde 2025, armées réelles en piles mixtes', { timeout: 300_000 }, () => {
  it('province voisine : pile mixte (blindés + infanterie) → Charleroi, guerre, capture visible', () => {
    const s = game([
      { nationId: 'fra', isAi: false },
      { nationId: 'bel', isAi: true },
    ]);
    const target = prov('bel-1');
    const u = capturerNear(s, 'fra', target.cityPoint);
    // Pile mixte de l'armée de départ (ORBAT 2025 regroupé) : chars, véhicules et infanterie.
    expect(u.mix && u.mix.length).toBeGreaterThan(2);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: [u.id], to: target.cityPoint })).toEqual({
      ok: true,
    });
    const notes = until(s, 'bel-1', 'fra', 3 * DAY);
    expect(s.wars['bel|fra']).toBeDefined();
    expect(
      notes.some((x) => x.kind === 'province_capture_started' && x.provinceId === 'bel-1'),
    ).toBe(true);
    expect(s.provinces['bel-1']!.owner).toBe('fra');
    expect(viewFor(s, 'fra').provinces['bel-1']!.owner).toBe('fra');
    expect(viewFor(s, 'bel').provinces['bel-1']!.owner).toBe('fra');
  });

  it('capitale défendue (Bruxelles) : combat contre la garnison, puis capture', () => {
    const s = game([
      { nationId: 'fra', isAi: false },
      { nationId: 'bel', isAi: true },
    ]);
    const target = prov('bel-3');
    const defenders = Object.values(s.units).filter(
      (u) =>
        u.owner === 'bel' &&
        !u.off &&
        sysOf(s, u).movement === 'land' &&
        Math.hypot(u.pos[0] - target.cityPoint[0], u.pos[1] - target.cityPoint[1]) < 0.1,
    );
    expect(defenders.length).toBeGreaterThan(0);
    const u = capturerNear(s, 'fra', target.cityPoint);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: [u.id], to: target.cityPoint }).ok).toBe(
      true,
    );
    const notes = until(s, 'bel-3', 'fra', 4 * DAY);
    expect(notes.some((x) => x.kind === 'combat_started')).toBe(true);
    expect(s.provinces['bel-3']!.owner).toBe('fra');
  });

  it('province lointaine : Paris → Varsovie par la route, guerres déclarées en chemin, capture', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'pol', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.infantry-mech', pos: prov('fra-24').cityPoint, count: 3 }],
    );
    const target = prov('pol-10');
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: target.cityPoint }).ok).toBe(
      true,
    );
    const arrival = s.units.u1!.move!.legs.at(-1)!.t1;
    expect(arrival).toBeGreaterThan(DAY);
    until(s, 'pol-10', 'fra', arrival + CAPTURE() + HOUR);
    expect(s.provinces['pol-10']!.owner).toBe('fra');
    expect(unitPosAt(s, s.units.u1!, s.time)).toEqual(target.cityPoint);
  });

  it('île : Toulon → Cagliari, traversée par la mer, puis capture', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'ita', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.infantry-light', pos: prov('fra-9').cityPoint, count: 2 }],
    );
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('ita-3').cityPoint }).ok,
    ).toBe(true);
    expect(s.units.u1!.move!.legs.some((l) => l.medium === 'sea')).toBe(true);
    until(s, 'ita-3', 'fra', 3 * DAY);
    expect(s.provinces['ita-3']!.owner).toBe('fra');
  });

  it('règle de capture du catalogue : troupes terrestres oui, DCA, missiles, radars non', () => {
    const cat = world.catalog;
    for (const id of ['eu.leclerc', 'eu.vbci', 'eu.infantry-light', 'eu.caesar', 'us.m777'])
      expect(cat.get(id)!.canCapture, id).toBe(true);
    for (const id of ['ru.s-400', 'eu.mistral', 'ru.iskander-m', 'us.an-tps-75', 'eu.rafale'])
      expect(cat.get(id)!.canCapture, id).toBe(false);
  });

  it('pile de chars seule : capture', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.leclerc', pos: prov('fra-7').cityPoint, count: 4 }],
    );
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('bel-1').cityPoint }).ok,
    ).toBe(true);
    until(s, 'bel-1', 'fra', 2 * DAY);
    expect(s.provinces['bel-1']!.owner).toBe('fra');
  });

  it('artillerie seule (CAESAR) : capture', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.caesar', pos: prov('fra-7').cityPoint, count: 4 }],
    );
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('bel-1').cityPoint }).ok,
    ).toBe(true);
    until(s, 'bel-1', 'fra', 2 * DAY);
    expect(s.provinces['bel-1']!.owner).toBe('fra');
  });

  it('batterie S-400 et artillerie ensemble sur la ville : capture (grâce à l’artillerie)', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [
        { owner: 'fra', systemId: 'ru.s-400', pos: prov('fra-7').cityPoint, count: 2 },
        { owner: 'fra', systemId: 'eu.caesar', pos: prov('fra-7').cityPoint, count: 2 },
      ],
    );
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1', 'u2'], to: prov('bel-1').cityPoint }).ok,
    ).toBe(true);
    until(s, 'bel-1', 'fra', 2 * DAY);
    expect(s.provinces['bel-1']!.owner).toBe('fra');
  });

  it('pile sans unité capable de capturer (S-400) : arrivée, pas de capture, explication', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'ru.s-400', pos: prov('fra-7').cityPoint, count: 2 }],
    );
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('bel-1').cityPoint }).ok,
    ).toBe(true);
    const notes = until(s, 'bel-1', 'fra', 2 * DAY);
    expect(s.provinces['bel-1']!.owner).toBe('bel');
    const hint = notes.find((x) => x.kind === 'generic' && x.category === 'capture');
    expect(hint).toBeDefined();
    expect((hint as { loc?: { text: { key: string } } }).loc?.text.key).toBe(
      'engine.note.captureBlocked.noCapturer',
    );
  });

  it('province alliée (droit de passage) : pas de guerre, pas de capture, explication', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.infantry-mech', pos: prov('fra-7').cityPoint, count: 8 }],
    );
    board(s).passage = { 'fra>bel': 30 * DAY };
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('bel-1').cityPoint }).ok,
    ).toBe(true);
    const notes = until(s, 'bel-1', 'fra', 2 * DAY);
    expect(s.wars['bel|fra']).toBeUndefined();
    expect(s.provinces['bel-1']!.owner).toBe('bel');
    const hint = notes.find((x) => x.kind === 'generic' && x.category === 'capture');
    expect((hint as { loc?: { text: { key: string } } }).loc?.text.key).toBe(
      'engine.note.captureBlocked.noWar',
    );
    // Neutre (sans passage) : la guerre est déclarée en entrant, la garnison combattue, la province prise.
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('lux-2').cityPoint }).ok,
    ).toBe(true);
    until(s, 'lux-2', 'fra', 2 * DAY);
    expect(s.wars['fra|lux']).toBeDefined();
    expect(s.provinces['lux-2']!.owner).toBe('fra');
  });

  it('régression : à l’arrivée en ville, distances des paires cohérentes avec les seuils', () => {
    // Avant correction : la paire (Luxembourg, pile) restait à « 5,000000001 km » (arrondi d'acos à
    // l'instant du franchissement) alors que la pile était sur la ville : ni capture, ni combat contre
    // la garnison posée au même point.
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [{ owner: 'fra', systemId: 'eu.infantry-light', pos: prov('fra-7').cityPoint, count: 2 }],
    );
    board(s).passage = { 'fra>bel': 30 * DAY };
    applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: prov('bel-1').cityPoint });
    until(s, 'bel-1', 'fra', 2 * DAY);
    const city = prov('lux-2').cityPoint;
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: city }).ok).toBe(true);
    const arrival = s.units.u1!.move!.legs.at(-1)!.t1;
    while (s.time < arrival + MINUTE) advanceTo(s, Math.min(arrival + MINUTE, s.time + HOUR));
    const u = s.units.u1!;
    expect(u.pos).toEqual(city);
    const R = CAPTURE_RADIUS_KM;
    const gc = data.balance.combat.groundContactKm;
    let checked = 0;
    for (const key of Object.keys(s.pairs).sort()) {
      if (!key.endsWith('#u1') && !key.split('|').includes('u1')) continue;
      const pair = s.pairs[key]!;
      const isProv = key.includes('#');
      const o = isProv ? null : s.units[key.split('|').find((x) => x !== 'u1')!]!;
      const other = o ? unitPosAt(s, o, s.time) : prov(key.slice(0, key.indexOf('#'))).cityPoint;
      const real = distanceKm(other, city);
      // Seuils propres à la paire : capture et contact (province), portées de tir (unités).
      const thresholds = o ? weaponRangesOf(s, [u, o]) : [R, gc];
      for (const r of thresholds) {
        if (Math.abs(real - r) < 1e-3) continue;
        expect(pair.d <= r, `${key} : ${pair.d} km pour ${real} km (seuil ${r})`).toBe(real <= r);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // Garnison au même point : le combat s'engage (ou la ville est déjà prise).
    expect(u.engaged || s.provinces['lux-2']!.capture !== null || !s.units.u1).toBe(true);
  });

  it('arrivée simultanée avec l’ennemi : combat, puis capture quand le défenseur tombe', () => {
    const s = game(
      [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: false },
      ],
      [
        { owner: 'fra', systemId: 'eu.infantry-mech', pos: prov('fra-7').cityPoint, count: 4 },
        { owner: 'bel', systemId: 'eu.infantry-light', pos: prov('bel-4').cityPoint, count: 1 },
      ],
    );
    const city = prov('bel-1').cityPoint;
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: city }).ok).toBe(true);
    // Le défenseur part de façon à arriver en même temps que l'attaquant.
    const tA = s.units.u1!.move!.legs.at(-1)!.t1;
    expect(applyOrder(s, 'bel', { kind: 'move', unitIds: ['u2'], to: city }).ok).toBe(true);
    const tD = s.units.u2!.move!.legs.at(-1)!.t1;
    if (tD < tA) {
      applyOrder(s, 'bel', { kind: 'stop', unitIds: ['u2'] });
      advanceTo(s, tA - tD);
      expect(applyOrder(s, 'bel', { kind: 'move', unitIds: ['u2'], to: city }).ok).toBe(true);
    }
    const notes = until(s, 'bel-1', 'fra', 3 * DAY);
    expect(notes.some((x) => x.kind === 'combat_started')).toBe(true);
    expect(s.units.u2).toBeUndefined();
    expect(s.provinces['bel-1']!.owner).toBe('fra');
  });

  it('IA en guerre : captures réelles en 7 jours de jeu (monde entier)', () => {
    const s = game([{ nationId: 'fra', isAi: false }]);
    for (const [a, b] of [
      ['rus', 'ukr'],
      ['irn', 'irq'],
      ['gbr', 'irl'],
    ] as const) {
      expect(applyOrder(s, a, { kind: 'declareWar', nationId: b }).ok).toBe(true);
    }
    const taken: Record<string, number> = {};
    for (let t = 6 * HOUR; t <= 7 * DAY; t += 6 * HOUR) {
      for (const x of advanceTo(s, t))
        if (x.kind === 'province_captured') taken[x.by] = (taken[x.by] ?? 0) + 1;
    }
    const total = Object.values(taken).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(5);
    // L'île d'Irlande est prise par la mer (traversée de port à port).
    expect(taken.gbr ?? 0).toBeGreaterThan(0);
  });
});
