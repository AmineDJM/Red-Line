import {
  INTERIOR_FOCUS,
  type BuildingType,
  type InteriorFocus,
  type InteriorIntelView,
  type IntelOpKind,
  type NationId,
  type ProvinceId,
  type ProvinceThreatView,
  type ThreatGrade,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, provincesOf, sortedKeys } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier } from '../registry.js';
import { ds as diploState } from '../diplo/state.js';
import { cfg, clamp } from './config.js';
import { budgetFactor, hash01, quality } from './levels.js';
import { publish } from './reports.js';
import { ist, nat, type StoredOp } from './state.js';
import { natDe, natLe, provinceName } from './text.js';

/**
 * Renseignement intérieur (sécurité intérieure) : priorité du département (ordre `interiorFocus`),
 * protection des sites sensibles (ordre `protectSite`), détection des opérations étrangères en
 * préparation (alertes), menace par province, surveillance des troubles et des réseaux rebelles.
 * Effets mesurables, calculés à partir du niveau et du budget du département et de sa priorité.
 * Tirages hachés (sans PRNG) pour les détections : aucun autre tirage n'est décalé.
 */

// ——— Réglages (balance.intel.interior) ———

export interface FocusEffects {
  agentDetect: number;
  opDetect: number;
  protection: number;
  unrest: number;
}

export interface InteriorConfig {
  focus: Record<InteriorFocus, FocusEffects>;
  opDetectBase: number;
  opDetectMax: number;
  foilFactor: number;
  detectedExposure: number;
  protectionMax: number;
  protectedBase: number;
  protectedPerLevel: number;
  protectionFocusBonus: number;
  unrestReductionMax: number;
  threatDecay: number;
  threatWeights: Record<string, number>;
}

export const INTERIOR_DEFAULTS: InteriorConfig = {
  focus: {
    balanced: { agentDetect: 1, opDetect: 1, protection: 1, unrest: 1 },
    counterintel: { agentDetect: 1.8, opDetect: 1.5, protection: 0.8, unrest: 0.6 },
    protection: { agentDetect: 0.8, opDetect: 1.2, protection: 1.6, unrest: 0.8 },
    surveillance: { agentDetect: 0.9, opDetect: 0.8, protection: 0.9, unrest: 1.8 },
  },
  opDetectBase: 0.25,
  opDetectMax: 0.85,
  foilFactor: 0.5,
  detectedExposure: 1.5,
  protectionMax: 0.6,
  protectedBase: 1,
  protectedPerLevel: 1,
  protectionFocusBonus: 2,
  unrestReductionMax: 0.4,
  threatDecay: 0.85,
  threatWeights: {
    sabotage: 30,
    rebels: 25,
    cyber: 10,
    domestic: 15,
    alert: 20,
    agent: 15,
    sensitive: 8,
    border: 15,
    capital: 10,
  },
};

const cache = new WeakMap<object, InteriorConfig>();

export function icfg(state: EngineState): InteriorConfig {
  const bal = state.world.balance;
  let c = cache.get(bal);
  if (c) return c;
  const src = bal.intel?.interior;
  const D = INTERIOR_DEFAULTS;
  const focus = {} as Record<InteriorFocus, FocusEffects>;
  for (const f of INTERIOR_FOCUS) focus[f] = { ...D.focus[f], ...(src?.focus?.[f] ?? {}) };
  c = {
    focus,
    opDetectBase: src?.opDetectBase ?? D.opDetectBase,
    opDetectMax: src?.opDetectMax ?? D.opDetectMax,
    foilFactor: src?.foilFactor ?? D.foilFactor,
    detectedExposure: src?.detectedExposure ?? D.detectedExposure,
    protectionMax: src?.protectionMax ?? D.protectionMax,
    protectedBase: src?.protectedBase ?? D.protectedBase,
    protectedPerLevel: src?.protectedPerLevel ?? D.protectedPerLevel,
    protectionFocusBonus: src?.protectionFocusBonus ?? D.protectionFocusBonus,
    unrestReductionMax: src?.unrestReductionMax ?? D.unrestReductionMax,
    threatDecay: src?.threatDecay ?? D.threatDecay,
    threatWeights: { ...D.threatWeights, ...(src?.threatWeights ?? {}) },
  };
  cache.set(bal, c);
  return c;
}

