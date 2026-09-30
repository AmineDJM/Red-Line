/**
 * Faux moteur minimal qui respecte le contrat de packages/engine/src/api.ts.
 * - Chaque nation jouée reçoit une unité `<nation>-1` à sa capitale.
 * - Une unité ennemie « scout » est posée près de la capitale du joueur (visible).
 * - Une unité ennemie « secret » patrouille très loin (jamais visible) : elle génère des événements
 *   et des notifications toutes les secondes de jeu, qui ne doivent JAMAIS sortir du serveur.
 * - Ordre `stance` sur l'unité « crash » : lève une exception (test d'isolation).
 * Phases 5-6 (tests) :
 * - `declareWar` : prend immédiatement la capitale de la nation visée (province_captured) ;
 * - `mobilize` { on: true } : victoire de la nation une seconde de jeu plus tard ;
 * - `createAlliance` / `inviteToAlliance` : alliance simplifiée (membre ajouté aussitôt) ;
 * - applySystem, publicView (sans l'unité secrète), ownersFrame, stats, battleReportFor ('r1').
 */
import { createHash } from 'node:crypto';
import type { Engine } from '../src/engine.js';
import type { GameSetup, GameState, SystemCommand, World } from '@redline/engine';
import {
  distanceKm,
  positionAt,
  type Balance,
  type BattleReport,
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
  kind: 'arrive' | 'patrol' | 'capture' | 'win';
  unitId: string;
  version: number;
  by?: string;
  target?: string;
}

interface FakeState extends GameState {
  seed: number;
  seq: number;
  players: string[];
  nations: string[];
  units: Record<string, FakeUnit>;
  queue: FakeEvent[];
  // ——— Phases 5-6 ———
  ai: Record<string, boolean>;
  owners: Record<string, string>;
  alliances: { id: string; members: string[] }[];
  sys: SystemCommand[];
  winner: string | null;
  conquered: Record<string, number>;
}

export const PATROL_PERIOD_MS = 1000;
export const fakeStats = { buildWorld: 0, lastExtras: null as unknown };

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
  extras,
) => {
  fakeStats.buildWorld++;
  fakeStats.lastExtras = extras ?? null;
  return {
    map,
    catalog: new Map(catalog.map((c) => [c.id, c])),
    balance,
    internal: { catalogIds: catalog.map((c) => c.id) },
  };
};

function makeCreateGame(patrol: boolean): Engine['createGame'] {
  return (world: World, setup: GameSetup) => {
    const nations = setup.nationIds ?? world.map.nations.map((n) => n.id);
    const players = setup.players.filter((p) => !p.isAi).map((p) => p.nationId);
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
      ai: Object.fromEntries(setup.players.filter((p) => p.isAi).map((p) => [p.nationId, true])),
      owners: Object.fromEntries(world.map.provinces.map((p) => [p.id, p.nationId])),
      alliances: [],
      sys: [],
      winner: null,
      conquered: {},
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
    if (patrol) push(s, { time: PATROL_PERIOD_MS, kind: 'patrol', unitId: 'secret', version: 0 });
    return s;
  };
}

const applyOrder: Engine['applyOrder'] = (state, nationId, order: Order) => {
  const s = S(state);
  if (s.winner) return { ok: false, error: 'game_over' };
  if (order.kind === 'stance' && order.unitIds.includes('crash'))
    throw new Error('boum (faux moteur)');
  if (order.kind === 'declareWar') {
    if (!s.nations.includes(order.nationId) || order.nationId === nationId) {
      return { ok: false, error: 'invalid_target' };
    }
    const cap = s.world.map.nations.find((n) => n.id === order.nationId)?.capitalProvinceId;
    if (!cap) return { ok: false, error: 'invalid_target' };
    push(s, { time: s.time, kind: 'capture', unitId: '', version: 0, by: nationId, target: cap });
    return { ok: true };
  }
  if (order.kind === 'mobilize') {
    if (order.on) push(s, { time: s.time + 1000, kind: 'win', unitId: '', version: 0, by: nationId });
    return { ok: true };
  }
  if (order.kind === 'createAlliance') {
    s.alliances.push({ id: `a${++s.seq}`, members: [nationId] });
    return { ok: true };
  }
  if (order.kind === 'inviteToAlliance') {
    const a = s.alliances.find((x) => x.members.includes(nationId));
    if (!a) return { ok: false, error: 'not_allowed' };
    if (!a.members.includes(order.nationId)) a.members.push(order.nationId);
    return { ok: true };
  }
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
    if (e.kind === 'capture') {
      const from = s.owners[e.target!]!;
      s.owners[e.target!] = e.by!;
      s.conquered[e.by!] = (s.conquered[e.by!] ?? 0) + 1;
      const p = s.world.map.provinces.find((x) => x.id === e.target);
      notes.push({
        kind: 'province_captured',
        time: e.time,
        at: (p?.cityPoint ?? [0, 0]) as LngLat,
        provinceId: e.target!,
        by: e.by!,
        from,
      });
      continue;
    }
    if (e.kind === 'win') {
      if (!s.winner) {
        s.winner = e.by!;
        notes.push({ kind: 'victory', time: e.time, winner: e.by! });
      }
      continue;
    }
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

function nationsOf(s: FakeState, me: string): Record<string, NationView> {
  const nations: Record<string, NationView> = {};
  for (const n of s.world.map.nations) {
    if (!s.nations.includes(n.id)) continue;
    nations[n.id] = {
      id: n.id,
      name: n.name,
      color: n.color,
      isAi: !s.players.includes(n.id) || !!s.ai[n.id],
      isPlayer: s.players.includes(n.id) && !s.ai[n.id],
      alive: true,
      provinceCount: Object.values(s.owners).filter((o) => o === n.id).length,
      allianceId: s.alliances.find((a) => a.members.includes(n.id))?.id ?? null,
    };
  }
  void me;
  return nations;
}

function provincesOf(s: FakeState): Record<string, ProvinceView> {
  const provinces: Record<string, ProvinceView> = {};
  for (const p of s.world.map.provinces) {
    provinces[p.id] = {
      id: p.id,
      owner: s.owners[p.id] ?? p.nationId,
      capture: null,
      buildings: p.buildings,
    };
  }
  return provinces;
}

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
  const mine = s.alliances.find((a) => a.members.includes(nationId));
  const view: PlayerView = {
    time: s.time,
    me: nationId,
    nations: nationsOf(s, nationId),
    provinces: provincesOf(s),
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
      winner: s.winner,
    },
  };
  if (s.alliances.length) {
    view.diplomacy = {
      relations: [],
      alliances: mine
        ? [
            {
              id: mine.id,
              name: 'Alliance',
              flag: 'A',
              leader: mine.members[0]!,
              members: [...mine.members],
              charter: { mutualDefense: true, intelSharing: true, passage: true },
              treasury: 0,
              createdAt: 0,
              votes: [],
              invites: [],
            },
          ]
        : [],
      myAllianceId: mine?.id ?? null,
      invitations: [],
      reputation: 50,
      disputed: [],
      neutrals: [],
    };
  }
  return view;
};

