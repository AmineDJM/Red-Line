import { DAY, HOUR, type AllianceCharter, type NationId } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, notify, sortedKeys } from '../../state/access.js';
import { board, scheduleMod } from '../registry.js';
import {
  addReputation,
  addStability,
  allianceOf,
  cfg,
  clamp,
  ds,
  isRegular,
  newId,
  type Alliance,
  type AllianceVote,
} from './state.js';
import { news } from './news.js';
import { OK, capitalPoint, declareDefensive, fail, refreshPassage, regularEnemies } from './relations.js';

function charterText(c: AllianceCharter): string {
  const parts: string[] = [];
  if (c.mutualDefense) parts.push('défense mutuelle');
  if (c.intelSharing) parts.push('partage du renseignement');
  if (c.passage) parts.push('droit de passage');
  return parts.length > 0 ? parts.join(', ') : 'coopération simple';
}

function genericNote(
  state: EngineState,
  aud: NationId[],
  title: string,
  text: string,
  category = 'alliance',
): void {
  notify(state, { kind: 'generic', time: state.time, at: null, category, title, text, severity: 'info' }, aud);
}

export function orderCreateAlliance(
  state: EngineState,
  n: NationId,
  name: string,
  flag: string,
  charter: AllianceCharter,
): OrderResult {
  if (allianceOf(state, n)) return fail('not_allowed', 'Vous appartenez déjà à une alliance.');
  const clean = name.trim();
  if (clean.length < 2) return fail('invalid_target', "Nom d'alliance trop court.");
  const d = ds(state);
  for (const id of sortedKeys(d.alliances))
    if (d.alliances[id]!.name.toLowerCase() === clean.toLowerCase())
      return fail('not_allowed', 'Ce nom est déjà pris.');
  const id = newId(state, 'al');
  d.alliances[id] = {
    id,
    name: clean,
    flag: flag.trim() || '■',
    leader: n,
    members: [n],
    charter: { ...charter },
    treasury: 0,
    createdAt: state.time,
    votes: [],
    invites: [],
    skip: {},
  };
  board(state).allianceOf[n] = id;
  delete d.leaning[n];
  news(state, 'alliance_created', { A: n, X: clean, Y: charterText(charter) }, capitalPoint(state, n), [n]);
  refreshPassage(state);
  return OK;
}

export function orderInvite(state: EngineState, n: NationId, target: NationId): OrderResult {
  const A = allianceOf(state, n);
  if (!A) return fail('not_allowed', "Vous n'appartenez à aucune alliance.");
  if (A.leader !== n) return fail('not_allowed', "Seul le chef de l'alliance peut inviter.");
  if (!isRegular(state, target) || target === n || !state.nations[target]!.alive)
    return fail('invalid_target', 'Nation invalide.');
  if (allianceOf(state, target)) return fail('not_allowed', 'Cette nation appartient déjà à une alliance.');
  if (A.members.some((m) => atWar(state, m, target)))
    return fail('not_allowed', 'Cette nation est en guerre avec un membre.');
  if (!A.invites.includes(target)) A.invites = [...A.invites, target].sort();
  genericNote(state, [target], "Invitation d'alliance", `L'alliance ${A.name} vous invite à la rejoindre.`);
  return OK;
}

export function joinAlliance(state: EngineState, n: NationId, A: Alliance): void {
  A.invites = A.invites.filter((x) => x !== n);
  if (A.members.includes(n)) return;
  A.members = [...A.members, n].sort();
  board(state).allianceOf[n] = A.id;
  delete ds(state).leaning[n];
  news(state, 'alliance_joined', { A: n, X: A.name, Y: String(A.members.length) }, capitalPoint(state, n), [
    n,
    A.leader,
  ]);
  refreshPassage(state);
}

