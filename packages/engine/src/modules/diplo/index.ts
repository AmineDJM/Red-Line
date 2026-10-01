import {
  DAY,
  HOUR,
  type GameNotification,
  type LngLat,
  type NationId,
  type NewsCategory,
  type Order,
  type OrderErrorCode,
} from '@redline/shared';
import type { GameSetup, OrderResult, SystemCommand } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { sortedKeys } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { seedRng } from '../../rng/rng.js';
import type { EngineModule, ModEvent } from '../types.js';
import { board, signal } from '../registry.js';
import { worldConfig } from './config.js';
import { addReputation, addStability, ds, isRegular, natList, type DiploState } from './state.js';
import { news, pushNews, throttled } from './news.js';
import {
  onCeasefireEnd,
  onGraceEnd,
  onWarDeclared,
  orderAnswerPeace,
  orderDeclareWar,
  orderProposePeace,
  ownerAt,
  refreshPassage,
} from './relations.js';
import {
  alliancesDaily,
  orderAnswerInvite,
  orderCreateAlliance,
  orderInvite,
  orderLeave,
  orderProposeVote,
  orderTreasury,
  orderVote,
  resolveVote,
} from './alliances.js';
import {
  closeSession,
  createSession,
  emergencySession,
  endResolution,
  openSession,
  orderPropose,
  orderVoteResolution,
} from './council.js';
import {
  disputedCaptured,
  initDisputed,
  isIrregularRebel,
  onHandover,
  onRebelsFunded,
  orderCourtNeutral,
  orderFundRebels,
  orderHireMercenaries,
  rebelCapture,
  unrestDaily,
} from './unrest.js';
import {
  onNuclear,
  onProvinceLost,
  onUnitLost,
  stabilityDaily,
  stabilityFactor,
  stabilityMark,
} from './stability.js';
import { playerView, spectatorView } from './view.js';

/** Durée de validité d'une proposition de paix sans réponse. */
const PROPOSAL_DAYS = 5;

type Handler<K extends Order['kind']> = (
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: K }>,
) => OrderResult;

function h<K extends Order['kind']>(fn: Handler<K>) {
  return (state: EngineState, n: NationId, o: Order): OrderResult => {
    if (!state.nations[n]?.alive)
      return { ok: false, error: 'not_allowed', message: 'Nation vaincue.' };
    if (!ds(state)) return { ok: false, error: 'unknown', message: 'Diplomatie indisponible.' };
    return fn(state, n, o as Extract<Order, { kind: K }>);
  };
}

function init(state: EngineState, setup: GameSetup): void {
  const c = worldConfig(state.world);
  const sd = setup.diplomacy ?? {};
  const speed = setup.speed && setup.speed > 0 ? setup.speed : 1;
  const every = (sd.councilEveryDays ?? c.councilEveryDays) * DAY;
  const d: DiploState = {
    rng: seedRng((setup.seed ^ 0x5d1b1ca7) >>> 0),
    rule: { majority: sd.majority ?? c.majority, veto: sd.veto ?? c.veto },
    councilEveryMs: every,
    // 12 h réelles de vote = 12 h × vitesse en temps de jeu.
    voteWindowMs: (sd.voteWindowRealHours ?? c.voteWindowRealHours) * HOUR * speed,
    rotatingSeats: sd.rotatingSeats ?? c.rotatingSeats,
    rep: {},
    since: {},
    aggressor: {},
    proposals: {},
    grace: {},
    alliances: {},
    nextId: 0,
    session: null as unknown as DiploState['session'],
    nextRegular: every,
    inForce: [],
    stab: {},
    disputed: {},
    unrest: {},
    funding: {},
    leaning: {},
    pseudo: {},
    irregular: {},
    news: [],
    newsSeq: 0,
    throttle: {},
    lastActive: {},
    refugees: {},
    effects: [],
    coups: {},
    ownerV: 0,
    hurt: {},
  };
  state.mods.diplo = d;
  const b = board(state);
  b.passage ??= {};
  for (const n of state.nationIds) {
    b.stability[n] = c.stabilityStart;
    d.rep[n] = c.reputationStart;
  }
  if (setup.victory) b.victory = { ...setup.victory };
  if (setup.aiLevel) {
    const declared = new Set(setup.players.map((p) => p.nationId));
    for (const n of state.nationIds)
      if (!declared.has(n)) state.nations[n]!.aiLevel = setup.aiLevel;
  }
  initDisputed(state);
  createSession(state, every);
}

