import {
  DAY,
  HOUR,
  distanceKm,
  type Leg,
  type LngLat,
  type NationId,
  type Relation,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState, Unit } from '../../state/types.js';
import {
  atWar,
  nationUnits,
  notify,
  provincesOf,
  sortedKeys,
  sysOf,
  unitPosAt,
  warsOf,
} from '../../state/access.js';
import { declareWar as coreDeclareWar, hasPassage, makePeace } from '../../state/war.js';
import { wi } from '../../state/world.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { computeCrossings, setMovement } from '../../movement/movement.js';
import { destroyUnit } from '../../combat/combat.js';
import { board, scheduleMod, signal } from '../registry.js';
import {
  PK_NATION,
  addReputation,
  addStability,
  cfg,
  ds,
  isPseudo,
  isRegular,
  natAgree,
  natLe,
  nationName,
  pairKey,
  sameAlliance,
} from './state.js';
import { news } from './news.js';
import { mutualDefense, openExpelVote } from './alliances.js';
import { autoResolution } from './council.js';
import { noteLoc } from '../../state/loc.js';

const FOREVER = Number.MAX_SAFE_INTEGER;

export function fail(error: NonNullable<OrderResult['error']>, message: string): OrderResult {
  return { ok: false, error, message };
}
export const OK: OrderResult = { ok: true };

/** Relation publique entre deux nations. */
export function relationOf(state: EngineState, a: NationId, b: NationId): Relation {
  if (atWar(state, a, b)) return 'war';
  const cf = board(state).ceasefires[pairKey(a, b)];
  if (cf !== undefined && cf > state.time) return 'ceasefire';
  if (sameAlliance(state, a, b)) return 'ally';
  return 'peace';
}

/** Recalcule les droits de passage du tableau (alliances avec passage ∪ délais de retrait). */
export function refreshPassage(state: EngineState): void {
  const d = ds(state);
  const out: Record<string, number> = {};
  for (const id of sortedKeys(d.alliances)) {
    const A = d.alliances[id]!;
    if (!A.charter.passage) continue;
    for (const x of A.members) for (const y of A.members) if (x !== y) out[`${x}>${y}`] = FOREVER;
  }
  for (const k of sortedKeys(d.grace)) {
    const until = d.grace[k]!;
    if (until <= state.time) {
      delete d.grace[k];
      continue;
    }
    out[k] = Math.max(out[k] ?? 0, until);
  }
  board(state).passage = out;
  const charters: NonNullable<ReturnType<typeof board>['allianceCharters']> = {};
  for (const id of sortedKeys(d.alliances)) {
    const A = d.alliances[id]!;
    charters[id] = { ...A.charter, leader: A.leader };
  }
  board(state).allianceCharters = charters;
}

/** Profondeur d'appel défensif (défense mutuelle en cours) : ces déclarations ne sont pas des agressions. */
let defensive = 0;

export function declareDefensive(state: EngineState, member: NationId, aggressor: NationId): void {
  defensive++;
  try {
    coreDeclareWar(state, member, aggressor);
  } finally {
    defensive--;
  }
}

/** Crochet du cœur : toute déclaration de guerre (attaque, entrée en territoire, ordre, alliance). */
export function onWarDeclared(state: EngineState, a: NationId, b: NationId): void {
  const d = ds(state);
  const key = pairKey(a, b);
  d.since[key] = state.time;
  delete d.proposals[key];
  delete d.grace[`${a}>${b}`];
  delete d.grace[`${b}>${a}`];
  if (isPseudo(state, a) || isPseudo(state, b)) {
    if (b === PK_NATION && isRegular(state, a)) peacekeepersAttacked(state, a);
    else if (a === PK_NATION && isRegular(state, b)) peacekeepersAttacked(state, b);
    refreshPassage(state);
    return;
  }
  const isDefensive = defensive > 0;
  d.aggressor[key] = a;
  const cf = board(state).ceasefires[key];
  const at = capitalPoint(state, b);
  if (cf !== undefined && cf > state.time) {
    delete board(state).ceasefires[key];
    const c = cfg(state);
    addStability(state, a, -c.ceasefireViolationStability, 'Cessez-le-feu violé');
    addReputation(state, a, -c.ceasefireViolationReputation);
    news(state, 'ceasefire_violated', { A: a, B: b }, at, [a, b]);
    autoResolution(
      state,
      'economic_sanctions',
      a,
      b,
      'Sanctions après la violation du cessez-le-feu.',
    );
  } else if (isDefensive) {
    const al = d.alliances[board(state).allianceOf[a] ?? ''];
    news(state, 'war_alliance', { A: a, B: b, X: al?.name ?? '' }, at, [a, b]);
  } else {
    addReputation(state, a, -cfg(state).aggressionReputation);
    news(state, 'war', { A: a, B: b }, at, [a, b]);
  }
  notify(state, { kind: 'war_declared', time: state.time, by: a, against: b }, null);
  refreshPassage(state);
  if (isDefensive) return;
  if (sameAlliance(state, a, b)) {
    addReputation(state, a, -10);
    openExpelVote(state, a);
    return;
  }
  mutualDefense(state, a, b);
}