// ——— État (NationIntel.int, créé à la demande) ———

export interface InteriorState {
  focus: InteriorFocus;
  /** Sites sensibles protégés (provinces). */
  protect: ProvinceId[];
  /** Opérations étrangères déjouées / alertes émises (totaux). */
  foiled: number;
  alerts: number;
  /** Mémoire des incidents par province (menace), décroissante. */
  inc: Record<ProvinceId, number>;
}

function intOf(state: EngineState, n: NationId): InteriorState | undefined {
  return ist(state)?.nations[n]?.int;
}

function intFor(state: EngineState, n: NationId): InteriorState {
  const ni = nat(state, n);
  return (ni.int ??= { focus: 'balanced', protect: [], foiled: 0, alerts: 0, inc: {} });
}

export function focusOf(state: EngineState, n: NationId): InteriorFocus {
  return intOf(state, n)?.focus ?? 'balanced';
}

function focusFx(state: EngineState, n: NationId): FocusEffects {
  return icfg(state).focus[focusOf(state, n)];
}

/**
 * Niveau du département intérieur sans relire la vue d'eco (portes de recherche connues du module :
 * ORBAT de départ et signaux) : rapide, appelé par les crochets de modificateurs.
 */
function levelFast(state: EngineState, n: NationId): number {
  const st = ist(state);
  const done = new Set<string>(st.gates[n] ?? []);
  for (const r of state.world.orbats?.get(st.orbatSet)?.get(n)?.research ?? []) done.add(r);
  let tiers = 0;
  for (let i = 1; i <= 3; i++) if (done.has(`research.intel.interior${i}`)) tiers++;
  const m = modifier(state, n, 'intel.interior.level');
  const bonus = m > 1 ? Math.round(m - 1) : 0;
  return 1 + Math.max(tiers, bonus);
}

/** Qualité du renseignement intérieur 0..1 (niveau et budget). */
export function interiorQuality(state: EngineState, n: NationId): number {
  return quality(state, n, 'interior', levelFast(state, n));
}

export function maxProtected(state: EngineState, n: NationId): number {
  const c = icfg(state);
  return (
    c.protectedBase +
    c.protectedPerLevel * levelFast(state, n) +
    (focusOf(state, n) === 'protection' ? c.protectionFocusBonus : 0)
  );
}

/** Réduction de la réussite adverse sur un site protégé (0..1). */
export function protectionOf(state: EngineState, n: NationId): number {
  const c = icfg(state);
  return clamp(c.protectionMax * interiorQuality(state, n) * focusFx(state, n).protection, 0, 0.9);
}

/** Réduction du risque de troubles (0..1). */
export function unrestReduction(state: EngineState, n: NationId): number {
  const c = icfg(state);
  return clamp(c.unrestReductionMax * interiorQuality(state, n) * focusFx(state, n).unrest, 0, 0.8);
}

/** Chance de détecter une opération étrangère en préparation (0..1). */
export function opDetectChance(state: EngineState, n: NationId, pid?: ProvinceId): number {
  const c = icfg(state);
  let p = c.opDetectBase * (0.4 + interiorQuality(state, n)) * focusFx(state, n).opDetect;
  if (pid && board(state).protectedSites?.[pid] === n) p *= 1.5;
  return clamp(p, 0, c.opDetectMax);
}

/** Multiplicateur de la chance de démasquer un agent (priorité du département hôte). */
export function agentDetectFactor(state: EngineState, host: NationId): number {
  return focusFx(state, host).agentDetect;
}

/** Crochet `modifier` du module : risque de troubles et protection des sites. */
export function interiorModifier(state: EngineState, n: NationId, key: string): number {
  if (key === 'unrest.risk') return 1 - unrestReduction(state, n);
  if (key === 'site.protection') return 1 - protectionOf(state, n);
  return 1;
}

