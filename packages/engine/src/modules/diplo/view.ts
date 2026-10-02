import type {
  AllianceView,
  CouncilView,
  DiplomacyView,
  DisputedView,
  NationId,
  PlayerView,
  RelationView,
  ResolutionView,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { sortedKeys } from '../../state/access.js';
import { board } from '../registry.js';
import {
  allianceOf,
  cfg,
  ds,
  isRegular,
  nationName,
  pairKey,
  reputation,
  stabilityOf,
  type Alliance,
  type Resolution,
} from './state.js';
import { relationOf } from './relations.js';
import { stabilityView } from './stability.js';
import { canonical } from '../../state/loc.js';
import { domesticView } from './domestic.js';

const RECENT_NEWS = 50;

const PSEUDO_COLORS = { rebel: '#8a7f5a', peacekeeper: '#7fb2e5' } as const;

function allianceView(A: Alliance): AllianceView {
  return {
    id: A.id,
    name: A.name,
    flag: A.flag,
    leader: A.leader,
    members: [...A.members],
    charter: { ...A.charter },
    treasury: A.treasury,
    createdAt: A.createdAt,
    votes: A.votes.map((v) => ({
      id: v.id,
      kind: v.kind,
      subject: v.subject,
      endsAt: v.endsAt,
      yes: [...v.yes],
      no: [...v.no],
    })),
    invites: [...A.invites],
  };
}

/** Alliance vue de l'extérieur : sans votes internes ni trésor. */
function publicAllianceView(A: Alliance): AllianceView {
  return { ...allianceView(A), votes: [], treasury: 0, invites: [] };
}

function resolutionView(r: Resolution): ResolutionView {
  return {
    id: r.id,
    type: r.type,
    proposer: r.proposer,
    target: {
      ...r.target,
      ...(r.target.provinceIds ? { provinceIds: [...r.target.provinceIds] } : {}),
    },
    text: r.text,
    votes: { ...r.votes },
    status: r.status,
    durationDays: r.durationDays,
  };
}

export function councilView(state: EngineState): CouncilView {
  const d = ds(state);
  const s = d.session;
  return {
    members: [...s.members],
    rotatingSeats: [...s.rotating],
    rule: { ...d.rule },
    nextSessionAt: s.opensAt,
    session: {
      phase: s.phase,
      opensAt: s.opensAt,
      votingEndsAt: s.votingEndsAt,
      resolutions: s.resolutions.map(resolutionView),
    },
    inForce: d.inForce.map((f) => ({ ...resolutionView(f), until: f.until })),
  };
}

export function disputedViews(state: EngineState): DisputedView[] {
  const d = ds(state);
  const out: DisputedView[] = [];
  for (const area of state.world.map.disputed) {
    const st = d.disputed[area.id];
    if (!st) continue;
    out.push({
      id: area.id,
      name: area.name,
      provinceIds: area.provinceIds.filter((p) => state.provinces[p]),
      holder: st.holder,
      claimants: [...area.claimants],
      tension: Math.round(st.tension),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function diplomacyView(state: EngineState, me: NationId): DiplomacyView {
  const d = ds(state);
  const relations: RelationView[] = [];
  for (const n of state.nationIds) {
    if (n === me) continue;
    const rel = relationOf(state, me, n);
    const p = d.proposals[pairKey(me, n)];
    if (rel === 'peace' && !p) continue;
    relations.push({
      nationId: n,
      relation: rel,
      since: d.since[pairKey(me, n)] ?? 0,
      pending: p ? { from: p.from, kind: p.kind, at: p.at } : null,
    });
  }
  const mine = allianceOf(state, me);
  const alliances = sortedKeys(d.alliances).map((id) => {
    const A = d.alliances[id]!;
    return A.members.includes(me) ? allianceView(A) : publicAllianceView(A);
  });
  const invitations = sortedKeys(d.alliances).filter((id) => d.alliances[id]!.invites.includes(me));
  const b = board(state);
  const neutrals: DiplomacyView['neutrals'] = [];
  for (const n of state.nationIds) {
    if (n === me || b.allianceOf[n] || !state.nations[n]!.alive || state.nations[n]!.isPlayer)
      continue;
    neutrals.push({ nationId: n, leaning: { ...(d.leaning[n] ?? {}) } });
  }
  return {
    relations,
    alliances,
    myAllianceId: mine?.id ?? null,
    invitations,
    reputation: Math.round(reputation(state, me)),
    disputed: disputedViews(state),
    neutrals,
  };
}

function recentNews(state: EngineState) {
  const all = ds(state).news;
  return (
    all
      .slice(-RECENT_NEWS)
      .reverse()
      // Ordre des clés fixe : la vue doit être identique après une sérialisation (clés triées).
      .map((n) => ({
        id: n.id,
        time: n.time,
        category: n.category,
        headline: n.headline,
        body: n.body,
        at: n.at,
        nations: [...n.nations],
        ...(n.loc ? { loc: canonical(n.loc) } : {}),
      }))
  );
}

/** Champs publics des nations, provinces et unités (communs à la vue joueur et spectateur). */
function decorate(state: EngineState, view: PlayerView, me: NationId | null): void {
  const d = ds(state);
  const b = board(state);
  for (const id of sortedKeys(view.nations)) {
    const nv = view.nations[id]!;
    if (me && id !== me && isRegular(state, id)) nv.relation = relationOf(state, me, id);
    nv.allianceId = b.allianceOf[id] ?? null;
    nv.stability = Math.round(stabilityOf(state, id));
    nv.reputation = Math.round(reputation(state, id));
    nv.embargoed = !!b.embargoed[id];
    nv.sanctioned = (b.sanctions[id] ?? 1) < 1;
    if (b.mobilized[id]) nv.mobilized = true;
  }
  // Pseudo-nations (rebelles, casques bleus) : absentes de la carte, mais présentes dans la vue.
  for (const id of sortedKeys(d.pseudo)) {
    const ns = state.nations[id];
    if (!ns) continue;
    const p = d.pseudo[id]!;
    view.nations[id] = {
      id,
      name: nationName(state, id),
      color: PSEUDO_COLORS[p.kind],
      isAi: true,
      isPlayer: false,
      alive: ns.alive,
      provinceCount: ns.provinceCount,
      ...(me ? { relation: relationOf(state, me, id) } : {}),
      allianceId: null,
    };
  }
  const disputedOf = new Map<string, string>();
  for (const area of state.world.map.disputed)
    if (d.disputed[area.id]) for (const p of area.provinceIds) disputedOf.set(p, area.id);
  const rt = cfg(state).revoltThreshold;
  for (const pid of sortedKeys(view.provinces)) {
    const pv = view.provinces[pid]!;
    const area = disputedOf.get(pid);
    const owner = state.provinces[pid]?.owner;
    let unrest = d.unrest[pid] ?? 0;
    if (area) {
      pv.disputedId = area;
      unrest += (d.disputed[area]?.tension ?? 0) / 2;
    }
    if (owner) unrest += Math.max(0, rt - stabilityOf(state, owner)) * 2;
    if (unrest > 0) pv.unrest = Math.round(Math.min(100, unrest));
    if (b.noFly[pid]) pv.noFlyZone = true;
  }
  for (const uid of sortedKeys(view.units)) {
    const it = d.irregular[uid];
    if (!it) continue;
    const uv = view.units[uid]!;
    // Un mercenaire n'est reconnu comme tel que par son employeur ou une observation précise.
    if (it.kind !== 'mercenary' || uv.level === 'own' || uv.level === 'precise')
      uv.affiliation = it.kind;
  }
}

export function playerView(state: EngineState, me: NationId, view: PlayerView): void {
  decorate(state, view, me);
  view.diplomacy = diplomacyView(state, me);
  view.council = councilView(state);
  view.stability = stabilityView(state, me);
  view.news = recentNews(state);
  const dom = domesticView(state, me);
  if (dom) view.domestic = dom;
}

export function spectatorView(state: EngineState, view: PlayerView): void {
  decorate(state, view, null);
  view.council = councilView(state);
  view.news = recentNews(state);
}
