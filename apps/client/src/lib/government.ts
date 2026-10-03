/**
 * Gouvernement : logique sans rendu (testée dans test/government.test.ts) — postes et missions par
 * ministère et par section, brouillon de l'assistant « Nouvelle mission » (cible, zone, objectif,
 * enveloppe), estimation des coûts avant validation d'après la vue du joueur et les données du jeu,
 * lecture des commandements du centre de commandement s'il les expose, rendu du journal.
 */
import {
  distanceKm,
  type Balance,
  type GovBudget,
  type GovGroup,
  type GovMinistry,
  type GovMissionDef,
  type GovMissionInput,
  type GovMissionStatus,
  type GovMissionView,
  type GovOffice,
  type GovOfficeView,
  type GovernmentView,
  type LocParam,
  type LocText,
  type NationId,
  type PlayerView,
  type ProvinceDef,
  type ResearchNode,
  type WeaponSystem,
} from '@redline/shared';
import type { IconName, Tone } from '@redline/ui';

export type DefenseSection = 'commands' | 'infra' | 'armament' | 'intel';
export const DEFENSE_SECTIONS: DefenseSection[] = ['commands', 'infra', 'armament', 'intel'];

/** Postes d'un ministère (ordre des données). */
export function officesOf(gv: GovernmentView, ministry: GovMinistry): GovOfficeView[] {
  return gv.offices.filter((o) => o.ministry === ministry);
}

/** Postes d'une section (infrastructures, armement, renseignement, économie). */
export function officesIn(gv: GovernmentView, group: GovGroup): GovOfficeView[] {
  return gv.offices.filter((o) => o.group === group);
}

export function officeById(gv: GovernmentView, id: GovOffice): GovOfficeView | undefined {
  return gv.offices.find((o) => o.id === id);
}

/** Missions en cours d'un poste : priorité décroissante, puis ancienneté. */
export function missionsOf(gv: GovernmentView, office: GovOffice): GovMissionView[] {
  return gv.missions
    .filter((m) => m.office === office)
    .sort((a, b) => b.priority - a.priority || a.since - b.since || (a.id < b.id ? -1 : 1));
}

/** Types de mission d'un poste, dans l'ordre des données. */
export function missionTypes(gv: GovernmentView, office: GovOffice): [string, GovMissionDef][] {
  return Object.entries(gv.missionDefs)
    .filter(([, d]) => d.office === office)
    .sort((a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1));
}

export const STATUS_TONE: Record<GovMissionStatus, Tone> = {
  active: 'green',
  waiting: 'cyan',
  blocked: 'amber',
  suspended: 'neutral',
  done: 'green',
};

/** Missions qui demandent l'attention (bloquées) d'un ensemble de postes. */
export function blockedCount(gv: GovernmentView | undefined, offices?: GovOffice[]): number {
  if (!gv) return 0;
  return gv.missions.filter(
    (m) => m.status === 'blocked' && (!offices || offices.includes(m.office)),
  ).length;
}

/** Postes vacants qui ont des missions (rien n'avance sans titulaire). */
export function vacantWithMissions(gv: GovernmentView): GovOffice[] {
  return gv.offices
    .filter((o) => !o.head && gv.missions.some((m) => m.office === o.id))
    .map((o) => o.id);
}

/** Dépensé et plafond d'une enveloppe (null : part des revenus sans plafond). */
export function budgetUsage(m: Pick<GovMissionView, 'budget' | 'spent' | 'available'>): {
  spent: number;
  cap: number | null;
  ratio: number;
} {
  const cap = m.budget.mode === 'amount' ? m.budget.amount : (m.budget.cap ?? null);
  const ratio = cap && cap > 0 ? Math.min(1, m.spent / cap) : 0;
  return { spent: m.spent, cap, ratio };
}

/** Totaux d'un ensemble de missions : dépensé, alloué (enveloppes en montant et plafonds). */
export function budgetTotals(ms: GovMissionView[]): { spent: number; allocated: number } {
  let spent = 0;
  let allocated = 0;
  for (const m of ms) {
    spent += m.spent;
    const u = budgetUsage(m);
    if (u.cap !== null) allocated += u.cap;
  }
  return { spent, allocated };
}

// ——— Brouillon de l'assistant ———

export type ZoneMode = 'all' | 'border' | 'around';

