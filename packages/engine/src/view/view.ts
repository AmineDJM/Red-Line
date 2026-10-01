import { modulePublicViews, moduleViews } from '../modules/registry.js';
import {
  HOUR,
  MINUTE,
  RESOURCES,
  positionAt,
  type EconomyView,
  type InfoLevel,
  type NationId,
  type NationView,
  type PlayerView,
  type ProvinceView,
  type Resource,
  type UnitStatus,
  type UnitView,
} from '@redline/shared';
import { currentLeg, isEmbarked, sortedKeys, sortedSet } from '../state/access.js';
import type { Contact, EngineState, Unit } from '../state/types.js';
import { wi } from '../state/world.js';
import { dailyIncomeOf } from '../economy/economy.js';
import { leaderOf } from '../combat/capture.js';

const LEVELS: InfoLevel[] = ['detected', 'detected', 'identified', 'precise'];

export function unitStatus(state: EngineState, u: Unit): UnitStatus {
  const t = state.time;
  if (
    u.engaged ||
    (u.lastHit >= 0 && t - u.lastHit <= state.world.balance.time.combatRoundMinutes * MINUTE)
  )
    return 'combat';
  if (isEmbarked(state, u, t)) return 'embarked';
  if (u.move) return 'moving';
  return 'idle';
}

function ownUnitView(state: EngineState, u: Unit): UnitView {
  const v: UnitView = {
    id: u.id,
    owner: u.owner,
    level: 'own',
    pos: u.pos,
    lastSeen: state.time,
    uncertaintyKm: 0,
    systemId: u.sys,
    count: u.count,
    hpRatio: u.hp / u.maxHp,
    status: unitStatus(state, u),
    stance: u.stance,
    xp: u.xp,
    targetId: u.target,
  };
  if (u.move) v.move = u.move;
  return v;
}

/** Unité étrangère actuellement observée : seulement le segment courant, depuis le début de l'observation. */
function seenUnitView(state: EngineState, u: Unit, c: Contact): UnitView {
  const t = state.time;
  const lvl = LEVELS[c.lvl] ?? 'detected';
  const leg = currentLeg(u, t);
  let pos = u.pos;
  let move: UnitView['move'];
  if (leg) {
    const start = Math.max(leg.t0, c.since);
    const from = start > leg.t0 ? positionAt({ legs: [leg] }, start) : leg.from;
    pos = from;
    move = { legs: [{ from, to: leg.to, t0: start, t1: leg.t1, medium: leg.medium }] };
  } else if (u.move) {
    pos = positionAt(u.move, t);
  }
  const v: UnitView = {
    id: u.id,
    owner: u.owner,
    level: lvl,
    pos,
    lastSeen: t,
    uncertaintyKm: 0,
  };
  if (move) v.move = move;
  if (c.lvl >= 2) v.systemId = u.sys;
  if (c.lvl >= 3) {
    v.count = u.count;
    v.hpRatio = u.hp / u.maxHp;
    v.status = unitStatus(state, u);
  }
  return v;
}

/** Contact perdu : dernière position connue, incertitude croissante. */
function lostUnitView(state: EngineState, id: string, c: Contact): UnitView {
  const ageH = (state.time - c.lastSeen) / HOUR;
  const v: UnitView = {
    id,
    owner: c.owner,
    level: LEVELS[c.lvl] ?? 'detected',
    pos: c.pos,
    lastSeen: c.lastSeen,
    uncertaintyKm: (c.unc ?? 0) + ageH * state.world.balance.sensors.uncertaintyGrowthKmh,
  };
  if (c.lvl >= 2 && c.sys) v.systemId = c.sys;
  if (c.lvl >= 3) {
    if (c.count !== null) v.count = c.count;
    if (c.hpr !== null) v.hpRatio = c.hpr;
    if (c.status !== null) v.status = c.status as UnitStatus;
  }
  return v;
}

/** Unités connues d'une nation (les siennes + contacts non oubliés), triées par identifiant. */
export function knownUnits(state: EngineState, me: NationId): UnitView[] {
  const out: UnitView[] = [];
  for (const id of sortedSet(state.rt.byNation.get(me)))
    out.push(ownUnitView(state, state.units[id]!));
  const known = state.know[me];
  if (known) {
    const forgetMs = state.world.balance.sensors.forgetAfterMinutes * MINUTE;
    for (const id of sortedKeys(known)) {
      const c = known[id]!;
      const u = state.units[id];
      if (c.seen && u) out.push(seenUnitView(state, u, c));
      else if (!c.seen && state.time - c.lastSeen <= forgetMs) out.push(lostUnitView(state, id, c));
    }
  }
  return out;
}

