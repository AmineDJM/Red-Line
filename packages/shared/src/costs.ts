import { z } from 'zod';

/**
 * Économie du service (back-office) : paramètres de coût éditables, mesures de consommation agrégées et
 * attribution des coûts aux parties et aux utilisateurs. Fonctions pures, partagées par le serveur et le
 * serveur factice du back-office. Méthode documentée dans docs/couts.md.
 *
 *   GET  /admin/api/costs/report?period=month|30d|7d|24h   superadmin → CostReport
 *   GET  /admin/api/costs/settings                         superadmin → { settings: CostSettings }
 *   PUT  /admin/api/costs/settings      CostSettings       superadmin → { settings }
 *   GET  /admin/api/costs/entries                          superadmin → { entries: CostEntry[] }
 *   POST /admin/api/costs/entries       CostEntryBody      superadmin → { entry }
 *   DELETE /admin/api/costs/entries/:id                    superadmin → { ok }
 *   GET  /admin/api/costs/users/:id                        superadmin → { cost: UserCost | null }
 *   GET  /admin/api/costs/games/:id                        moderator  → { cost: GameCost | null }
 */

const HOURS_PER_MONTH = 730;

export const RenderPlanSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  usdPerMonth: z.number().min(0).max(100_000),
  cpu: z.number().positive().max(256),
  ramMb: z.number().positive().max(1_048_576),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

/** Offres Render relevées le 1er octobre 2026 (à recontrôler sur la facture : les prix bougent). */
export const DEFAULT_RENDER_PLANS: RenderPlan[] = [
  { id: 'starter', label: 'Starter', usdPerMonth: 7, cpu: 0.5, ramMb: 512 },
  { id: 'standard', label: 'Standard', usdPerMonth: 25, cpu: 1, ramMb: 2048 },
  { id: 'pro', label: 'Pro', usdPerMonth: 85, cpu: 2, ramMb: 4096 },
  { id: 'pro_plus', label: 'Pro Plus', usdPerMonth: 175, cpu: 4, ramMb: 8192 },
];

const num = (d: number, min = 0, max = 1e9) => z.number().min(min).max(max).default(d);

export const CostSettingsSchema = z.object({
  /** Conversion des recettes (euros) en dollars. */
  eurToUsd: num(1.08, 0.1, 10),
  /** TVA comprise dans les prix publics (retirée des recettes nettes). */
  vatPercent: num(20, 0, 50),
  compute: z
    .object({
      plans: z.array(RenderPlanSchema).min(1).max(12).default(DEFAULT_RENDER_PLANS),
      plan: z.string().default('starter'),
      instances: z.number().int().min(1).max(50).default(1),
      /** Part du coût fixe de calcul répartie au prorata du CPU·s ; le reste au prorata de la mémoire·h. */
      cpuWeight: num(0.5, 0, 1),
      /** Abonnement d'espace de travail Render (Hobby : 0 ; Pro : 25 $). */
      workspaceUsdPerMonth: num(0, 0, 100_000),
    })
    .default({}),
  database: z
    .object({
      plan: z.string().max(60).default('basic-256mb'),
      usdPerMonth: num(6, 0, 100_000),
      /** Stockage provisionné (Go) et prix par Go-mois. */
      storageGb: num(5, 0, 100_000),
      storageUsdPerGbMonth: num(0.3, 0, 100),
    })
    .default({}),
  bandwidth: z
    .object({
      /** Sortie incluse dans l'espace de travail (Go par mois), puis prix par Go. */
      includedGb: num(5, 0, 1e7),
      usdPerGb: num(0.15, 0, 100),
    })
    .default({}),
  stripe: z
    .object({
      /** Frais par paiement : pourcentage + fixe (centimes d'euro). Cartes de l'EEE : 1,5 % + 0,25 €. */
      percent: num(1.5, 0, 20),
      fixedEurCents: num(25, 0, 1000),
    })
    .default({}),
  push: z.object({ usdPerThousand: num(0, 0, 1000) }).default({}),
  /** Modèle de mémoire résidente d'une partie chargée (mesures de docs/charge.md). */
  memory: z
    .object({
      /** Mo de tas par Mio d'état sérialisé (partie monde : ~2,1 Mio → ~20 Mo). */
      mbPerStateMiB: num(9.5, 0, 1000),
      mbMinPerGame: num(4, 0, 10_000),
      /** Vue gardée par connexion (base des diffs) et tampons. */
      mbPerConnection: num(1.2, 0, 1000),
    })
    .default({}),
  alerts: z
    .object({
      /** Coût mensuel par joueur gratuit au-delà duquel une alerte est levée ($). */
      freeUserMonthlyUsd: num(0.25, 0, 1000),
      cpuPctStarter: num(40, 1, 400),
      cpuPctOther: num(70, 1, 400),
      rssMbStarter: num(420, 1, 1e6),
      rssShareOther: num(0.85, 0.1, 1),
      loopP99Ms: num(200, 1, 100_000),
      dbGbWarn: num(4, 0, 1e6),
      playersStarter: num(30, 1, 1e6),
      gamesStarter: num(8, 1, 1e6),
    })
    .default({}),
  retention: z
    .object({
      hourlyDays: z.number().int().min(2).max(90).default(14),
      dailyDays: z.number().int().min(31).max(3650).default(400),
    })
    .default({}),
});
export type CostSettings = z.infer<typeof CostSettingsSchema>;
export const DEFAULT_COST_SETTINGS: CostSettings = CostSettingsSchema.parse({});