export interface BudgetDraft {
  mode: 'amount' | 'share';
  /** Enveloppe en jours de budget de défense (mode montant). */
  days: number;
  pct: number;
  capOn: boolean;
  capDays: number;
}

export interface MissionDraft {
  office: GovOffice;
  type: string | null;
  priority: number;
  goal: number;
  resource?: string;
  branch?: string;
  category?: string;
  nationId?: NationId;
  zone: ZoneMode;
  provinceId?: string;
  radiusKm: number;
  budget: BudgetDraft;
}

export function emptyDraft(office: GovOffice): MissionDraft {
  return {
    office,
    type: null,
    priority: 2,
    goal: 0,
    zone: 'all',
    radiusKm: 400,
    budget: { mode: 'amount', days: 20, pct: 10, capOn: false, capDays: 60 },
  };
}

/** Choix d'un type : objectif et cible par défaut des données. */
export function withType(d: MissionDraft, type: string, def: GovMissionDef): MissionDraft {
  const next: MissionDraft = { ...d, type, goal: def.goal, zone: 'all' };
  delete next.resource;
  delete next.branch;
  delete next.category;
  delete next.nationId;
  delete next.provinceId;
  if (def.target === 'resource') next.resource = def.defaultTarget ?? 'oil';
  if (def.target === 'branch') next.branch = def.defaultTarget ?? 'aero';
  if (def.target === 'category') next.category = def.defaultTarget ?? 'air_defense';
  return next;
}

/** Montant d'une enveloppe en dollars (jours × unité, arrondi au million). */
export function daysToUsd(days: number, unit: number): number {
  return Math.max(0, Math.round((days * unit) / 1e6) * 1e6);
}

export function toBudget(b: BudgetDraft, unit: number): GovBudget {
  if (b.mode === 'amount') return { mode: 'amount', amount: daysToUsd(b.days, unit) };
  return b.capOn
    ? { mode: 'share', pct: b.pct, cap: daysToUsd(b.capDays, unit) }
    : { mode: 'share', pct: b.pct };
}

/** Brouillon d'une enveloppe existante (modification). */
export function budgetDraftOf(b: GovBudget, unit: number): BudgetDraft {
  const days = (v: number) => (unit > 0 ? Math.max(1, Math.round(v / unit)) : 20);
  return b.mode === 'amount'
    ? { mode: 'amount', days: days(b.amount), pct: 10, capOn: false, capDays: 60 }
    : {
        mode: 'share',
        days: 20,
        pct: b.pct,
        capOn: b.cap !== undefined,
        capDays: b.cap !== undefined ? days(b.cap) : 60,
      };
}

/** Raison qui empêche de confier la mission (clé i18n), sinon null. */
export function draftError(d: MissionDraft, def: GovMissionDef | undefined): string | null {
  if (!d.type || !def) return 'gov.wizard.err.type';
  if (def.target === 'nation' && !d.nationId) return 'gov.wizard.err.nation';
  if (d.zone === 'border' && !d.nationId) return 'gov.wizard.err.border';
  if (d.zone === 'around' && !d.provinceId) return 'gov.wizard.err.around';
  if (d.budget.mode === 'amount' && d.budget.days <= 0) return 'gov.wizard.err.budget';
  return null;
}

export function toInput(d: MissionDraft, def: GovMissionDef, unit: number): GovMissionInput {
  const out: GovMissionInput = {
    type: d.type!,
    priority: d.priority,
    budget: toBudget(d.budget, unit),
  };
  if (!autoGoal(def)) out.goal = d.goal;
  if (def.target === 'resource' && d.resource) out.resource = d.resource as never;
  if (def.target === 'branch' && d.branch) out.branch = d.branch as never;
  if (def.target === 'category' && d.category) out.category = d.category as never;
  if (def.target === 'nation' && d.nationId) out.nationId = d.nationId;
  if (def.zone && d.zone === 'border' && d.nationId) out.nationId = d.nationId;
  if (def.zone && d.zone === 'around' && d.provinceId) {
    out.provinceId = d.provinceId;
    out.radiusKm = d.radiusKm;
  }
  return out;
}

/** Objectif fixé par le moteur (prochaine génération : nœuds à acquérir ; sites protégeables). */
export function autoGoal(def: GovMissionDef): boolean {
  return def.goal <= 0;
}

