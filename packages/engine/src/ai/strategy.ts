import {
  DAY,
  HOUR,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
  type AiBalance,
  type AiLevelBalance,
  type ResolutionType,
} from '@redline/shared';
import type { EngineState } from '../state/types.js';
import { atWar, provincesOf, sortedKeys, warsOf } from '../state/access.js';
import { wi } from '../state/world.js';
import { nextFloat } from '../rng/rng.js';
import { aiOrder } from './trace.js';
import { nearestOwnedCityKm } from '../movement/plan-unit.js';
import { aiCfg, aiLevelCfg } from './config.js';
import { board } from '../modules/registry.js';
import {
  allianceOf,
  cfg,
  ds,
  isRegular,
  pairKey,
  reputation,
  stabilityOf,
  type Alliance,
  type AllianceVote,
  type Resolution,
} from '../modules/diplo/state.js';
import { relationOf } from '../modules/diplo/relations.js';
import { disputedOf } from '../modules/diplo/unrest.js';
import { elide, news } from '../modules/diplo/news.js';
import { capitalPoint, declareBlocDefense } from '../modules/diplo/relations.js';
import {
  activeAiWars,
  aiNation,
  blocDefenders,
  blocsOf,
  frontScore,
  isWeak,
  recentPeace,
  restraintOf,
  rivalry,
  rivalsOf,
  sameBloc,
  warYoungerThan,
  worldIntensity,
  worldLevel,
} from './world.js';
import {
  estimateForce,
  invalidateForceMemo,
  withForceMemo,
  lostTo,
  mutualAllies,
  neighborNations,
  overseasNations,
  ownForce,
  type OwnForce,
} from './estimate.js';

/**
 * IA stratégique (diplomatie et grandes décisions), à base de règles et de priorités. Mêmes règles que
 * les joueurs : elle n'agit que par des ordres (`applyOrderImpl`) et ne lit que ce qu'une nation a le
 * droit de savoir (ses unités, ses contacts, la carte politique, le Conseil, ses propositions et votes).
 *
 *  - guerres choisies selon les rapports de force connus (et les alliances adverses) ;
 *  - menace contre un joueur humain voisin (par la terre ou par la mer) : préparatifs (troupes massées
 *    à la frontière, plan connu du renseignement adverse), ultimatum public, puis guerre si le rapport
 *    de force tient toujours ; renonce sinon (dissuasion) ;
 *  - paix ou cessez-le-feu quand elle perd, acceptation raisonnée des propositions ;
 *  - alliances (création, invitations, adhésion), votes d'alliance ;
 *  - Conseil de sécurité : propositions contre ses agresseurs, votes selon ses intérêts ;
 *  - guerres par procuration : courtiser des neutres, financer des rebelles chez l'ennemi.
 */

type LevelProfile = AiLevelBalance;

/** Réglages stratégiques de l'IA (data/balance, section ai.strategy). */
function S(state: EngineState): AiBalance['strategy'] {
  return aiCfg(state.world).strategy;
}

function profile(state: EngineState, n: NationId): LevelProfile {
  return aiLevelCfg(state, state.nations[n]!.aiLevel);
}

interface Memory {
  /** Pas de guerre ni de départ d'alliance avant cette date (reprise en main). */
  calmUntil: number;
  peaceAsk: Record<NationId, number>;
  lastProxy: number;
  /** Séance du Conseil pour laquelle elle a déjà proposé. */
  proposedSession: number;
  /** Captures impossibles (aucun chemin sans violer un neutre) : province → nouvel essai après. */
  capFail: Record<string, number>;
  /** Invitations d'alliance envoyées : nation → date (pas de relance avant `inviteCooldownDays`). */
  invited?: Record<NationId, number>;
  /** Unités engagées dans une offensive : unité → [province visée, jusqu'à] (pas de rappel en renfort). */
  commit?: Record<string, [string, number]>;
  /** Dernière menace vue sur la capitale : [force, date] (hystérésis de la garnison). */
  capThreat?: [number, number];
  /** Menace en cours contre un joueur humain : préparatifs puis ultimatum. */
  plan?: WarPlan;
  /** Joueurs humains : pas de nouvelle menace avant cette date (menace abandonnée, paix). */
  humanCool?: Record<NationId, number>;
  /** Opérations offensives en cours (rassemblement, débarquement), par province visée. */
  ops?: Record<ProvinceId, Operation>;
  /** Guerres contre d'autres IA : ennemi → [état du front, depuis] (enlisement). */
  front?: Record<NationId, [number, number]>;
}

/** Menace contre un joueur humain. */
export interface WarPlan {
  t: NationId;
  stage: 'prep' | 'ultimatum';
  /** Fin de l'étape en cours. */
  until: number;
}

/**
 * Opération offensive : le groupe se rassemble d'abord en `at` (ville amie proche de l'objectif, port
 * d'embarquement pour un débarquement), puis part en bloc vers la ville visée.
 */
export interface Operation {
  /** Point de rassemblement. */
  at: LngLat;
  units: string[];
  /** Force exigée pour partir. */
  need: number;
  /** Départ au plus tard (avec les unités arrivées). */
  until: number;
  /** Débarquement : navires d'escorte envoyés sur la zone. */
  sea?: string[];
  /** Groupe lancé : heure de départ de chaque unité (départs échelonnés, arrivée groupée). */
  go?: Record<string, number>;
}

interface AiState {
  mem: Record<NationId, Memory>;
}

function aiState(state: EngineState): AiState {
  const mods = state.mods as Record<string, unknown>;
  let s = mods.ai as AiState | undefined;
  if (!s) mods.ai = s = { mem: {} };
  return s;
}

