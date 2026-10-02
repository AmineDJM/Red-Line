import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  CostSettingsSchema,
  DEFAULT_COST_SETTINGS,
  ZERO_USAGE,
  computeCostReport,
  costAlerts,
  planOf,
  type CostCategory,
  type CostDashboard,
  type CostEntry,
  type CostInput,
  type CostInputGame,
  type CostInputUser,
  type CostPeriod,
  type CostReport,
  type CostSeriesPoint,
  type CostSettings,
  type LiveLoad,
  type Usage,
  type UserKind,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import { costEntries, serverSettings } from '../db/schema.js';

const SETTINGS_KEY = 'cost_settings';
const STORAGE_TTL_MS = 5 * 60_000;
const REPORT_TTL_MS = 30_000;

type Num = string | number | null;
const n = (v: Num | undefined) => (v === null || v === undefined ? 0 : Number(v));

const SUMS = sql.raw(`
  sum(cpu_sim_ms) AS "cpuSimMs", sum(cpu_flush_ms) AS "cpuFlushMs", sum(cpu_other_ms) AS "cpuOtherMs",
  sum(mem_mb_h) AS "memMbH", sum(ws_bytes) AS "wsBytes", sum(ws_msgs) AS "wsMsgs",
  sum(http_bytes) AS "httpBytes", sum(play_s) AS "playS", sum(orders) AS "orders",
  sum(push_sent) AS "pushSent", sum(stripe_calls) AS "stripeCalls"`);

function usageOf(r: Record<string, Num>): Usage {
  const u = { ...ZERO_USAGE };
  for (const k of Object.keys(u) as (keyof Usage)[]) u[k] = n(r[k]);
  return u;
}

/** Début de période et grain des agrégats lus. */
export function periodBounds(period: CostPeriod, now: Date): { from: Date; grain: 'hour' | 'day' } {
  const t = now.getTime();
  switch (period) {
    case '24h': {
      const from = new Date(t - 24 * 3_600_000);
      from.setUTCMinutes(0, 0, 0);
      return { from, grain: 'hour' };
    }
    case '7d':
    case '30d': {
      const from = new Date(t - (period === '7d' ? 7 : 30) * 86_400_000);
      from.setUTCHours(0, 0, 0, 0);
      return { from, grain: 'day' };
    }
    default:
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), grain: 'day' };
  }
}

/**
 * Économie du service : paramètres de coût (server_settings), dépenses saisies, lecture des agrégats de
 * consommation et attribution des coûts (computeCostReport, packages/shared/src/costs.ts).
 */