function onEvent(state: EngineState, ev: ModEvent): void {
  const d = ds(state);
  const x = (ev.d ?? {}) as Record<string, unknown>;
  switch (ev.e) {
    case 'c_open':
      if (d.session.id === x.id && d.session.v === x.v) openSession(state);
      return;
    case 'c_close':
      if (d.session.id === x.id && d.session.v === x.v) closeSession(state);
      return;
    case 'avote':
      resolveVote(state, String(x.a), String(x.id));
      return;
    case 'grace':
      onGraceEnd(state, String(x.a), String(x.b), Number(x.until));
      return;
    case 'cf_end':
      onCeasefireEnd(state, String(x.a), String(x.b), Number(x.until));
      return;
    case 'r_end':
      endResolution(state, String(x.id));
      return;
    case 'handover':
      onHandover(state, String(x.pid), String(x.to), String(x.reb));
      return;
  }
}

function onDailyTick(state: EngineState): void {
  const d = ds(state);
  if (!d) return;
  d.effects = d.effects.filter((e) => e.until > state.time);
  for (const k of sortedKeys(d.proposals)) {
    if (state.time - d.proposals[k]!.at > PROPOSAL_DAYS * DAY) delete d.proposals[k];
  }
  for (const k of sortedKeys(d.throttle))
    if (state.time - d.throttle[k]! > 30 * DAY) delete d.throttle[k];
  unrestDaily(state);
  alliancesDaily(state);
  stabilityDaily(state);
  stabilityMark(state);
  refreshPassage(state);
}

// ——— Événements mondiaux (commande système) ———

const WORLD_EVENTS: Record<
  string,
  { days: number; mods: Record<string, number>; stability: number; alert: number }
> = {
  oil_crisis: {
    days: 14,
    mods: { 'income.money': 0.9, 'income.oil': 0.7 },
    stability: 3,
    alert: 10,
  },
  market_crash: { days: 10, mods: { 'income.money': 0.8 }, stability: 5, alert: 5 },
  pandemic: {
    days: 20,
    mods: { 'production.speed': 0.85, 'research.speed': 0.9 },
    stability: 4,
    alert: 0,
  },
  arms_fair: { days: 7, mods: { 'production.cost': 0.9 }, stability: 0, alert: 0 },
};

function worldEvent(state: EngineState, cmd: SystemCommand): OrderResult {
  if (cmd.kind !== 'worldEvent') return { ok: false, error: 'unknown' };
  const d = ds(state);
  const params = cmd.params ?? {};
  signal(state, 'world_event', {
    event: cmd.event,
    params: { ...params },
    message: cmd.message ?? '',
  });
  if (cmd.event === 'emergency_council') {
    emergencySession(state, cmd.message);
    return { ok: true };
  }
  const def = WORLD_EVENTS[cmd.event];
  if (!def) return { ok: false, error: 'invalid_target', message: 'Événement inconnu.' };
  const days = params.days ?? def.days;
  const factor = params.factor;
  const mods: Record<string, number> = {};
  for (const k of sortedKeys(def.mods)) mods[k] = factor !== undefined ? factor : def.mods[k]!;
  d.effects.push({ event: cmd.event, until: state.time + days * DAY, mods });
  const hit = params.stability ?? def.stability;
  if (hit > 0) for (const n of state.nationIds) addStability(state, n, -hit, 'Crise mondiale');
  if (def.alert > 0) signal(state, 'alert', { amount: def.alert, reason: cmd.event });
  news(state, cmd.event as 'oil_crisis', { X: cmd.message ?? '' }, null, []);
  return { ok: true };
}

// ——— Signaux ———

function lngLat(x: unknown): LngLat | null {
  return Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' && typeof x[1] === 'number'
    ? [x[0], x[1]]
    : null;
}

function placeName(state: EngineState, at: LngLat | null, pid?: unknown): string {
  const w = wi(state.world);
  if (typeof pid === 'string' && w.provById.get(pid)) return w.provById.get(pid)!.name;
  if (!at) return '—';
  const nav = w.nav;
  const p = nav.cellProv.get(nav.cellAt(at));
  return p ? (w.provById.get(p)?.name ?? '—') : 'la zone maritime visée';
}

const STRIKE_LABEL: Record<string, string> = {
  missile: 'de missiles',
  air: 'aériennes',
  artillery: "d'artillerie",
};