function memory(state: EngineState, n: NationId): Memory {
  const s = aiState(state);
  let m = s.mem[n];
  if (!m) {
    // Reprise en cours de partie (joueur inactif remplacé) : transition douce.
    const calm = state.time > 0 ? state.time + S(state).takeoverCalmDays * DAY : 0;
    s.mem[n] = m = {
      calmUntil: calm,
      peaceAsk: {},
      lastProxy: state.time,
      proposedSession: 0,
      capFail: {},
    };
  }
  return m;
}

/** Un joueur reprend la main : la mémoire de l'IA est effacée (elle repartira en douceur). */
export function forgetNation(state: EngineState, n: NationId): void {
  const s = (state.mods as Record<string, unknown>).ai as AiState | undefined;
  if (s?.mem[n]) delete s.mem[n];
  const plans = board(state).warPlans;
  if (plans?.[n]) delete plans[n];
}

/** Registre des captures impossibles d'une nation (budget de calcul de l'IA tactique). */
export function captureFailures(state: EngineState, n: NationId): Record<string, number> {
  const m = memory(state, n);
  m.capFail ??= {};
  for (const k of sortedKeys(m.capFail)) if (m.capFail[k]! <= state.time) delete m.capFail[k];
  return m.capFail;
}

/**
 * Menace retenue sur la capitale : la plus forte vue depuis `memoryMs` (une menace qui disparaît de
 * la vue un instant ne libère pas la garnison, qui ne fait plus la navette avec le front).
 */
export function capitalThreat(
  state: EngineState,
  n: NationId,
  seen: number,
  memoryMs: number,
): number {
  const m = memory(state, n);
  const last = m.capThreat;
  if (seen > 0 && (!last || seen >= last[0] || state.time - last[1] >= memoryMs)) {
    m.capThreat = [seen, state.time];
    return seen;
  }
  if (last && state.time - last[1] < memoryMs) return Math.max(seen, last[0]);
  delete m.capThreat;
  return seen;
}

/** Engagements offensifs en cours d'une nation (unités disparues et engagements échus retirés). */
export function commitments(state: EngineState, n: NationId): Record<string, [string, number]> {
  const m = memory(state, n);
  const c = (m.commit ??= {});
  for (const k of sortedKeys(c)) if (c[k]![1] <= state.time || !state.units[k]) delete c[k];
  return c;
}

/** Menace en cours d'une nation IA contre un joueur humain, sinon null. */
export function warPlanOf(state: EngineState, n: NationId): WarPlan | null {
  const s = (state.mods as Record<string, unknown>).ai as AiState | undefined;
  return s?.mem[n]?.plan ?? null;
}

/** Plus d'opérations en cours (nation en paix) ; sans créer de mémoire. */
export function clearOperations(state: EngineState, n: NationId): void {
  const s = (state.mods as Record<string, unknown>).ai as AiState | undefined;
  const m = s?.mem[n];
  if (m?.ops) delete m.ops;
}

/** Opérations offensives en cours d'une nation (mémoire de l'IA, sérialisée). */
export function operations(state: EngineState, n: NationId): Record<ProvinceId, Operation> {
  return (memory(state, n).ops ??= {});
}

function order(state: EngineState, n: NationId, o: Order): boolean {
  const ok = aiOrder(state, n, o).ok;
  invalidateForceMemo();
  return ok;
}

/** Contexte calculé une fois par réflexion pour toutes les nations (budget de calcul). */
export interface ThinkContext {
  /** Nations avec une affaire diplomatique en attente (proposition, invitation, vote). */
  pending: Set<NationId>;
  /** Nations en guerre contre au moins une nation régulière. */
  fighting: Set<NationId>;
}

export function thinkContext(state: EngineState): ThinkContext {
  const pending = new Set<NationId>();
  const fighting = new Set<NationId>();
  for (const k of sortedKeys(state.wars)) {
    const [a, b] = k.split('|') as [NationId, NationId];
    if (isRegular(state, a) && isRegular(state, b)) {
      fighting.add(a);
      fighting.add(b);
    }
  }
  const d = ds(state);
  if (d) {
    for (const k of sortedKeys(d.proposals)) pending.add(d.proposals[k]!.to);
    for (const id of sortedKeys(d.alliances)) {
      const A = d.alliances[id]!;
      for (const x of A.invites) pending.add(x);
      for (const v of A.votes)
        for (const m of A.members) if (!v.yes.includes(m) && !v.no.includes(m)) pending.add(m);
    }
    const s = d.session;
    if (s && s.phase === 'voting') {
      for (const m of s.members) {
        if (
          s.resolutions.some(
            (r) => r.status === 'voting' && r.votes[m] === undefined && r.target.nationId !== m,
          )
        )
          pending.add(m);
      }
    }
  }
  return { pending, fighting };
}

/** La nation est-elle près d'un conflit (en guerre, voisin en guerre, affaire diplomatique en attente) ? */
export function isHot(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  ctx: ThinkContext,
): boolean {
  if (warsOf(state, n).length > 0 || ctx.pending.has(n) || warPlanOf(state, n)) return true;
  return neighbors.some((x) => ctx.fighting.has(x));
}

/** Réactions (chaque réflexion) : propositions de paix, invitations, votes d'alliance et du Conseil. */
export function reactiveThink(state: EngineState, n: NationId, ctx: ThinkContext): void {
  if (!ds(state) || !ctx.pending.has(n)) return;
  withForceMemo(() => reactive(state, n));
}