export function orderAnswerInvite(
  state: EngineState,
  n: NationId,
  allianceId: string,
  accept: boolean,
): OrderResult {
  const A = ds(state).alliances[allianceId];
  if (!A || !A.invites.includes(n)) return fail('invalid_target', 'Aucune invitation de cette alliance.');
  if (!accept) {
    A.invites = A.invites.filter((x) => x !== n);
    genericNote(state, [A.leader], 'Invitation déclinée', `${n.toUpperCase()} décline l'invitation.`);
    return OK;
  }
  if (allianceOf(state, n)) return fail('not_allowed', 'Quittez d’abord votre alliance actuelle.');
  if (A.members.some((m) => atWar(state, m, n)))
    return fail('not_allowed', 'Vous êtes en guerre avec un membre.');
  joinAlliance(state, n, A);
  return OK;
}

/** Retire un membre (départ, exclusion, coup d'État). Dissout l'alliance vide. */
export function removeMember(state: EngineState, n: NationId, A: Alliance): void {
  const d = ds(state);
  A.members = A.members.filter((m) => m !== n);
  delete board(state).allianceOf[n];
  A.votes = A.votes.filter((v) => v.subject !== n);
  for (const v of A.votes) {
    v.yes = v.yes.filter((x) => x !== n);
    v.no = v.no.filter((x) => x !== n);
  }
  if (A.members.length === 0) {
    delete d.alliances[A.id];
    for (const x of sortedKeys(d.leaning)) {
      delete d.leaning[x]![A.id];
      if (Object.keys(d.leaning[x]!).length === 0) delete d.leaning[x];
    }
    // Le trésor d'une alliance dissoute revient au dernier membre.
    const ns = state.nations[n];
    if (ns) ns.money += A.treasury;
  } else if (A.leader === n) {
    A.leader = bestMember(state, A.members);
  }
  refreshPassage(state);
}

function bestMember(state: EngineState, members: NationId[]): NationId {
  let best = members[0]!;
  for (const m of members) {
    const c = state.nations[m]!.provinceCount;
    const bc = state.nations[best]!.provinceCount;
    if (c > bc || (c === bc && m < best)) best = m;
  }
  return best;
}

export function orderLeave(state: EngineState, n: NationId): OrderResult {
  const A = allianceOf(state, n);
  if (!A) return fail('not_allowed', "Vous n'appartenez à aucune alliance.");
  if (regularEnemies(state, n).length > 0 || A.members.some((m) => regularEnemies(state, m).length > 0)) {
    const c = cfg(state);
    addStability(state, n, -c.leaveAllianceStability, "Départ d'alliance");
    addReputation(state, n, -c.leaveAllianceReputation);
  }
  const name = A.name;
  removeMember(state, n, A);
  news(state, 'alliance_left', { A: n, X: name }, capitalPoint(state, n), [n]);
  return OK;
}

function eligible(A: Alliance, v: AllianceVote): NationId[] {
  return A.members.filter((m) => !(v.kind === 'expel' && m === v.subject));
}

export function openVote(
  state: EngineState,
  A: Alliance,
  kind: AllianceVote['kind'],
  subject: NationId,
  proposer: NationId | null,
  hours: number,
  victim?: NationId,
): AllianceVote {
  const v: AllianceVote = {
    id: newId(state, 'av'),
    kind,
    subject,
    endsAt: state.time + hours * HOUR,
    yes: proposer ? [proposer] : [],
    no: [],
  };
  if (victim) v.victim = victim;
  A.votes.push(v);
  scheduleMod(state, { t: v.endsAt, m: 'diplo', e: 'avote', d: { a: A.id, id: v.id } });
  const label =
    kind === 'replace_leader'
      ? `Remplacement du chef par ${subject.toUpperCase()}`
      : kind === 'expel'
        ? `Exclusion de ${subject.toUpperCase()}`
        : `Dispense de défense mutuelle face à ${subject.toUpperCase()}`;
  genericNote(state, A.members, "Vote d'alliance", `${A.name} : ${label}.`, 'alliance_vote');
  return v;
}