function peacekeepersAttacked(state: EngineState, attacker: NationId): void {
  const c = cfg(state);
  addStability(state, attacker, -c.condemnationStability, 'Condamnation');
  addReputation(state, attacker, -c.condemnationReputation * 1.5);
  news(state, 'peacekeepers_attacked', { A: attacker }, null, [attacker]);
  autoResolution(
    state,
    'economic_sanctions',
    attacker,
    PK_NATION,
    'Sanctions après l’attaque de casques bleus.',
  );
}

export function capitalPoint(state: EngineState, n: NationId): LngLat | null {
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  return cap ? (w.provById.get(cap)?.cityPoint ?? null) : null;
}

/** Fin de guerre : paix (retrait des troupes) ou cessez-le-feu (lignes gelées). */
export function endWar(
  state: EngineState,
  a: NationId,
  b: NationId,
  kind: 'peace' | 'ceasefire',
  days?: number,
): void {
  const d = ds(state);
  const key = pairKey(a, b);
  makePeace(state, a, b);
  delete d.proposals[key];
  delete d.aggressor[key];
  d.since[key] = state.time;
  const at = capitalPoint(state, a);
  if (kind === 'ceasefire') {
    const until = state.time + (days ?? cfg(state).ceasefireDays) * DAY;
    board(state).ceasefires[key] = until;
    // Lignes gelées : chacun peut rester (et manœuvrer) là où il se trouve jusqu'à la fin de la trêve.
    d.grace[`${a}>${b}`] = until;
    d.grace[`${b}>${a}`] = until;
    scheduleMod(state, { t: until, m: 'diplo', e: 'cf_end', d: { a, b, until } });
    news(state, 'ceasefire', { A: a, B: b, X: String(days ?? cfg(state).ceasefireDays) }, at, [
      a,
      b,
    ]);
    notify(
      state,
      {
        kind: 'generic',
        time: state.time,
        at: null,
        category: 'ceasefire',
        title: 'Cessez-le-feu',
        text: `Cessez-le-feu en vigueur : ${nationName(state, a)} / ${nationName(state, b)}.`,
        severity: 'info',
        loc: noteLoc('ceasefire', { a: { nation: a }, b: { nation: b } }),
      },
      null,
    );
  } else {
    delete board(state).ceasefires[key];
    startWithdrawal(state, a, b);
    addReputation(state, a, 2);
    addReputation(state, b, 2);
    news(state, 'peace', { A: a, B: b }, at, [a, b]);
    notify(state, { kind: 'peace_signed', time: state.time, a, b }, null);
  }
  refreshPassage(state);
  signal(state, 'peace', { a, b, kind });
}

/** Paix : droit de passage temporaire et ordre de retrait des unités en territoire adverse. */
function startWithdrawal(state: EngineState, a: NationId, b: NationId): void {
  const d = ds(state);
  const until = state.time + cfg(state).peaceGraceHours * HOUR;
  d.grace[`${a}>${b}`] = until;
  d.grace[`${b}>${a}`] = until;
  withdraw(state, a, b);
  withdraw(state, b, a);
  scheduleMod(state, { t: until, m: 'diplo', e: 'grace', d: { a, b, until } });
}