function reactive(state: EngineState, n: NationId): void {
  const P = profile(state, n);
  const mine = ownForce(state, n);
  const d = ds(state);
  // Propositions de paix reçues.
  for (const k of sortedKeys(d.proposals)) {
    const p = d.proposals[k];
    if (!p || p.to !== n) continue;
    const accept = shouldAcceptPeace(state, n, p.from, mine, P);
    order(state, n, { kind: 'answerPeace', nationId: p.from, accept });
  }
  // Invitations.
  const invites = sortedKeys(d.alliances)
    .map((id) => d.alliances[id]!)
    .filter((A) => A.invites.includes(n));
  if (invites.length > 0) {
    const mineA = allianceOf(state, n);
    for (const A of invites) {
      const ok = !mineA && acceptInvite(state, n, A, P);
      order(state, n, { kind: 'answerInvite', allianceId: A.id, accept: ok });
      if (ok) break;
    }
  }
  // Votes d'alliance.
  const A = allianceOf(state, n);
  if (A) {
    for (const v of [...A.votes]) {
      if (v.yes.includes(n) || v.no.includes(n)) continue;
      if (v.kind === 'expel' && v.subject === n) continue;
      order(state, n, {
        kind: 'allianceVote',
        voteId: v.id,
        yes: allianceVote(state, n, A, v, mine, P),
      });
    }
  }
  // Conseil de sécurité.
  const s = d.session;
  if (s.phase === 'voting' && s.members.includes(n)) {
    for (const r of s.resolutions) {
      if (r.status !== 'voting' || r.votes[n] !== undefined || r.target.nationId === n) continue;
      order(state, n, {
        kind: 'voteResolution',
        resolutionId: r.id,
        vote: councilVote(state, n, r),
      });
    }
  }
}

function sideForce(
  state: EngineState,
  n: NationId,
  t: NationId,
  mine: OwnForce,
  P: LevelProfile,
): number {
  let v = estimateForce(state, n, t, mine, P.caution);
  for (const m of mutualAllies(state, t, n)) v += estimateForce(state, n, m, mine, P.caution);
  return v;
}

function myForce(state: EngineState, n: NationId, t: NationId, mine: OwnForce): number {
  let v = mine.value;
  for (const m of mutualAllies(state, n, t)) v += estimateForce(state, n, m, mine, 1);
  return v;
}

function ratioAgainst(
  state: EngineState,
  n: NationId,
  t: NationId,
  mine: OwnForce,
  P: LevelProfile,
): number {
  // +1 : deux camps sans forces connues sont à égalité.
  return (myForce(state, n, t, mine) + 1) / (sideForce(state, n, t, mine, P) + 1);
}

/**
 * But de guerre atteint : agresseur qui tient la part `warGoalShare` des provinces d'origine de `e`
 * (guerre limitée : il arrête ses offensives contre elle et propose la paix).
 */
export function warGoalReached(state: EngineState, n: NationId, e: NationId): boolean {
  const share = aiNation(state, e)
    ? worldLevel(state, n).warGoalShare
    : profile(state, n).warGoalShare;
  if (share >= 1 || ds(state)?.aggressor[pairKey(n, e)] !== n) return false;
  const init = wi(state.world).provsByNation.get(e)?.length ?? 0;
  return init > 0 && lostTo(state, e, n) >= Math.max(1, Math.ceil(share * init));
}

/**
 * Capitulation d'une IA face à une autre IA : capitale tenue par l'ennemi, ou part `capitulationShare`
 * de ses provinces d'origine perdue à son profit. Elle accepte alors la paix (l'ennemi garde ses gains).
 */
export function capitulates(state: EngineState, n: NationId, e: NationId): boolean {
  if (!aiNation(state, e) || !aiNation(state, n)) return false;
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  if (cap && state.provinces[cap]?.owner === e) return true;
  const init = w.provsByNation.get(n)?.length ?? 0;
  const WL = worldLevel(state, n);
  if (init <= 0 || WL.capitulationShare <= 0) return false;
  if (warYoungerThan(state, n, e, WL.capitulationMinDays)) return false;
  return lostTo(state, n, e) >= Math.max(1, Math.ceil(WL.capitulationShare * init));
}

/**
 * Guerre enlisée entre deux IA : aucune province n'a changé de main entre elles depuis
 * `stalemateDays` (mémoire de l'IA, mise à jour à chaque réflexion stratégique).
 */
function stalemate(state: EngineState, n: NationId, e: NationId, m: Memory): boolean {
  if (!aiNation(state, e)) return false;
  const days = worldLevel(state, n).stalemateDays;
  if (days <= 0) return false;
  const f = m.front?.[e];
  return !!f && state.time - f[1] >= days * DAY;
}

/** Mise à jour de l'état des fronts contre les autres IA (enlisement). */
function trackFronts(state: EngineState, n: NationId, m: Memory): void {
  const front = (m.front ??= {});
  for (const e of warsOf(state, n)) {
    if (!aiNation(state, e)) continue;
    const score = frontScore(state, n, e);
    const cur = front[e];
    if (!cur || cur[0] !== score) front[e] = [score, state.time];
  }
  for (const k of sortedKeys(front)) if (!atWar(state, n, k)) delete front[k];
}

/**
 * Guerre limitée atteinte : agresseur qui tient des provinces de `e` depuis au moins `share` ×
 * `satisfiedPeaceDays` jours de guerre (il garde ses gains à la paix).
 */
function satisfied(
  state: EngineState,
  n: NationId,
  e: NationId,
  P: LevelProfile,
  share: number,
): boolean {
  const days = aiNation(state, e) ? worldLevel(state, n).satisfiedPeaceDays : P.satisfiedPeaceDays;
  if (days <= 0) return false;
  const key = pairKey(n, e);
  if (ds(state).aggressor[key] !== n || lostTo(state, e, n) === 0) return false;
  const since = state.wars[key];
  return since !== undefined && state.time - since >= days * share * DAY;
}