export function orderProposeVote(
  state: EngineState,
  n: NationId,
  kind: AllianceVote['kind'],
  subject: NationId,
): OrderResult {
  const A = allianceOf(state, n);
  if (!A) return fail('not_allowed', "Vous n'appartenez à aucune alliance.");
  if (A.votes.some((v) => v.kind === kind && v.subject === subject))
    return fail('not_allowed', 'Un vote identique est déjà en cours.');
  if (kind === 'replace_leader' && (!A.members.includes(subject) || subject === A.leader))
    return fail('invalid_target', 'Candidat invalide.');
  if (kind === 'expel' && (!A.members.includes(subject) || subject === n))
    return fail('invalid_target', 'Membre invalide.');
  if (kind === 'skip_mutual_defense' && (A.members.includes(subject) || !isRegular(state, subject)))
    return fail('invalid_target', 'Nation invalide.');
  const v = openVote(state, A, kind, subject, n, cfg(state).allianceVoteHours);
  maybeResolveEarly(state, A, v);
  return OK;
}

export function orderVote(state: EngineState, n: NationId, voteId: string, yes: boolean): OrderResult {
  const A = allianceOf(state, n);
  const v = A?.votes.find((x) => x.id === voteId);
  if (!A || !v) return fail('invalid_target', 'Vote introuvable.');
  if (!eligible(A, v).includes(n)) return fail('not_allowed', 'Vous ne pouvez pas voter.');
  v.yes = v.yes.filter((x) => x !== n);
  v.no = v.no.filter((x) => x !== n);
  (yes ? v.yes : v.no).push(n);
  v.yes.sort();
  v.no.sort();
  maybeResolveEarly(state, A, v);
  return OK;
}

function maybeResolveEarly(state: EngineState, A: Alliance, v: AllianceVote): void {
  const el = eligible(A, v);
  if (el.every((m) => v.yes.includes(m) || v.no.includes(m))) resolveVote(state, A.id, v.id);
}

export function openExpelVote(state: EngineState, n: NationId): void {
  const A = allianceOf(state, n);
  if (!A || A.votes.some((v) => v.kind === 'expel' && v.subject === n)) return;
  openVote(state, A, 'expel', n, null, cfg(state).allianceVoteHours);
}

/** Clôture d'un vote d'alliance (échéance ou tous les votants se sont exprimés). */
export function resolveVote(state: EngineState, allianceId: string, voteId: string): void {
  const A = ds(state).alliances[allianceId];
  if (!A) return;
  const idx = A.votes.findIndex((x) => x.id === voteId);
  if (idx < 0) return;
  const v = A.votes[idx]!;
  A.votes.splice(idx, 1);
  const el = eligible(A, v);
  const yes = v.yes.filter((x) => el.includes(x)).length;
  const no = v.no.filter((x) => el.includes(x)).length;
  const passed = yes > no;
  switch (v.kind) {
    case 'replace_leader':
      if (passed && A.members.includes(v.subject)) {
        A.leader = v.subject;
        news(state, 'leader_replaced', { A: v.subject, X: A.name }, null, A.members);
      }
      break;
    case 'expel':
      if (passed && A.members.includes(v.subject)) {
        removeMember(state, v.subject, A);
        news(state, 'alliance_expelled', { A: v.subject, X: A.name }, null, [v.subject]);
      }
      break;
    case 'skip_mutual_defense':
      if (passed) {
        A.skip[v.subject] = state.time + cfg(state).councilEveryDays * DAY;
        news(state, 'mutual_skipped', { A: v.subject, X: A.name }, null, A.members);
      } else if (v.victim) {
        triggerMutualDefense(state, A, v.subject, v.victim);
      }
      break;
  }
}

/**
 * Défense mutuelle : un membre (avec la clause) est attaqué. Les alliés entrent en guerre après un délai,
 * sauf si l'alliance vote la dispense (vote ouvert automatiquement, clos à l'échéance).
 */