// ——— Ordres ———

function fail(error: 'invalid_target' | 'capacity' | 'not_allowed', message: string): OrderResult {
  return { ok: false, error, message };
}

export function orderInteriorFocus(
  state: EngineState,
  n: NationId,
  focus: InteriorFocus,
): OrderResult {
  if (!state.nations[n]?.alive) return fail('not_allowed', 'Nation vaincue.');
  if (!INTERIOR_FOCUS.includes(focus)) return fail('invalid_target', 'Priorité inconnue.');
  const it = intFor(state, n);
  it.focus = focus;
  // Moins de sites protégeables hors priorité « protection » : les plus anciens restent.
  const max = maxProtected(state, n);
  if (it.protect.length > max) {
    for (const pid of it.protect.slice(max)) unprotect(state, n, pid);
    it.protect = it.protect.slice(0, max);
  }
  return { ok: true };
}

function unprotect(state: EngineState, n: NationId, pid: ProvinceId): void {
  const ps = board(state).protectedSites;
  if (ps?.[pid] === n) delete ps[pid];
  if (ps && Object.keys(ps).length === 0) delete board(state).protectedSites;
}

export function orderProtectSite(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  on: boolean,
): OrderResult {
  if (!state.nations[n]?.alive) return fail('not_allowed', 'Nation vaincue.');
  if (state.provinces[pid]?.owner !== n)
    return fail('invalid_target', 'Cette province ne vous appartient pas.');
  const it = intFor(state, n);
  const has = it.protect.includes(pid);
  if (on) {
    if (has) return fail('not_allowed', 'Site déjà protégé.');
    if (it.protect.length >= maxProtected(state, n))
      return fail('capacity', 'Nombre maximal de sites protégés atteint.');
    it.protect.push(pid);
    (board(state).protectedSites ??= {})[pid] = n;
  } else {
    if (!has) return fail('not_allowed', "Ce site n'est pas protégé.");
    it.protect = it.protect.filter((p) => p !== pid);
    unprotect(state, n, pid);
  }
  return { ok: true };
}

/** Province perdue : sa protection tombe. */
export function interiorOnCapture(state: EngineState, pid: ProvinceId, from: NationId): void {
  const it = intOf(state, from);
  if (!it) return;
  if (it.protect.includes(pid)) {
    it.protect = it.protect.filter((p) => p !== pid);
    unprotect(state, from, pid);
  }
  delete it.inc[pid];
}

// ——— Incidents et menace ———

export function addIncident(
  state: EngineState,
  n: NationId,
  pid: ProvinceId | null | undefined,
  kind: string,
): void {
  if (!pid || state.provinces[pid]?.owner !== n || !state.nations[n]?.alive) return;
  const w = icfg(state).threatWeights[kind] ?? 0;
  if (w <= 0) return;
  const it = intFor(state, n);
  it.inc[pid] = Math.round(clamp((it.inc[pid] ?? 0) + w, 0, 100) * 10) / 10;
}

const SENSITIVE: ReadonlySet<BuildingType> = new Set<BuildingType>([
  'arms_factory',
  'research_center',
  'secret_lab',
  'missile_silo',
  'refinery',
  'power_plant',
  'electronics_plant',
  'air_base',
  'naval_base',
  'military_base',
]);

function provinceBuildings(state: EngineState, pid: ProvinceId): BuildingType[] {
  const out = new Set<BuildingType>(wi(state.world).provById.get(pid)?.buildings ?? []);
  for (const b of board(state).extraBuildings?.[pid] ?? []) out.add(b);
  return [...out];
}

function gradeOf(level: number): ThreatGrade {
  if (level >= 75) return 'critical';
  if (level >= 50) return 'high';
  if (level >= 25) return 'moderate';
  return 'low';
}