function shouldAcceptPeace(
  state: EngineState,
  n: NationId,
  from: NationId,
  mine: OwnForce,
  P: LevelProfile,
): boolean {
  if (state.nations[n]!.aiLevel === 'easy') return true;
  if (satisfied(state, n, from, P, 0.5) || warGoalReached(state, n, from)) return true;
  // Guerre entre IA : capitulation (capitale perdue, territoire largement perdu), victoire acquise
  // (capitale ennemie tenue) ou enlisement.
  if (capitulates(state, n, from) || capitulates(state, from, n)) return true;
  if (stalemate(state, n, from, memory(state, n))) return true;
  // Victime qui n'a rien perdu et ne mène pas d'offensive dans cette guerre : le statu quo lui suffit.
  if (
    P.offensive !== 'all' &&
    ds(state).aggressor[pairKey(n, from)] === from &&
    lostTo(state, n, from) === 0
  )
    return true;
  if (stabilityOf(state, n) < 40) return true;
  if (noFront(state, n, from, S(state).unreachablePeaceDays)) return true;
  const ratio = ratioAgainst(state, n, from, mine, P);
  if (ratio < P.acceptRatio) return true;
  // Guerre enlisée : aucun gain depuis longtemps.
  const since = ds(state).since[pairKey(n, from)] ?? 0;
  return state.time - since > 20 * DAY && lostTo(state, from, n) === 0;
}

function acceptInvite(state: EngineState, n: NationId, A: Alliance, P: LevelProfile): boolean {
  if (A.members.some((m) => atWar(state, m, n))) return false;
  const leaning = ds(state).leaning[n]?.[A.id] ?? 0;
  if (leaning >= S(state).inviteLeaning) return true;
  if (!P.alliances) return false;
  if (reputation(state, A.leader) < 35) return false;
  // Une alliance utile : elle combat déjà un de mes ennemis, ou me protège d'un agresseur.
  const d = ds(state);
  const enemies = warsOf(state, n).filter((e) => isRegular(state, e));
  if (A.members.some((m) => enemies.some((e) => atWar(state, m, e)))) return true;
  return A.charter.mutualDefense && enemies.some((e) => d.aggressor[pairKey(n, e)] === e);
}

function allianceVote(
  state: EngineState,
  n: NationId,
  A: Alliance,
  v: AllianceVote,
  mine: OwnForce,
  P: LevelProfile,
): boolean {
  switch (v.kind) {
    case 'skip_mutual_defense': {
      // Dispense si l'agresseur est bien plus fort que l'alliance entière.
      let ours = 0;
      for (const m of A.members) ours += m === n ? mine.value : estimateForce(state, n, m, mine, 1);
      return estimateForce(state, n, v.subject, mine, P.caution) > ours * 1.5;
    }
    case 'replace_leader': {
      const leader = state.nations[A.leader];
      if (!leader?.alive) return true;
      const last = ds(state).lastActive[A.leader] ?? 0;
      return leader.isPlayer && state.time - last > cfg(state).leaderInactiveDays * DAY;
    }
    case 'expel':
      return (
        reputation(state, v.subject) < 25 ||
        A.members.some((m) => m !== v.subject && atWar(state, m, v.subject))
      );
  }
}

function councilVote(state: EngineState, n: NationId, r: Resolution): 'yes' | 'no' | 'abstain' {
  const t = r.target.nationId;
  const b = board(state);
  if (t) {
    if (b.allianceOf[t] && b.allianceOf[t] === b.allianceOf[n]) return 'no';
    if (atWar(state, n, t)) return 'yes';
    if (r.proposer !== t && atWar(state, n, r.proposer)) return 'no';
    if (r.type === 'ceasefire') return 'yes';
    if (reputation(state, t) < 40) return 'yes';
    return 'abstain';
  }
  const pids = r.target.provinceIds ?? [];
  const owners = new Set(pids.map((p) => state.provinces[p]?.owner));
  for (const o of owners) {
    if (!o) continue;
    if (o === n || (b.allianceOf[o] && b.allianceOf[o] === b.allianceOf[n])) return 'no';
  }
  for (const o of owners) if (o && atWar(state, n, o)) return 'yes';
  return atWar(state, n, r.proposer) ? 'no' : 'abstain';
}

/** Réflexion stratégique complète (espacée dans le temps). */
export function strategicThink(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  hot = false,
): void {
  if (!ds(state)) return;
  withForceMemo(() => strategic(state, n, neighbors, hot));
}

function strategic(state: EngineState, n: NationId, neighbors: NationId[], hot: boolean): void {
  const P = profile(state, n);
  const m = memory(state, n);
  const mine = ownForce(state, n);
  seekPeace(state, n, neighbors, mine, P, m);
  if (P.alliances) alliances(state, n, neighbors, P, m);
  if (P.council) council(state, n, mine, P, m);
  if (state.time - m.lastProxy >= S(state).proxyEveryDays * DAY) {
    m.lastProxy = state.time;
    if (P.proxy) {
      court(state, n, neighbors);
      fund(state, n);
    }
  }
  blocDefense(state, n, mine, P);
  if (advancePlan(state, n, mine, P, m)) return;
  seekHumanWar(state, n, neighbors, mine, P, m, hot);
  if (m.plan) return;
  seekWar(state, n, neighbors, mine, P, m, hot);
  seekWorldWar(state, n, neighbors, mine, P, m, hot);
}

function seekPeace(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
): void {
  const stab = stabilityOf(state, n);
  const cfgS = S(state);
  trackFronts(state, n, m);
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    const last = m.peaceAsk[e] ?? -Infinity;
    if (state.time - last < cfgS.peaceAskEveryDays * DAY) continue;
    // Guerre sans front (alliance lointaine) : rien à y gagner, paix blanche.
    const idle = !neighbors.includes(e) && noFront(state, n, e, cfgS.unreachablePeaceDays);
    const ratio = ratioAgainst(state, n, e, mine, P);
    const lost = lostTo(state, n, e);
    const losing = (ratio < P.peaceRatio && lost > 0) || ratio < P.peaceRatio * 0.6 || stab < 30;
    const done = !losing && (satisfied(state, n, e, P, 1) || warGoalReached(state, n, e));
    // Guerre entre IA : capitulation (la paix cède le territoire perdu) ou enlisement (statu quo).
    const ends = capitulates(state, n, e) || stalemate(state, n, e, m);
    if (!losing && !idle && !done && !ends) continue;
    m.peaceAsk[e] = state.time;
    order(state, n, {
      kind: 'proposePeace',
      nationId: e,
      type: !ends && !idle && !done && (stab < 30 || lost > 0) ? 'ceasefire' : 'peace',
    });
  }
  for (const k of sortedKeys(m.peaceAsk)) if (!atWar(state, n, k)) delete m.peaceAsk[k];
}

