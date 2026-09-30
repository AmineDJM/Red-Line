/**
 * Faux moteur minimal qui respecte le contrat de packages/engine/src/api.ts.
 * - Chaque nation jouée reçoit une unité `<nation>-1` à sa capitale.
 * - Une unité ennemie « scout » est posée près de la capitale du joueur (visible).
 * - Une unité ennemie « secret » patrouille très loin (jamais visible) : elle génère des événements
 *   et des notifications toutes les secondes de jeu, qui ne doivent JAMAIS sortir du serveur.
 * - Ordre `stance` sur l'unité « crash » : lève une exception (test d'isolation).
 */
import { createHash } from 'node:crypto';
import type { Engine } from '../src/engine.js';
import type { GameSetup, GameState, World } from '@redline/engine';
import {
  distanceKm,
  positionAt,
  type Balance,
  type GameNotification,
  type LngLat,
  type MapData,
  type NationView,
  type Order,
  type PlayerView,
  type ProvinceView,
  type UnitView,
  type ViewDiff,
  type WeaponSystem,
} from '@redline/shared';

interface FakeUnit {
  id: string;
  owner: string;
  systemId: string;
  pos: LngLat;
  move?: { from: LngLat; to: LngLat; t0: number; t1: number };
  hidden?: boolean;
  stance: 'hold' | 'defend' | 'aggressive';
  version: number;
}

interface FakeEvent {
  time: number;
  seq: number;
  kind: 'arrive' | 'patrol';
  unitId: string;
  version: number;
}

interface FakeState extends GameState {
  seed: number;
  seq: number;
  players: string[];
  nations: string[];
  units: Record<string, FakeUnit>;
  queue: FakeEvent[];
}

export const PATROL_PERIOD_MS = 1000;
export const fakeStats = { buildWorld: 0 };

const S = (s: GameState) => s as FakeState;

function unitPos(u: FakeUnit, t: number): LngLat {
  if (!u.move) return u.pos;
  return positionAt({ legs: [{ ...u.move, medium: 'land' }] }, t);
}

function push(s: FakeState, e: Omit<FakeEvent, 'seq'>): void {
  s.queue.push({ ...e, seq: ++s.seq });
  s.queue.sort((a, b) => a.time - b.time || a.seq - b.seq);
}

function capitalOf(world: World, nation: string): LngLat {
  const n = world.map.nations.find((x) => x.id === nation);
  const p = world.map.provinces.find((x) => x.id === n?.capitalProvinceId);
  return (p?.cityPoint ?? [0, 0]) as LngLat;
}

function visibleTo(s: FakeState, nation: string, u: FakeUnit): boolean {
  if (u.owner === nation) return true;
  if (u.hidden) return false;
  return Object.values(s.units).some(
    (o) => o.owner === nation && distanceKm(unitPos(o, s.time), unitPos(u, s.time)) < 1500,
  );
}

const buildWorld: Engine['buildWorld'] = (
  map: MapData,
  catalog: WeaponSystem[],
  balance: Balance,
) => {
  fakeStats.buildWorld++;
  return {
    map,
    catalog: new Map(catalog.map((c) => [c.id, c])),
    balance,
    internal: { catalogIds: catalog.map((c) => c.id) },
  };
};

const createGame: Engine['createGame'] = (world: World, setup: GameSetup) => {
  const nations = setup.nationIds ?? world.map.nations.map((n) => n.id);
  const players = setup.players.map((p) => p.nationId);
  const systemId = [...world.catalog.keys()][0] ?? 'xx.none';
  const s: FakeState = {
    world,
    time: 0,
    seed: setup.seed,
    seq: 0,
    players,
    nations,
    units: {},
    queue: [],
  };
  for (const p of players) {
    const cap = capitalOf(world, p);
    s.units[`${p}-1`] = {
      id: `${p}-1`,
      owner: p,
      systemId,
      pos: cap,
      stance: 'defend',
      version: 0,
    };
    const enemy = nations.find((n) => !players.includes(n)) ?? 'zzz';
    s.units.scout = {
      id: 'scout',
      owner: enemy,
      systemId,
      pos: [cap[0] + 1, cap[1] + 1],
      stance: 'hold',
      version: 0,
    };
    s.units.secret = {
      id: 'secret',
      owner: enemy,
      systemId,
      pos: [cap[0] + 150 > 180 ? cap[0] - 150 : cap[0] + 150, -cap[1]],
      stance: 'hold',
      hidden: true,
      version: 0,
    };
  }
  push(s, { time: PATROL_PERIOD_MS, kind: 'patrol', unitId: 'secret', version: 0 });
  return s;
};

const applyOrder: Engine['applyOrder'] = (state, nationId, order: Order) => {
  const s = S(state);
  if (order.kind === 'stance' && order.unitIds.includes('crash'))
    throw new Error('boum (faux moteur)');
  if (order.kind !== 'move' && order.kind !== 'stop' && order.kind !== 'stance') {
    return { ok: false, error: 'not_allowed', message: 'Ordre non géré par le faux moteur' };
  }
  for (const id of order.unitIds) {
    const u = s.units[id];
    if (!u || !visibleTo(s, nationId, u)) return { ok: false, error: 'unknown_unit' };
    if (u.owner !== nationId) return { ok: false, error: 'not_owner' };
  }
  for (const id of order.unitIds) {
    const u = s.units[id]!;
    const here = unitPos(u, s.time);
    u.version++;
    if (order.kind === 'stance') {
      u.stance = order.stance;
    } else if (order.kind === 'stop') {
      u.pos = here;
      delete u.move;
    } else {
      const speed = s.world.catalog.get(u.systemId)?.speedKmh || 100;
      const t1 =
        s.time + Math.max(1000, Math.round((distanceKm(here, order.to) / speed) * 3_600_000));
      u.pos = here;
      u.move = { from: here, to: order.to, t0: s.time, t1 };
      push(s, { time: t1, kind: 'arrive', unitId: id, version: u.version });
    }
  }
  return { ok: true };
};

