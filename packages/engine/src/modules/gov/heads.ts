import {
  DAY,
  GOV_SKILLS,
  govRating,
  type GovHeadView,
  type GovOffice,
  type GovOfficeDef,
  type GovSkill,
  type GovTraitDef,
  type NationId,
  type Order,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { nextFloat, seedRng, type RngState } from '../../rng/rng.js';
import type { EngineState } from '../../state/types.js';
import { CULTURES, cultureOf } from '../command/names.js';
import { eco } from '../eco/state.js';
import { costIndexOf } from '../eco/upkeep.js';
import { book } from '../eco/util.js';
import { journal, notifyOwner } from './journal.js';
import { clamp, govBal, govNation, govOpt, nextGovId, type HeadSt, type PoolSt } from './state.js';

/**
 * Titulaires des postes du gouvernement : ministres et directeurs FICTIFS (noms tirés des listes
 * culturelles du jeu, combinaisons générées, jamais de personnes réelles), vivier déterministe par
 * nation et par poste (graine de la partie), nomination (prime), coût journalier selon la note et le
 * coût local du pays, renvoi (indemnité), démission faute de paiement. Les compétences ont des
 * effets modestes : vitesse, rabais négociés, actions simultanées, qualité des choix, réserve gardée.
 */

export interface Candidate {
  idx: number;
  first: string;
  last: string;
  culture: string;
  skills: Record<GovSkill, number>;
  traits: string[];
}

function hashStr(s: string, h = 2166136261): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

function gauss(r: RngState): number {
  const u = Math.max(1e-9, nextFloat(r));
  const v = nextFloat(r);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function officeDef(state: EngineState, office: GovOffice): GovOfficeDef | undefined {
  return govBal(state).offices[office];
}

/** Postes des données, dans l'ordre d'affichage. */
export function officeIds(state: EngineState): GovOffice[] {
  const o = govBal(state).offices;
  return (Object.keys(o) as GovOffice[]).sort(
    (a, b) => o[a]!.order - o[b]!.order || (a < b ? -1 : 1),
  );
}

/** Conditions d'un trait (cohérence avec les compétences du poste : gestion, expertise, prudence). */
function traitFits(id: string, mg: number, ex: number, fi: number): boolean {
  switch (id) {
    case 'efficient':
      return mg >= 55;
    case 'bureaucrat':
      return mg <= 50;
    case 'ambitious':
      return fi <= 55;
    case 'cautious':
    case 'frugal':
      return fi >= 50;
    case 'technocrat':
      return ex >= 62;
    default:
      return true;
  }
}

/** Candidat n° `idx` du vivier d'un poste : fonction pure de la graine. */
export function candidate(
  state: EngineState,
  n: NationId,
  office: GovOffice,
  idx: number,
): Candidate {
  const H = govBal(state).heads;
  const used = officeDef(state, office)?.skills ?? ['management', 'industry', 'finance'];
  const r = seedRng(hashStr(`${n}:${office}:${idx}`, (state.setup.seed ^ 0x9e37) >>> 0));
  const culture = cultureOf(n);
  const names = CULTURES[culture] ?? CULTURES.en!;
  const first = names.first[Math.floor(nextFloat(r) * names.first.length)]!;
  const last = names.last[Math.floor(nextFloat(r) * names.last.length)]!;
  const rating = clamp(H.skillMean + H.skillSpread * gauss(r), 20, 92);
  const skills = {} as Record<GovSkill, number>;
  for (const k of GOV_SKILLS) {
    const bonus = k === used[1] ? 10 : k === used[0] ? 4 : 0;
    skills[k] = Math.round(clamp(rating + bonus + 10 * gauss(r) - 4, 5, 99));
  }
  const traits: string[] = [];
  if (nextFloat(r) < H.traitChance) {
    const defs = Object.keys(H.traits).sort();
    const ok = defs.filter((id) =>
      traitFits(id, skills[used[0]!], skills[used[1]!], skills[used[2]!]),
    );
    let total = 0;
    for (const id of ok) total += H.traits[id]!.weight;
    let x = nextFloat(r) * total;
    for (const id of ok) {
      x -= H.traits[id]!.weight;
      if (x <= 0) {
        traits.push(id);
        break;
      }
    }
  }
  return { idx, first, last, culture, skills, traits };
}

export function traitSum(state: EngineState, traits: string[]): GovTraitDef {
  const defs = govBal(state).heads.traits;
  const out: GovTraitDef = {
    weight: 0,
    speed: 0,
    discount: 0,
    reserve: 1,
    slots: 0,
    salary: 1,
    choice: 0,
  };
  for (const id of traits) {
    const t = defs[id];
    if (!t) continue;
    out.speed += t.speed;
    out.discount += t.discount;
    out.reserve *= t.reserve;
    out.slots += t.slots;
    out.salary *= t.salary;
    out.choice += t.choice;
  }
  return out;
}

export interface HeadEffects {
  /** Gain de vitesse (fraction, négatif : plus lent). */
  speed: number;
  /** Rabais négocié (fraction). */
  discount: number;
  /** Actions simultanées par mission. */
  slots: number;
  /** Choix parmi les k meilleurs. */
  choice: number;
  /** Réserve gardée (jours de budget). */
  reserveDays: number;
}

type Person = { skills: Record<GovSkill, number>; traits: string[] };

/** Effets des compétences et des traits d'un titulaire à un poste. */
export function effectsOf(state: EngineState, office: GovOffice, p: Person): HeadEffects {
  const E = govBal(state).effects;
  const used = officeDef(state, office)?.skills ?? ['management', 'industry', 'finance'];
  const mg = p.skills[used[0]!];
  const ex = p.skills[used[1]!];
  const fi = p.skills[used[2]!];
  const T = traitSum(state, p.traits);
  const ramp = (v: number, from: number) => clamp((v - from) / Math.max(1, 100 - from), 0, 1);
  return {
    speed: clamp(E.speedMax * ramp(mg, E.speedFrom) + T.speed, -0.2, 0.3),
    discount: clamp(E.discountMax * ramp(ex, E.discountFrom) + T.discount, 0, 0.2),
    slots: Math.max(1, E.slotsBase + (mg >= E.slotsAt ? 1 : 0) + T.slots),
    choice: Math.max(1, 1 + Math.floor((100 - ex) / E.choiceStep) + T.choice),
    reserveDays: E.reserveDays * (0.5 + fi / 100) * T.reserve,
  };
}

/** Coût journalier d'un titulaire (dollars) : poste, note, traits, coût local du pays. */
export function salaryOf(state: EngineState, n: NationId, office: GovOffice, p: Person): number {
  const H = govBal(state).heads;
  const def = officeDef(state, office);
  if (!def) return 0;
  const rating = govRating(p.skills, def.skills);
  let s =
    def.salaryUsdPerDay *
    (H.salaryBase + (H.salarySpan * rating) / 100) *
    traitSum(state, p.traits).salary;
  if (H.useCostIndex && eco(state).live) s *= costIndexOf(state, n);
  return Math.round(s / 1000) * 1000;
}

// ——— Vivier ———

/** Vivier d'un poste (lecture seule si absent : rangs 0..taille−1). */
export function poolIds(state: EngineState, n: NationId, office: GovOffice): number[] {
  const p = govOpt(state)?.nations[n]?.pools[office];
  return p ? p.ids : [...Array(govBal(state).heads.poolSize).keys()];
}

function poolOf(state: EngineState, n: NationId, office: GovOffice): PoolSt {
  const gn = govNation(state, n);
  let p = gn.pools[office];
  if (!p) {
    const size = govBal(state).heads.poolSize;
    p = gn.pools[office] = { ids: [...Array(size).keys()], next: size, at: state.time };
  }
  return p;
}

/** Renouvellement des viviers (le plus ancien candidat non nommé est remplacé). */
export function refreshPools(state: EngineState): void {
  const g = govOpt(state);
  if (!g) return;
  const days = govBal(state).heads.poolRefreshDays;
  if (days <= 0) return;
  for (const n of Object.keys(g.nations).sort()) {
    const gn = g.nations[n]!;
    for (const office of Object.keys(gn.pools).sort() as GovOffice[]) {
      const p = gn.pools[office]!;
      if (state.time - p.at < days * DAY) continue;
      p.ids.shift();
      p.ids.push(p.next++);
      p.at = state.time;
    }
  }
}

export const candidateId = (idx: number) => `c${idx}`;

export function headView(
  state: EngineState,
  n: NationId,
  office: GovOffice,
  p: Candidate | HeadSt,
  hired: boolean,
): GovHeadView {
  const H = govBal(state).heads;
  const salary = salaryOf(state, n, office, p);
  const def = officeDef(state, office);
  const h = hired ? (p as HeadSt) : null;
  return {
    id: h ? h.id : candidateId(p.idx),
    first: p.first,
    last: p.last,
    culture: p.culture,
    skills: { ...p.skills },
    traits: [...p.traits],
    rating: Math.round(govRating(p.skills, def?.skills ?? [])),
    salaryPerDay: salary,
    hireCost: hired ? 0 : Math.round(salary * H.signingDays),
    severance: Math.round(salary * H.severanceDays),
    ...(h ? { since: h.since } : {}),
    ...(h && h.unpaid > 0 ? { unpaidDays: h.unpaid } : {}),
    effects: effectsOf(state, office, p),
  };
}

export const fullName = (h: { first: string; last: string }) => `${h.first} ${h.last}`;

// ——— Coût journalier ———

function charge(state: EngineState, n: NationId, amount: number): void {
  if (amount <= 0) return;
  state.nations[n]!.money -= amount;
  book(state, n, 'government', -amount);
}

/** Coût journalier des titulaires : payé si la trésorerie le permet, sinon démission au-delà du seuil. */
export function payroll(state: EngineState): void {
  const g = govOpt(state);
  if (!g) return;
  const H = govBal(state).heads;
  for (const n of Object.keys(g.nations).sort()) {
    const ns = state.nations[n];
    if (!ns?.alive) continue;
    const gn = g.nations[n]!;
    for (const office of Object.keys(gn.heads).sort() as GovOffice[]) {
      const h = gn.heads[office]!;
      const s = salaryOf(state, n, office, h);
      if (ns.money >= s) {
        charge(state, n, s);
        h.unpaid = 0;
        continue;
      }
      h.unpaid++;
      if (h.unpaid >= H.resignAfterUnpaidDays) {
        delete gn.heads[office];
        gn.v++;
        journal(state, n, office, 'resigned', { name: fullName(h) }, 'bad');
        notifyOwner(state, n, 'resigned', { name: fullName(h) }, 'critical');
      } else {
        journal(state, n, office, 'unpaid', { name: fullName(h), days: h.unpaid }, 'warn');
      }
    }
  }
}

// ——— Ordres ———

const fail = (error: OrderResult['error'], message: string): OrderResult => ({
  ok: false,
  error,
  message,
});

export function orderAppoint(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govAppoint' }>,
): OrderResult {
  const B = govBal(state);
  if (!B.enabled) return fail('not_allowed', 'Gouvernement désactivé.');
  if (!state.nations[n]?.alive) return fail('not_allowed', 'Nation vaincue.');
  if (!officeDef(state, o.office)) return fail('invalid_target', 'Poste inconnu.');
  const m = /^c(\d+)$/.exec(o.candidateId);
  const idx = m ? Number(m[1]) : -1;
  if (!poolIds(state, n, o.office).includes(idx))
    return fail('invalid_target', 'Candidat introuvable.');
  const c = candidate(state, n, o.office, idx);
  const salary = salaryOf(state, n, o.office, c);
  const gn0 = govOpt(state)?.nations[n];
  const prev = gn0?.heads[o.office];
  const cost =
    Math.round(salary * B.heads.signingDays) +
    (prev ? Math.round(salaryOf(state, n, o.office, prev) * B.heads.severanceDays) : 0);
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds', 'Fonds insuffisants.');
  charge(state, n, cost);
  const gn = govNation(state, n);
  const p = poolOf(state, n, o.office);
  p.ids = p.ids.filter((x) => x !== idx);
  p.ids.push(p.next++);
  if (prev) journal(state, n, o.office, 'replaced', { name: fullName(prev) });
  const h: HeadSt = {
    id: nextGovId(state, 'h'),
    idx,
    first: c.first,
    last: c.last,
    culture: c.culture,
    skills: { ...c.skills },
    traits: [...c.traits],
    since: state.time,
    unpaid: 0,
  };
  gn.heads[o.office] = h;
  gn.v++;
  journal(state, n, o.office, 'appointed', { name: fullName(h) }, 'good');
  return { ok: true };
}

export function orderDismiss(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'govDismiss' }>,
): OrderResult {
  const gn = govOpt(state)?.nations[n];
  const h = gn?.heads[o.office];
  if (!gn || !h) return fail('invalid_target', 'Poste vacant.');
  const cost = Math.round(salaryOf(state, n, o.office, h) * govBal(state).heads.severanceDays);
  if (state.nations[n]!.money < cost) return fail('insufficient_funds', 'Fonds insuffisants.');
  charge(state, n, cost);
  delete gn.heads[o.office];
  gn.v++;
  journal(state, n, o.office, 'dismissed', { name: fullName(h) }, 'warn');
  return { ok: true };
}