// ——— Estimation avant validation ———

export interface PlanEstimate {
  /** Actions possibles recensées (emplacements, nœuds, lots…), null si inconnu. */
  options: number | null;
  /** Coût de la première action. */
  first: number | null;
  /** Coût estimé de l'objectif complet. */
  total: number | null;
  /** Durée typique d'une action (heures de jeu). */
  hours: number | null;
  /** Mission sans dépense directe (réserve, protection). */
  free?: boolean;
  /** Coûts des actions recensées, croissants (couverture de l'enveloppe). */
  costs?: number[];
  /** Clé i18n d'un avertissement (aucun emplacement, aucun gisement…). */
  warn?: string;
}

const RES_BUILDING: Record<string, string> = {
  oil: 'oil_field',
  metals: 'mine',
  food: 'farm',
  electronics: 'electronics_plant',
};

interface EstimateCtx {
  view: PlayerView;
  me: NationId;
  provinces: Record<string, ProvinceDef>;
  catalog: Record<string, WeaponSystem>;
  research: Record<string, ResearchNode>;
  balance: Balance | null;
}

/** Provinces du joueur dans la zone du brouillon. */
export function scopeOf(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): string[] {
  const own = Object.keys(ctx.view.provinces)
    .filter((p) => ctx.view.provinces[p]!.owner === ctx.me)
    .sort();
  let list = own;
  if (def.zone && d.zone === 'around' && d.provinceId) {
    const c = ctx.provinces[d.provinceId]?.cityPoint;
    if (c)
      list = list.filter((p) => {
        const q = ctx.provinces[p]?.cityPoint;
        return !!q && distanceKm(q, c) <= d.radiusKm;
      });
  }
  const neighbor = (p: string, test: (owner: string | undefined) => boolean) =>
    (ctx.provinces[p]?.neighbors ?? []).some((q) => test(ctx.view.provinces[q]?.owner));
  if (def.zone && d.zone === 'border' && d.nationId)
    list = list.filter((p) => neighbor(p, (o) => o === d.nationId));
  else if (def.placement === 'border')
    list = list.filter((p) => neighbor(p, (o) => !!o && o !== ctx.me));
  return list;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function buildEstimate(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): PlanEstimate {
  const buildings =
    def.exec === 'extract'
      ? [RES_BUILDING[d.resource ?? def.defaultTarget ?? 'oil'] ?? '']
      : def.buildings;
  const costs: number[] = [];
  const hours: number[] = [];
  const B = ctx.balance?.buildings;
  const growth = B?.levelCostGrowth ?? 1.6;
  const tGrowth = B?.levelTimeGrowth ?? 0.25;
  const maxOf = (b: string) =>
    b === 'fortification' ? (B?.effects?.fortification?.maxLevel ?? 3) : (B?.maxLevel ?? 5);
  // Chaque emplacement offre ses niveaux restants (coût et durée croissants par niveau).
  const ladder = (b: string, level: number, cost: number, h: number) => {
    const base = cost / Math.pow(growth, level - 1);
    const h1 = h / (1 + tGrowth * (level - 1));
    for (let l = level; l <= maxOf(b); l++) {
      costs.push(base * Math.pow(growth, l - 1));
      hours.push(h1 * (1 + tGrowth * (l - 1)));
    }
  };
  for (const pid of scopeOf(ctx, d, def)) {
    const pv = ctx.view.provinces[pid]!;
    for (const b of buildings) {
      const fresh = pv.buildOptions?.find((o) => o.type === b);
      const st = pv.buildingState?.find((x) => x.type === b);
      if (fresh && !fresh.blocked && (def.exec !== 'upgrade' || fresh.level > 1)) {
        ladder(b, fresh.level, fresh.cost, fresh.hours);
        continue;
      }
      if (st?.next && st.health >= 1 && !st.upgradeUntil && !st.buildUntil)
        ladder(b, st.next.level, st.next.cost, st.next.hours);
    }
  }
  if (!costs.length)
    return {
      options: 0,
      first: null,
      total: null,
      hours: null,
      warn: def.exec === 'extract' ? 'gov.estimate.noDeposit' : 'gov.estimate.noSite',
    };
  const sorted = [...costs].sort((a, b) => a - b);
  const n = Math.max(1, d.goal);
  return {
    options: costs.length,
    first: sorted[0]!,
    total: sum(sorted.slice(0, n)),
    hours: median(hours),
    costs: sorted,
    ...(costs.length < n ? { warn: 'gov.estimate.few' } : {}),
  };
}

function eraOk(s: WeaponSystem, year: number): boolean {
  if (!s.era) return true;
  return s.era.introduced <= year && (s.era.retired === undefined || s.era.retired > year);
}

function produceEstimate(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): PlanEstimate {
  const cat = d.category ?? def.defaultTarget ?? '';
  const done = new Set(ctx.view.research?.done ?? []);
  const known = (s: WeaponSystem) => s.requires.every((r) => done.has(r) || !ctx.research[r]);
  const all = Object.values(ctx.catalog).filter(
    (s) => s.category === cat && s.enabled && eraOk(s, 2025),
  );
  const local = all.filter(known);
  const pool = local.length ? local : all.filter((s) => s.exportable);
  if (!pool.length)
    return { options: 0, first: null, total: null, hours: null, warn: 'gov.estimate.noSystem' };
  // Le moteur prend le matériel le plus récent : estimation sur la meilleure génération accessible.
  const best = Math.max(...pool.map((s) => s.generation));
  const top = pool.filter((s) => s.generation === best).sort((a, b) => a.cost.money - b.cost.money);
  const unit = top[0]!.cost.money * (local.length ? 1 : 1.3);
  return {
    options: pool.length,
    first: unit,
    total: unit * Math.max(1, d.goal),
    hours: top[0]!.buildTimeH,
  };
}

/** Nœuds encore à rechercher pour ouvrir des portes (prérequis compris). */
function closure(ctx: EstimateCtx, gates: string[], done: Set<string>): ResearchNode[] {
  const out = new Map<string, ResearchNode>();
  const stack = [...gates];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || done.has(id)) continue;
    const node = ctx.research[id];
    if (!node) continue;
    out.set(id, node);
    stack.push(...node.requires);
  }
  return [...out.values()];
}

