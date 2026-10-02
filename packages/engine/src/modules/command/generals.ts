import {
  DAY,
  GENERAL_SKILLS,
  generalRating,
  type CommandGeneralView,
  type GeneralSkill,
  type GeneralTraitDef,
  type NationId,
  type Order,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { nextFloat, seedRng, type RngState } from '../../rng/rng.js';
import type { EngineState, Unit } from '../../state/types.js';
import { costIndexOf } from '../eco/upkeep.js';
import { book } from '../eco/util.js';
import { CULTURES, cultureOf } from './names.js';
import { journal, notifyOwner } from './journal.js';
import {
  cmd,
  cmdBal,
  cmdOpt,
  cmdRoll,
  nextCmdId,
  type ArmySt,
  type GenSt,
  type PoolSt,
} from './state.js';

/**
 * Généraux du centre de commandement : vivier de candidats fictifs par nation (tirage déterministe,
 * pur : graine de la partie, nation, rang du candidat), recrutement (prime d'engagement), solde
 * journalière selon le grade et les compétences (indice de coût local), limogeage (indemnité),
 * démission faute de paiement, expérience, blessure ou mort quand le QG de l'armée est frappé, et
 * bonus d'efficacité modestes des piles commandées.
 */

export interface Candidate {
  idx: number;
  first: string;
  last: string;
  culture: string;
  skills: Record<GeneralSkill, number>;
  traits: string[];
}

function hashStr(s: string, h = 2166136261): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Loi normale centrée réduite (Box-Muller). */
function gauss(r: RngState): number {
  const u = Math.max(1e-9, nextFloat(r));
  const v = nextFloat(r);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SPECIALTIES: GeneralSkill[] = ['offense', 'defense', 'logistics', 'air', 'naval'];

/** Conditions d'un trait (cohérence avec les compétences). */
function traitFits(id: string, s: Record<GeneralSkill, number>): boolean {
  switch (id) {
    case 'reckless':
    case 'blitz':
      return s.audacity >= 55;
    case 'thrifty':
    case 'methodical':
      return s.audacity <= 55;
    case 'airman':
      return s.air >= 55;
    case 'sailor':
      return s.naval >= 55;
    case 'logistician':
      return s.logistics >= 55;
    case 'encircler':
      return s.offense >= 55;
    case 'fortifier':
      return s.defense >= 55;
    case 'veteran':
      return s.experience >= 65;
    default:
      return true;
  }
}

/** Candidat n° `idx` du vivier d'une nation : fonction pure de la graine. */
export function candidate(state: EngineState, n: NationId, idx: number): Candidate {
  const G = cmdBal(state).generals;
  const r = seedRng(hashStr(`${n}:${idx}`, (state.setup.seed ^ 0x6e6e) >>> 0));
  const culture = cultureOf(n);
  const names = CULTURES[culture] ?? CULTURES.en!;
  const first = names.first[Math.floor(nextFloat(r) * names.first.length)]!;
  const last = names.last[Math.floor(nextFloat(r) * names.last.length)]!;
  const rating = clamp(G.skillMean + G.skillSpread * gauss(r), 18, 94);
  const main = SPECIALTIES[Math.floor(nextFloat(r) * SPECIALTIES.length)]!;
  const second = SPECIALTIES[Math.floor(nextFloat(r) * SPECIALTIES.length)]!;
  const skills = {} as Record<GeneralSkill, number>;
  for (const k of GENERAL_SKILLS) {
    if (k === 'audacity') skills[k] = Math.round(clamp(15 + 70 * nextFloat(r), 5, 95));
    else {
      const bonus = (k === main ? 14 : 0) + (k === second && second !== main ? 6 : 0);
      skills[k] = Math.round(clamp(rating + bonus + 9 * gauss(r) - 4, 5, 99));
    }
  }
  const traits: string[] = [];
  const defs = Object.keys(G.traits).sort();
  const pick = (): string | null => {
    const ok = defs.filter((id) => !traits.includes(id) && traitFits(id, skills));
    let total = 0;
    for (const id of ok) total += G.traits[id]!.weight;
    if (total <= 0) return null;
    let x = nextFloat(r) * total;
    for (const id of ok) {
      x -= G.traits[id]!.weight;
      if (x <= 0) return id;
    }
    return ok[ok.length - 1] ?? null;
  };
  if (nextFloat(r) < G.traitChance) {
    const t = pick();
    if (t) traits.push(t);
    if (t && nextFloat(r) < G.secondTraitChance) {
      const t2 = pick();
      if (t2) traits.push(t2);
    }
  }
  traits.sort();
  return { idx, first, last, culture, skills, traits };
}

/** Effets cumulés des traits d'un général. */
export function traitSum(state: EngineState, traits: string[]): GeneralTraitDef {
  const defs = cmdBal(state).generals.traits;
  const out: GeneralTraitDef = {
    weight: 0,
    attackRatio: 0,
    retreatAt: 0,
    objectives: 0,
    sorties: 0,
    escorts: 0,
    damage: 0,
    armor: 0,
    logistics: 0,
    rally: false,
    encircle: 0,
    friction: 1,
    salary: 1,
    xp: 1,
  };
  for (const id of traits) {
    const t = defs[id];
    if (!t) continue;
    out.attackRatio += t.attackRatio;
    out.retreatAt += t.retreatAt;
    out.objectives += t.objectives;
    out.sorties += t.sorties;
    out.escorts += t.escorts;
    out.damage += t.damage;
    out.armor += t.armor;
    out.logistics += t.logistics;
    out.rally ||= t.rally;
    out.encircle += t.encircle;
    out.friction *= t.friction;
    out.salary *= t.salary;
    out.xp *= t.xp;
  }
  return out;
}

/** Grade (1 à 4 étoiles) d'après la note globale. */
export function rankOf(state: EngineState, skills: Record<GeneralSkill, number>): number {
  const ranks = cmdBal(state).generals.ranks;
  const r = generalRating(skills);
  let k = 0;
  for (let i = 0; i < ranks.length; i++) if (r >= ranks[i]!.minRating) k = i;
  return k + 1;
}

/** Coût journalier (solde + état-major), en dollars : grade, prime de compétence, traits, coût local. */
export function salaryOf(
  state: EngineState,
  n: NationId,
  skills: Record<GeneralSkill, number>,
  traits: string[],
): number {
  const G = cmdBal(state).generals;
  const ranks = G.ranks;
  const rating = generalRating(skills);
  const k = rankOf(state, skills) - 1;
  const lo = ranks[k]!.minRating;
  const hi = ranks[k + 1]?.minRating ?? 100;
  const frac = clamp((rating - lo) / Math.max(1, hi - lo), 0, 1);
  let s = ranks[k]!.salaryUsdPerDay * (1 + G.rankPremium * frac) * traitSum(state, traits).salary;
  if (G.useCostIndex && state.world.balance.money) s *= costIndexOf(state, n);
  return Math.round(s / 1000) * 1000;
}

// ——— Vivier ———

function poolOf(state: EngineState, n: NationId, create: boolean): PoolSt {
  const c = create ? cmd(state) : cmdOpt(state);
  const size = cmdBal(state).generals.poolSize;
  const existing = c?.pools[n];
  if (existing) return existing;
  const p: PoolSt = { ids: [...Array(size).keys()], next: size, at: state.time };
  if (create) cmd(state).pools[n] = p;
  return p;
}

export function candidateId(idx: number): string {
  return `cand${idx}`;
}

/** Candidats proposés à une nation (sans modifier l'état). */
export function candidatesOf(state: EngineState, n: NationId): Candidate[] {
  return poolOf(state, n, false).ids.map((i) => candidate(state, n, i));
}

/** Renouvellement du vivier : le plus ancien candidat non recruté laisse sa place. */
export function refreshPools(state: EngineState): void {
  const c = cmdOpt(state);
  if (!c) return;
  const days = cmdBal(state).generals.poolRefreshDays;
  if (days <= 0) return;
  for (const n of Object.keys(c.pools).sort()) {
    const p = c.pools[n]!;
    if (state.time - p.at < days * DAY) continue;
    p.ids.shift();
    p.ids.push(p.next++);
    p.at = state.time;
  }
}

// ——— Vues ———

function status(g: GenSt): CommandGeneralView['status'] {
  return g.status;
}

export function generalView(state: EngineState, g: GenSt): CommandGeneralView {
  const G = cmdBal(state).generals;
  const salary = salaryOf(state, g.owner, g.skills, g.traits);
  return {
    id: g.id,
    first: g.first,
    last: g.last,
    culture: g.culture,
    rank: rankOf(state, g.skills),
    skills: { ...g.skills },
    traits: [...g.traits],
    xp: Math.round(g.xp * 10) / 10,
    salaryPerDay: salary,
    hireCost: 0,
    severance: Math.round(salary * G.severanceDays),
    status: status(g),
    armyId: g.army,
    ...(g.woundedUntil !== null && g.status === 'wounded' ? { woundedUntil: g.woundedUntil } : {}),
    ...(g.unpaid > 0 ? { unpaidDays: g.unpaid } : {}),
    victories: g.victories,
  };
}

export function candidateView(state: EngineState, n: NationId, c: Candidate): CommandGeneralView {
  const G = cmdBal(state).generals;
  const salary = salaryOf(state, n, c.skills, c.traits);
  return {
    id: candidateId(c.idx),
    first: c.first,
    last: c.last,
    culture: c.culture,
    rank: rankOf(state, c.skills),
    skills: { ...c.skills },
    traits: [...c.traits],
    xp: 0,
    salaryPerDay: salary,
    hireCost: Math.round(salary * G.signingBonusDays),
    severance: Math.round(salary * G.severanceDays),
    status: 'candidate',
    armyId: null,
    victories: 0,
  };
}

export function fullName(g: { first: string; last: string }): string {
  return `${g.first} ${g.last}`;
}

// ——— Paiements ———

/** Débite la trésorerie (grand livre « command »). */
function charge(state: EngineState, n: NationId, amount: number): void {
  if (amount <= 0) return;
  state.nations[n]!.money -= amount;
  book(state, n, 'command', -amount);
}

/** Solde journalière : payée si la trésorerie le permet, sinon jour impayé (démission au-delà du seuil). */
export function payroll(state: EngineState): void {
  const c = cmdOpt(state);
  if (!c) return;
  const G = cmdBal(state).generals;
  for (const id of Object.keys(c.gens).sort()) {
    const g = c.gens[id]!;
    const ns = state.nations[g.owner];
    if (!ns?.alive) continue;
    const salary = salaryOf(state, g.owner, g.skills, g.traits);
    if (ns.money >= salary) {
      charge(state, g.owner, salary);
      g.unpaid = 0;
      continue;
    }
    g.unpaid++;
    if (g.unpaid >= G.resignAfterUnpaidDays) {
      const army = g.army ? c.armies[g.army] : null;
      notifyOwner(state, g.owner, 'generalResigned', { general: fullName(g) }, 'critical');
      if (army) journal(state, army, 'resigned', { general: fullName(g) }, 'bad');
      removeGeneral(state, g);
    } else {
      notifyOwner(
        state,
        g.owner,
        'generalUnpaid',
        { general: fullName(g), days: g.unpaid, max: G.resignAfterUnpaidDays },
        'warn',
      );
    }
  }
}

/** Retire un général (limogé, démission, mort) : son armée devient passive. */
export function removeGeneral(state: EngineState, g: GenSt): void {
  const c = cmd(state);
  const a = g.army ? c.armies[g.army] : null;
  if (a && a.general === g.id) {
    a.general = null;
    a.v++;
  }
  delete c.gens[g.id];
}

// ——— Ordres ———

const fail = (error: OrderResult['error'], message: string): OrderResult => ({
  ok: false,
  error,
  message,
});

/** Recrutement possible ? (candidat du vivier, trésorerie pour la prime d'engagement). */
export function checkHire(
  state: EngineState,
  n: NationId,
  candidateId: string,
): { ok: true; idx: number } | { ok: false; res: OrderResult } {
  const B = cmdBal(state);
  if (!B.enabled)
    return { ok: false, res: fail('not_allowed', 'Centre de commandement désactivé.') };
  const m = /^cand(\d+)$/.exec(candidateId);
  const idx = m ? Number(m[1]) : -1;
  if (!m || !poolOf(state, n, false).ids.includes(idx))
    return { ok: false, res: fail('invalid_target', 'Candidat inconnu.') };
  const cand = candidate(state, n, idx);
  const bonus = Math.round(
    salaryOf(state, n, cand.skills, cand.traits) * B.generals.signingBonusDays,
  );
  if (state.nations[n]!.money < bonus)
    return { ok: false, res: fail('insufficient_funds', 'Trésorerie insuffisante.') };
  return { ok: true, idx };
}

/** Recrute le candidat (prime d'engagement), le remplace dans le vivier, lui confie l'armée. */
export function doHire(state: EngineState, n: NationId, idx: number, army: ArmySt | null): GenSt {
  const B = cmdBal(state);
  const c = cmd(state);
  const cand = candidate(state, n, idx);
  const salary = salaryOf(state, n, cand.skills, cand.traits);
  charge(state, n, Math.round(salary * B.generals.signingBonusDays));
  const p = poolOf(state, n, true);
  p.ids = p.ids.filter((x) => x !== idx);
  p.ids.push(p.next++);
  const id = nextCmdId(state, 'g');
  const g: GenSt = {
    id,
    owner: n,
    idx,
    first: cand.first,
    last: cand.last,
    culture: cand.culture,
    skills: cand.skills,
    traits: cand.traits,
    xp: 0,
    xpUsed: 0,
    status: 'active',
    army: null,
    hiredAt: state.time,
    woundedUntil: null,
    unpaid: 0,
    victories: 0,
  };
  c.gens[id] = g;
  if (army) assign(state, g, army);
  return g;
}

export function orderHire(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'generalHire' }>,
): OrderResult {
  const c = cmd(state);
  const army = o.armyId ? c.armies[o.armyId] : undefined;
  if (o.armyId && (!army || army.owner !== n)) return fail('invalid_target', 'Armée inconnue.');
  const r = checkHire(state, n, o.candidateId);
  if (!r.ok) return r.res;
  doHire(state, n, r.idx, army ?? null);
  return { ok: true };
}

export function orderAssign(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'generalAssign' }>,
): OrderResult {
  const c = cmd(state);
  const g = c.gens[o.generalId];
  if (!g || g.owner !== n) return fail('invalid_target', 'Général inconnu.');
  if (g.status === 'dead' || g.status === 'resigned')
    return fail('not_allowed', 'Ce général n’est plus en service.');
  if (o.armyId === null) {
    unassign(state, g);
    return { ok: true };
  }
  const a = c.armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  assign(state, g, a);
  return { ok: true };
}

