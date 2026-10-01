import {
  DAY,
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
import { elide } from '../modules/diplo/news.js';
import {
  estimateForce,
  invalidateForceMemo,
  withForceMemo,
  lostTo,
  mutualAllies,
  neighborNations,
  ownForce,
  type OwnForce,
} from './estimate.js';

/**
 * IA stratégique (diplomatie et grandes décisions), à base de règles et de priorités. Mêmes règles que
 * les joueurs : elle n'agit que par des ordres (`applyOrderImpl`) et ne lit que ce qu'une nation a le
 * droit de savoir (ses unités, ses contacts, la carte politique, le Conseil, ses propositions et votes).
 *
 *  - guerres choisies selon les rapports de force connus (et les alliances adverses) ;
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
}

/** Registre des captures impossibles d'une nation (budget de calcul de l'IA tactique). */
export function captureFailures(state: EngineState, n: NationId): Record<string, number> {
  const m = memory(state, n);
  m.capFail ??= {};
  for (const k of sortedKeys(m.capFail)) if (m.capFail[k]! <= state.time) delete m.capFail[k];
  return m.capFail;
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
  if (warsOf(state, n).length > 0 || ctx.pending.has(n)) return true;
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

function shouldAcceptPeace(
  state: EngineState,
  n: NationId,
  from: NationId,
  mine: OwnForce,
  P: LevelProfile,
): boolean {
  if (state.nations[n]!.aiLevel === 'easy') return true;
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
  seekWar(state, n, neighbors, mine, P, m, hot);
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
  for (const e of warsOf(state, n)) {
    if (!isRegular(state, e)) continue;
    const last = m.peaceAsk[e] ?? -Infinity;
    if (state.time - last < cfgS.peaceAskEveryDays * DAY) continue;
    // Guerre sans front (alliance lointaine) : rien à y gagner, paix blanche.
    const idle = !neighbors.includes(e) && noFront(state, n, e, cfgS.unreachablePeaceDays);
    const ratio = ratioAgainst(state, n, e, mine, P);
    const lost = lostTo(state, n, e);
    const losing = (ratio < P.peaceRatio && lost > 0) || ratio < P.peaceRatio * 0.6 || stab < 30;
    if (!losing && !idle) continue;
    m.peaceAsk[e] = state.time;
    order(state, n, {
      kind: 'proposePeace',
      nationId: e,
      type: !idle && (stab < 30 || lost > 0) ? 'ceasefire' : 'peace',
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
  return !neighborNations(state, n).includes(e);
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
    if (!isRegular(state, t) || !state.nations[t]!.alive) continue;
    const rel = relationOf(state, n, t);
    if (rel !== 'peace') continue;
    if (d.grace[`${n}>${t}`] !== undefined) continue;
    let r = ratioAgainst(state, n, t, mine, P);
    if (state.nations[t]!.isPlayer) r *= P.humanTargetBias;
    const waived = P.casusBelliWaiverRatio > 0 && r >= P.casusBelliWaiverRatio;
    if (!waived && !casusBelli(state, n, t)) continue;
    if (r >= bestRatio) {
      bestRatio = r;
      best = t;
    }
  }
  if (!best) return;
  // Probabilité par jour ramenée à l'intervalle entre deux réflexions stratégiques de cette nation.
  const perDay = state.nations[best]!.isPlayer ? P.warChanceHumanPerDay : P.warChancePerDay;
  if (perDay <= 0) return;
  const period = state.world.balance.time.aiThinkMinutes / (24 * 60);
  const every = hot ? S(state).strategicEveryHot : S(state).strategicEveryCalm;
  const chance = 1 - Math.pow(1 - perDay, every * period);
  if (nextFloat(state.rng) >= chance) return;
  order(state, n, { kind: 'declareWar', nationId: best });
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