const advanceTo: Engine['advanceTo'] = (state, t) => {
  const s = S(state);
  const notes: GameNotification[] = [];
  while (s.queue.length && s.queue[0]!.time <= t) {
    const e = s.queue.shift()!;
    const u = s.units[e.unitId];
    if (!u) continue;
    if (e.kind === 'patrol') {
      u.pos = [u.pos[0], u.pos[1] > 0 ? u.pos[1] - 0.1 : u.pos[1] + 0.1];
      notes.push({ kind: 'arrived', time: e.time, at: u.pos, unitId: u.id });
      push(s, { time: e.time + PATROL_PERIOD_MS, kind: 'patrol', unitId: u.id, version: 0 });
    } else if (e.version === u.version && u.move) {
      u.pos = u.move.to;
      delete u.move;
      notes.push({ kind: 'arrived', time: e.time, at: u.pos, unitId: u.id });
    }
  }
  s.time = Math.max(s.time, t);
  return notes;
};

const nextEventTime: Engine['nextEventTime'] = (state) => S(state).queue[0]?.time ?? null;

const viewFor: Engine['viewFor'] = (state, nationId) => {
  const s = S(state);
  const units: Record<string, UnitView> = {};
  for (const u of Object.values(s.units)) {
    if (!visibleTo(s, nationId, u)) continue;
    const own = u.owner === nationId;
    const move = u.move ? { legs: [{ ...u.move, medium: 'land' as const }] } : undefined;
    units[u.id] = own
      ? {
          id: u.id,
          owner: u.owner,
          level: 'own',
          pos: u.pos,
          ...(move ? { move } : {}),
          lastSeen: s.time,
          uncertaintyKm: 0,
          systemId: u.systemId,
          count: 1,
          hpRatio: 1,
          status: u.move ? 'moving' : 'idle',
          stance: u.stance,
          xp: 0,
        }
      : {
          id: u.id,
          owner: u.owner,
          level: 'detected',
          pos: unitPos(u, s.time),
          lastSeen: s.time,
          uncertaintyKm: 0,
        };
  }
  const nations: Record<string, NationView> = {};
  for (const n of s.world.map.nations) {
    if (!s.nations.includes(n.id)) continue;
    nations[n.id] = {
      id: n.id,
      name: n.name,
      color: n.color,
      isAi: !s.players.includes(n.id),
      isPlayer: s.players.includes(n.id),
      alive: true,
      provinceCount: s.world.map.provinces.filter((p) => p.nationId === n.id).length,
    };
  }
  const provinces: Record<string, ProvinceView> = {};
  for (const p of s.world.map.provinces) {
    provinces[p.id] = { id: p.id, owner: p.nationId, capture: null, buildings: p.buildings };
  }
  return {
    time: s.time,
    me: nationId,
    nations,
    provinces,
    units,
    economy: {
      money: s.world.balance.economy.startingMoney,
      resources: { oil: 0, metals: 0, electronics: 0, food: 0 },
      incomePerDay: { money: 0 },
      production: [],
    },
    victory: {
      provinceShareTarget: s.world.balance.victory.provinceShare,
      leader: null,
      winner: null,
    },
  };
};

const J = (x: unknown) => JSON.stringify(x);

const diffViews: Engine['diffViews'] = (prev: PlayerView, next: PlayerView): ViewDiff | null => {
  const d: ViewDiff = { time: next.time };
  let changed = false;
  const upsert: UnitView[] = [];
  const remove: string[] = [];
  for (const [id, u] of Object.entries(next.units)) if (J(prev.units[id]) !== J(u)) upsert.push(u);
  for (const id of Object.keys(prev.units)) if (!next.units[id]) remove.push(id);
  if (upsert.length || remove.length) {
    d.units = { upsert, remove };
    changed = true;
  }
  if (J(prev.nations) !== J(next.nations)) {
    d.nations = next.nations;
    changed = true;
  }
  if (J(prev.provinces) !== J(next.provinces)) {
    d.provinces = next.provinces;
    changed = true;
  }
  if (J(prev.economy) !== J(next.economy)) {
    d.economy = next.economy;
    changed = true;
  }
  if (J(prev.victory) !== J(next.victory)) {
    d.victory = next.victory;
    changed = true;
  }
  return changed ? d : null;
};

const notificationsFor: Engine['notificationsFor'] = (state, nationId, items) => {
  const s = S(state);
  return items.filter((n) => {
    const id = 'unitId' in n ? n.unitId : undefined;
    if (!id) return true;
    const u = s.units[id];
    return !!u && visibleTo(s, nationId, u);
  });
};

const serializeState: Engine['serializeState'] = (state) => {
  const { world: _w, ...rest } = S(state);
  return new TextEncoder().encode(JSON.stringify(rest));
};

const deserializeState: Engine['deserializeState'] = (world, bytes) => {
  const rest = JSON.parse(new TextDecoder().decode(bytes)) as Omit<FakeState, 'world'>;
  return { ...rest, world } as FakeState;
};

const stateHash: Engine['stateHash'] = (state) =>
  createHash('sha256').update(serializeState(state)).digest('hex');

export function createFakeEngine(): Engine {
  return {
    buildWorld,
    createGame,
    applyOrder,
    advanceTo,
    nextEventTime,
    viewFor,
    diffViews,
    notificationsFor,
    serializeState,
    deserializeState,
    stateHash,
  };
}