function researchEstimate(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): PlanEstimate {
  const done = new Set(ctx.view.research?.done ?? []);
  let nodes: ResearchNode[];
  if (def.target === 'category') {
    const cat = d.category ?? def.defaultTarget ?? 'fighter';
    const sys = Object.values(ctx.catalog).filter((s) => s.category === cat && s.enabled);
    const ok = (s: WeaponSystem) => s.requires.every((r) => done.has(r) || !ctx.research[r]);
    const best = Math.max(0, ...sys.filter(ok).map((s) => s.generation));
    const higher = sys.filter((s) => !ok(s) && s.generation > best);
    if (!higher.length)
      return { options: 0, first: null, total: null, hours: null, warn: 'gov.estimate.unlocked' };
    const gen = Math.min(...higher.map((s) => s.generation));
    const gates = higher.filter((s) => s.generation === gen).flatMap((s) => s.requires);
    nodes = closure(ctx, gates, done);
  } else {
    const br = d.branch ?? def.defaultTarget ?? 'aero';
    nodes = Object.values(ctx.research)
      .filter((n) => n.branch === br && !done.has(n.id))
      .sort((a, b) => a.tier - b.tier || a.cost.money - b.cost.money)
      .slice(0, Math.max(1, d.goal));
  }
  if (!nodes.length)
    return { options: 0, first: null, total: null, hours: null, warn: 'gov.estimate.noResearch' };
  const open = nodes.filter((n) => n.requires.every((r) => done.has(r) || !ctx.research[r]));
  const first = (open.length ? open : nodes).sort((a, b) => a.cost.money - b.cost.money)[0]!;
  return {
    options: nodes.length,
    first: first.cost.money,
    total: sum(nodes.map((n) => n.cost.money)),
    hours: median(nodes.map((n) => n.durationH)),
  };
}

type OpCosts = Record<string, { money: number; durationH: number }>;

function opCost(
  balance: Balance | null,
  kind: string,
  nation: boolean,
): { money: number; durationH: number } | null {
  const intel = balance?.intel as
    { ops?: OpCosts; reconNation?: { ops?: OpCosts }; deep?: { ops?: OpCosts } } | undefined;
  return (
    (nation ? intel?.reconNation?.ops?.[kind] : undefined) ??
    intel?.ops?.[kind] ??
    intel?.deep?.ops?.[kind] ??
    null
  );
}