/** Menace par province (provinces de la nation, menace décroissante). Lecture seule. */
export function provinceThreats(state: EngineState, n: NationId): ProvinceThreatView[] {
  const c = icfg(state);
  const W = c.threatWeights;
  const w = wi(state.world);
  const it = intOf(state, n);
  const unrest = state.mods.diplo ? diploState(state).unrest : {};
  const capital = w.nationById.get(n)?.capitalProvinceId;
  const out: ProvinceThreatView[] = [];
  for (const pid of provincesOf(state, n)) {
    const factors: string[] = [];
    let v = 0;
    const inc = it?.inc[pid] ?? 0;
    if (inc >= 1) {
      v += inc;
      factors.push('Incidents récents');
    }
    const u = unrest[pid] ?? 0;
    if (u >= 5) {
      v += u * 0.5;
      factors.push('Agitation');
    }
    const sens = provinceBuildings(state, pid).filter((b) => SENSITIVE.has(b));
    if (sens.length) {
      v += Math.min(3, sens.length) * (W.sensitive ?? 0);
      factors.push(`Sites sensibles (${sens.length})`);
    }
    const def = w.provById.get(pid)!;
    const front = def.neighbors.some((q) => {
      const o = state.provinces[q]?.owner;
      return !!o && o !== n && atWar(state, n, o);
    });
    if (front) {
      v += W.border ?? 0;
      factors.push('Frontière ennemie');
    }
    if (pid === capital) {
      v += W.capital ?? 0;
      factors.push('Capitale');
    }
    const prot = board(state).protectedSites?.[pid] === n;
    if (v <= 0) continue;
    const level = Math.round(clamp(v, 0, 100));
    out.push({ provinceId: pid, level, grade: gradeOf(level), factors, protected: prot });
  }
  return out.sort((a, b) => b.level - a.level || (a.provinceId < b.provinceId ? -1 : 1));
}

// ——— Opérations étrangères : détection, protection, échec ———

/** Opérations dont la préparation peut être repérée par la sécurité intérieure de la cible. */
const WATCHED: ReadonlySet<IntelOpKind> = new Set([
  'infiltrate_spy',
  'recruit_source',
  'steal_research',
  'sabotage_factory',
  'fund_rebels',
  'cyber_radar',
  'cyber_production',
  'cyber_orders',
  'disinformation',
  'leak_plans',
  'plant_fake_report',
  'recon_economic',
]);

/** Opérations dont la réussite baisse sur un site protégé. */
const PROTECTED_OPS: ReadonlySet<IntelOpKind> = new Set([
  'sabotage_factory',
  'fund_rebels',
  'recon_economic',
  'recon_military',
]);

const ALERT_LINE: Partial<Record<IntelOpKind, (state: EngineState, op: StoredOp) => string>> = {
  sabotage_factory: (s, op) =>
    `Préparatifs de sabotage repérés autour des installations de ${provinceName(s, op.target.provinceId!)}.`,
  fund_rebels: (s, op) =>
    `Transferts de fonds vers des groupes armés en préparation en ${provinceName(s, op.target.provinceId!)}.`,
  steal_research: () => 'Tentatives d’approche de chercheurs de nos programmes sensibles.',
  cyber_radar: () => 'Reconnaissance informatique de notre réseau radar.',
  cyber_production: () => 'Reconnaissance informatique de nos chaînes de production.',
  cyber_orders: () => 'Reconnaissance informatique de nos réseaux de commandement.',
  disinformation: () => 'Campagne de désinformation en préparation (comptes et relais identifiés).',
  leak_plans: () => 'Approches suspectes de personnels ayant accès à des documents classifiés.',
  plant_fake_report: () => 'Tentative d’intoxication de nos circuits de renseignement.',
  infiltrate_spy: () => 'Officier de renseignement étranger signalé à nos frontières.',
  recruit_source: () => 'Tentatives de recrutement de sources dans notre administration.',
  recon_economic: () => 'Repérages d’agents étrangers autour de nos installations économiques.',
};

