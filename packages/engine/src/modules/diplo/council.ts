import {
  DAY,
  distanceKm,
  type NationId,
  type ProvinceId,
  type ResolutionType,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { notify, sortedKeys, warsOf } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { nextFloat } from '../../rng/rng.js';
import { makePeace } from '../../state/war.js';
import { board, scheduleMod } from '../registry.js';
import {
  PK_NATION,
  addReputation,
  addStability,
  cfg,
  ds,
  isRegular,
  nationName,
  type InForce,
  type Resolution,
  type Session,
} from './state.js';
import { news } from './news.js';
import { OK, endWar, fail } from './relations.js';
import { disbandUnits, spawnPeacekeepers } from './unrest.js';

export const RESOLUTION_LABELS: Record<ResolutionType, string> = {
  arms_embargo: 'embargo sur les armes',
  economic_sanctions: 'sanctions économiques',
  ceasefire: 'cessez-le-feu',
  no_fly_zone: "zone d'exclusion aérienne",
  peacekeeping: 'force de maintien de la paix',
  condemnation: 'condamnation',
};

const NATION_TYPES: ResolutionType[] = [
  'arms_embargo',
  'economic_sanctions',
  'ceasefire',
  'condemnation',
];

/** Chefs d'alliance (sièges permanents, droit de veto si la règle le prévoit). */
export function allianceLeaders(state: EngineState): NationId[] {
  const d = ds(state);
  return [...new Set(sortedKeys(d.alliances).map((id) => d.alliances[id]!.leader))].sort();
}

/** Sièges tournants : nations non alignées tirées au sort (les nations actives ont plus de chances). */
function pickRotating(state: EngineState, count: number): NationId[] {
  const b = board(state);
  const cand = state.nationIds.filter((n) => state.nations[n]!.alive && !b.allianceOf[n]);
  const out: NationId[] = [];
  const pool = cand.map((n) => ({ n, w: state.nations[n]!.active ? 5 : 1 }));
  while (out.length < count && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = nextFloat(ds(state).rng) * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= pool[i]!.w;
      if (r < 0) break;
    }
    out.push(pool[i]!.n);
    pool.splice(i, 1);
  }
  return out.sort();
}

function members(state: EngineState, rotating: NationId[]): NationId[] {
  return [...new Set([...allianceLeaders(state), ...rotating])]
    .filter((n) => state.nations[n]?.alive)
    .sort();
}

/** Nouvelle séance (phase des propositions) ; ouverture du vote à `regular`. */
export function createSession(state: EngineState, regular: number): Session {
  const d = ds(state);
  const rotating = pickRotating(state, d.rotatingSeats);
  const prev = d.session;
  const s: Session = {
    id: (prev?.id ?? 0) + 1,
    v: 1,
    phase: 'proposals',
    opensAt: regular,
    votingEndsAt: regular + d.voteWindowMs,
    members: members(state, rotating),
    rotating,
    resolutions: [],
  };
  d.session = s;
  scheduleMod(state, { t: s.opensAt, m: 'diplo', e: 'c_open', d: { id: s.id, v: s.v } });
  return s;
}

export function openSession(state: EngineState): void {
  const d = ds(state);
  const s = d.session;
  if (s.phase !== 'proposals') return;
  s.phase = 'voting';
  s.opensAt = state.time;
  s.votingEndsAt = state.time + d.voteWindowMs;
  s.members = members(state, s.rotating);
  for (const r of s.resolutions) r.status = 'voting';
  s.v++;
  scheduleMod(state, { t: s.votingEndsAt, m: 'diplo', e: 'c_close', d: { id: s.id, v: s.v } });
  news(
    state,
    'council_open',
    { X: String(s.resolutions.length), Y: s.members.map((m) => nationName(state, m)).join(', ') },
    null,
    s.members,
  );
  notify(
    state,
    {
      kind: 'council',
      time: state.time,
      text: `Séance du Conseil de sécurité ouverte : ${s.resolutions.length} résolution(s) au vote.`,
    },
    null,
  );
}

/** Séance d'urgence : le vote s'ouvre immédiatement sur les propositions en attente. */
export function emergencySession(state: EngineState, message?: string): void {
  const s = ds(state).session;
  news(state, 'emergency_council', { X: message ?? '' }, null, []);
  if (s.phase === 'proposals') openSession(state);
}