const NEWS_CATEGORIES = new Set<NewsCategory>([
  'strike',
  'war',
  'peace',
  'council',
  'leak',
  'revolt',
  'coup',
  'alliance',
  'economy',
  'nuclear',
  'capture',
  'refugees',
  'event',
]);

function onSignal(state: EngineState, name: string, x: Record<string, unknown>): void {
  if (!ds(state)) return;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'news': {
      const cat = str(x.category) as NewsCategory;
      const nations = Array.isArray(x.nations)
        ? x.nations.filter((n): n is string => typeof n === 'string')
        : [];
      pushNews(
        state,
        NEWS_CATEGORIES.has(cat) ? cat : 'event',
        str(x.headline),
        str(x.body),
        lngLat(x.at),
        nations,
      );
      return;
    }
    case 'strike': {
      const by = str(x.by);
      const victim = str(x.victim);
      if (x.nuclear || !by || !victim) return;
      if (throttled(state, `strike|${by}|${victim}|${str(x.kind)}`, 6 * HOUR)) return;
      const at = lngLat(x.at);
      news(
        state,
        'strike',
        { A: by, B: victim, X: STRIKE_LABEL[str(x.kind)] ?? '', P: placeName(state, at) },
        at,
        [by, victim],
      );
      return;
    }
    case 'nuclear_detonation': {
      const by = str(x.by);
      const victim = str(x.victim);
      const at = lngLat(x.at);
      if (by && victim) onNuclear(state, by, victim);
      news(
        state,
        'nuclear',
        { A: by, B: victim, P: placeName(state, at, x.pid) },
        at,
        [by, victim].filter(Boolean),
      );
      return;
    }
    case 'battle_end': {
      const nations = (Array.isArray(x.nations) ? x.nations : [])
        .filter((n): n is string => typeof n === 'string')
        .sort();
      if (nations.length < 2 || throttled(state, `battle|${nations.join('|')}`, 12 * HOUR)) return;
      const at = lngLat(x.at);
      const winner = str(x.winner) || undefined;
      news(
        state,
        'battle',
        { A: winner, P: placeName(state, at), X: natList(state, nations) },
        at,
        nations,
      );
      return;
    }
    case 'leak': {
      const victim = str(x.victim);
      pushNews(
        state,
        'leak',
        str(x.headline) || 'Fuite de documents',
        str(x.body),
        null,
        victim ? [victim] : [],
      );
      return;
    }
    case 'agent_caught': {
      const spy = str(x.spyNation);
      const on = str(x.onNation);
      if (!spy || !on) return;
      addReputation(state, spy, -3);
      news(state, 'agent_caught', { A: spy, B: on }, null, [spy, on]);
      return;
    }
    case 'blockade': {
      const by = str(x.by);
      const pid = str(x.pid);
      const strait = state.world.map.straits.find((s) => s.id === x.straitId);
      const P = pid ? placeName(state, null, pid) : (strait?.name ?? '—');
      if (throttled(state, `blockade|${by}|${pid || str(x.straitId)}|${x.on ? 1 : 0}`, 12 * HOUR))
        return;
      news(
        state,
        x.on === false ? 'blockade_lifted' : 'blockade',
        { A: by, P },
        null,
        by ? [by] : [],
      );
      return;
    }
    case 'disinformation': {
      const victim = str(x.victim);
      const amount = typeof x.amount === 'number' ? x.amount : 0;
      if (victim && amount > 0) addStability(state, victim, -amount, 'Désinformation');
      return;
    }
    case 'rebels_funded': {
      const amount = typeof x.amount === 'number' ? x.amount : 0;
      onRebelsFunded(state, str(x.by), str(x.pid), amount);
      return;
    }
    case 'black_market_detected': {
      const buyer = str(x.buyer);
      if (!buyer) return;
      addReputation(state, buyer, -5);
      if (!throttled(state, `bm|${buyer}`, 3 * DAY))
        news(state, 'black_market', { A: buyer }, null, [buyer]);
      return;
    }
    case 'stability': {
      const n = str(x.nation);
      const delta = typeof x.delta === 'number' ? x.delta : 0;
      // La mobilisation est déjà comptée chaque jour depuis le tableau partagé (board.mobilized).
      if (str(x.reason) === 'mobilization') return;
      if (n && delta) addStability(state, n, delta, str(x.reason) || 'Événement');
      return;
    }
  }
}

const AUDIENCE_PUBLIC = new Set(['coup', 'ceasefire']);
const AUDIENCE_PRIVATE = new Set(['peace_proposal', 'alliance', 'alliance_vote']);