export const COST_CATEGORIES = ['video_api', 'hosting', 'tools', 'marketing', 'other'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const CostEntryBodySchema = z.object({
  /** Jour de la dépense (AAAA-MM-JJ) ; une dépense mensuelle compte chaque mois à partir de ce jour. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(COST_CATEGORIES),
  label: z.string().min(1).max(200),
  amountUsd: z.number().min(0).max(1e7),
  monthly: z.boolean().default(false),
});
export type CostEntryBody = z.infer<typeof CostEntryBodySchema>;

export interface CostEntry extends CostEntryBody {
  id: number;
  /** 'manual' : saisi dans le back-office ; 'measured' : relevé par le serveur (API du studio vidéo…). */
  source: 'manual' | 'measured';
  ref: string | null;
  createdAt: string;
}

/** Consommation mesurée (somme sur une période). */
export interface Usage {
  /** Temps CPU de simulation, de diffusion (vues, diffs) et autre (instantanés, chargements), en ms. */
  cpuSimMs: number;
  cpuFlushMs: number;
  cpuOtherMs: number;
  /** Mémoire résidente estimée intégrée dans le temps (Mo·h). */
  memMbH: number;
  /** Octets envoyés sur le réseau (WebSocket après compression, HTTP). */
  wsBytes: number;
  httpBytes: number;
  wsMsgs: number;
  /** Temps de connexion des joueurs (s) : base des « heures de jeu ». */
  playS: number;
  orders: number;
  pushSent: number;
  stripeCalls: number;
}

export const ZERO_USAGE: Usage = {
  cpuSimMs: 0,
  cpuFlushMs: 0,
  cpuOtherMs: 0,
  memMbH: 0,
  wsBytes: 0,
  httpBytes: 0,
  wsMsgs: 0,
  playS: 0,
  orders: 0,
  pushSent: 0,
  stripeCalls: 0,
};

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  const out = { ...a };
  for (const k of Object.keys(ZERO_USAGE) as (keyof Usage)[]) out[k] += b[k] ?? 0;
  return out;
}

export type UserKind = 'free' | 'paying' | 'guest' | 'staff';
export const USER_KINDS: UserKind[] = ['free', 'paying', 'guest', 'staff'];

export interface CostInputGame {
  id: string;
  name: string;
  mode: 'solo' | 'multi';
  status: string;
  /** Joueurs humains de la partie (le coût de la partie leur est réparti à parts égales). */
  humans: string[];
  createdBy: string | null;
  usage: Usage;
  /** Octets stockés en base pour la partie (instantanés, journal, timelapse, messagerie). */
  storageBytes: number;
}

export interface CostInputUser {
  id: string;
  name: string;
  kind: UserKind;
  /** Consommation directe (octets reçus, temps de connexion, notifications…). */
  usage: Usage;
  /** Paiements de la période : brut TTC (centimes d'euro) et nombre de paiements. */
  paidEurCents: number;
  refundedEurCents: number;
  payments: number;
}

export interface CostInput {
  /** Bornes de la période et instant de calcul (ISO). */
  from: string;
  to: string;
  now: string;
  /** Consommation du processus entier (y compris ce qui n'est attribué à personne). */
  server: Usage & {
    cpuProcessMs: number;
    rssMbH: number;
    rssMaxMb: number;
    peakPlayers: number;
    peakGames: number;
  };
  games: CostInputGame[];
  users: CostInputUser[];
  /** Dépenses saisies ou mesurées tombant dans la période ($). */
  entriesUsd: number;
  entriesByCategory: Partial<Record<CostCategory, number>>;
  /** Taille de la base (octets). */
  dbBytes: number;
}

export interface CostBreakdown {
  compute: number;
  database: number;
  bandwidth: number;
  stripe: number;
  push: number;
  other: number;
  total: number;
}

const zeroBreakdown = (): CostBreakdown => ({
  compute: 0,
  database: 0,
  bandwidth: 0,
  stripe: 0,
  push: 0,
  other: 0,
  total: 0,
});

export interface UserCost {
  id: string;
  name: string;
  kind: UserKind;
  cost: CostBreakdown;
  /** Coût marginal : la part de capacité réellement consommée (hors capacité inutilisée). */
  marginalUsd: number;
  playHours: number;
  cpuS: number;
  memMbH: number;
  bytes: number;
  games: number;
  revenueNetUsd: number;
  marginUsd: number;
}

export interface GameCost {
  id: string;
  name: string;
  mode: 'solo' | 'multi';
  status: string;
  humans: number;
  cost: CostBreakdown;
  marginalUsd: number;
  cpuS: number;
  memMbH: number;
  storageBytes: number;
  playHours: number;
}

export interface CohortCost {
  users: number;
  costUsd: number;
  costPerUser: number;
  marginalPerUser: number;
  /** Coût par utilisateur ramené à un mois de 730 h (projection). */
  monthlyPerUser: number;
  playHours: number;
  revenueNetUsd: number;
}

export interface CostReport {
  from: string;
  to: string;
  /** Heures écoulées de la période et part d'un mois qu'elles représentent. */
  hours: number;
  monthFraction: number;
  plan: RenderPlan;
  cost: CostBreakdown;
  /** Coût projeté sur un mois complet au rythme de la période. */
  projectedMonthUsd: number;
  projectedMonth: CostBreakdown;
  /** Part du coût de calcul effectivement utilisée (CPU et mémoire mesurés / capacité payée). */
  utilization: { cpu: number; memory: number };
  unit: { cpuHourUsd: number; gbHourUsd: number; egressGbUsd: number; storageGbMonthUsd: number };
  revenue: {
    grossUsd: number;
    refundsUsd: number;
    vatUsd: number;
    netUsd: number;
    payments: number;
  };
  marginUsd: number;
  marginPct: number | null;
  activeUsers: number;
  payingUsers: number;
  arpuUsd: number;
  arppuUsd: number;
  conversion: number;
  playHours: number;
  costPerPlayHour: number;
  egressGb: number;
  cohorts: Record<UserKind, CohortCost>;
  modes: Record<
    'solo' | 'multi',
    { games: number; costUsd: number; costPerGame: number; playHours: number }
  >;
  topUsers: UserCost[];
  topGames: GameCost[];
  /** Listes complètes, triées par coût décroissant (absentes de la réponse HTTP sauf `full=1`). */
  users?: UserCost[];
  games?: GameCost[];
  /** Coût non attribué (aucun joueur : parties d'IA, capacité sans usage). */
  unattributedUsd: number;
  /** Charge du serveur sur la période. */
  load: {
    dbBytes: number;
    peakPlayers: number;
    peakGames: number;
    rssMaxMb: number;
    cpuAvgPct: number;
  };
}

export function planOf(s: CostSettings): RenderPlan {
  return s.compute.plans.find((p) => p.id === s.compute.plan) ?? s.compute.plans[0]!;
}

const cpuMs = (u: Usage) => u.cpuSimMs + u.cpuFlushMs + u.cpuOtherMs;
const share = (part: number, total: number) => (total > 0 ? part / total : 0);

/**
 * Attribution des coûts d'une période (méthode : docs/couts.md).
 * - Calcul (instances) : coût fixe de la période, réparti au prorata du CPU·s (part `cpuWeight`) et de la
 *   mémoire·h (le reste) des parties.
 * - Base : forfait + stockage provisionné, au prorata des octets stockés par partie.
 * - Coût d'une partie : réparti à parts égales entre ses joueurs humains (à défaut, son créateur).
 * - Bande passante (au-delà de l'inclus) : au prorata des octets reçus par chaque joueur ; les octets non
 *   attribuables (fichiers statiques, tuiles) au prorata du temps de jeu.
 * - Stripe et push : coûts directs. Autres dépenses (studio vidéo, outils) : par tête d'utilisateur actif.
 */
export function computeCostReport(input: CostInput, s: CostSettings): CostReport {
  const from = Date.parse(input.from);
  const to = Math.max(from + 1, Math.min(Date.parse(input.to), Date.parse(input.now)));
  const hours = (to - from) / 3_600_000;
  const f = hours / HOURS_PER_MONTH;
  const plan = planOf(s);
  const eur = s.eurToUsd;

  // ——— Coûts de la période ———
  const computeFixed = plan.usdPerMonth * s.compute.instances * f;
  const dbFixed =
    (s.database.usdPerMonth + s.database.storageGb * s.database.storageUsdPerGbMonth) * f;
  const egressBytes = input.server.wsBytes + input.server.httpBytes;
  const egressGb = egressBytes / 1e9;
  const includedGb = s.bandwidth.includedGb * f;
  const bandwidth = Math.max(0, egressGb - includedGb) * s.bandwidth.usdPerGb;
  const workspace = s.compute.workspaceUsdPerMonth * f;
  const other = workspace + input.entriesUsd;

  const totalCpu = input.games.reduce((a, g) => a + cpuMs(g.usage), 0);
  const totalMem = input.games.reduce((a, g) => a + g.usage.memMbH, 0);
  const totalStore = input.games.reduce((a, g) => a + g.storageBytes, 0);
  const w = totalCpu > 0 && totalMem > 0 ? s.compute.cpuWeight : totalCpu > 0 ? 1 : 0;

  // Prix unitaires à pleine capacité (coût marginal).
  const cpuHourUsd = (plan.usdPerMonth * s.compute.cpuWeight) / (plan.cpu * HOURS_PER_MONTH);
  const gbHourUsd =
    (plan.usdPerMonth * (1 - s.compute.cpuWeight)) / ((plan.ramMb / 1024) * HOURS_PER_MONTH);
  const marginalOf = (u: Usage) =>
    (cpuMs(u) / 3_600_000) * cpuHourUsd + (u.memMbH / 1024) * gbHourUsd;

  // ——— Parties ———
  const users = new Map<string, UserCost>();
  const userIn = new Map(input.users.map((u) => [u.id, u]));
  const ensure = (id: string): UserCost => {
    let u = users.get(id);
    if (!u) {
      const src = userIn.get(id);
      u = {
        id,
        name: src?.name ?? id.slice(0, 8),
        kind: src?.kind ?? 'free',
        cost: zeroBreakdown(),
        marginalUsd: 0,
        playHours: 0,
        cpuS: 0,
        memMbH: 0,
        bytes: 0,
        games: 0,
        revenueNetUsd: 0,
        marginUsd: 0,
      };
      users.set(id, u);
    }
    return u;
  };
  for (const u of input.users) ensure(u.id);

  let unattributed = 0;
  const games: GameCost[] = input.games.map((g) => {
    const compute =
      computeFixed *
      (w * share(cpuMs(g.usage), totalCpu) + (1 - w) * share(g.usage.memMbH, totalMem));
    const database = dbFixed * share(g.storageBytes, totalStore);
    const cost = { ...zeroBreakdown(), compute, database, total: compute + database };
    const marginal = marginalOf(g.usage);
    const owners = g.humans.length ? g.humans : g.createdBy ? [g.createdBy] : [];
    if (!owners.length) unattributed += cost.total;
    for (const id of owners) {
      const u = ensure(id);
      const k = 1 / owners.length;
      u.cost.compute += compute * k;
      u.cost.database += database * k;
      u.marginalUsd += marginal * k;
      u.cpuS += (cpuMs(g.usage) / 1000) * k;
      u.memMbH += g.usage.memMbH * k;
      u.games += 1;
    }
    return {
      id: g.id,
      name: g.name,
      mode: g.mode,
      status: g.status,
      humans: g.humans.length,
      cost,
      marginalUsd: marginal,
      cpuS: cpuMs(g.usage) / 1000,
      memMbH: g.usage.memMbH,
      storageBytes: g.storageBytes,
      playHours: g.usage.playS / 3600,
    };
  });
  // Capacité payée sans aucune partie pour la porter (serveur à vide).
  if (totalCpu === 0 && totalMem === 0) unattributed += computeFixed;
  if (totalStore === 0) unattributed += dbFixed;

  // ——— Coûts directs des utilisateurs ———
  const directBytes = input.users.reduce((a, u) => a + u.usage.wsBytes + u.usage.httpBytes, 0);
  const sharedBytes = Math.max(0, egressBytes - directBytes);
  const totalPlay = input.users.reduce((a, u) => a + u.usage.playS, 0);
  const active = input.users.filter(
    (u) => u.usage.playS > 0 || u.usage.wsBytes > 0 || users.get(u.id)!.games > 0 || u.payments > 0,
  );
  const perByte = egressBytes > 0 ? bandwidth / egressBytes : 0;
  let stripeTotal = 0;
  let gross = 0;
  let refunds = 0;
  let payments = 0;
  for (const src of input.users) {
    const u = ensure(src.id);
    const ownBytes = src.usage.wsBytes + src.usage.httpBytes;
    const sharedPart =
      totalPlay > 0
        ? share(src.usage.playS, totalPlay)
        : active.length
          ? active.includes(src)
            ? 1 / active.length
            : 0
          : 0;
    u.bytes = ownBytes + sharedBytes * sharedPart;
    u.cost.bandwidth = u.bytes * perByte;
    u.cost.push = (src.usage.pushSent / 1000) * s.push.usdPerThousand;
    const fees =
      src.payments * (s.stripe.fixedEurCents / 100) * eur +
      (src.paidEurCents / 100) * eur * (s.stripe.percent / 100);
    u.cost.stripe = fees;
    stripeTotal += fees;
    u.playHours = src.usage.playS / 3600;
    const g = (src.paidEurCents / 100) * eur;
    const r = (src.refundedEurCents / 100) * eur;
    gross += g;
    refunds += r;
    payments += src.payments;
    u.revenueNetUsd = (g - r) / (1 + s.vatPercent / 100) - fees;
    u.marginalUsd += ownBytes * (s.bandwidth.usdPerGb / 1e9) + u.cost.push + fees;
  }
  if (!input.users.length) unattributed += bandwidth;
  const pushTotal = [...users.values()].reduce((a, u) => a + u.cost.push, 0);
  const perHead = active.length ? other / active.length : 0;
  if (!active.length) unattributed += other;
  for (const src of active) users.get(src.id)!.cost.other = perHead;
  for (const u of users.values()) {
    const c = u.cost;
    c.total = c.compute + c.database + c.bandwidth + c.stripe + c.push + c.other;
    u.marginUsd = u.revenueNetUsd - c.total;
  }

  const cost: CostBreakdown = {
    compute: computeFixed,
    database: dbFixed,
    bandwidth,
    stripe: stripeTotal,
    push: pushTotal,
    other,
    total: 0,
  };
  cost.total = cost.compute + cost.database + cost.bandwidth + cost.stripe + cost.push + cost.other;

  // ——— Projection mensuelle (fixes au mois plein, variables au rythme de la période) ———
  const k = f > 0 ? 1 / f : 0;
  const projGb = egressGb * k;
  const projectedMonth: CostBreakdown = {
    compute: plan.usdPerMonth * s.compute.instances,
    database: s.database.usdPerMonth + s.database.storageGb * s.database.storageUsdPerGbMonth,
    bandwidth: Math.max(0, projGb - s.bandwidth.includedGb) * s.bandwidth.usdPerGb,
    stripe: stripeTotal * k,
    push: pushTotal * k,
    other: s.compute.workspaceUsdPerMonth + input.entriesUsd * k,
    total: 0,
  };
  projectedMonth.total =
    projectedMonth.compute +
    projectedMonth.database +
    projectedMonth.bandwidth +
    projectedMonth.stripe +
    projectedMonth.push +
    projectedMonth.other;

  const vat = gross - refunds - (gross - refunds) / (1 + s.vatPercent / 100);
  const net = gross - refunds - vat - stripeTotal;
  const userList = [...users.values()];
  const activeIds = new Set(active.map((u) => u.id));
  const customers = userList.filter((u) => u.kind !== 'staff' && activeIds.has(u.id));
  const registered = customers.filter((u) => u.kind !== 'guest');
  const payingNow = input.users.filter((u) => u.payments > 0 && u.kind !== 'staff');

  const cohorts = {} as Record<UserKind, CohortCost>;
  for (const kind of USER_KINDS) {
    const list = userList.filter((u) => u.kind === kind && activeIds.has(u.id));
    const c = list.reduce((a, u) => a + u.cost.total, 0);
    const m = list.reduce((a, u) => a + u.marginalUsd, 0);
    cohorts[kind] = {
      users: list.length,
      costUsd: c,
      costPerUser: list.length ? c / list.length : 0,
      marginalPerUser: list.length ? m / list.length : 0,
      monthlyPerUser: list.length ? (c / list.length) * k : 0,
      playHours: list.reduce((a, u) => a + u.playHours, 0),
      revenueNetUsd: list.reduce((a, u) => a + u.revenueNetUsd, 0),
    };
  }
  const modes = {} as CostReport['modes'];
  for (const mode of ['solo', 'multi'] as const) {
    const list = games.filter((g) => g.mode === mode);
    const c = list.reduce((a, g) => a + g.cost.total, 0);
    modes[mode] = {
      games: list.length,
      costUsd: c,
      costPerGame: list.length ? c / list.length : 0,
      playHours: list.reduce((a, g) => a + g.playHours, 0),
    };
  }
  const playHours = input.users.reduce((a, u) => a + u.usage.playS, 0) / 3600;
  const sortedUsers = userList
    .filter((u) => u.cost.total > 0 || u.revenueNetUsd !== 0)
    .sort((a, b) => b.cost.total - a.cost.total);
  const sortedGames = [...games].sort((a, b) => b.cost.total - a.cost.total);
  const capCpuMs = plan.cpu * s.compute.instances * hours * 3_600_000;
  const capMemMbH = plan.ramMb * s.compute.instances * hours;

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    hours,
    monthFraction: f,
    plan,
    cost,
    projectedMonthUsd: projectedMonth.total,
    projectedMonth,
    utilization: {
      cpu: share(input.server.cpuProcessMs, capCpuMs),
      memory: share(input.server.rssMbH, capMemMbH),
    },
    unit: {
      cpuHourUsd,
      gbHourUsd,
      egressGbUsd: s.bandwidth.usdPerGb,
      storageGbMonthUsd: s.database.storageUsdPerGbMonth,
    },
    revenue: { grossUsd: gross, refundsUsd: refunds, vatUsd: vat, netUsd: net, payments },
    marginUsd: net - cost.total,
    marginPct: net > 0 ? (net - cost.total) / net : null,
    activeUsers: customers.length,
    payingUsers: payingNow.length,
    arpuUsd: customers.length ? net / customers.length : 0,
    arppuUsd: payingNow.length ? net / payingNow.length : 0,
    conversion: registered.length
      ? payingNow.filter((u) => activeIds.has(u.id)).length / registered.length
      : 0,
    playHours,
    costPerPlayHour: playHours > 0 ? cost.total / playHours : 0,
    egressGb,
    cohorts,
    modes,
    topUsers: sortedUsers.slice(0, 25),
    topGames: sortedGames.slice(0, 25),
    users: sortedUsers,
    games: sortedGames,
    unattributedUsd: unattributed,
    load: {
      dbBytes: input.dbBytes,
      peakPlayers: input.server.peakPlayers,
      peakGames: input.server.peakGames,
      rssMaxMb: input.server.rssMaxMb,
      cpuAvgPct: hours > 0 ? (input.server.cpuProcessMs / (hours * 3_600_000)) * 100 : 0,
    },
  };
}