function intelEstimate(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): PlanEstimate {
  const kinds =
    def.exec === 'counterintel'
      ? ['counterintel_sweep']
      : def.exec === 'protect'
        ? ['harden_sites']
        : def.ops;
  const costs = kinds
    .map((k) => opCost(ctx.balance, k, def.exec === 'intel'))
    .filter((c): c is { money: number; durationH: number } => !!c);
  if (!costs.length) return { options: null, first: null, total: null, hours: null };
  const avg = sum(costs.map((c) => c.money)) / costs.length;
  const n = def.exec === 'protect' ? 1 : Math.max(1, d.goal);
  return {
    options: kinds.length,
    first: costs[0]!.money,
    total: avg * n,
    hours: median(costs.map((c) => c.durationH)),
  };
}

function repairEstimate(ctx: EstimateCtx, d: MissionDraft, def: GovMissionDef): PlanEstimate {
  let k = 0;
  for (const pid of scopeOf(ctx, d, def))
    for (const b of ctx.view.provinces[pid]!.buildingState ?? [])
      if (b.health < 1 && !b.repairUntil) k++;
  return {
    options: k,
    first: null,
    total: null,
    hours: null,
    ...(k ? {} : { warn: 'gov.estimate.nothingDamaged' }),
  };
}

/** Coûts et volume prévus d'une mission avant validation (approximation affichée au joueur). */
export function estimatePlan(
  ctx: EstimateCtx,
  d: MissionDraft,
  def: GovMissionDef | undefined,
): PlanEstimate | null {
  if (!def || !d.type) return null;
  switch (def.exec) {
    case 'extract':
    case 'invest':
    case 'build':
    case 'upgrade':
      return buildEstimate(ctx, d, def);
    case 'produce':
    case 'stock':
      return produceEstimate(ctx, d, def);
    case 'research':
      return researchEstimate(ctx, d, def);
    case 'intel':
    case 'counterintel':
    case 'protect':
      return intelEstimate(ctx, d, def);
    case 'repair':
      return repairEstimate(ctx, d, def);
    case 'reserve':
      return { options: null, first: null, total: null, hours: null, free: true };
  }
}

/** Actions que l'enveloppe couvre (les moins chères d'abord), null si inconnu ou sans plafond. */
export function coverCount(est: PlanEstimate | null, env: number | null): number | null {
  if (!est || env === null || est.first == null) return null;
  if (!est.costs) return Math.floor(env / est.first);
  let spent = 0;
  let k = 0;
  for (const c of est.costs) {
    if (spent + c > env) break;
    spent += c;
    k++;
  }
  return k;
}

/** Enveloppe effective du brouillon en dollars (null : part des revenus sans plafond). */
export function envelopeUsd(b: BudgetDraft, unit: number): number | null {
  if (b.mode === 'amount') return daysToUsd(b.days, unit);
  return b.capOn ? daysToUsd(b.capDays, unit) : null;
}

// ——— Commandements (centre de commandement refondu) ———

export interface CommandSummary {
  id: string;
  domain: 'land' | 'air' | 'sea' | 'air_defense';
  chief: string | null;
  generals: number;
  operations: number;
}

const DOMAINS: CommandSummary['domain'][] = ['land', 'air', 'sea', 'air_defense'];

function domainOf(x: Record<string, unknown>): CommandSummary['domain'] | null {
  const raw = String(x.domain ?? x.branch ?? x.kind ?? x.id ?? '');
  if (/air_?def|dca|aa\b/i.test(raw)) return 'air_defense';
  if (/^(air|aero)/i.test(raw)) return 'air';
  if (/(sea|naval|navy|marine)/i.test(raw)) return 'sea';
  if (/(land|army|terre|ground)/i.test(raw)) return 'land';
  return null;
}

function personName(p: unknown): string | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.name === 'string') return o.name;
  if (typeof o.first === 'string' && typeof o.last === 'string') return `${o.first} ${o.last}`;
  return null;
}

/**
 * Les quatre commandements (Terre, Air, Marine, Défense antiaérienne), si le centre de commandement
 * les expose (`view.command.commands`) ; null sinon (emplacement « en préparation »). Lecture
 * tolérante : seuls l'identifiant, le domaine, le chef, les généraux et les opérations sont lus.
 */