/** Lancement d'une opération étrangère : la sécurité intérieure de la cible peut la repérer (alerte). */
export function watchOp(state: EngineState, by: NationId, op: StoredOp): void {
  const v = op.victim;
  if (!v || v === by || !WATCHED.has(op.kind) || !state.nations[v]?.alive) return;
  const pid = op.target.provinceId;
  const p = opDetectChance(state, v, pid);
  if (hash01('detect', op.id, by, v, op.startedAt) >= p) return;
  op.dt = 1;
  const it = intFor(state, v);
  it.alerts++;
  addIncident(state, v, pid ?? capitalOf(state, v), 'alert');
  if (!state.nations[v]!.isPlayer) return;
  const q = interiorQuality(state, v);
  const known = hash01('attrib', op.id, v) < 0.5 * q + 0.1;
  const at = pid ? cityOf(state, pid) : null;
  publish(state, v, {
    dept: 'interior',
    source: op.kind.startsWith('cyber') ? 'sigint' : 'humint',
    kind: 'flash',
    title:
      op.kind === 'sabotage_factory'
        ? 'ALERTE — Sabotage en préparation'
        : 'ALERTE — Opération étrangère en préparation',
    lines: [
      ALERT_LINE[op.kind]?.(state, op) ?? 'Activité de service étranger repérée.',
      known ? `Commanditaire présumé : ${natLe(state, by)}.` : 'Commanditaire non identifié.',
      pid
        ? 'Mesures de protection renforcées : chances de réussite adverses réduites.'
        : 'Surveillance renforcée : chances de réussite adverses réduites.',
    ],
    at,
    radiusKm: at ? 30 : 0,
    subject: { ...(known ? { nationId: by } : {}), ...(pid ? { provinceId: pid } : {}) },
    actions: pid ? [{ kind: 'open_province', provinceId: pid }] : [],
    q: Math.max(0.5, q),
    share: false,
  });
}

/** Multiplicateur de réussite au dénouement : opération repérée, site protégé. */
export function successFactor(state: EngineState, op: StoredOp): number {
  let f = 1;
  if (op.dt) f *= 1 - icfg(state).foilFactor;
  const v = op.victim;
  const pid = op.target.provinceId;
  if (v && pid && PROTECTED_OPS.has(op.kind) && board(state).protectedSites?.[pid] === v)
    f *= 1 - protectionOf(state, v);
  return f;
}

/** Multiplicateur du risque d'être démasquée (opération repérée). */
export function exposureFactor(state: EngineState, op: StoredOp): number {
  return op.dt ? icfg(state).detectedExposure : 1;
}

/** Échec d'une opération repérée ou visant un site protégé : la cible le sait. */
export function onForeignFailed(state: EngineState, by: NationId, op: StoredOp): void {
  const v = op.victim;
  if (!v || !state.nations[v]?.alive) return;
  const pid = op.target.provinceId;
  const guarded = !!pid && board(state).protectedSites?.[pid] === v;
  if (!op.dt && !guarded) return;
  intFor(state, v).foiled++;
  if (!state.nations[v]!.isPlayer) return;
  const at = pid ? cityOf(state, pid) : null;
  publish(state, v, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: 'Opération étrangère déjouée',
    lines: [
      pid
        ? `Opération adverse visant ${provinceName(state, pid)} mise en échec${guarded ? ' (site protégé)' : ''}.`
        : 'Opération adverse mise en échec par nos services.',
      op.dt ? `Préparatifs repérés en amont ; service ${natDe(state, by)} soupçonné.` : '',
    ].filter(Boolean),
    at,
    radiusKm: at ? 20 : 0,
    subject: { ...(op.dt ? { nationId: by } : {}), ...(pid ? { provinceId: pid } : {}) },
    actions: pid ? [{ kind: 'open_province', provinceId: pid }] : [],
    q: Math.max(0.6, interiorQuality(state, v)),
    share: false,
  });
}

function cityOf(state: EngineState, pid: ProvinceId): [number, number] | null {
  const p = wi(state.world).provById.get(pid)?.cityPoint;
  return p ? [p[0], p[1]] : null;
}