export function ownerAt(state: EngineState, p: LngLat): NationId | null {
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellAt(p));
  return pid ? (state.provinces[pid]?.owner ?? null) : null;
}

function destinationOf(u: Unit): LngLat {
  const legs = u.move?.legs;
  return legs && legs.length > 0 ? legs[legs.length - 1]!.to : u.pos;
}

/** Point de retour le plus proche pour une unité (ville possédée, ou mise à l'eau pour un navire). */
function homeFor(state: EngineState, u: Unit): LngLat | null {
  const w = wi(state.world);
  const here = unitPosAt(state, u, state.time);
  const sea = sysOf(state, u).movement === 'sea';
  let best: LngLat | null = null;
  let bestD = Infinity;
  for (const pid of provincesOf(state, u.owner)) {
    const p = sea ? w.seaSpawn.get(pid) : w.provById.get(pid)!.cityPoint;
    if (!p) continue;
    const dx = distanceKm(p, here);
    if (dx < bestD) {
      bestD = dx;
      best = p;
    }
  }
  return best;
}

function inTerritoryOf(state: EngineState, u: Unit, host: NationId): boolean {
  return (
    ownerAt(state, unitPosAt(state, u, state.time)) === host ||
    ownerAt(state, destinationOf(u)) === host
  );
}

/** Ordre de retrait des unités de `x` présentes (ou en route) chez `host`. */
export function withdraw(state: EngineState, x: NationId, host: NationId): void {
  for (const uid of nationUnits(state, x)) {
    const u = state.units[uid]!;
    const s = sysOf(state, u);
    if (s.movement === 'static' || s.speedKmh <= 0) continue;
    if (!inTerritoryOf(state, u, host)) continue;
    const home = homeFor(state, u);
    if (!home) continue;
    const plan = planUnitMove(state, u, home);
    if ('error' in plan) continue;
    // Un retrait ne doit pas traverser un pays tiers (ce serait une déclaration de guerre) :
    // l'unité attend alors son rapatriement d'office à la fin du délai.
    if (s.movement !== 'sea' && crossesThird(state, u, plan.legs, host)) continue;
    setMovement(state, u, plan.legs);
  }
}

function crossesThird(state: EngineState, u: Unit, legs: Leg[], host: NationId): boolean {
  const start = unitPosAt(state, u, state.time);
  for (const c of computeCrossings(state, start, legs)) {
    if (!c.p) continue;
    const o = state.provinces[c.p]?.owner;
    if (!o || o === u.owner || o === host || atWar(state, u.owner, o)) continue;
    if (!hasPassage(state, u.owner, o)) return true;
  }
  return false;
}

/** Fin du délai de retrait : les unités restées chez l'autre sont rapatriées d'office. */
export function repatriate(state: EngineState, x: NationId, host: NationId): void {
  for (const uid of nationUnits(state, x)) {
    const u = state.units[uid];
    if (!u) continue;
    if (
      ownerAt(state, unitPosAt(state, u, state.time)) !== host &&
      !(u.move && inTerritoryOf(state, u, host))
    )
      continue;
    const home = homeFor(state, u);
    if (!home) {
      destroyUnit(state, u, null);
      continue;
    }
    teleport(state, u, home);
  }
}

export function teleport(state: EngineState, u: Unit, p: LngLat): void {
  u.move = null;
  u.pos = [p[0], p[1]];
  setMovement(state, u, null);
}

/** Événement : fin du délai de retrait après la paix. */
export function onGraceEnd(state: EngineState, a: NationId, b: NationId, until: number): void {
  const d = ds(state);
  if (atWar(state, a, b)) return;
  if (d.grace[`${a}>${b}`] !== until) return;
  delete d.grace[`${a}>${b}`];
  delete d.grace[`${b}>${a}`];
  repatriate(state, a, b);
  repatriate(state, b, a);
  refreshPassage(state);
}