/**
 * Guerre sans front depuis `days` jours : aucune province prise ni perdue entre les deux camps (carte
 * publique), et pas de frontière commune. Typiquement une guerre d'alliance avec un pays lointain.
 */
function noFront(state: EngineState, n: NationId, e: NationId, days: number): boolean {
  const since = state.wars[pairKey(n, e)];
  if (since === undefined || state.time - since < days * DAY) return false;
  if (lostTo(state, n, e) > 0 || lostTo(state, e, n) > 0) return false;
  if (neighborNations(state, n).includes(e)) return false;
  // Front maritime : un débarquement reste possible (niveau qui les pratique).
  return !(profile(state, n).amphibious && overseasNations(state, n).includes(e));
}

function seekWar(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
  hot: boolean,
): void {
  if (P.maxWars <= 0 || state.time < m.calmUntil || state.time < P.warmupDays * DAY) return;
  if (stabilityOf(state, n) < S(state).minStabilityForWar) return;
  const wars = warsOf(state, n).filter((e) => isRegular(state, e));
  if (wars.length >= P.maxWars) return;
  const d = ds(state);
  if (d.coups[n] !== undefined && state.time - d.coups[n]! < 5 * DAY) return;
  let best: NationId | null = null;
  let bestRatio = P.warRatio;
  for (const t of neighbors) {
    // Joueurs humains : menace progressive (préparatifs, ultimatum), voir seekHumanWar.
    if (!isRegular(state, t) || !state.nations[t]!.alive || state.nations[t]!.isPlayer) continue;
    const rel = relationOf(state, n, t);
    if (rel !== 'peace') continue;
    if (d.grace[`${n}>${t}`] !== undefined) continue;
    // Monde crédible : pas de guerre de choix entre membres d'un même bloc (rivalités : seekWorldWar).
    if (sameBloc(state, n, t)) continue;
    const r = ratioAgainst(state, n, t, mine, P);
    if (r < bestRatio) continue;
    // Pas de guerre sur la seule foi de ses alliés (dont la force n'est qu'estimée) : ses propres
    // forces doivent déjà peser une part du rapport voulu.
    const own = (mine.value + 1) / (sideForce(state, n, t, mine, P) + 1);
    if (own < P.warRatio * S(state).ownRatioShare) continue;
    // Guerre sans motif : jamais pour une nation retenue par son bloc (démocraties alliées…).
    const waived =
      P.casusBelliWaiverRatio > 0 &&
      r >= P.casusBelliWaiverRatio &&
      restraintOf(state, n) <= aiCfg(state.world).world.waiverMaxRestraint;
    if (!waived && !casusBelli(state, n, t)) continue;
    if (r >= bestRatio) {
      bestRatio = r;
      best = t;
    }
  }
  if (!best) return;
  if (aiNation(state, best) && worldFull(state, n)) return;
  if (!roll(state, P.warChancePerDay, hot)) return;
  order(state, n, { kind: 'declareWar', nationId: best });
}

/** Plafond mondial de guerres entre IA atteint (vraisemblance, coût de calcul). */
function worldFull(state: EngineState, n: NationId): boolean {
  const cap = Math.round(worldLevel(state, n).maxActiveWars * worldIntensity(state));
  return activeAiWars(state) >= cap;
}

/**
 * Monde vivant : guerres entre IA. Deux motifs, tous deux publics et crédibles :
 *  - rivalité historique (données : Russie–Ukraine, Inde–Pakistan, Corées…) : probabilité par jour
 *    `rivalryChancePerDay` × poids × intensité, si le rapport de force estimé atteint `rivalryRatio`
 *    (le rival voisin, ou à portée de frappe ou de débarquement) ;
 *  - opportunisme : voisin affaibli (capitale perdue, instable, en train de perdre une autre guerre),
 *    `opportunismChancePerDay` × intensité × (1 − retenue de son bloc), rapport `opportunismRatio`.
 * Jamais contre un membre de son bloc (sauf rivalité), ni au-delà des plafonds (guerres de la nation,
 * guerres entre IA dans le monde), ni juste après une paix avec la même nation (`rematchDays`).
 * Les forces des alliés de la cible, et des membres de ses blocs à défense mutuelle qui viendraient à
 * son secours, comptent dans le rapport de force (dissuasion).
 */