const publicView: NonNullable<Engine['publicView']> = (state) => {
  const s = S(state);
  const units: Record<string, UnitView> = {};
  for (const u of Object.values(s.units)) {
    if (u.hidden) continue; // l'unité secrète n'est jamais publique
    units[u.id] = {
      id: u.id,
      owner: u.owner,
      level: 'identified',
      pos: unitPos(u, s.time),
      lastSeen: s.time,
      uncertaintyKm: 0,
      systemId: u.systemId,
    };
  }
  return {
    time: s.time,
    me: '',
    nations: nationsOf(s, ''),
    provinces: provincesOf(s),
    units,
    economy: {
      money: 0,
      resources: { oil: 0, metals: 0, electronics: 0, food: 0 },
      incomePerDay: { money: 0 },
      production: [],
    },
    victory: {
      provinceShareTarget: s.world.balance.victory.provinceShare,
      leader: null,
      winner: s.winner,
    },
    spectator: true,
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
  for (const k of ['nations', 'provinces', 'economy', 'victory', 'diplomacy'] as const) {
    if (J(prev[k]) !== J(next[k])) {
      (d as unknown as Record<string, unknown>)[k] = next[k];
      changed = true;
    }
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

const applySystem: NonNullable<Engine['applySystem']> = (state, cmd) => {
  const s = S(state);
  switch (cmd.kind) {
    case 'setAi':
      if (!s.nations.includes(cmd.nationId)) return { ok: false, error: 'invalid_target' };
      s.ai[cmd.nationId] = cmd.isAi;
      break;
    case 'addPlayer':
      if (!s.nations.includes(cmd.nationId)) return { ok: false, error: 'invalid_target' };
      if (!s.players.includes(cmd.nationId)) s.players.push(cmd.nationId);
      s.ai[cmd.nationId] = false;
      break;
    case 'accelerate':
      if (cmd.target.id === 'inconnu') {
        return { ok: false, error: 'invalid_target', message: 'Production inconnue' };
      }
      break;
    default:
      break;
  }
  s.sys.push(cmd);
  return { ok: true };
};

const ownersFrame: NonNullable<Engine['ownersFrame']> = (state) => ({ ...S(state).owners });

const stats: NonNullable<Engine['stats']> = (state) => {
  const s = S(state);
  const out: ReturnType<NonNullable<Engine['stats']>> = { nations: {}, alertLevel: 5 };
  for (const n of s.nations) {
    out.nations[n] = {
      provincesStart: s.world.map.provinces.filter((p) => p.nationId === n).length,
      provincesEnd: Object.values(s.owners).filter((o) => o === n).length,
      conquered: s.conquered[n] ?? 0,
      kills: 0,
      losses: 0,
      spentUsd: 0,
      bestUnits: [],
    };
  }
  return out;
};

const battleReportFor: NonNullable<Engine['battleReportFor']> = (state, nationId, reportId) => {
  const s = S(state);
  if (reportId !== 'r1' || !s.players.includes(nationId)) return null;
  return {
    id: 'r1',
    at: [0, 0],
    provinceId: null,
    startedAt: 0,
    endedAt: 1000,
    title: 'Bataille de test',
    outcome: 'draw',
    countermeasures: [],
    timeline: [{ t: 0, text: 'Contact' }],
  } as unknown as BattleReport;
};

export interface FakeEngineOptions {
  /** Unité secrète en patrouille (événements toutes les secondes de jeu). Défaut : vrai. */
  patrol?: boolean;
  /** Fonctions des phases 2+ (applySystem, publicView…). Défaut : vrai. */
  phase2?: boolean;
}

export function createFakeEngine(o: FakeEngineOptions = {}): Engine {
  const base: Engine = {
    buildWorld,
    createGame: makeCreateGame(o.patrol !== false),
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
  if (o.phase2 === false) return base;
  return { ...base, applySystem, publicView, ownersFrame, stats, battleReportFor };
}

/** Accès de test à l'état interne du faux moteur. */
export const fakeState = (s: GameState) => S(s);