function tally(state: EngineState, s: Session, r: Resolution): Resolution['status'] {
  const d = ds(state);
  const leaders = new Set(allianceLeaders(state));
  let yes = 0;
  let no = 0;
  let veto = false;
  for (const m of s.members) {
    if (m === r.target.nationId) continue;
    const v = r.votes[m];
    if (v === 'yes') yes++;
    else if (v === 'no') {
      no++;
      if (d.rule.veto && leaders.has(m)) veto = true;
    }
  }
  if (veto) return 'vetoed';
  if (yes === 0) return 'rejected';
  const ok = d.rule.majority === 'two_thirds' ? yes * 3 >= (yes + no) * 2 : yes > no;
  return ok ? 'passed' : 'rejected';
}

export function closeSession(state: EngineState): void {
  const d = ds(state);
  const s = d.session;
  if (s.phase !== 'voting') return;
  s.phase = 'closed';
  for (const r of s.resolutions) {
    r.status = tally(state, s, r);
    const label = RESOLUTION_LABELS[r.type];
    const tgt = r.target.nationId;
    const votes = sortedKeys(r.votes)
      .map((m) => `${nationName(state, m)} ${r.votes[m] === 'yes' ? 'pour' : r.votes[m] === 'no' ? 'contre' : 'abstention'}`)
      .join(', ');
    if (r.status === 'passed') {
      applyResolution(state, r);
      if (tgt) news(state, 'resolution_passed', { A: tgt, X: label, Y: r.durationDays > 0 ? String(r.durationDays) : votes || '—' }, null, [tgt]);
      else news(state, 'resolution_zone_passed', { X: label, Y: zoneLabel(state, r.target.provinceIds ?? []) }, null, []);
    } else if (r.status === 'vetoed') {
      const vetoer = sortedKeys(r.votes).find((m) => r.votes[m] === 'no' && allianceLeaders(state).includes(m));
      news(state, 'resolution_vetoed', { A: vetoer, X: label }, null, tgt ? [tgt] : []);
    } else {
      news(state, 'resolution_rejected', { A: r.proposer, X: label }, null, tgt ? [tgt] : []);
    }
  }
  notify(
    state,
    {
      kind: 'council',
      time: state.time,
      text: `Séance close : ${s.resolutions.filter((r) => r.status === 'passed').length} résolution(s) adoptée(s) sur ${s.resolutions.length}.`,
    },
    null,
  );
  // Rythme mensuel : la prochaine séance ordinaire suit la précédente (les urgences ne le décalent pas).
  let next = d.nextRegular;
  while (next <= state.time) next += d.councilEveryMs;
  d.nextRegular = next;
  createSession(state, next);
}

function zoneLabel(state: EngineState, pids: ProvinceId[]): string {
  const w = wi(state.world);
  const names = pids.slice(0, 4).map((p) => w.provById.get(p)?.name ?? p);
  return names.join(', ') + (pids.length > 4 ? '…' : '');
}

function applyResolution(state: EngineState, r: Resolution): void {
  const c = cfg(state);
  const t = r.target.nationId;
  switch (r.type) {
    case 'condemnation':
      if (t) {
        addStability(state, t, -c.condemnationStability, 'Condamnation');
        addReputation(state, t, -c.condemnationReputation);
      }
      break;
    case 'ceasefire':
      if (t) {
        for (const e of warsOf(state, t)) {
          if (isRegular(state, e)) endWar(state, t, e, 'ceasefire', r.durationDays);
        }
      }
      break;
    default:
      break;
  }
  if (r.durationDays <= 0) return;
  const f: InForce = { ...r, until: state.time + r.durationDays * DAY };
  if (r.type === 'peacekeeping') f.units = spawnPeacekeepers(state, r.target.provinceIds ?? [], f.until);
  ds(state).inForce.push(f);
  scheduleMod(state, { t: f.until, m: 'diplo', e: 'r_end', d: { id: r.id } });
  syncBoard(state);
}

/** Tableau partagé (embargos, sanctions, zones d'exclusion) recalculé à partir des résolutions en vigueur. */
export function syncBoard(state: EngineState): void {
  const b = board(state);
  const c = cfg(state);
  b.embargoed = {};
  b.sanctions = {};
  b.noFly = {};
  for (const f of ds(state).inForce) {
    const t = f.target.nationId;
    if (f.type === 'arms_embargo' && t) b.embargoed[t] = true;
    if (f.type === 'economic_sanctions' && t) b.sanctions[t] = Math.min(b.sanctions[t] ?? 1, c.sanctionsIncomeFactor);
    if (f.type === 'no_fly_zone') for (const p of f.target.provinceIds ?? []) b.noFly[p] = true;
  }
}