function seekWorldWar(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
  hot: boolean,
): void {
  const WL = worldLevel(state, n);
  const intensity = worldIntensity(state);
  if (WL.maxWars <= 0 || intensity <= 0 || !aiNation(state, n)) return;
  if (state.time < m.calmUntil || state.time < WL.fromDays * DAY) return;
  if (stabilityOf(state, n) < S(state).minStabilityForWar) return;
  const wars = warsOf(state, n).filter((e) => isRegular(state, e));
  if (wars.length >= WL.maxWars) return;
  const d = ds(state);
  if (d.coups[n] !== undefined && state.time - d.coups[n]! < 5 * DAY) return;
  if (worldFull(state, n)) return;
  const reach = aiCfg(state.world).world.rivalReachKm;
  const w = wi(state.world);
  const cands = new Set<NationId>(neighbors);
  for (const r of rivalsOf(state, n)) cands.add(r.t);
  const restraint = restraintOf(state, n);
  const A = allianceOf(state, n);
  let best: { t: NationId; chance: number; motive: string } | null = null;
  for (const t of [...cands].sort()) {
    if (!aiNation(state, t) || relationOf(state, n, t) !== 'peace') continue;
    if (d.grace[`${n}>${t}`] !== undefined) continue;
    if (recentPeace(state, n, t, WL.rematchDays)) continue;
    const rival = rivalry(state, n, t);
    if (!rival && sameBloc(state, n, t)) continue;
    // Rivalité dont elle n'est pas l'initiatrice (la Corée du Sud n'envahit pas le Nord) : seulement
    // l'opportunisme ordinaire, s'il s'applique.
    const starter = rival?.starts ? rival : null;
    if (A && A.members.includes(t)) continue;
    const near = neighbors.includes(t);
    if (!near) {
      // Rival non voisin : sa capitale à portée (frappes, débarquement).
      if (!starter) continue;
      const tCap = w.nationById.get(t)?.capitalProvinceId;
      if (!tCap || nearestOwnedCityKm(state, n, w.provById.get(tCap)!.cityPoint) > reach) continue;
    }
    const weak = isWeak(state, t, n);
    let chance = 0;
    let need = Infinity;
    if (starter) {
      chance = WL.rivalryChancePerDay * starter.weight * (weak ? 2 : 1);
      need = WL.rivalryRatio;
    } else if (weak && near && wars.length === 0) {
      // Vautour : seulement libre de toute autre guerre.
      chance = WL.opportunismChancePerDay * (1 - restraint);
      need = WL.opportunismRatio;
    }
    chance *= intensity;
    if (chance <= 0 || (best && chance <= best.chance)) continue;
    // Dissuasion : alliés de la cible et membres de ses blocs à défense mutuelle.
    let theirs = sideForce(state, n, t, mine, P);
    for (const x of blocDefenders(state, t, n))
      theirs += estimateForce(state, n, x, mine, P.caution);
    const r = (myForce(state, n, t, mine) + 1) / (theirs + 1);
    if (r < need) continue;
    if ((mine.value + 1) / (theirs + 1) < need * S(state).ownRatioShare) continue;
    best = { t, chance: Math.min(1, chance), motive: starter?.motive ?? '' };
  }
  if (!best || !roll(state, best.chance, hot)) return;
  if (order(state, n, { kind: 'declareWar', nationId: best.t })) {
    warMotive(state, n, best.t, best.motive || null);
  }
}

/** Ajoute le motif invoqué à la dépêche de déclaration de guerre qui vient d'être publiée. */
function warMotive(state: EngineState, n: NationId, t: NationId, motive: string | null): void {
  const list = ds(state).news;
  const it = list[list.length - 1];
  if (!it || it.time !== state.time || it.category !== 'war') return;
  if (!it.nations.includes(n) || !it.nations.includes(t)) return;
  it.body = motive
    ? `${it.body} Motif invoqué : ${motive}.`
    : `${it.body} Le pays attaqué était déjà affaibli.`;
}

/**
 * Défense mutuelle d'un bloc (données) : membre IA voisin de l'agresseur ou de la victime, quand une
 * IA d'un bloc à défense mutuelle est attaquée par une IA extérieure au bloc, dans les premiers jours de
 * la guerre, si leurs forces réunies pèsent assez face à l'agresseur.
 */
function blocDefense(state: EngineState, n: NationId, mine: OwnForce, P: LevelProfile): void {
  if (!aiNation(state, n)) return;
  const blocs = blocsOf(state, n).filter((b) => b.mutualDefense);
  if (blocs.length === 0) return;
  const W = aiCfg(state.world).world;
  const d = ds(state);
  for (const b of blocs) {
    for (const v of b.members) {
      if (v === n || !aiNation(state, v)) continue;
      for (const x of warsOf(state, v)) {
        if (!aiNation(state, x) || b.members.includes(x) || atWar(state, n, x)) continue;
        if (d.aggressor[pairKey(v, x)] !== x) continue;
        if (!warYoungerThan(state, v, x, W.blocDefenseDays)) continue;
        if (!blocDefenders(state, v, x).includes(n)) continue;
        if (relationOf(state, n, x) !== 'peace') continue;
        const ours = mine.value + estimateForce(state, n, v, mine, 1);
        const theirs = estimateForce(state, n, x, mine, P.caution);
        if ((ours + 1) / (theirs + 1) < W.blocDefenseRatio) continue;
        declareBlocDefense(state, n, x, b.name);
        return;
      }
    }
  }
}

/** Tirage d'une probabilité par jour, ramenée à l'intervalle entre deux réflexions stratégiques. */
function roll(state: EngineState, perDay: number, hot: boolean): boolean {
  if (perDay <= 0) return false;
  const period = state.world.balance.time.aiThinkMinutes / (24 * 60);
  const every = hot ? S(state).strategicEveryHot : S(state).strategicEveryCalm;
  const chance = 1 - Math.pow(1 - perDay, every * period);
  return nextFloat(state.rng) < chance;
}

/** Nations IA qui menacent `t` (plan en cours) ou l'ont attaquée, hors `except`. */
function aggressorsOf(state: EngineState, t: NationId, except: NationId): NationId[] {
  const s = aiState(state);
  const d = ds(state);
  return state.nationIds.filter((x) => {
    if (x === except || !state.nations[x]!.alive) return false;
    if (s.mem[x]?.plan?.t === t) return true;
    return atWar(state, x, t) && d.aggressor[pairKey(x, t)] === x;
  });
}

/**
 * Rapport de force contre un joueur humain ; en coalition (difficile), les forces des autres agresseurs
 * du même joueur (estimées, sans tricher) s'ajoutent aux siennes.
 */
function humanRatio(
  state: EngineState,
  n: NationId,
  t: NationId,
  mine: OwnForce,
  P: LevelProfile,
): number {
  let ours = myForce(state, n, t, mine);
  if (P.coalition)
    for (const x of aggressorsOf(state, t, n)) ours += estimateForce(state, n, x, mine, 1);
  return ((ours + 1) / (sideForce(state, n, t, mine, P) + 1)) * P.humanTargetBias;
}

