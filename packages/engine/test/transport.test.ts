/**
 * Transport naval de troupes (ordres embark / disembark) sur les VRAIES données (carte, routes,
 * catalogue) : embarquement au port, traversée, débarquement amphibie et capture d'une province
 * insulaire, refus motivés, navire coulé, débarquement contesté, rejeu et reprise d'instantané.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { HOUR, MINUTE, distanceKm, type LngLat, type ProvinceDef } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
  type GameSetup,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { destroyUnit } from '../src/combat/combat.js';
import { mil, milBal } from '../src/modules/mil/state.js';
import { capacityOf, placesOf } from '../src/modules/mil/transport.js';
import { unitModifier } from '../src/modules/registry.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

const SHIP = 'eu.mistral-class';
const INF = 'eu.infantry-light';
const NATIONS = ['fra', 'ita', 'mco', 'mlt', 'esp'];

let data: RealData;
let world: World;
let prov: (id: string) => ProvinceDef;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, { research: data.research });
  prov = (id) => data.map.provinces.find((p) => p.id === id)!;
}, 60_000);

const sea = (pid: string): LngLat => wi(world).seaSpawn.get(pid)!;

function game(units: GameSetup['units']): EngineState {
  return createGame(world, {
    seed: 3,
    players: NATIONS.map((n) => ({ nationId: n, isAi: false })),
    nationIds: NATIONS,
    units,
  }) as EngineState;
}

function run(s: EngineState, ms: number): void {
  const end = s.time + ms;
  while (s.time < end) advanceTo(s, Math.min(end, s.time + 30 * MINUTE));
}

// Provinces désignées par leur ville (identifiants propres à chaque version de la carte).
let TOULON = '';
let CAGLIARI = '';
let LYON = '';
beforeAll(() => {
  TOULON = provinceAt(data.map, PLACES.toulon).id;
  CAGLIARI = provinceAt(data.map, PLACES.cagliari).id;
  LYON = provinceAt(data.map, PLACES.lyon).id;
});

describe('transport naval : embarquer, traverser, débarquer', () => {
  it('Toulon → Cagliari : embarquement au port, traversée, débarquement, capture de l’île', () => {
    const s = game([
      { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 2 },
    ]);
    const ship = s.units.u1!;
    const inf = s.units.u2!;
    expect(capacityOf(s, ship)).toBe(100);
    expect(placesOf(s, inf)).toBe(80);
    expect(applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' })).toEqual({
      ok: true,
    });
    // Embarquement en cours : visible côté propriétaire, durée du port.
    const v0 = viewFor(s, 'fra');
    expect(v0.units.u2!.loading).toEqual({
      transportId: 'u1',
      doneAt: milBal(s).transport.portMinutes * MINUTE,
    });
    expect(v0.units.u1!.cargo).toMatchObject({ capacity: 100, used: 80, loadingIds: ['u2'] });
    run(s, 61 * MINUTE);
    expect(mil(s).tr?.u2).toBe('u1');
    expect(inf.off).toBe(true);
    const v1 = viewFor(s, 'fra');
    expect(v1.units.u2).toMatchObject({ status: 'embarked', transportId: 'u1' });
    expect(v1.units.u1!.cargo).toMatchObject({ unitIds: ['u2'], used: 80 });
    // Une pile à bord ne se déplace pas seule : refus motivé.
    expect(
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u2'], to: prov(TOULON).cityPoint }),
    ).toMatchObject({ ok: false, reason: 'transport_embarked' });
    // Les autres nations ne voient pas la cargaison.
    expect(viewFor(s, 'ita').units.u2).toBeUndefined();

    // Traversée vers Cagliari puis débarquement amphibie.
    const target = prov(CAGLIARI).cityPoint;
    expect(applyOrder(s, 'fra', { kind: 'disembark', transportId: 'u1', to: target })).toEqual({
      ok: true,
    });
    expect(ship.move).not.toBeNull();
    expect(viewFor(s, 'fra').units.u1!.cargo!.landing).toMatchObject({ doneAt: null });
    const arrive = ship.move!.legs[ship.move!.legs.length - 1]!.t1;
    // Côte ennemie : mise à terre plus lente qu'au port (coastFactor).
    run(s, arrive - s.time + 4 * HOUR);
    expect(mil(s).tr?.u2).toBeUndefined();
    expect(inf.off).toBe(false);
    expect(distanceKm(inf.pos, target)).toBeLessThan(5);
    // Mise à terre en Italie : guerre déclarée comme pour une entrée par la route, puis capture.
    expect(s.wars['fra|ita']).toBeDefined();
    run(s, (data.balance.time.captureMinutes + 30) * MINUTE);
    expect(s.provinces[CAGLIARI]!.owner).toBe('fra');
    expect(viewFor(s, 'fra').provinces[CAGLIARI]!.owner).toBe('fra');
  });

  it('refus clairs : capacité, distance, navire sans soute, navire en route, cargaison vide', () => {
    const s = game([
      { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 5 },
      { owner: 'fra', systemId: INF, pos: prov(LYON).cityPoint, count: 1 },
      { owner: 'fra', systemId: 'eu.fremm', pos: sea(TOULON), count: 1 },
      { owner: 'ita', systemId: INF, pos: prov(CAGLIARI).cityPoint, count: 1 },
    ]);
    expect(
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' }),
    ).toMatchObject({
      ok: false,
      error: 'capacity',
      reason: 'transport_capacity',
      params: { need: 200, cap: 100 },
    });
    expect(
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u3'], transportId: 'u1' }),
    ).toMatchObject({ ok: false, reason: 'transport_too_far' });
    expect(
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u4' }),
    ).toMatchObject({ ok: false, reason: 'transport_not_ship' });
    expect(
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u4'], transportId: 'u1' }),
    ).toMatchObject({ ok: false, reason: 'transport_not_land' });
    expect(
      applyOrder(s, 'ita', { kind: 'embark', unitIds: ['u5'], transportId: 'u1' }),
    ).toMatchObject({ ok: false, error: 'not_owner' });
    expect(applyOrder(s, 'fra', { kind: 'disembark', transportId: 'u1' })).toMatchObject({
      ok: false,
      reason: 'transport_empty',
    });
    // Navire en route : il faut d'abord l'arrêter.
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: sea(CAGLIARI) }).ok).toBe(
      true,
    );
    advanceTo(s, 10 * MINUTE);
    expect(applyOrder(s, 'fra', { kind: 'split', unitId: 'u2', count: 2 }).ok).toBe(true);
    expect(
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' }),
    ).toMatchObject({ ok: false, reason: 'transport_moving' });
  });

  it('embarquement annulé si la pile ou le navire bouge ; scission et fusion refusées à bord', () => {
    const s = game([
      { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 1 },
    ]);
    expect(applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' }).ok).toBe(
      true,
    );
    expect(applyOrder(s, 'fra', { kind: 'stop', unitIds: ['u2'] }).ok).toBe(true);
    run(s, 2 * HOUR);
    expect(mil(s).tr?.u2).toBeUndefined();
    expect(s.units.u2!.off).toBeFalsy();
    expect(applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' }).ok).toBe(
      true,
    );
    run(s, 2 * HOUR);
    expect(mil(s).tr?.u2).toBe('u1');
    expect(applyOrder(s, 'fra', { kind: 'split', unitId: 'u1', count: 1 })).toMatchObject({
      ok: false,
    });
    expect(applyOrder(s, 'fra', { kind: 'merge', unitIds: ['u2', 'u3'] })).toMatchObject({
      ok: false,
      reason: 'transport_embarked',
    });
    // Débarquement sur place (au port) : de retour sur la carte, sur la route.
    expect(applyOrder(s, 'fra', { kind: 'disembark', transportId: 'u1' }).ok).toBe(true);
    run(s, 2 * HOUR);
    expect(s.units.u2!.off).toBe(false);
    expect(wi(world).roads!.snap(s.units.u2!.pos, 0.05)).not.toBeNull();
  });

  it('navire coulé : les troupes à bord sont perdues', () => {
    const s = game([
      { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 2 },
    ]);
    applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' });
    run(s, 2 * HOUR);
    expect(mil(s).tr?.u2).toBe('u1');
    destroyUnit(s, s.units.u1!, null);
    expect(s.units.u2).toBeUndefined();
    expect(mil(s).tr?.u2).toBeUndefined();
    const notes = advanceTo(s, s.time + MINUTE);
    void notes;
  });

  it('débarquement contesté : malus de dégâts des troupes mises à terre sous le feu', () => {
    const s = game([
      { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
      { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 2 },
      { owner: 'ita', systemId: INF, pos: prov(CAGLIARI).cityPoint, count: 1 },
    ]);
    applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' });
    run(s, 2 * HOUR);
    applyOrder(s, 'fra', { kind: 'disembark', transportId: 'u1', to: prov(CAGLIARI).cityPoint });
    const ship = s.units.u1!;
    const arrive = ship.move!.legs[ship.move!.legs.length - 1]!.t1;
    // Juste après la mise à terre (débarquement depuis la côte ou un port ennemi : plus long).
    let landedAt = -1;
    for (let t = s.time; t < arrive + 6 * HOUR && landedAt < 0; t += 10 * MINUTE) {
      advanceTo(s, t);
      if (s.units.u2 && !s.units.u2.off) landedAt = s.time;
    }
    expect(landedAt).toBeGreaterThan(0);
    expect(mil(s).lnd?.u2).toBeGreaterThan(s.time);
    expect(unitModifier(s, s.units.u2!, 'combat.damage')).toBeCloseTo(
      1 - milBal(s).transport.landingPenalty,
    );
    // Le malus expire.
    run(s, (milBal(s).transport.landingPenaltyHours + 1) * HOUR);
    if (s.units.u2) expect(unitModifier(s, s.units.u2, 'combat.damage')).toBeCloseTo(1);
  });

  it('rejeu identique et reprise d’instantané pendant la traversée', () => {
    const play = (snapAt: number | null) => {
      let s = game([
        { owner: 'fra', systemId: SHIP, pos: sea(TOULON), count: 1 },
        { owner: 'fra', systemId: INF, pos: prov(TOULON).cityPoint, count: 2 },
      ]);
      applyOrder(s, 'fra', { kind: 'embark', unitIds: ['u2'], transportId: 'u1' });
      run(s, 2 * HOUR);
      applyOrder(s, 'fra', { kind: 'disembark', transportId: 'u1', to: prov(CAGLIARI).cityPoint });
      run(s, 3 * HOUR);
      if (snapAt !== null) s = deserializeState(world, serializeState(s)) as EngineState;
      run(s, 30 * HOUR);
      return stateHash(s);
    };
    const a = play(null);
    expect(play(null)).toBe(a);
    expect(play(1)).toBe(a);
  });
});