// ───────────────────────────── Alertes et recommandations ─────────────────────────────

export interface LiveLoad {
  cpuPct: number;
  rssMb: number;
  eventLoopP99Ms: number;
  connectedPlayers: number;
  games: number;
  gamesBehind: number;
}

export interface CostAlert {
  level: 'warn' | 'crit';
  code: string;
  message: string;
}

export interface Recommendation {
  code: string;
  message: string;
}

const usd = (v: number) => `${(v < 0.1 ? v.toFixed(3) : v.toFixed(2)).replace('.', ',')} $`;

/** Alertes (seuils de docs/charge.md et des paramètres) et recommandations d'offre. */
export function costAlerts(
  r: CostReport,
  live: LiveLoad | null,
  s: CostSettings,
): { alerts: CostAlert[]; recommendations: Recommendation[] } {
  const alerts: CostAlert[] = [];
  const recs: Recommendation[] = [];
  const a = s.alerts;
  const plan = planOf(s);
  const starter = plan.ramMb <= 512;
  const free = r.cohorts.free;
  if (free.users > 0 && free.monthlyPerUser > a.freeUserMonthlyUsd) {
    alerts.push({
      level: free.monthlyPerUser > 2 * a.freeUserMonthlyUsd ? 'crit' : 'warn',
      code: 'free_user_cost',
      message: `Coût mensuel projeté par joueur gratuit : ${usd(free.monthlyPerUser)} (seuil ${usd(a.freeUserMonthlyUsd)}).`,
    });
  }
  if (r.revenue.netUsd > 0 && r.marginUsd < 0) {
    alerts.push({
      level: 'warn',
      code: 'negative_margin',
      message: `Marge négative sur la période : ${usd(r.marginUsd)}.`,
    });
  }
  const cpuAvg = r.load.cpuAvgPct;
  const cpuMax = starter ? a.cpuPctStarter : a.cpuPctOther * plan.cpu;
  const cpuNow = live?.cpuPct ?? 0;
  if (cpuNow > cpuMax || cpuAvg > cpuMax) {
    alerts.push({
      level: 'crit',
      code: 'cpu',
      message: `CPU ${Math.round(Math.max(cpuNow, cpuAvg))} % d'un cœur (seuil ${cpuMax} % en ${plan.label}).`,
    });
  }
  const rssMax = starter ? a.rssMbStarter : plan.ramMb * a.rssShareOther;
  if (live && live.rssMb > rssMax) {
    alerts.push({
      level: 'crit',
      code: 'memory',
      message: `Mémoire ${Math.round(live.rssMb)} Mo (seuil ${Math.round(rssMax)} Mo en ${plan.label}).`,
    });
  }
  if (live && live.eventLoopP99Ms > a.loopP99Ms) {
    alerts.push({
      level: 'warn',
      code: 'loop',
      message: `Boucle d'événements : 99e centile ${Math.round(live.eventLoopP99Ms)} ms (seuil ${a.loopP99Ms} ms).`,
    });
  }
  if (live && live.gamesBehind > 0) {
    alerts.push({
      level: 'warn',
      code: 'behind',
      message: `${live.gamesBehind} partie(s) en rattrapage de simulation.`,
    });
  }
  const dbGb = r.load.dbBytes / 1e9;
  if (dbGb > a.dbGbWarn) {
    alerts.push({
      level: 'warn',
      code: 'db_size',
      message: `Base de données : ${dbGb.toFixed(1)} Go (seuil ${a.dbGbWarn} Go).`,
    });
  }
  if (r.projectedMonth.bandwidth > 0) {
    alerts.push({
      level: 'warn',
      code: 'bandwidth',
      message: `Bande passante au-delà de l'inclus : ${usd(r.projectedMonth.bandwidth)} projetés ce mois.`,
    });
  }

  // Recommandations d'offre (docs/charge.md : un seul cœur utile, montée en charge verticale).
  const peakPlayers = Math.max(live?.connectedPlayers ?? 0, r.load.peakPlayers);
  const peakGames = Math.max(live?.games ?? 0, r.load.peakGames);
  const next = s.compute.plans
    .filter((p) => p.usdPerMonth > plan.usdPerMonth)
    .sort((x, y) => x.usdPerMonth - y.usdPerMonth)[0];
  const saturated =
    alerts.some((x) => x.code === 'cpu' || x.code === 'memory') ||
    (starter && (peakPlayers > a.playersStarter || peakGames > a.gamesStarter));
  if (saturated && next) {
    recs.push({
      code: 'upgrade',
      message: `Passer de ${plan.label} à ${next.label} (${next.usdPerMonth} $/mois, ${next.cpu} CPU, ${next.ramMb} Mo)${next.ramMb >= 2048 ? ` avec NODE_OPTIONS=--max-old-space-size=${Math.round(next.ramMb * 0.75)}` : ''}.`,
    });
  }
  const lower = s.compute.plans
    .filter((p) => p.usdPerMonth < plan.usdPerMonth)
    .sort((x, y) => y.usdPerMonth - x.usdPerMonth)[0];
  if (
    lower &&
    !saturated &&
    r.hours >= 72 &&
    r.load.cpuAvgPct / 100 < lower.cpu * 0.4 &&
    r.load.rssMaxMb > 0 &&
    r.load.rssMaxMb < lower.ramMb * 0.7
  ) {
    recs.push({
      code: 'downgrade',
      message: `Charge faible : l'offre ${lower.label} (${lower.usdPerMonth} $/mois) suffirait (CPU moyen ${Math.round(r.load.cpuAvgPct)} % d'un cœur).`,
    });
  }
  if (dbGb > a.dbGbWarn) {
    recs.push({
      code: 'db_upgrade',
      message:
        'Passer la base à basic-1gb ou porter SNAPSHOT_INTERVAL_S à 120 (la reprise rejoue le journal).',
    });
  }
  if (free.users > 0 && free.monthlyPerUser > a.freeUserMonthlyUsd) {
    recs.push({
      code: 'free_limits',
      message:
        'Réduire le coût des joueurs gratuits : quota de parties solo plus bas, délai d’abandon plus court, veille des IA plus tôt (Paramètres du serveur).',
    });
  }
  return { alerts, recommendations: recs };
}