export class CostService {
  private cached: CostSettings = DEFAULT_COST_SETTINGS;
  private storage: { at: number; perGame: Map<string, number>; dbBytes: number } | null = null;
  private reports = new Map<string, { at: number; report: CostReport; input: CostInput }>();
  /** Charge instantanée (métriques du processus), fournie par l'application. */
  live: (() => LiveLoad) | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  async init(): Promise<void> {
    const [row] = await this.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.key, SETTINGS_KEY));
    if (row) {
      const r = CostSettingsSchema.safeParse(row.value);
      if (r.success) this.cached = r.data;
      else this.log.warn('paramètres de coût invalides en base : valeurs par défaut');
    }
  }

  settings(): CostSettings {
    return this.cached;
  }

  async saveSettings(value: unknown): Promise<CostSettings> {
    const s = CostSettingsSchema.parse(value);
    if (!s.compute.plans.some((p) => p.id === s.compute.plan)) {
      throw new Error(`offre inconnue : ${s.compute.plan}`);
    }
    await this.db
      .insert(serverSettings)
      .values({ key: SETTINGS_KEY, value: s })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: s } });
    this.cached = s;
    this.reports.clear();
    return s;
  }

  // ───────────── Dépenses ─────────────

  async entries(): Promise<CostEntry[]> {
    const rows = await this.db
      .select()
      .from(costEntries)
      .orderBy(sql`${costEntries.day} desc, ${costEntries.id} desc`)
      .limit(1000);
    return rows.map((r) => ({
      id: r.id,
      day: r.day,
      category: r.category as CostCategory,
      label: r.label,
      amountUsd: r.amountUsd,
      monthly: r.monthly,
      source: r.source,
      ref: r.ref,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Coût externe mesuré par le serveur (ex. appel d'une API payante du studio vidéo) : à appeler par le
   * service concerné avec le montant facturé. Visible dans l'écran Économie (source « mesurée »).
   */
  async recordExternal(e: {
    category: CostCategory;
    label: string;
    amountUsd: number;
    ref?: string;
    at?: Date;
  }): Promise<void> {
    await this.db.insert(costEntries).values({
      day: (e.at ?? new Date()).toISOString().slice(0, 10),
      category: e.category,
      label: e.label.slice(0, 200),
      amountUsd: e.amountUsd,
      source: 'measured',
      ref: e.ref ?? null,
    });
    this.reports.clear();
  }

  invalidate(): void {
    this.reports.clear();
    this.storage = null;
  }

  // ───────────── Mesures ─────────────

  /** Octets stockés en base par partie (instantanés, journal, timelapse, messagerie) et taille totale. */
  async storageBytes(): Promise<{ perGame: Map<string, number>; dbBytes: number }> {
    const now = Date.now();
    if (this.storage && now - this.storage.at < STORAGE_TTL_MS) return this.storage;
    const rows = await this.db.execute<{ id: string; bytes: Num }>(sql`
      SELECT g.id::text AS id,
        coalesce(s.b, 0) + coalesce(o.b, 0) + coalesce(t.b, 0) + coalesce(c.b, 0) AS bytes
      FROM games g
      LEFT JOIN (SELECT game_id, sum(octet_length(state) + 64) AS b FROM game_snapshots GROUP BY 1) s ON s.game_id = g.id
      LEFT JOIN (SELECT game_id, sum(pg_column_size(payload) + 48) AS b FROM game_orders GROUP BY 1) o ON o.game_id = g.id
      LEFT JOIN (SELECT game_id, sum(pg_column_size(delta) + 32) AS b FROM timelapse_frames GROUP BY 1) t ON t.game_id = g.id
      LEFT JOIN (SELECT game_id, sum(octet_length(text) + octet_length(author_name) + 96) AS b FROM chat_messages GROUP BY 1) c ON c.game_id = g.id`);
    const [size] = await this.db.execute<{ b: Num }>(
      sql`SELECT pg_database_size(current_database()) AS b`,
    );
    this.storage = {
      at: now,
      perGame: new Map([...rows].map((r) => [r.id, n(r.bytes)])),
      dbBytes: n(size?.b),
    };
    return this.storage;
  }

  /** Entrées du calcul d'attribution pour une période. */
  async input(period: CostPeriod, now = new Date()): Promise<CostInput> {
    const { from, grain } = periodBounds(period, now);
    const fromIso = from.toISOString();
    const s = this.cached;
    const [server] = await this.db.execute<Record<string, Num>>(sql`
      SELECT ${SUMS}, sum(cpu_process_ms) AS "cpuProcessMs", sum(rss_mb_h) AS "rssMbH",
        max(rss_max_mb) AS "rssMaxMb", max(peak_players) AS "peakPlayers", max(peak_games) AS "peakGames"
      FROM usage_stats WHERE grain = ${grain} AND scope = 'server' AND period_start >= ${fromIso}::timestamptz`);
    const gameRows = await this.db.execute<Record<string, Num> & { key: string }>(sql`
      SELECT key, ${SUMS} FROM usage_stats
      WHERE grain = ${grain} AND scope = 'game' AND period_start >= ${fromIso}::timestamptz GROUP BY key`);
    const userRows = await this.db.execute<Record<string, Num> & { key: string }>(sql`
      SELECT key, ${SUMS} FROM usage_stats
      WHERE grain = ${grain} AND scope = 'user' AND period_start >= ${fromIso}::timestamptz GROUP BY key`);
    const storage = await this.storageBytes();
    const usedGames = new Map(gameRows.map((r) => [r.key, usageOf(r)]));
    const gameIds = [...new Set([...usedGames.keys(), ...storage.perGame.keys()])];
    const meta = gameIds.length
      ? await this.db.execute<{
          id: string;
          name: string;
          mode: 'solo' | 'multi';
          status: string;
          created_by: string | null;
          humans: string[] | null;
        }>(sql`
          SELECT g.id::text AS id, g.name, g.mode, g.status, g.created_by::text AS created_by,
            array_remove(array_agg(DISTINCT gp.user_id::text), NULL) AS humans
          FROM games g LEFT JOIN game_players gp ON gp.game_id = g.id
          WHERE g.id::text = ANY(string_to_array(${gameIds.join(',')}, ','))
          GROUP BY g.id`)
      : [];
    const games: CostInputGame[] = [...meta].map((g) => ({
      id: g.id,
      name: g.name,
      mode: g.mode,
      status: g.status,
      humans: g.humans ?? [],
      createdBy: g.created_by,
      usage: usedGames.get(g.id) ?? { ...ZERO_USAGE },
      storageBytes: storage.perGame.get(g.id) ?? 0,
    }));
    // Parties supprimées depuis : leur consommation reste comptée (non attribuée).
    for (const [id, usage] of usedGames) {
      if (!games.some((g) => g.id === id)) {
        games.push({
          id,
          name: `(supprimée) ${id.slice(0, 8)}`,
          mode: 'solo',
          status: 'deleted',
          humans: [],
          createdBy: null,
          usage,
          storageBytes: 0,
        });
      }
    }
    const usedUsers = new Map(userRows.map((r) => [r.key, usageOf(r)]));
    const userIds = new Set<string>(usedUsers.keys());
    for (const g of games) {
      if (n(cpuOf(g.usage)) > 0 || g.usage.memMbH > 0 || g.storageBytes > 0) {
        for (const h of g.humans) userIds.add(h);
        if (!g.humans.length && g.createdBy) userIds.add(g.createdBy);
      }
    }
    const pays = await this.db.execute<{
      user_id: string;
      paid: Num;
      refunded: Num;
      payments: Num;
    }>(sql`
      SELECT user_id::text AS user_id,
        sum(CASE WHEN paid_at >= ${fromIso}::timestamptz THEN price_cents * (CASE WHEN currency = 'usd' THEN ${1 / s.eurToUsd}::float8 ELSE 1 END) ELSE 0 END) AS paid,
        sum(CASE WHEN status = 'refunded' AND refunded_at >= ${fromIso}::timestamptz THEN price_cents * (CASE WHEN currency = 'usd' THEN ${1 / s.eurToUsd}::float8 ELSE 1 END) ELSE 0 END) AS refunded,
        count(*) FILTER (WHERE paid_at >= ${fromIso}::timestamptz) AS payments
      FROM purchases WHERE user_id IS NOT NULL AND paid_at IS NOT NULL
        AND (paid_at >= ${fromIso}::timestamptz OR refunded_at >= ${fromIso}::timestamptz)
      GROUP BY user_id`);
    for (const p of pays) userIds.add(p.user_id);
    const ids = [...userIds];
    const people = ids.length
      ? await this.db.execute<{
          id: string;
          name: string;
          is_guest: boolean;
          role: string;
          unlimited: boolean;
          paying: boolean;
        }>(sql`
          SELECT u.id::text AS id, u.display_name AS name, u.is_guest, u.role, u.unlimited,
            EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = u.id AND p.status = 'paid') AS paying
          FROM users u WHERE u.id::text = ANY(string_to_array(${ids.join(',')}, ','))`)
      : [];
    const payOf = new Map([...pays].map((p) => [p.user_id, p]));
    const users: CostInputUser[] = [...people].map((u) => {
      const kind: UserKind =
        u.role !== 'player' || u.unlimited
          ? 'staff'
          : u.is_guest
            ? 'guest'
            : u.paying
              ? 'paying'
              : 'free';
      const p = payOf.get(u.id);
      return {
        id: u.id,
        name: u.name,
        kind,
        usage: usedUsers.get(u.id) ?? { ...ZERO_USAGE },
        paidEurCents: n(p?.paid),
        refundedEurCents: n(p?.refunded),
        payments: n(p?.payments),
      };
    });
    const entries = await this.entriesIn(from, now);
    return {
      from: fromIso,
      to: now.toISOString(),
      now: now.toISOString(),
      server: {
        ...usageOf(server ?? {}),
        cpuProcessMs: n(server?.cpuProcessMs),
        rssMbH: n(server?.rssMbH),
        rssMaxMb: n(server?.rssMaxMb),
        peakPlayers: n(server?.peakPlayers),
        peakGames: n(server?.peakGames),
      },
      games,
      users,
      entriesUsd: entries.total,
      entriesByCategory: entries.byCategory,
      dbBytes: storage.dbBytes,
    };
  }

  /** Dépenses de la période : ponctuelles datées dedans, mensuelles au prorata des heures couvertes. */
  private async entriesIn(
    from: Date,
    to: Date,
  ): Promise<{ total: number; byCategory: Partial<Record<CostCategory, number>> }> {
    const rows = await this.db.select().from(costEntries);
    const byCategory: Partial<Record<CostCategory, number>> = {};
    let total = 0;
    for (const r of rows) {
      const day = Date.parse(`${r.day}T00:00:00Z`);
      let amount = 0;
      if (r.monthly) {
        const start = Math.max(day, from.getTime());
        const hours = Math.max(0, (to.getTime() - start) / 3_600_000);
        amount = (r.amountUsd * hours) / 730;
      } else {
        const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
        if (day >= fromDay && day <= to.getTime()) amount = r.amountUsd;
      }
      if (!amount) continue;
      total += amount;
      const c = r.category as CostCategory;
      byCategory[c] = (byCategory[c] ?? 0) + amount;
    }
    return { total, byCategory };
  }

  async report(
    period: CostPeriod,
    now = new Date(),
  ): Promise<{ report: CostReport; input: CostInput }> {
    const hit = this.reports.get(period);
    if (hit && now.getTime() - hit.at < REPORT_TTL_MS) return hit;
    const input = await this.input(period, now);
    const report = computeCostReport(input, this.cached);
    const out = { at: now.getTime(), report, input };
    this.reports.set(period, out);
    return out;
  }

  /** Série temporelle (heures sur 24 h, jours sinon) : coûts, recettes, charge. */
  async series(period: CostPeriod, now = new Date()): Promise<CostSeriesPoint[]> {
    const { from, grain } = periodBounds(period, now);
    const s = this.cached;
    const plan = planOf(s);
    const rows = await this.db.execute<Record<string, Num> & { t: Date | string }>(sql`
      SELECT period_start AS t, sum(cpu_process_ms) AS cpu, sum(rss_mb_h) AS rss, max(peak_players) AS players,
        sum(ws_bytes + http_bytes) AS bytes, sum(play_s) AS play
      FROM usage_stats WHERE grain = ${grain} AND scope = 'server' AND period_start >= ${from.toISOString()}::timestamptz
      GROUP BY period_start ORDER BY period_start`);
    const trunc = grain === 'hour' ? 'hour' : 'day';
    const pays = await this.db.execute<{ t: Date | string; cents: Num; n: Num }>(sql`
      SELECT date_trunc(${trunc}, paid_at, 'UTC') AS t,
        sum(price_cents * (CASE WHEN currency = 'usd' THEN ${1 / s.eurToUsd}::float8 ELSE 1 END)) AS cents, count(*) AS n
      FROM purchases WHERE paid_at >= ${from.toISOString()}::timestamptz AND status IN ('paid', 'refunded')
      GROUP BY 1`);
    const payAt = new Map([...pays].map((p) => [new Date(p.t).toISOString(), p]));
    const stepH = grain === 'hour' ? 1 : 24;
    const out: CostSeriesPoint[] = [];
    const fixedPerHour =
      (plan.usdPerMonth * s.compute.instances +
        s.compute.workspaceUsdPerMonth +
        s.database.usdPerMonth +
        s.database.storageGb * s.database.storageUsdPerGbMonth) /
      730;
    const byT = new Map([...rows].map((r) => [new Date(r.t).toISOString(), r]));
    for (let t = from.getTime(); t <= now.getTime(); t += stepH * 3_600_000) {
      const key = new Date(t).toISOString();
      const r = byT.get(key);
      const p = payAt.get(key);
      const hours = Math.min(stepH, Math.max(0, (now.getTime() - t) / 3_600_000));
      if (hours <= 0) break;
      const bytes = n(r?.bytes);
      const over = Math.max(0, bytes / 1e9 - (s.bandwidth.includedGb * hours) / 730);
      const gross = (n(p?.cents) / 100) * s.eurToUsd;
      const fees =
        n(p?.n) * (s.stripe.fixedEurCents / 100) * s.eurToUsd + gross * (s.stripe.percent / 100);
      out.push({
        t: key,
        costUsd: fixedPerHour * hours + over * s.bandwidth.usdPerGb + fees,
        revenueNetUsd: gross / (1 + s.vatPercent / 100) - fees,
        playHours: n(r?.play) / 3600,
        cpuPct: hours > 0 ? (n(r?.cpu) / (hours * 3_600_000)) * 100 : 0,
        rssMb: hours > 0 ? n(r?.rss) / hours : 0,
        peakPlayers: n(r?.players),
        egressMb: bytes / 1e6,
      });
    }
    return out;
  }

  async dashboard(period: CostPeriod, now = new Date()): Promise<CostDashboard> {
    const { report } = await this.report(period, now);
    const live = this.live?.() ?? null;
    const { alerts, recommendations } = costAlerts(report, live, this.cached);
    const { users: _u, games: _g, ...light } = report;
    return {
      period,
      report: light,
      alerts,
      recommendations,
      series: await this.series(period, now),
      live,
    };
  }
}

function cpuOf(u: Usage): number {
  return u.cpuSimMs + u.cpuFlushMs + u.cpuOtherMs;
}