export function orderDismiss(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'generalDismiss' }>,
): OrderResult {
  const c = cmd(state);
  const g = c.gens[o.generalId];
  if (!g || g.owner !== n) return fail('invalid_target', 'Général inconnu.');
  const salary = salaryOf(state, n, g.skills, g.traits);
  const sev = Math.round(salary * cmdBal(state).generals.severanceDays);
  if (state.nations[n]!.money < sev)
    return fail('insufficient_funds', 'Trésorerie insuffisante pour l’indemnité.');
  charge(state, n, sev);
  const a = g.army ? c.armies[g.army] : null;
  if (a) journal(state, a, 'dismissed', { general: fullName(g) }, 'warn');
  removeGeneral(state, g);
  return { ok: true };
}

/** Confie l'armée au général (l'ancien commandant passe en réserve). */
export function assign(state: EngineState, g: GenSt, a: ArmySt): void {
  const c = cmd(state);
  if (g.army === a.id) return;
  unassign(state, g);
  if (a.general) {
    const prev = c.gens[a.general];
    if (prev) prev.army = null;
  }
  a.general = g.id;
  g.army = a.id;
  a.v++;
  journal(state, a, 'command', { general: fullName(g) }, 'info');
}

function unassign(state: EngineState, g: GenSt): void {
  const c = cmd(state);
  const a = g.army ? c.armies[g.army] : null;
  if (a && a.general === g.id) {
    a.general = null;
    a.v++;
  }
  g.army = null;
}