export function mutualDefense(state: EngineState, aggressor: NationId, victim: NationId): void {
  const A = allianceOf(state, victim);
  if (!A || !A.charter.mutualDefense || A.members.includes(aggressor)) return;
  const skip = A.skip[aggressor];
  if (skip !== undefined && skip > state.time) return;
  if (A.members.every((m) => m === victim || atWar(state, m, aggressor))) return;
  if (A.votes.some((v) => v.kind === 'skip_mutual_defense' && v.subject === aggressor)) return;
  const delay = cfg(state).mutualDefenseDelayHours;
  if (delay <= 0) {
    triggerMutualDefense(state, A, aggressor, victim);
    return;
  }
  openVote(state, A, 'skip_mutual_defense', aggressor, null, delay, victim);
}

function triggerMutualDefense(state: EngineState, A: Alliance, aggressor: NationId, victim: NationId): void {
  if (!atWar(state, victim, aggressor) || !isRegular(state, aggressor)) return;
  const b = board(state);
  for (const m of [...A.members].sort()) {
    if (m === victim || m === aggressor || atWar(state, m, aggressor)) continue;
    const cf = b.ceasefires[m < aggressor ? `${m}|${aggressor}` : `${aggressor}|${m}`];
    if (cf !== undefined && cf > state.time) continue;
    declareDefensive(state, m, aggressor);
  }
}

export function orderTreasury(state: EngineState, n: NationId, amount: number): OrderResult {
  const A = allianceOf(state, n);
  if (!A) return fail('not_allowed', "Vous n'appartenez à aucune alliance.");
  const ns = state.nations[n]!;
  if (!Number.isFinite(amount) || amount === 0) return fail('invalid_target', 'Montant invalide.');
  if (amount > 0) {
    if (ns.money < amount) return fail('insufficient_funds', 'Fonds insuffisants.');
    ns.money -= amount;
    A.treasury += amount;
  } else {
    if (A.leader !== n) return fail('not_allowed', 'Seul le chef peut puiser dans le trésor.');
    if (A.treasury < -amount) return fail('insufficient_funds', 'Trésor insuffisant.');
    A.treasury += amount;
    ns.money -= amount;
  }
  return OK;
}

/** Tick journalier : chef inactif, neutres courtisés qui rejoignent, érosion des inclinaisons. */
export function alliancesDaily(state: EngineState): void {
  const d = ds(state);
  const c = cfg(state);
  for (const id of sortedKeys(d.alliances)) {
    const A = d.alliances[id]!;
    for (const m of [...A.members]) if (!state.nations[m]?.alive) removeMember(state, m, A);
    if (!d.alliances[id]) continue;
    const leader = state.nations[A.leader]!;
    const last = d.lastActive[A.leader] ?? 0;
    const inactive = leader.isPlayer && state.time - last > c.leaderInactiveDays * DAY;
    if (inactive && A.members.length > 1 && !A.votes.some((v) => v.kind === 'replace_leader')) {
      const cand = A.members.filter((m) => m !== A.leader);
      const active = cand.filter((m) => !state.nations[m]!.isPlayer || state.time - (d.lastActive[m] ?? 0) <= c.leaderInactiveDays * DAY);
      openVote(state, A, 'replace_leader', bestMember(state, active.length > 0 ? active : cand), null, c.allianceVoteHours);
    }
    for (const k of sortedKeys(A.skip)) if (A.skip[k]! <= state.time) delete A.skip[k];
  }
  for (const n of sortedKeys(d.leaning)) {
    const L = d.leaning[n]!;
    let bestId: string | null = null;
    for (const aid of sortedKeys(L)) {
      L[aid] = clamp(L[aid]! - c.leaningDecayPerDay, 0, 1);
      if (L[aid]! <= 0 || !d.alliances[aid]) {
        delete L[aid];
        continue;
      }
      if (!bestId || L[aid]! > L[bestId]!) bestId = aid;
    }
    if (Object.keys(L).length === 0) delete d.leaning[n];
    const ns = state.nations[n];
    if (!bestId || !ns || ns.isPlayer || !ns.alive || allianceOf(state, n)) continue;
    const A = d.alliances[bestId]!;
    if (L[bestId]! >= c.courtJoinLeaning && !A.members.some((m) => atWar(state, m, n))) joinAlliance(state, n, A);
  }
}