function capitalOf(state: EngineState, n: NationId): ProvinceId | null {
  return wi(state.world).nationById.get(n)?.capitalProvinceId ?? null;
}

// ——— Tick journalier ———

/** Décroissance de la menace ; surveillance des réseaux rebelles (joueurs). */
export function interiorDaily(state: EngineState): void {
  const st = ist(state);
  const c = icfg(state);
  for (const n of sortedKeys(st.nations)) {
    const it = st.nations[n]!.int;
    if (!it) continue;
    for (const pid of sortedKeys(it.inc)) {
      const v = Math.round(it.inc[pid]! * c.threatDecay * 10) / 10;
      if (v < 1 || state.provinces[pid]?.owner !== n) delete it.inc[pid];
      else it.inc[pid] = v;
    }
  }
  if (!state.mods.diplo) return;
  const unrest = diploState(state).unrest;
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive || !ns.isPlayer) continue;
    let hot: ProvinceId | null = null;
    for (const pid of provincesOf(state, n))
      if ((unrest[pid] ?? 0) >= 20 && (!hot || (unrest[pid] ?? 0) > (unrest[hot] ?? 0))) hot = pid;
    if (!hot) continue;
    const q = interiorQuality(state, n);
    const ni = nat(state, n);
    const key = `rebels:${hot}`;
    const last = ni.flash[key];
    if (last !== undefined && state.time - last < 3 * 86_400_000) continue;
    // Détection selon la qualité et la priorité « surveillance ».
    if (hash01('surv', n, hot, state.time) >= clamp(q * focusFx(state, n).unrest, 0, 0.95))
      continue;
    ni.flash[key] = state.time;
    const red = Math.round(unrestReduction(state, n) * 100);
    publish(state, n, {
      dept: 'interior',
      source: 'humint',
      kind: 'counterintel',
      title: `Réseaux rebelles — ${provinceName(state, hot)}`,
      lines: [
        `Agitation élevée en ${provinceName(state, hot)} (${Math.round(unrest[hot] ?? 0)}/100) : cellules armées en formation.`,
        `Surveillance en cours : risque de troubles réduit de ${red} %. Protection du site ou loi martiale à envisager.`,
      ],
      at: cityOf(state, hot),
      radiusKm: 40,
      subject: { provinceId: hot },
      actions: [{ kind: 'open_province', provinceId: hot }],
      q,
      share: false,
    });
  }
}

// ——— Vue ———

export function interiorView(state: EngineState, n: NationId): InteriorIntelView {
  const it = intOf(state, n);
  const st = ist(state);
  const threats = provinceThreats(state, n);
  const top = threats.slice(0, 5);
  let caught = 0;
  let doubles = 0;
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.host !== n || a.caughtAt === undefined) continue;
    caught++;
    if (a.state === 'double') doubles++;
  }
  const c = cfg(state);
  const q = interiorQuality(state, n);
  const agentDetect = clamp(
    c.agentDetectPerDay *
      (0.5 + 0.5 * levelFast(state, n)) *
      (0.5 + budgetFactor(state, n, 'interior')) *
      agentDetectFactor(state, n),
    0,
    0.9,
  );
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    focus: it?.focus ?? 'balanced',
    protected: [...(it?.protect ?? [])],
    maxProtected: maxProtected(state, n),
    metrics: {
      quality: r3(q),
      agentDetectPerDay: r3(agentDetect),
      opDetect: r3(opDetectChance(state, n)),
      protection: r3(protectionOf(state, n)),
      unrestReduction: r3(unrestReduction(state, n)),
    },
    threatLevel: top.length ? Math.round(top.reduce((s, t) => s + t.level, 0) / top.length) : 0,
    threats: threats.slice(0, 12).map((t) => ({ ...t, factors: [...t.factors] })),
    stats: { foiled: it?.foiled ?? 0, alerts: it?.alerts ?? 0, caught, doubles },
  };
}