// ——— Expérience, blessures ———

const MISSION_SKILL: Record<string, GeneralSkill> = {
  conquer: 'offense',
  landing: 'naval',
  defend: 'defense',
  hold_front: 'defense',
  reserve: 'defense',
  air_superiority: 'air',
  air_defense: 'air',
  deep_strike: 'air',
  sea_control: 'naval',
};

/** Expérience : +1 en expérience tous les `xpPerSkill` points, et une fois sur deux dans la spécialité. */
export function gainXp(state: EngineState, g: GenSt, amount: number, brain: string | null): void {
  const G = cmdBal(state).generals;
  g.xp += amount * traitSum(state, g.traits).xp;
  const per = Math.max(0.1, G.xpPerSkill);
  while (g.xp - g.xpUsed >= per) {
    g.xpUsed += per;
    g.skills.experience = Math.min(99, g.skills.experience + 1);
    const k = brain ? MISSION_SKILL[brain] : undefined;
    if (k && Math.round(g.xpUsed / per) % 2 === 0) g.skills[k] = Math.min(99, g.skills[k] + 1);
  }
}

/** Convalescence terminée. */
export function healGenerals(state: EngineState): void {
  const c = cmdOpt(state);
  if (!c) return;
  for (const id of Object.keys(c.gens).sort()) {
    const g = c.gens[id]!;
    if (g.status === 'wounded' && g.woundedUntil !== null && g.woundedUntil <= state.time) {
      g.status = 'active';
      g.woundedUntil = null;
      const a = g.army ? c.armies[g.army] : null;
      if (a) journal(state, a, 'recovered', { general: fullName(g) }, 'good');
    }
  }
}