export function commandsOf(view: PlayerView | null | undefined): CommandSummary[] | null {
  const raw = (view?.command as unknown as { commands?: unknown } | undefined)?.commands;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).map(([id, v]) => ({ id, ...(v as object) }))
      : [];
  const out: CommandSummary[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const x = it as Record<string, unknown>;
    const domain = domainOf(x);
    if (!domain) continue;
    const arr = (k: string) => (Array.isArray(x[k]) ? (x[k] as unknown[]).length : 0);
    out.push({
      id: String(x.id ?? domain),
      domain,
      chief: personName(x.chief ?? x.commander ?? x.head ?? x.general),
      generals: arr('generals') || arr('generalIds'),
      operations: arr('operations') || arr('operationIds') || arr('armies') || arr('armyIds'),
    });
  }
  if (!out.length) return null;
  return out.sort((a, b) => DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain));
}

// ——— Journal ———

type T = (k: string, o?: Record<string, unknown>) => string;

/** Paramètres d'un compte rendu : sommes en dollars (`cost`, `left`, `floor`), nœuds de recherche. */
export function govParam(
  k: string,
  p: LocParam,
  t: T,
  ctx: {
    money: (v: number) => string;
    nation: (id: string) => string;
    province: (id: string) => string;
    system: (id: string) => string;
    node: (id: string) => string;
  },
): string {
  if (typeof p === 'number')
    return k === 'cost' || k === 'left' || k === 'floor' ? ctx.money(p) : String(p);
  if (typeof p === 'string') return k === 'node' ? ctx.node(p) : p;
  if ('nation' in p) return ctx.nation(p.nation);
  if ('province' in p) return ctx.province(p.province);
  if ('system' in p) return ctx.system(p.system);
  if ('list' in p) return p.list.map((x) => govParam('', x, t, ctx)).join(', ');
  const sub: Record<string, string> = {};
  for (const [kk, v] of Object.entries(p.params ?? {})) sub[kk] = govParam(kk, v, t, ctx);
  return t(p.key, sub);
}

export function govText(lt: LocText, t: T, ctx: Parameters<typeof govParam>[3]): string {
  const ps: Record<string, string> = {};
  for (const [k, v] of Object.entries(lt.params ?? {})) ps[k] = govParam(k, v, t, ctx);
  return t(lt.key, ps);
}

/** Initiales d'un titulaire (portrait stylisé). */
export function initials(first: string, last: string): string {
  const l = last.replace(/^(Al-|El-|Ben |Ben-|De |Di |Van |Von )/, '');
  return `${first[0] ?? ''}${l[0] ?? ''}`.toUpperCase();
}

/** Mission confiée à un poste sans titulaire ou bloquée : texte d'aide principal (clé i18n). */
export function officeHint(o: GovOfficeView, ms: GovMissionView[]): string | null {
  if (!o.head) return ms.length ? 'gov.hint.vacantMissions' : 'gov.hint.vacant';
  if (!ms.length) return 'gov.hint.noMission';
  return null;
}

// ——— Pictogrammes ———

const MISSION_ICON: Record<string, IconName> = {
  air_bases: 'target',
  military_bases: 'building',
  upgrade_bases: 'wrench',
  logistics: 'truck',
  fortify: 'shield',
  air_defense: 'radio',
  coastal: 'anchor',
  research_next: 'research',
  research_branch: 'research',
  research_labs: 'building',
  produce: 'factory',
  stockpile: 'box',
  arms_industry: 'factory',
  counterintel: 'eye',
  protect_sites: 'lock',
  watch: 'spy',
  map_defenses: 'mapPin',
  economic_intel: 'document',
  resource: 'oil',
  industry: 'factory',
  revenue: 'money',
  war_economy: 'bolt',
  reserves: 'wallet',
  repair: 'wrench',
};

const RESOURCE_ICON: Record<string, IconName> = {
  oil: 'oil',
  metals: 'metals',
  electronics: 'electronics',
  food: 'food',
};

export function missionIcon(m: { type: string; resource?: string }): IconName {
  if (m.type === 'resource' && m.resource) return RESOURCE_ICON[m.resource] ?? 'oil';
  return MISSION_ICON[m.type] ?? 'target';
}