/**
 * Menace contre un joueur humain voisin (par la terre, ou par la mer si le niveau débarque) : rapport
 * de force estimé suffisant, sans motif exigé (voisin opportuniste), au plus `humanAggressors` IA à la
 * fois contre le même joueur, pas avant `humanWarFromDays`. Début des préparatifs : le plan est inscrit
 * (le renseignement adverse peut le découvrir) et les troupes se massent à la frontière (IA tactique).
 */
function seekHumanWar(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
  hot: boolean,
): void {
  if (m.plan || P.warChanceHumanPerDay <= 0) return;
  if (state.time < P.humanWarFromDays * DAY || state.time < m.calmUntil) return;
  if (stabilityOf(state, n) < S(state).minStabilityForWar) return;
  const wars = warsOf(state, n).filter((e) => isRegular(state, e));
  if (wars.length >= Math.max(1, P.maxWars)) return;
  const d = ds(state);
  if (d.coups[n] !== undefined && state.time - d.coups[n]! < 5 * DAY) return;
  const cool = (m.humanCool ??= {});
  for (const k of sortedKeys(cool)) if (cool[k]! <= state.time) delete cool[k];
  const cands = P.amphibious ? [...neighbors, ...overseasNations(state, n)] : neighbors;
  const w = wi(state.world);
  let best: NationId | null = null;
  let bestRatio = P.humanWarRatio;
  for (const t of cands) {
    const tn = state.nations[t];
    if (!tn?.isPlayer || !tn.alive || !isRegular(state, t)) continue;
    if (relationOf(state, n, t) !== 'peace' || d.grace[`${n}>${t}`] !== undefined) continue;
    if (cool[t] !== undefined) continue;
    // Un vrai voisin : sa capitale à portée de ses propres villes (pas un territoire d'outre-mer isolé).
    const tCap = w.nationById.get(t)?.capitalProvinceId;
    if (!tCap || state.provinces[tCap]?.owner !== t) continue;
    if (nearestOwnedCityKm(state, n, w.provById.get(tCap)!.cityPoint) > S(state).threatReachKm)
      continue;
    // Paix récente avec ce joueur : pas de nouvelle menace avant le délai.
    const since = d.since[pairKey(n, t)];
    if (since !== undefined && state.time - since < P.humanCooldownDays * DAY) continue;
    if (aggressorsOf(state, t, n).length >= P.humanAggressors) continue;
    const r = humanRatio(state, n, t, mine, P);
    if (r < bestRatio) continue;
    // Guerre motivée : sans motif ni opportunité, il faut une supériorité plus nette (ou jamais).
    if (!motive(state, n, t)) {
      if (P.humanMotiveFactor <= 0 || r < P.humanWarRatio * P.humanMotiveFactor) continue;
    }
    // Ses propres forces pèsent déjà une part du rapport voulu (moitié en coalition).
    const own = (mine.value + 1) / (sideForce(state, n, t, mine, P) + 1);
    if (own < P.humanWarRatio * S(state).ownRatioShare * (P.coalition ? 0.5 : 1)) continue;
    bestRatio = r;
    best = t;
  }
  if (!best || !roll(state, P.warChanceHumanPerDay, hot)) return;
  let until = state.time + P.humanPrepHours * HOUR;
  // Coalition : même échéance que les préparatifs déjà engagés contre ce joueur (attaque coordonnée).
  for (const x of aggressorsOf(state, best, n)) {
    const p = aiState(state).mem[x]?.plan;
    if (p && p.stage === 'prep' && p.until > until) until = p.until;
  }
  m.plan = { t: best, stage: 'prep', until };
  const b = board(state);
  (b.warPlans ??= {})[n] = [best];
}

/**
 * Motif ou opportunité contre `t` : motif public (casusBelli), ou cible déjà en guerre contre une autre
 * nation régulière, ou instable (stabilité publique basse).
 */
function motive(state: EngineState, n: NationId, t: NationId): boolean {
  if (casusBelli(state, n, t) || rivalry(state, n, t)) return true;
  if (warsOf(state, t).some((x) => x !== n && isRegular(state, x))) return true;
  return stabilityOf(state, t) < S(state).minStabilityForWar;
}

/** Fin d'une menace (guerre déclarée, abandon) ; `cool` : pas de nouvelle menace avant un délai. */
function endPlan(state: EngineState, n: NationId, m: Memory, cool: boolean): void {
  const p = m.plan;
  if (!p) return;
  delete m.plan;
  const b = board(state);
  if (b.warPlans?.[n]) delete b.warPlans[n];
  if (cool) (m.humanCool ??= {})[p.t] = state.time + profile(state, n).humanCooldownDays * DAY;
}

/**
 * Étapes d'une menace en cours : fin des préparatifs → ultimatum public ; fin de l'ultimatum →
 * déclaration de guerre. À chaque étape, renonciation si le rapport de force estimé s'est dégradé (le
 * joueur a renforcé sa frontière, trouvé des alliés). Vrai tant que la menace occupe la nation.
 */
function advancePlan(
  state: EngineState,
  n: NationId,
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
): boolean {
  const p = m.plan;
  if (!p) return false;
  const tn = state.nations[p.t];
  if (!tn?.alive || !tn.isPlayer || relationOf(state, n, p.t) !== 'peace') {
    endPlan(state, n, m, false);
    return false;
  }
  if (state.time < p.until) return true;
  const hold = humanRatio(state, n, p.t, mine, P) >= P.humanWarRatio * S(state).planHoldShare;
  if (!hold) {
    if (p.stage === 'ultimatum')
      news(state, 'deescalation', { A: n, B: p.t }, capitalPoint(state, n), [n, p.t]);
    endPlan(state, n, m, true);
    return true;
  }
  if (p.stage === 'prep') {
    p.stage = 'ultimatum';
    p.until = state.time + P.ultimatumHours * HOUR;
    news(
      state,
      'ultimatum',
      { A: n, B: p.t, X: String(Math.round(P.ultimatumHours)) },
      capitalPoint(state, p.t),
      [n, p.t],
    );
    return true;
  }
  endPlan(state, n, m, false);
  order(state, n, { kind: 'declareWar', nationId: p.t });
  return true;
}