/** QG de l'armée : première pile terrestre encore présente (sinon la première pile). */
export function hqOf(state: EngineState, a: ArmySt): string | null {
  let first: string | null = null;
  for (const id of a.units) {
    const u = state.units[id];
    if (!u || u.off) continue;
    first ??= id;
    if (state.world.catalog.get(u.sys)?.movement === 'land') return id;
  }
  return first;
}

/** Coup reçu par le QG : blessure ou mort du général (tirage du module). */
export function hqHit(state: EngineState, tgt: Unit, dmg: number): void {
  const c = cmdOpt(state);
  const aid = c?.unitArmy[tgt.id];
  if (!c || !aid) return;
  const a = c.armies[aid];
  const g = a?.general ? c.gens[a.general] : undefined;
  if (!a || !g || g.status !== 'active') return;
  if (hqOf(state, a) !== tgt.id) return;
  const H = cmdBal(state).generals.hq;
  const share = Math.min(1, (25 * dmg) / Math.max(1, tgt.maxHp));
  const x = cmdRoll(state);
  if (x < H.killChance * share) {
    g.status = 'dead';
    notifyOwner(
      state,
      g.owner,
      'generalKilled',
      { general: fullName(g), army: a.name },
      'critical',
    );
    journal(state, a, 'killed', { general: fullName(g) }, 'bad');
    removeGeneral(state, g);
  } else if (x < (H.killChance + H.woundChance) * share) {
    g.status = 'wounded';
    g.woundedUntil = state.time + H.woundDays * DAY;
    notifyOwner(state, g.owner, 'generalWounded', { general: fullName(g), army: a.name }, 'warn');
    journal(state, a, 'wounded', { general: fullName(g), days: H.woundDays }, 'bad');
  }
}