function audience(
  _state: EngineState,
  _nation: NationId,
  note: GameNotification,
): boolean | undefined {
  switch (note.kind) {
    case 'war_declared':
    case 'peace_signed':
    case 'council':
    case 'news':
      return true;
    case 'generic':
      if (AUDIENCE_PUBLIC.has(note.category)) return true;
      if (AUDIENCE_PRIVATE.has(note.category)) return false;
      return undefined;
    default:
      return undefined;
  }
}

const LOCKED: OrderErrorCode = 'locked';

/**
 * Diplomatie : relations, alliances, Conseil de sécurité, guerres par procuration, territoires disputés,
 * rebelles, stabilité, coups d'État, réfugiés, neutres, fil d'actualité mondial. L'IA stratégique qui
 * s'en sert vit dans src/ai/ (mêmes ordres que les joueurs).
 */
export const diploModule: EngineModule = {
  id: 'diplo',
  init,
  rebuild(state) {
    if (!ds(state)) return;
    board(state).passage ??= {};
  },
  onEvent,
  orders: {
    declareWar: h<'declareWar'>((s, n, o) => orderDeclareWar(s, n, o.nationId)),
    proposePeace: h<'proposePeace'>((s, n, o) => orderProposePeace(s, n, o.nationId, o.type)),
    answerPeace: h<'answerPeace'>((s, n, o) => orderAnswerPeace(s, n, o.nationId, o.accept)),
    createAlliance: h<'createAlliance'>((s, n, o) =>
      orderCreateAlliance(s, n, o.name, o.flag, o.charter),
    ),
    inviteToAlliance: h<'inviteToAlliance'>((s, n, o) => orderInvite(s, n, o.nationId)),
    answerInvite: h<'answerInvite'>((s, n, o) => orderAnswerInvite(s, n, o.allianceId, o.accept)),
    leaveAlliance: h<'leaveAlliance'>((s, n) => orderLeave(s, n)),
    allianceVote: h<'allianceVote'>((s, n, o) => orderVote(s, n, o.voteId, o.yes)),
    allianceProposeVote: h<'allianceProposeVote'>((s, n, o) =>
      orderProposeVote(s, n, o.vote, o.subject),
    ),
    allianceTreasury: h<'allianceTreasury'>((s, n, o) => orderTreasury(s, n, o.amount)),
    proposeResolution: h<'proposeResolution'>((s, n, o) =>
      orderPropose(s, n, o.type, o.target, o.text),
    ),
    voteResolution: h<'voteResolution'>((s, n, o) =>
      orderVoteResolution(s, n, o.resolutionId, o.vote),
    ),
    courtNeutral: h<'courtNeutral'>((s, n, o) => orderCourtNeutral(s, n, o.nationId, o.aid)),
    fundRebels: h<'fundRebels'>((s, n, o) => orderFundRebels(s, n, o.provinceId, o.amount)),
    hireMercenaries: h<'hireMercenaries'>((s, n, o) =>
      orderHireMercenaries(s, n, o.provinceId, o.count),
    ),
  },
  system: { worldEvent },
  view: (state, nation, view) => {
    if (ds(state)) playerView(state, nation, view);
  },
  publicView: (state, view) => {
    if (ds(state)) spectatorView(state, view);
  },
  hooks: {
    onDailyTick,
    onWarDeclared(state, a, b) {
      if (ds(state)) onWarDeclared(state, a, b);
    },
    onUnitDestroyed(state, u) {
      if (ds(state)) onUnitLost(state, u);
    },
    onProvinceCaptured(state, pid, from, to) {
      if (!ds(state)) return;
      ds(state).ownerV++;
      onProvinceLost(state, pid, from, to);
      disputedCaptured(state, pid);
      if (isIrregularRebel(state, to)) rebelCapture(state, pid, from, to);
    },
    onOrder(state, n) {
      const d = ds(state);
      if (d && isRegular(state, n)) d.lastActive[n] = state.time;
    },
    canImport(state, n) {
      return board(state).embargoed[n] ? LOCKED : null;
    },
    modifier(state, n, key) {
      const d = ds(state);
      if (!d) return 1;
      let f = 1;
      if (key === 'production.speed' || key === 'income.money') f *= stabilityFactor(state, n);
      for (const e of d.effects)
        if (e.until > state.time && e.mods[key] !== undefined) f *= e.mods[key]!;
      return f;
    },
    onSignal,
    audience,
  },
};