export function viewForImpl(state: EngineState, me: NationId): PlayerView {
  const ns = state.nations[me];
  if (!ns) throw new Error(`nation absente de la partie : ${me}`);
  const w = wi(state.world);
  const nations: Record<NationId, NationView> = {};
  for (const id of state.nationIds) {
    const n = state.nations[id]!;
    const def = w.nationById.get(id)!;
    nations[id] = {
      id,
      name: def.name,
      color: def.color,
      isAi: n.isAi,
      isPlayer: n.isPlayer,
      alive: n.alive,
      provinceCount: n.provinceCount,
    };
    if (state.unl?.[id]) nations[id]!.unlimited = true;
  }
  const provinces: Record<string, ProvinceView> = {};
  for (const pid of w.provIds) {
    const P = state.provinces[pid];
    if (!P) continue;
    const cap = P.capture;
    provinces[pid] = {
      id: pid,
      owner: P.owner,
      capture:
        cap && (P.owner === me || cap.by === me)
          ? { by: cap.by, startedAt: cap.startedAt, completesAt: cap.completesAt }
          : null,
      buildings: w.provById.get(pid)!.buildings,
    };
  }
  const units: Record<string, UnitView> = {};
  for (const v of knownUnits(state, me)) units[v.id] = v;

  const inc = dailyIncomeOf(state, me);
  const resources = {} as Record<Resource, number>;
  const incomeRes: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    resources[r] = ns.res[r];
    if (inc.res[r] !== 0) incomeRes[r] = inc.res[r];
  }
  const economy: EconomyView = {
    money: ns.money,
    resources,
    incomePerDay: { money: inc.money - inc.upkeep, ...incomeRes },
    production: ns.production.map((it) => ({ ...it })),
  };
  if (state.unl?.[me]) economy.unlimited = true;
  const view: PlayerView = {
    time: state.time,
    me,
    nations,
    provinces,
    units,
    economy,
    victory: {
      provinceShareTarget: state.world.balance.victory.provinceShare,
      leader: leaderOf(state),
      winner: state.winner,
    },
  };
  moduleViews(state, me, view);
  return view;
}

/** Vue publique (spectateur) : frontières, nations, unités de tous au niveau « identifiée », sans secret. */
export function publicViewImpl(state: EngineState): PlayerView {
  const w = wi(state.world);
  const nations: Record<NationId, NationView> = {};
  for (const id of state.nationIds) {
    const n = state.nations[id]!;
    const def = w.nationById.get(id)!;
    nations[id] = {
      id,
      name: def.name,
      color: def.color,
      isAi: n.isAi,
      isPlayer: n.isPlayer,
      alive: n.alive,
      provinceCount: n.provinceCount,
    };
    if (state.unl?.[id]) nations[id]!.unlimited = true;
  }
  const provinces: Record<string, ProvinceView> = {};
  for (const pid of sortedKeys(state.provinces)) {
    const P = state.provinces[pid]!;
    provinces[pid] = {
      id: pid,
      owner: P.owner,
      capture: P.capture
        ? { by: P.capture.by, startedAt: P.capture.startedAt, completesAt: P.capture.completesAt }
        : null,
      buildings: [...(w.provById.get(pid)?.buildings ?? [])],
    };
  }
  const units: Record<string, UnitView> = {};
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    const v: UnitView = {
      id: u.id,
      owner: u.owner,
      level: 'identified',
      pos: u.pos,
      lastSeen: state.time,
      uncertaintyKm: 0,
      systemId: u.sys,
    };
    if (u.move) v.move = u.move;
    units[uid] = v;
  }
  const resources = {} as Record<Resource, number>;
  for (const r of RESOURCES) resources[r] = 0;
  const view: PlayerView = {
    time: state.time,
    me: '',
    nations,
    provinces,
    units,
    economy: { money: 0, resources, incomePerDay: { money: 0 }, production: [] },
    victory: {
      provinceShareTarget: state.world.balance.victory.provinceShare,
      leader: leaderOf(state),
      winner: state.winner,
    },
    spectator: true,
  };
  modulePublicViews(state, view);
  return view;
}

/** Propriétaires des provinces (timelapse de fin de partie). */
export function ownersFrameImpl(state: EngineState): Record<string, NationId> {
  const out: Record<string, NationId> = {};
  for (const pid of sortedKeys(state.provinces)) out[pid] = state.provinces[pid]!.owner;
  return out;
}