/** Général actif qui commande la pile (null sinon). */
export function commanderOf(state: EngineState, u: Unit): GenSt | null {
  const c = cmdOpt(state);
  const aid = c?.unitArmy[u.id];
  if (!c || !aid) return null;
  const a = c.armies[aid];
  const g = a?.general ? c.gens[a.general] : undefined;
  return g && g.status === 'active' ? g : null;
}

/** Bonus modestes du général (crochet unitModifier). */
export function commandModifier(state: EngineState, u: Unit, key: string): number {
  if (
    key !== 'combat.damage' &&
    key !== 'combat.armor' &&
    key !== 'air.fuel' &&
    key !== 'supply.range'
  )
    return 1;
  const g = commanderOf(state, u);
  if (!g) return 1;
  const B = cmdBal(state).generals.bonus;
  const t = traitSum(state, g.traits);
  const exp = 0.5 + g.skills.experience / 200;
  switch (key) {
    case 'combat.damage':
      return u.move || u.target ? 1 + B.damage * (g.skills.offense / 100) * exp + t.damage : 1;
    case 'combat.armor':
      return u.move ? 1 : 1 + B.armor * (g.skills.defense / 100) * exp + t.armor;
    case 'air.fuel':
      return (
        1 + B.logistics * (Math.max(g.skills.logistics, g.skills.air) / 100) * exp + t.logistics
      );
    default:
      return 1 + B.logistics * (g.skills.logistics / 100) * exp + t.logistics;
  }
}