/**
 * Motif de guerre public : territoire revendiqué tenu par `t`, provinces perdues au profit de `t`
 * (revanche), allié attaqué par `t`, nation paria.
 */
function casusBelli(state: EngineState, n: NationId, t: NationId): boolean {
  const d = ds(state);
  if (lostTo(state, n, t) > 0) return true;
  for (const area of state.world.map.disputed) {
    if (area.claimants.includes(n) && d.disputed[area.id]?.holder === t) return true;
  }
  const A = allianceOf(state, n);
  if (A && A.members.some((m) => m !== n && atWar(state, m, t))) return true;
  return reputation(state, t) < 35;
}

function alliances(
  state: EngineState,
  n: NationId,
  neighbors: NationId[],
  P: LevelProfile,
  m: Memory,
): void {
  const A = allianceOf(state, n);
  const d = ds(state);
  if (!A) {
    const threatened = warsOf(state, n).some(
      (e) => isRegular(state, e) && d.aggressor[pairKey(n, e)] === e,
    );
    const size = state.nations[n]!.provinceCount;
    const cfgS = S(state);
    const big = state.nations[n]!.aiLevel === 'hard' && size >= cfgS.allianceMinProvinces;
    if (!(threatened && size >= cfgS.allianceMinProvinces - 1) && !big) return;
    // Pas de poussière d'alliances : un plafond proportionnel au nombre de nations.
    if (
      Object.keys(d.alliances).length >=
      Math.max(4, Math.ceil(state.nationIds.length / cfgS.nationsPerAlliance))
    )
      return;
    if (state.time < m.calmUntil) return;
    const w = wi(state.world);
    const cap = w.nationById.get(n)?.capitalProvinceId;
    const place =
      (cap && (w.provById.get(cap)?.cityName ?? w.provById.get(cap)?.name)) || n.toUpperCase();
    // Nom libre (une alliance dissoute ou homonyme garde le sien).
    const taken = new Set(Object.values(d.alliances).map((x) => x.name.toLowerCase()));
    let name = elide(`Pacte de ${place}`).slice(0, 40);
    if (taken.has(name.toLowerCase())) name = `${name.slice(0, 33)} (${n.toUpperCase()})`;
    if (taken.has(name.toLowerCase())) return;
    order(state, n, {
      kind: 'createAlliance',
      name,
      flag: n.toUpperCase().slice(0, 3),
      charter: { mutualDefense: true, intelSharing: true, passage: true },
    });
    return;
  }
  if (A.leader !== n) return;
  let sent = 0;
  const b = board(state);
  const cfgS = S(state);
  const invited = (m.invited ??= {});
  for (const k of sortedKeys(invited))
    if (state.time - invited[k]! >= cfgS.inviteCooldownDays * DAY) delete invited[k];
  for (const t of neighbors) {
    if (sent >= cfgS.invitesPerThink) break;
    if (
      !isRegular(state, t) ||
      !state.nations[t]!.alive ||
      b.allianceOf[t] ||
      A.invites.includes(t) ||
      invited[t] !== undefined
    )
      continue;
    if (A.members.some((x) => atWar(state, x, t))) continue;
    invited[t] = state.time;
    if (order(state, n, { kind: 'inviteToAlliance', nationId: t })) sent++;
  }
}

function council(
  state: EngineState,
  n: NationId,
  mine: OwnForce,
  P: LevelProfile,
  m: Memory,
): void {
  const s = ds(state).session;
  if (s.phase !== 'proposals' || m.proposedSession === s.id) return;
  if (s.resolutions.length >= S(state).maxCouncilProposals) return;
  const d = ds(state);
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    const victim = d.aggressor[pairKey(n, e)] === e;
    const losing = ratioAgainst(state, n, e, mine, P) < P.peaceRatio;
    let type: ResolutionType | null = null;
    if (losing) type = 'ceasefire';
    else if (victim)
      type = state.nations[n]!.aiLevel === 'hard' ? 'arms_embargo' : 'economic_sanctions';
    if (!type) continue;
    if (s.resolutions.some((r) => r.type === type && r.target.nationId === e)) continue;
    m.proposedSession = s.id;
    order(state, n, { kind: 'proposeResolution', type, target: { nationId: e }, text: '' });
    return;
  }
}

function court(state: EngineState, n: NationId, neighbors: NationId[]): void {
  const A = allianceOf(state, n);
  const ns = state.nations[n]!;
  if (!A || ns.money <= 0) return;
  const b = board(state);
  const d = ds(state);
  let best: NationId | null = null;
  for (const t of neighbors) {
    const tn = state.nations[t];
    if (
      !tn ||
      !isRegular(state, t) ||
      !tn.alive ||
      tn.isPlayer ||
      b.allianceOf[t] ||
      atWar(state, n, t)
    )
      continue;
    if (!best || (d.leaning[t]?.[A.id] ?? 0) > (d.leaning[best]?.[A.id] ?? 0)) best = t;
  }
  const aid = ns.money * S(state).courtShare;
  if (best && aid > 0) order(state, n, { kind: 'courtNeutral', nationId: best, aid });
}

function fund(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  const amount = ns.money * S(state).fundShare;
  if (!(amount > 0)) return;
  let target: ProvinceId | null = null;
  const w = wi(state.world);
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    for (const pid of provincesOf(state, e)) {
      const area = disputedOf(state, pid);
      if (area && area.claimants.includes(n)) {
        target = pid;
        break;
      }
      if (!target && w.provById.get(pid)!.neighbors.some((x) => state.provinces[x]?.owner === n))
        target = pid;
    }
    if (target) break;
  }
  if (target) order(state, n, { kind: 'fundRebels', provinceId: target, amount });
}

export { S as strategyCfg };
