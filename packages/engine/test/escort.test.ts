/**
 * Ordre « escorter » sur les VRAIES données (carte, catalogue) : chasseurs escortant des bombardiers,
 * frégate escortant un transport, défense antiaérienne mobile accompagnant une colonne ; engagement des
 * menaces, fin d'escorte (cible détruite, ordre d'arrêt), refus motivés, rejeu déterministe.
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
import { unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { destroyUnit } from '../src/combat/combat.js';
import { mil, milBal } from '../src/modules/mil/state.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

let data: RealData;
let world: World;
let prov: (id: string) => ProvinceDef;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, { research: data.research });
  prov = (id) => data.map.provinces.find((p) => p.id === id)!;
}, 60_000);

function game(
  units: GameSetup['units'],
  nations = ['rus', 'ukr', 'fra', 'ita', 'blr'],
): EngineState {
  return createGame(world, {
    seed: 5,
    players: nations.map((n) => ({ nationId: n, isAi: false })),
    nationIds: nations,
    units,
  }) as EngineState;
}

const at = (s: EngineState, id: string): LngLat => unitPosAt(s, s.units[id]!, s.time);
const gap = (s: EngineState, a: string, b: string) => distanceKm(at(s, a), at(s, b));
// Provinces désignées par leur ville (identifiants propres à chaque version de la carte).
let KURSK = '';
let KYIV = '';
let TOULON = '';
let CAGLIARI = '';
let MONTPELLIER = '';
beforeAll(() => {
  KURSK = provinceAt(data.map, PLACES.koursk).id;
  KYIV = provinceAt(data.map, PLACES.kiev).id;
  TOULON = provinceAt(data.map, PLACES.toulon).id;
  CAGLIARI = provinceAt(data.map, PLACES.cagliari).id;
  MONTPELLIER = provinceAt(data.map, PLACES.montpellier).id;
});

describe('escorter', () => {
  it('chasseurs et bombardiers : décollage avec la cible, vol en formation', () => {
    const s = game([
      { owner: 'rus', systemId: 'ru.tu-22m3', pos: prov(KURSK).cityPoint, count: 2 },
      { owner: 'rus', systemId: 'ru.su-35', pos: prov(KURSK).cityPoint, count: 2 },
    ]);
    // Bombardier encore au sol : l'escorte attend son décollage.
    expect(applyOrder(s, 'rus', { kind: 'escort', unitIds: ['u2'], targetId: 'u1' })).toEqual({
      ok: true,
    });
    expect(mil(s).ms.u2!.mis).toBe('escort');
    expect(viewFor(s, 'rus').units.u2!.mission).toMatchObject({ kind: 'escort', escortId: 'u1' });
    advanceTo(s, 10 * MINUTE);
    expect(mil(s).ms.u2!.up).toBe(false);
    // Le bombardier part vers l'ouest (sans franchir la frontière) : l'escorte le rejoint.
    const aim: LngLat = [prov(KURSK).cityPoint[0] - 1.5, prov(KURSK).cityPoint[1] + 2.5];
    expect(applyOrder(s, 'rus', { kind: 'move', unitIds: ['u1'], to: aim }).ok).toBe(true);
    advanceTo(s, 20 * MINUTE);
    expect(mil(s).ms.u2!.up).toBe(true);
    for (let t = 25; t <= 40; t += 5) {
      advanceTo(s, t * MINUTE);
      expect(gap(s, 'u1', 'u2'), `écart à ${t} min`).toBeLessThan(milBal(s).escort.followKm);
    }
  });

  it('engage un intercepteur ennemi qui menace la pile escortée', () => {
    const kyiv = prov(KYIV).cityPoint;
    const s = game([
      { owner: 'rus', systemId: 'ru.tu-22m3', pos: prov(KURSK).cityPoint, count: 2 },
      { owner: 'rus', systemId: 'ru.su-35', pos: prov(KURSK).cityPoint, count: 4 },
      // Intercepteur ukrainien en vol au-devant du raid.
      { owner: 'ukr', systemId: 'ru.mig-29', pos: [33.6, 50.8], count: 2 },
    ]);
    expect(applyOrder(s, 'rus', { kind: 'move', unitIds: ['u1'], to: kyiv }).ok).toBe(true);
    expect(applyOrder(s, 'rus', { kind: 'escort', unitIds: ['u2'], targetId: 'u1' }).ok).toBe(true);
    let engaged = false;
    for (let t = 2; t <= 60 && !engaged; t += 2) {
      advanceTo(s, t * MINUTE);
      engaged = s.units.u2?.target === 'u3' || !s.units.u3 || s.units.u3.hp < s.units.u3.maxHp;
    }
    expect(engaged).toBe(true);
  });

  it('frégate et transport : la frégate suit le navire ; fin quand la cible est détruite', () => {
    const toulon = wi(world).seaSpawn.get(TOULON)!;
    const cagliari = wi(world).seaSpawn.get(CAGLIARI)!;
    const s = game([
      { owner: 'fra', systemId: 'eu.mistral-class', pos: toulon, count: 1 },
      { owner: 'fra', systemId: 'eu.fremm', pos: toulon, count: 1 },
    ]);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: cagliari }).ok).toBe(true);
    expect(applyOrder(s, 'fra', { kind: 'escort', unitIds: ['u2'], targetId: 'u1' }).ok).toBe(true);
    for (let h = 1; h <= 6; h++) {
      advanceTo(s, h * HOUR);
      expect(gap(s, 'u1', 'u2'), `écart à ${h} h`).toBeLessThan(milBal(s).escort.followKm);
    }
    destroyUnit(s, s.units.u1!, null);
    const notes = advanceTo(s, s.time + 10 * MINUTE);
    expect(mil(s).ms.u2!.mis).toBe('none');
    expect(s.units.u2!.move).toBeNull();
    expect(notes.some((n) => n.kind === 'generic' && n.category === 'escort')).toBe(true);
  });

  it('défense antiaérienne mobile : suit une colonne sur la route ; arrêt = fin d’escorte', () => {
    const s = game([
      { owner: 'rus', systemId: 'eu.infantry-light', pos: prov(KURSK).cityPoint, count: 2 },
      { owner: 'rus', systemId: 'ru.tor-m2', pos: prov(KURSK).cityPoint, count: 2 },
    ]);
    const voronezh = data.map.provinces.find((p) => p.cityName === 'Voronej')!.cityPoint;
    expect(applyOrder(s, 'rus', { kind: 'move', unitIds: ['u1'], to: voronezh }).ok).toBe(true);
    expect(applyOrder(s, 'rus', { kind: 'escort', unitIds: ['u2'], targetId: 'u1' }).ok).toBe(true);
    for (let h = 1; h <= 3; h++) {
      advanceTo(s, h * HOUR);
      expect(gap(s, 'u1', 'u2')).toBeLessThan(milBal(s).escort.followKm);
    }
    expect(applyOrder(s, 'rus', { kind: 'stop', unitIds: ['u2'] }).ok).toBe(true);
    expect(mil(s).ms.u2!.mis).toBe('none');
    advanceTo(s, 4 * HOUR);
    expect(s.units.u2!.move).toBeNull();
  });

  it('refus motivés', () => {
    const s = game([
      { owner: 'rus', systemId: 'ru.tu-22m3', pos: prov(KURSK).cityPoint, count: 1 },
      { owner: 'rus', systemId: 'ru.su-35', pos: prov(KURSK).cityPoint, count: 1 },
      { owner: 'rus', systemId: 'eu.infantry-light', pos: prov(KURSK).cityPoint, count: 1 },
      { owner: 'ukr', systemId: 'eu.infantry-light', pos: prov(KYIV).cityPoint, count: 1 },
      { owner: 'fra', systemId: 'eu.fremm', pos: wi(world).seaSpawn.get(TOULON)!, count: 1 },
      { owner: 'fra', systemId: 'eu.infantry-light', pos: prov(TOULON).cityPoint, count: 1 },
      { owner: 'rus', systemId: 'us.kc-135-stratotanker', pos: prov(KURSK).cityPoint, count: 1 },
    ]);
    const r = (n: string, unitIds: string[], targetId: string) =>
      applyOrder(s, n, { kind: 'escort', unitIds, targetId });
    expect(r('rus', ['u2'], 'u2')).toMatchObject({ ok: false, reason: 'escort_self' });
    expect(r('rus', ['u2'], 'u4')).toMatchObject({ ok: false, reason: 'escort_target_invalid' });
    expect(r('fra', ['u5'], 'u6')).toMatchObject({ ok: false, reason: 'escort_domain' });
    expect(r('rus', ['u7'], 'u1')).toMatchObject({ ok: false, reason: 'escort_incapable' });
    expect(r('ukr', ['u4'], 'u3')).toMatchObject({ ok: false, reason: 'escort_target_invalid' });
  });

  it('rejeu identique et reprise d’instantané en cours d’escorte', () => {
    const play = (snap: boolean) => {
      let s = game([
        {
          owner: 'fra',
          systemId: 'eu.mistral-class',
          pos: wi(world).seaSpawn.get(TOULON)!,
          count: 1,
        },
        { owner: 'fra', systemId: 'eu.fremm', pos: wi(world).seaSpawn.get(TOULON)!, count: 1 },
      ]);
      applyOrder(s, 'fra', {
        kind: 'move',
        unitIds: ['u1'],
        to: wi(world).seaSpawn.get(CAGLIARI)!,
      });
      applyOrder(s, 'fra', { kind: 'escort', unitIds: ['u2'], targetId: 'u1' });
      advanceTo(s, 3 * HOUR);
      if (snap) s = deserializeState(world, serializeState(s)) as EngineState;
      applyOrder(s, 'fra', {
        kind: 'move',
        unitIds: ['u1'],
        to: wi(world).seaSpawn.get(MONTPELLIER)!,
      });
      advanceTo(s, 12 * HOUR);
      return stateHash(s);
    };
    const a = play(false);
    expect(play(false)).toBe(a);
    expect(play(true)).toBe(a);
  });
});