// ───────────────────────────── Paramètres du serveur et annonces ─────────────────────────────

/** Paramètres d'exploitation modifiables à chaud (back-office, superadmin). */
export const RuntimeSettingsSchema = z.object({
  maxActiveSoloPerUser: z.number().int().min(0).max(1000),
  maxActiveMultiPerUser: z.number().int().min(0).max(1000),
  /** Délais en minutes (affichage et saisie). */
  soloAbandonMin: z
    .number()
    .min(10)
    .max(60 * 24 * 60),
  multiAbandonMin: z
    .number()
    .min(10)
    .max(60 * 24 * 60),
  dormancyDelayMin: z
    .number()
    .min(1)
    .max(60 * 24 * 7),
  idleUnloadMin: z
    .number()
    .min(1)
    .max(60 * 24 * 7),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export const AnnouncementBodySchema = z.object({
  text: z.string().min(1).max(500),
  level: z.enum(['info', 'warn']).default('info'),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }),
  active: z.boolean().default(true),
  /** Envoyer tout de suite aux joueurs connectés (message dans la partie). */
  broadcast: z.boolean().default(true),
});
export type AnnouncementBody = z.infer<typeof AnnouncementBodySchema>;

export interface Announcement {
  id: number;
  text: string;
  level: 'info' | 'warn';
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
  authorName: string | null;
}

// ───────────────────────────── Tableau de bord ─────────────────────────────

export const COST_PERIODS = ['24h', '7d', '30d', 'month'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

export interface CostSeriesPoint {
  /** Début du créneau (heure ou jour, ISO). */
  t: string;
  costUsd: number;
  revenueNetUsd: number;
  playHours: number;
  /** CPU moyen du processus (% d'un cœur) et mémoire résidente moyenne (Mo). */
  cpuPct: number;
  rssMb: number;
  peakPlayers: number;
  egressMb: number;
}

export interface CostDashboard {
  period: CostPeriod;
  report: CostReport;
  alerts: CostAlert[];
  recommendations: Recommendation[];
  series: CostSeriesPoint[];
  live: LiveLoad | null;
}