export function endResolution(state: EngineState, id: string): void {
  const d = ds(state);
  const idx = d.inForce.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const f = d.inForce[idx]!;
  d.inForce.splice(idx, 1);
  if (f.type === 'peacekeeping') {
    disbandUnits(state, f.units ?? []);
    for (const e of warsOf(state, PK_NATION)) makePeace(state, PK_NATION, e);
  }
  syncBoard(state);
}

function resolveZone(state: EngineState, target: Resolution['target']): ProvinceId[] {
  const w = wi(state.world);
  const out = new Set<ProvinceId>();
  for (const p of target.provinceIds ?? []) if (state.provinces[p]) out.add(p);
  if (target.at && target.radiusKm) {
    for (const pid of sortedKeys(state.provinces)) {
      if (distanceKm(w.provById.get(pid)!.cityPoint, target.at) <= target.radiusKm) out.add(pid);
    }
  }
  return [...out].sort().slice(0, 50);
}

function nextResolutionId(state: EngineState): string {
  return `r${++ds(state).nextId}`;
}

export function orderPropose(
  state: EngineState,
  n: NationId,
  type: ResolutionType,
  target: Resolution['target'],
  text: string,
): OrderResult {
  const d = ds(state);
  const s = d.session;
  if (s.phase !== 'proposals') return fail('locked', 'Le vote est en cours : propositions closes.');
  if (s.resolutions.filter((r) => r.proposer === n && !r.auto).length >= cfg(state).proposalsPerNation)
    return fail('capacity', 'Nombre maximal de propositions atteint pour cette séance.');
  const clean: Resolution['target'] = {};
  if (NATION_TYPES.includes(type)) {
    const t = target.nationId;
    if (!t || t === n || !isRegular(state, t) || !state.nations[t]!.alive)
      return fail('invalid_target', 'Nation visée invalide.');
    if (type === 'ceasefire' && warsOf(state, t).every((e) => !isRegular(state, e)))
      return fail('invalid_target', "Cette nation n'est en guerre avec personne.");
    clean.nationId = t;
  } else {
    const pids = resolveZone(state, target);
    if (pids.length === 0) return fail('invalid_target', 'Zone invalide.');
    clean.provinceIds = pids;
    if (target.at) clean.at = [target.at[0], target.at[1]];
    if (target.radiusKm) clean.radiusKm = target.radiusKm;
  }
  s.resolutions.push({
    id: nextResolutionId(state),
    type,
    proposer: n,
    target: clean,
    text: text.trim() || defaultText(state, type, clean),
    votes: {},
    status: 'proposed',
    durationDays: cfg(state).resolutionDays[type],
  });
  return OK;
}

function defaultText(state: EngineState, type: ResolutionType, t: Resolution['target']): string {
  const label = RESOLUTION_LABELS[type];
  if (t.nationId) return `Projet de résolution : ${label} (${nationName(state, t.nationId)}).`;
  return `Projet de résolution : ${label} (${zoneLabel(state, t.provinceIds ?? [])}).`;
}

export function orderVoteResolution(
  state: EngineState,
  n: NationId,
  id: string,
  vote: 'yes' | 'no' | 'abstain',
): OrderResult {
  const s = ds(state).session;
  if (s.phase !== 'voting') return fail('locked', "Aucun vote en cours au Conseil.");
  if (!s.members.includes(n)) return fail('not_allowed', "Vous ne siégez pas au Conseil.");
  const r = s.resolutions.find((x) => x.id === id);
  if (!r || r.status !== 'voting') return fail('invalid_target', 'Résolution introuvable.');
  if (r.target.nationId === n) return fail('not_allowed', 'Une nation visée ne vote pas.');
  r.votes[n] = vote;
  return OK;
}

/**
 * Proposition automatique (violation de cessez-le-feu, attaque de casques bleus) : ajoutée à la séance
 * et mise au vote sans attendre (séance d'urgence si la séance est encore aux propositions).
 */
export function autoResolution(
  state: EngineState,
  type: ResolutionType,
  target: NationId,
  proposer: NationId,
  text: string,
): void {
  const s = ds(state).session;
  if (s.resolutions.some((r) => r.type === type && r.target.nationId === target && r.status !== 'rejected'))
    return;
  s.resolutions.push({
    id: nextResolutionId(state),
    type,
    proposer,
    target: { nationId: target },
    text,
    votes: {},
    status: s.phase === 'voting' ? 'voting' : 'proposed',
    durationDays: cfg(state).resolutionDays[type],
    auto: true,
  });
  if (s.phase === 'proposals') emergencySession(state, text);
}