/** Événement : fin d'un cessez-le-feu → paix de fait (retrait des troupes). */
export function onCeasefireEnd(state: EngineState, a: NationId, b: NationId, until: number): void {
  const key = pairKey(a, b);
  if (board(state).ceasefires[key] !== until) return;
  delete board(state).ceasefires[key];
  if (atWar(state, a, b)) return;
  ds(state).since[key] = state.time;
  startWithdrawal(state, a, b);
  refreshPassage(state);
}

// ——— Ordres ———

export function orderDeclareWar(state: EngineState, n: NationId, target: NationId): OrderResult {
  if (target === n || !isRegular(state, target)) return fail('invalid_target', 'Nation invalide.');
  if (!state.nations[target]!.alive) return fail('invalid_target', 'Nation vaincue.');
  if (atWar(state, n, target)) return fail('not_allowed', 'Déjà en guerre avec cette nation.');
  coreDeclareWar(state, n, target);
  return OK;
}

export function orderProposePeace(
  state: EngineState,
  n: NationId,
  target: NationId,
  kind: 'peace' | 'ceasefire',
): OrderResult {
  if (target === n || !isRegular(state, target)) return fail('invalid_target', 'Nation invalide.');
  const rel = relationOf(state, n, target);
  if (rel !== 'war' && !(rel === 'ceasefire' && kind === 'peace'))
    return fail('not_allowed', 'Aucune guerre à terminer avec cette nation.');
  const d = ds(state);
  const key = pairKey(n, target);
  const cur = d.proposals[key];
  // Les deux camps proposent la même chose : accord immédiat.
  if (cur && cur.from === target && cur.kind === kind) {
    concludePeace(state, cur.from, n, kind);
    return OK;
  }
  d.proposals[key] = { from: n, to: target, kind, at: state.time };
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at: null,
      category: 'peace_proposal',
      title: kind === 'peace' ? 'Proposition de paix' : 'Proposition de cessez-le-feu',
      text: `${natLe(state, n, true)} ${natAgree(state, n, 'propose', 'proposent')} ${kind === 'peace' ? 'la paix' : 'un cessez-le-feu'}.`,
      severity: 'info',
      loc: noteLoc(kind === 'peace' ? 'peaceProposal' : 'ceasefireProposal', {
        nation: { nation: n },
      }),
    },
    [target],
  );
  return OK;
}

function concludePeace(
  state: EngineState,
  a: NationId,
  b: NationId,
  kind: 'peace' | 'ceasefire',
): void {
  if (kind === 'peace' && !atWar(state, a, b)) {
    // Paix après un cessez-le-feu : la trêve devient définitive.
    const key = pairKey(a, b);
    delete board(state).ceasefires[key];
    delete ds(state).proposals[key];
    ds(state).since[key] = state.time;
    startWithdrawal(state, a, b);
    addReputation(state, a, 2);
    addReputation(state, b, 2);
    news(state, 'peace', { A: a, B: b }, capitalPoint(state, a), [a, b]);
    notify(state, { kind: 'peace_signed', time: state.time, a, b }, null);
    refreshPassage(state);
    signal(state, 'peace', { a, b, kind });
    return;
  }
  endWar(state, a, b, kind);
}

export function orderAnswerPeace(
  state: EngineState,
  n: NationId,
  from: NationId,
  accept: boolean,
): OrderResult {
  const d = ds(state);
  const key = pairKey(n, from);
  const p = d.proposals[key];
  if (!p || p.from !== from || p.to !== n)
    return fail('invalid_target', 'Aucune proposition en attente.');
  if (!accept) {
    delete d.proposals[key];
    notify(
      state,
      {
        kind: 'generic',
        time: state.time,
        at: null,
        category: 'peace_proposal',
        title: 'Proposition refusée',
        text: `${natLe(state, n, true)} ${natAgree(state, n, 'refuse', 'refusent')} votre proposition.`,
        severity: 'info',
        loc: noteLoc('proposalRefused', { nation: { nation: n } }),
      },
      [from],
    );
    return OK;
  }
  concludePeace(state, from, n, p.kind);
  return OK;
}

/** Nations régulières en guerre avec `n`. */
export function regularEnemies(state: EngineState, n: NationId): NationId[] {
  return warsOf(state, n).filter((e) => isRegular(state, e));
}
