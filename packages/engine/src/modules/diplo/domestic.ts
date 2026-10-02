import {
  DAY,
  DOMESTIC_POLICIES,
  HOUR,
  type DomesticEventKind,
  type DomesticPolicy,
  type DomesticPolicyEffects,
  type DomesticView,
  type GameTime,
  type NationId,
  type ProvinceId,
  type ProvinceRiskView,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { notify, provincesOf, sortedKeys } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { aiOrder } from '../../ai/trace.js';
import { board, modifier, signal } from '../registry.js';
import { addStability, clamp, ds, isRegular, pairKey, round1, stabilityOf } from './state.js';
import { regularEnemies } from './relations.js';

/**
 * Gestion intérieure : politiques choisies par le joueur (ordre `domesticPolicy`, journalisé comme tout
 * ordre), soutien de la population à la guerre, événements intérieurs (grèves, manifestations, émeutes,
 * sabotages de réseaux rebelles). Chiffres : data/balance, section `domestic` (valeurs par défaut
 * ci-dessous). Tirages hachés (sans consommer de PRNG) : l'ajout de ce système ne décale aucun autre tirage.
 */

// ——— Réglages ———

export interface DomesticConfig {
  changeCooldownDays: number;
  policies: Record<DomesticPolicy, DomesticPolicyEffects>;
  warSupport: {
    start: number;
    driftPerDay: number;
    defensiveBonus: number;
    offensivePenalty: number;
    lossPerUnit: number;
    lossCapPerDay: number;
    provinceLost: number;
    lowThreshold: number;
    lowWeariness: number;
    highThreshold: number;
    highWeariness: number;
  };
  events: {
    strikeChance: number;
    moraleThreshold: number;
    strikeHours: number;
    strikeProduction: number;
    protestChance: number;
    stabilityThreshold: number;
    protestStability: number;
    protestUnrest: number;
    sabotageChance: number;
    sabotageUnrest: number;
    sabotageDamage: [number, number];
    riotThreshold: number;
    riotStability: number;
    cooldownDays: number;
  };
  occupiedRisk: number;
  ai: boolean;
}

const NEUTRAL: DomesticPolicyEffects = {
  income: 1,
  production: 1,
  infantry: 1,
  research: 1,
  upkeep: 1,
  stabilityPerDay: 0,
  morale: 0,
  warSupport: 0,
  unrest: 1,
  strikes: 1,
  excludes: [],
};

const P = (e: Partial<DomesticPolicyEffects>): DomesticPolicyEffects => ({ ...NEUTRAL, ...e });

export const DOMESTIC_DEFAULTS: DomesticConfig = {
  changeCooldownDays: 2,
  policies: {
    propaganda: P({ income: 0.98, stabilityPerDay: 0.3, morale: 6, warSupport: 15, unrest: 0.9 }),
    conscription: P({ infantry: 1.5, income: 0.95, upkeep: 0.95, morale: -4, warSupport: -5 }),
    war_economy: P({
      production: 1.25,
      income: 0.95,
      stabilityPerDay: -0.6,
      morale: -5,
      strikes: 1.5,
    }),
    austerity: P({
      income: 1.06,
      upkeep: 0.9,
      stabilityPerDay: -0.4,
      morale: -8,
      unrest: 1.2,
      strikes: 2,
      excludes: ['stimulus'],
    }),
    stimulus: P({
      income: 0.9,
      stabilityPerDay: 0.4,
      morale: 8,
      strikes: 0.5,
      excludes: ['austerity'],
    }),
    martial_law: P({
      income: 0.95,
      research: 0.95,
      stabilityPerDay: 1.2,
      morale: -10,
      warSupport: -10,
      unrest: 0.4,
      strikes: 0.2,
    }),
  },
  warSupport: {
    start: 60,
    driftPerDay: 2,
    defensiveBonus: 15,
    offensivePenalty: 10,
    lossPerUnit: 0.3,
    lossCapPerDay: 5,
    provinceLost: 2,
    lowThreshold: 35,
    lowWeariness: 2,
    highThreshold: 75,
    highWeariness: 0.6,
  },
  events: {
    strikeChance: 0.25,
    moraleThreshold: 55,
    strikeHours: 48,
    strikeProduction: 0.8,
    protestChance: 0.25,
    stabilityThreshold: 50,
    protestStability: 2,
    protestUnrest: 8,
    sabotageChance: 0.2,
    sabotageUnrest: 25,
    sabotageDamage: [0.1, 0.3],
    riotThreshold: 30,
    riotStability: 4,
    cooldownDays: 3,
  },
  occupiedRisk: 25,
  ai: true,
};

const cache = new WeakMap<object, DomesticConfig>();

export function domCfg(state: EngineState): DomesticConfig {
  const bal = state.world.balance;
  let c = cache.get(bal);
  if (c) return c;
  const src = bal.domestic;
  const D = DOMESTIC_DEFAULTS;
  const policies = {} as Record<DomesticPolicy, DomesticPolicyEffects>;
  for (const p of DOMESTIC_POLICIES) {
    const o = src?.policies?.[p];
    policies[p] = o ? { ...D.policies[p], ...o, excludes: [...o.excludes] } : D.policies[p];
  }
  c = {
    changeCooldownDays: src?.changeCooldownDays ?? D.changeCooldownDays,
    policies,
    warSupport: { ...D.warSupport, ...(src?.warSupport ?? {}) },
    events: { ...D.events, ...(src?.events ?? {}) },
    occupiedRisk: src?.occupiedRisk ?? D.occupiedRisk,
    ai: src?.ai ?? D.ai,
  };
  cache.set(bal, c);
  return c;
}

// ——— État (state.mods.diplo.dom, créé à la demande : absent des anciennes sauvegardes) ———

export interface DomEvent {
  id: string;
  t: GameTime;
  k: DomesticEventKind;
  pid: ProvinceId | null;
  title: string;
  text: string;
  sev: 'info' | 'warn' | 'critical';
}

export interface DomNation {
  /** Politiques actives : date d'activation. */
  p: Partial<Record<DomesticPolicy, GameTime>>;
  /** Dernier changement de chaque politique (délai minimal). */
  ch: Partial<Record<DomesticPolicy, GameTime>>;
  /** Soutien à la guerre (absent = valeur de départ). */
  ws?: number;
  /** Dernier événement de chaque type (délai minimal). */
  last: Partial<Record<DomesticEventKind, GameTime>>;
  /** Grève en cours : fin. */
  strike?: GameTime;
  ev: DomEvent[];
  seq: number;
}

const MAX_EVENTS = 12;

function domOf(state: EngineState, n: NationId): DomNation | undefined {
  return ds(state).dom?.[n];
}

function domFor(state: EngineState, n: NationId): DomNation {
  const d = ds(state);
  const all = (d.dom ??= {});
  return (all[n] ??= { p: {}, ch: {}, last: {}, ev: [], seq: 0 });
}

/** Politiques actives d'une nation, dans l'ordre canonique. */
export function activePolicies(state: EngineState, n: NationId): DomesticPolicy[] {
  const dn = domOf(state, n);
  if (!dn) return [];
  return DOMESTIC_POLICIES.filter((p) => dn.p[p] !== undefined);
}

type NumKey = Exclude<keyof DomesticPolicyEffects, 'excludes'>;
const ADDITIVE: ReadonlySet<NumKey> = new Set(['stabilityPerDay', 'morale', 'warSupport']);

/** Effet cumulé des politiques actives (produit des multiplicateurs, somme des effets additifs). */
export function policyTotal(state: EngineState, n: NationId, key: NumKey): number {
  const add = ADDITIVE.has(key);
  let v = add ? 0 : 1;
  const dn = domOf(state, n);
  if (!dn) return v;
  const pol = domCfg(state).policies;
  for (const p of DOMESTIC_POLICIES) {
    if (dn.p[p] === undefined) continue;
    v = add ? v + pol[p][key] : v * pol[p][key];
  }
  return v;
}

/** Contribution des politiques et des grèves aux modificateurs (crochet `modifier` du module). */
export function domesticModifier(state: EngineState, n: NationId, key: string): number {
  const dn = domOf(state, n);
  if (!dn) return 1;
  switch (key) {
    case 'income.money':
      return policyTotal(state, n, 'income');
    case 'production.speed': {
      const strike =
        dn.strike !== undefined && dn.strike > state.time
          ? domCfg(state).events.strikeProduction
          : 1;
      return policyTotal(state, n, 'production') * strike;
    }
    case 'production.speed.infantry':
      return policyTotal(state, n, 'infantry');
    case 'research.speed':
      return policyTotal(state, n, 'research');
    case 'upkeep':
      return policyTotal(state, n, 'upkeep');
    case 'unrest.risk':
      return policyTotal(state, n, 'unrest');
    default:
      return 1;
  }
}

/** Décalage du moral visé des provinces, publié pour le module eco (tableau partagé). */
function syncMoraleShift(state: EngineState, n: NationId): void {
  const b = board(state);
  const shift = round1(policyTotal(state, n, 'morale'));
  if (shift === 0) {
    if (b.moraleShift) delete b.moraleShift[n];
  } else (b.moraleShift ??= {})[n] = shift;
}

// ——— Ordre ———

function fail(error: 'not_allowed' | 'cooldown' | 'invalid_target', message: string): OrderResult {
  return { ok: false, error, message };
}

export function orderDomesticPolicy(
  state: EngineState,
  n: NationId,
  policy: DomesticPolicy,
  on: boolean,
): OrderResult {
  if (!isRegular(state, n)) return fail('not_allowed', 'Nation invalide.');
  const c = domCfg(state);
  if (!c.policies[policy]) return fail('invalid_target', 'Politique inconnue.');
  const dn = domFor(state, n);
  const active = dn.p[policy] !== undefined;
  if (active === on)
    return fail('not_allowed', on ? 'Politique déjà en vigueur.' : 'Politique inactive.');
  const last = dn.ch[policy];
  if (last !== undefined && state.time - last < c.changeCooldownDays * DAY)
    return fail('cooldown', 'Changement trop récent : attendez la fin du délai.');
  if (on) {
    for (const x of c.policies[policy].excludes) {
      if (dn.p[x] === undefined) continue;
      delete dn.p[x];
      dn.ch[x] = state.time;
    }
    dn.p[policy] = state.time;
  } else delete dn.p[policy];
  dn.ch[policy] = state.time;
  syncMoraleShift(state, n);
  signal(state, 'domestic_policy', { nation: n, policy, on });
  return { ok: true };
}

// ——— Soutien à la guerre ———

export function warSupportOf(state: EngineState, n: NationId): number {
  return domOf(state, n)?.ws ?? domCfg(state).warSupport.start;
}

export function warSupportTarget(state: EngineState, n: NationId): number {
  const c = domCfg(state).warSupport;
  let t = c.start + policyTotal(state, n, 'warSupport');
  const enemies = regularEnemies(state, n);
  if (enemies.length > 0) {
    const d = ds(state);
    const defensive = enemies.some((e) => d.aggressor[pairKey(n, e)] !== n);
    t += defensive ? c.defensiveBonus : -c.offensivePenalty;
  }
  return clamp(t);
}

/** Multiplicateur de la lassitude de guerre selon le soutien de la population. */
export function wearinessFactor(state: EngineState, n: NationId): number {
  const c = domCfg(state).warSupport;
  const ws = warSupportOf(state, n);
  if (ws < c.lowThreshold) return c.lowWeariness;
  if (ws > c.highThreshold) return c.highWeariness;
  return 1;
}

/** Tick du soutien à la guerre (avant le tick de stabilité, qui remet à zéro les pertes du jour). */
export function warSupportDaily(state: EngineState): void {
  const c = domCfg(state).warSupport;
  const d = ds(state);
  for (const n of state.nationIds) {
    if (!state.nations[n]!.alive || !isRegular(state, n)) continue;
    const cur = warSupportOf(state, n);
    const target = warSupportTarget(state, n);
    const det = d.stab[n];
    const loss =
      Math.min(c.lossCapPerDay, (det?.lost ?? 0) * c.lossPerUnit) +
      (det?.provLost ?? 0) * c.provinceLost;
    const step = Math.min(c.driftPerDay, Math.abs(target - cur)) * Math.sign(target - cur);
    const next = round1(clamp(cur + step - loss));
    const dn = domOf(state, n);
    if (next === c.start) {
      if (dn) delete dn.ws;
    } else domFor(state, n).ws = next;
  }
}

// ——— Risque de troubles ———

/** Moral moyen d'une nation (publié par eco ; absent = moral de départ). */
export function moraleOf(state: EngineState, n: NationId): number {
  return board(state).moraleAvg?.[n] ?? state.world.balance.morale?.start ?? 70;
}

/** Facteur de risque (politiques × renseignement intérieur). Lecture seule. */
export function unrestFactor(state: EngineState, n: NationId): number {
  return modifier(state, n, 'unrest.risk');
}

/** Risque de troubles d'une province (0..100), sans le facteur national. */
function baseRisk(state: EngineState, pid: ProvinceId, owner: NationId, stab: number): number {
  const c = domCfg(state);
  const d = ds(state);
  const w = wi(state.world);
  const occupied = w.provById.get(pid)?.nationId !== owner;
  const s = Math.max(0, 60 - stab) * 0.8;
  return (d.unrest[pid] ?? 0) + (occupied ? c.occupiedRisk : 0) + s;
}

export function provinceRisks(
  state: EngineState,
  n: NationId,
  factor = unrestFactor(state, n),
): ProvinceRiskView[] {
  const d = ds(state);
  const w = wi(state.world);
  const stab = stabilityOf(state, n);
  const prot = board(state).protectedSites ?? {};
  const out: ProvinceRiskView[] = [];
  for (const pid of provincesOf(state, n)) {
    const risk = Math.round(clamp(baseRisk(state, pid, n, stab) * factor));
    const v: ProvinceRiskView = {
      id: pid,
      risk,
      unrest: Math.round(d.unrest[pid] ?? 0),
      occupied: w.provById.get(pid)?.nationId !== n,
    };
    if (prot[pid] === n) v.protected = true;
    out.push(v);
  }
  return out.sort((a, b) => b.risk - a.risk || (a.id < b.id ? -1 : 1));
}

// ——— Événements intérieurs ———

/** Tirage haché [0, 1) : déterministe, ne consomme aucun PRNG. */
function draw(state: EngineState, ...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = `${state.time}|${ds(state).rng[0]}|${parts.join('|')}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function ready(state: EngineState, n: NationId, k: DomesticEventKind): boolean {
  const last = domOf(state, n)?.last[k];
  return last === undefined || state.time - last >= domCfg(state).events.cooldownDays * DAY;
}

function provName(state: EngineState, pid: ProvinceId | null): string {
  return pid ? (wi(state.world).provById.get(pid)?.name ?? pid) : '';
}

function record(
  state: EngineState,
  n: NationId,
  k: DomesticEventKind,
  pid: ProvinceId | null,
  title: string,
  text: string,
  sev: DomEvent['sev'],
): void {
  const dn = domFor(state, n);
  dn.last[k] = state.time;
  dn.seq++;
  dn.ev.push({ id: `d${dn.seq}`, t: state.time, k, pid, title, text, sev });
  if (dn.ev.length > MAX_EVENTS) dn.ev.splice(0, dn.ev.length - MAX_EVENTS);
  const w = wi(state.world);
  const at = pid ? (w.provById.get(pid)?.cityPoint ?? null) : null;
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at: at ? [at[0], at[1]] : null,
      category: 'domestic',
      title,
      text,
      severity: sev,
    },
    [n],
  );
  signal(state, 'domestic_event', { nation: n, kind: k, pid });
}

const SABOTAGE_PREF = [
  'arms_factory',
  'refinery',
  'power_plant',
  'electronics_plant',
  'port',
  'military_base',
  'air_base',
] as const;

function nationEvents(state: EngineState, n: NationId): void {
  const c = domCfg(state).events;
  const d = ds(state);
  const provs = provincesOf(state, n);
  if (provs.length === 0) return;
  const stab = stabilityOf(state, n);
  const morale = moraleOf(state, n);
  const strikeBase =
    morale < c.moraleThreshold
      ? c.strikeChance * ((c.moraleThreshold - morale) / c.moraleThreshold)
      : 0;
  const protestBase =
    stab < c.stabilityThreshold
      ? c.protestChance * ((c.stabilityThreshold - stab) / Math.max(1, c.stabilityThreshold))
      : 0;
  let hot: ProvinceId | null = null;
  for (const p of provs) if ((d.unrest[p] ?? 0) > (hot ? (d.unrest[hot] ?? 0) : 0)) hot = p;
  const hotUnrest = hot ? (d.unrest[hot] ?? 0) : 0;
  const sabotageBase = hotUnrest >= c.sabotageUnrest ? c.sabotageChance * (hotUnrest / 100) : 0;
  if (strikeBase <= 0 && protestBase <= 0 && sabotageBase <= 0) return;
  // Facteurs (renseignement intérieur compris) calculés seulement si un événement est possible.
  const factor = unrestFactor(state, n);
  const strikes = policyTotal(state, n, 'strikes');

  if (
    strikeBase > 0 &&
    ready(state, n, 'strike') &&
    draw(state, n, 'strike') < strikeBase * strikes
  ) {
    const dn = domFor(state, n);
    dn.strike = state.time + c.strikeHours * HOUR;
    const pid = hot ?? provs[Math.floor(draw(state, n, 'strike-p') * provs.length)]!;
    record(
      state,
      n,
      'strike',
      pid,
      'Grève générale',
      `Mouvement de grève parti de ${provName(state, pid)} : production ralentie de ${Math.round((1 - c.strikeProduction) * 100)} % pendant ${c.strikeHours} h.`,
      'warn',
    );
  }
  if (
    protestBase > 0 &&
    ready(state, n, 'protest') &&
    draw(state, n, 'protest') < protestBase * factor
  ) {
    const pid = hot ?? provs[Math.floor(draw(state, n, 'protest-p') * provs.length)]!;
    d.unrest[pid] = round1(clamp((d.unrest[pid] ?? 0) + c.protestUnrest));
    if (stab < c.riotThreshold && ready(state, n, 'riot')) {
      addStability(state, n, -(c.protestStability + c.riotStability), 'Émeutes');
      domFor(state, n).last.protest = state.time;
      record(
        state,
        n,
        'riot',
        pid,
        'Émeutes',
        `Les manifestations de ${provName(state, pid)} dégénèrent en émeutes. Stabilité −${c.protestStability + c.riotStability}.`,
        'critical',
      );
    } else {
      addStability(state, n, -c.protestStability, 'Manifestations');
      record(
        state,
        n,
        'protest',
        pid,
        'Manifestations',
        `Manifestations contre le gouvernement à ${provName(state, pid)}. Stabilité −${c.protestStability}.`,
        'warn',
      );
    }
  }
  if (hot && sabotageBase > 0 && ready(state, n, 'sabotage')) {
    let p = sabotageBase * factor;
    if (board(state).protectedSites?.[hot] === n) p *= modifier(state, n, 'site.protection');
    if (draw(state, n, 'sabotage') < p) {
      const bs = wi(state.world).provById.get(hot)?.buildings ?? [];
      const building = SABOTAGE_PREF.find((b) => bs.includes(b)) ?? bs[0];
      if (building) {
        const [lo, hi] = c.sabotageDamage;
        const damage = Math.round((lo + draw(state, n, 'sabotage-d') * (hi - lo)) * 100) / 100;
        signal(state, 'sabotage', { victim: n, pid: hot, building, damage, domestic: true });
        record(
          state,
          n,
          'sabotage',
          hot,
          'Sabotage intérieur',
          `Réseau rebelle actif à ${provName(state, hot)} : installation endommagée à ${Math.round(damage * 100)} %.`,
          'critical',
        );
      }
    }
  }
}

/** Politiques simples de l'IA : effort de guerre en guerre, loi martiale en crise. */
function aiPolicies(state: EngineState, n: NationId): void {
  const ns = state.nations[n]!;
  if (!ns.isAi || !ns.active || ns.isPlayer) return;
  const stab = stabilityOf(state, n);
  const atWar = regularEnemies(state, n).length > 0;
  const has = (p: DomesticPolicy) => domOf(state, n)?.p[p] !== undefined;
  const set = (p: DomesticPolicy, on: boolean) => {
    if (has(p) === on) return;
    const last = domOf(state, n)?.ch[p];
    if (last !== undefined && state.time - last < domCfg(state).changeCooldownDays * DAY) return;
    aiOrder(state, n, { kind: 'domesticPolicy', policy: p, on });
  };
  if (atWar && stab >= 55) set('war_economy', true);
  else if (!atWar || stab < 40) set('war_economy', false);
  if (stab < 25) set('martial_law', true);
  else if (stab > 50) set('martial_law', false);
}

/** Tick journalier : effets des politiques sur la stabilité, événements intérieurs, IA. */
export function domesticDaily(state: EngineState): void {
  const c = domCfg(state);
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive || !isRegular(state, n)) continue;
    const dn = domOf(state, n);
    if (dn) {
      const delta = policyTotal(state, n, 'stabilityPerDay');
      if (delta !== 0) addStability(state, n, round1(delta), 'Politiques intérieures');
      if (dn.strike !== undefined && dn.strike <= state.time) delete dn.strike;
    }
    nationEvents(state, n);
    if (c.ai) aiPolicies(state, n);
  }
}

// ——— Vue ———

export function domesticView(state: EngineState, n: NationId): DomesticView | null {
  if (!isRegular(state, n)) return null;
  const c = domCfg(state);
  const dn = domOf(state, n);
  const factor = round2(unrestFactor(state, n));
  const risks = provinceRisks(state, n, factor);
  let national = 0;
  const top = risks.slice(0, 5);
  for (const r of top) national += r.risk;
  national = top.length ? Math.round(national / top.length) : 0;
  return {
    policies: DOMESTIC_POLICIES.map((id) => {
      const since = dn?.p[id];
      const ch = dn?.ch[id];
      return {
        id,
        active: since !== undefined,
        since: since ?? null,
        changeableAt: ch !== undefined ? ch + c.changeCooldownDays * DAY : 0,
        effects: { ...c.policies[id], excludes: [...c.policies[id].excludes] },
      };
    }),
    stability: stabilityOf(state, n),
    morale: round1(moraleOf(state, n)),
    warSupport: warSupportOf(state, n),
    warSupportTarget: round1(warSupportTarget(state, n)),
    wearinessFactor: wearinessFactor(state, n),
    unrestRisk: national,
    unrestFactor: factor,
    strikeUntil: dn?.strike !== undefined && dn.strike > state.time ? dn.strike : null,
    provinces: risks.slice(0, 15),
    events: (dn?.ev ?? [])
      .slice()
      .reverse()
      .map((e) => ({
        id: e.id,
        time: e.t,
        kind: e.k,
        provinceId: e.pid,
        title: e.title,
        text: e.text,
        severity: e.sev,
      })),
    totals: {
      income: round2(policyTotal(state, n, 'income')),
      production: round2(policyTotal(state, n, 'production')),
      research: round2(policyTotal(state, n, 'research')),
      upkeep: round2(policyTotal(state, n, 'upkeep')),
      stabilityPerDay: round2(policyTotal(state, n, 'stabilityPerDay')),
      morale: round1(policyTotal(state, n, 'morale')),
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Nettoyage à la désérialisation (sauvegardes antérieures : rien à faire, champs optionnels). */
export function domesticRebuild(state: EngineState): void {
  const d = ds(state);
  if (!d.dom) return;
  for (const n of sortedKeys(d.dom)) {
    const dn = d.dom[n]!;
    dn.p ??= {};
    dn.ch ??= {};
    dn.last ??= {};
    dn.ev ??= [];
    dn.seq ??= 0;
  }
}
