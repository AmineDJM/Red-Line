import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { CostSettings, Usage } from '@redline/shared';
import type { Db } from '../db/client.js';
import { usageStats } from '../db/schema.js';

/**
 * Comptabilité de la consommation (docs/couts.md) : chaque coût mesurable est rapporté à une partie et/ou
 * à un utilisateur, accumulé en mémoire puis versé en base (table usage_stats, grains heure et jour)
 * toutes les `flushMs`. Mesures :
 *  - CPU : temps synchrone de simulation (advance, ordres), de diffusion (vues, diffs) et autre
 *    (instantanés, chargements, créations), mesuré autour des appels au moteur (un seul fil d'exécution :
 *    le temps écoulé est du temps CPU du processus) ;
 *  - mémoire résidente estimée d'une partie chargée (modèle CostSettings.memory), intégrée dans le temps ;
 *  - octets réseau réellement écrits sur la socket (WebSocket après permessage-deflate, HTTP) ;
 *  - temps de connexion des joueurs, ordres, notifications push, appels Stripe.
 */

export type CpuKind = 'sim' | 'flush' | 'other';

type Acc = Usage & {
  cpuProcessMs: number;
  rssMbH: number;
  rssMaxMb: number;
  peakPlayers: number;
  peakGames: number;
};

const zero = (): Acc => ({
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
  cpuProcessMs: 0,
  rssMbH: 0,
  rssMaxMb: 0,
  peakPlayers: 0,
  peakGames: 0,
});

/** Partie chargée vue par le compteur (fournie par l'hôte). */
export interface MeteredGame {
  id: string;
  /** Taille brute du dernier état sérialisé (octets). */
  rawStateBytes: number;
  connections: number;
  /** Connexions de joueurs (hors spectateurs) : utilisateur. */
  players: string[];
}

export interface UsageSources {
  games(): Iterable<MeteredGame>;
  connectedPlayers(): number;
}

export interface UsageMeterOptions {
  db: Db | null;
  log: FastifyBaseLogger;
  settings: () => CostSettings;
  sampleMs?: number;
  flushMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

export class UsageMeter {
  private games = new Map<string, Acc>();
  private users = new Map<string, Acc>();
  private server: Acc = zero();
  private sources: UsageSources | null = null;
  /** Fonctions appelées à chaque échantillon (octets écrits sur les WebSocket…). */
  readonly samplers: (() => void)[] = [];
  private lastSample: number;
  private lastCpu = process.cpuUsage();
  private sampleTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private lastPurge = 0;
  private readonly now: () => number;

  constructor(private readonly o: UsageMeterOptions) {
    this.now = o.now ?? Date.now;
    this.lastSample = this.now();
  }

  setSources(s: UsageSources): void {
    this.sources = s;
  }

  start(): void {
    if (this.sampleTimer) return;
    this.lastSample = this.now();
    this.lastCpu = process.cpuUsage();
    this.sampleTimer = setInterval(() => this.sample(), this.o.sampleMs ?? 15_000);
    this.sampleTimer.unref();
    this.flushTimer = setInterval(() => void this.flush(), this.o.flushMs ?? 60_000);
    this.flushTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.sampleTimer = this.flushTimer = null;
    this.sample();
    await this.flush();
  }

  private acc(map: Map<string, Acc>, key: string): Acc {
    let a = map.get(key);
    if (!a) map.set(key, (a = zero()));
    return a;
  }

  // ───────────── Enregistrement ─────────────

  cpu(gameId: string, kind: CpuKind, ms: number): void {
    if (!(ms > 0)) return;
    const field = kind === 'sim' ? 'cpuSimMs' : kind === 'flush' ? 'cpuFlushMs' : 'cpuOtherMs';
    this.acc(this.games, gameId)[field] += ms;
    this.server[field] += ms;
  }

  /** Mesure le temps synchrone d'une fonction et l'impute à la partie. */
  time<T>(gameId: string, kind: CpuKind, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.cpu(gameId, kind, performance.now() - t0);
    }
  }

  /** Octets WebSocket écrits pour un utilisateur dans une partie. */
  ws(userId: string, gameId: string | null, bytes: number, msgs = 0): void {
    if (bytes <= 0 && msgs <= 0) return;
    const u = this.acc(this.users, userId);
    u.wsBytes += bytes;
    u.wsMsgs += msgs;
    if (gameId) {
      const g = this.acc(this.games, gameId);
      g.wsBytes += bytes;
      g.wsMsgs += msgs;
    }
    this.server.wsBytes += bytes;
    this.server.wsMsgs += msgs;
  }

  /** Octets HTTP (réponse complète, en-têtes compris) ; utilisateur inconnu : coût partagé. */
  http(userId: string | null, bytes: number): void {
    if (bytes <= 0) return;
    if (userId) this.acc(this.users, userId).httpBytes += bytes;
    this.server.httpBytes += bytes;
  }

  order(gameId: string, userId: string): void {
    this.acc(this.games, gameId).orders++;
    this.acc(this.users, userId).orders++;
    this.server.orders++;
  }

  push(userId: string, n: number): void {
    if (n <= 0) return;
    this.acc(this.users, userId).pushSent += n;
    this.server.pushSent += n;
  }

  stripe(userId: string | null): void {
    if (userId) this.acc(this.users, userId).stripeCalls++;
    this.server.stripeCalls++;
  }

  /** Échantillon : mémoire estimée, temps de jeu, CPU du processus, RSS, pointes. */
  sample(): void {
    const now = this.now();
    const dtS = Math.max(0, (now - this.lastSample) / 1000);
    this.lastSample = now;
    for (const fn of this.samplers) {
      try {
        fn();
      } catch (err) {
        this.o.log.debug({ err }, 'échantillon de consommation en échec');
      }
    }
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.server.cpuProcessMs += (cpu.user + cpu.system) / 1000;
    const rss = process.memoryUsage.rss() / 1048576;
    this.server.rssMbH += (rss * dtS) / 3600;
    this.server.rssMaxMb = Math.max(this.server.rssMaxMb, rss);
    if (!this.sources) return;
    const m = this.o.settings().memory;
    let games = 0;
    for (const g of this.sources.games()) {
      games++;
      const mb =
        Math.max(m.mbMinPerGame, (g.rawStateBytes / 1048576) * m.mbPerStateMiB) +
        g.connections * m.mbPerConnection;
      const a = this.acc(this.games, g.id);
      a.memMbH += (mb * dtS) / 3600;
      this.server.memMbH += (mb * dtS) / 3600;
      for (const userId of new Set(g.players)) {
        a.playS += dtS;
        this.acc(this.users, userId).playS += dtS;
        this.server.playS += dtS;
      }
    }
    this.server.peakGames = Math.max(this.server.peakGames, games);
    this.server.peakPlayers = Math.max(this.server.peakPlayers, this.sources.connectedPlayers());
  }

  /** Mesures en attente (tests, diagnostic). */
  pending(): { server: Acc; games: Map<string, Acc>; users: Map<string, Acc> } {
    return { server: this.server, games: this.games, users: this.users };
  }

  // ───────────── Versement en base ─────────────

  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush()).catch(() => {});
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const db = this.o.db;
    const games = this.games;
    const users = this.users;
    const server = this.server;
    this.games = new Map();
    this.users = new Map();
    this.server = zero();
    if (!db) return;
    const now = new Date(this.now());
    const hour = new Date(now);
    hour.setUTCMinutes(0, 0, 0);
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const rows: (typeof usageStats.$inferInsert)[] = [];
    const push = (scope: 'server' | 'game' | 'user', key: string, a: Acc) => {
      const v = {
        cpuSimMs: a.cpuSimMs,
        cpuFlushMs: a.cpuFlushMs,
        cpuOtherMs: a.cpuOtherMs,
        cpuProcessMs: a.cpuProcessMs,
        memMbH: a.memMbH,
        rssMbH: a.rssMbH,
        rssMaxMb: a.rssMaxMb,
        wsBytes: Math.round(a.wsBytes),
        wsMsgs: Math.round(a.wsMsgs),
        httpBytes: Math.round(a.httpBytes),
        playS: a.playS,
        orders: a.orders,
        pushSent: a.pushSent,
        stripeCalls: a.stripeCalls,
        peakPlayers: a.peakPlayers,
        peakGames: a.peakGames,
      };
      rows.push({ grain: 'hour', periodStart: hour, scope, key, ...v });
      rows.push({ grain: 'day', periodStart: day, scope, key, ...v });
    };
    push('server', 'all', server);
    for (const [k, a] of games) push('game', k, a);
    for (const [k, a] of users) push('user', k, a);
    const add = (col: string) => sql.raw(`usage_stats.${col} + excluded.${col}`);
    const max = (col: string) => sql.raw(`greatest(usage_stats.${col}, excluded.${col})`);
    try {
      for (let i = 0; i < rows.length; i += 500) {
        await db
          .insert(usageStats)
          .values(rows.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [usageStats.grain, usageStats.periodStart, usageStats.scope, usageStats.key],
            set: {
              cpuSimMs: add('cpu_sim_ms'),
              cpuFlushMs: add('cpu_flush_ms'),
              cpuOtherMs: add('cpu_other_ms'),
              cpuProcessMs: add('cpu_process_ms'),
              memMbH: add('mem_mb_h'),
              rssMbH: add('rss_mb_h'),
              rssMaxMb: max('rss_max_mb'),
              wsBytes: add('ws_bytes'),
              wsMsgs: add('ws_msgs'),
              httpBytes: add('http_bytes'),
              playS: add('play_s'),
              orders: add('orders'),
              pushSent: add('push_sent'),
              stripeCalls: add('stripe_calls'),
              peakPlayers: max('peak_players'),
              peakGames: max('peak_games'),
            },
          });
      }
    } catch (err) {
      this.o.log.warn({ err }, 'comptabilité des coûts : versement en base en échec');
      return;
    }
    if (now.getTime() - this.lastPurge >= 3_600_000) {
      this.lastPurge = now.getTime();
      await this.purge(now).catch((err) =>
        this.o.log.warn({ err }, 'comptabilité des coûts : purge en échec'),
      );
    }
  }

  /** Rétention : agrégats horaires puis journaliers au-delà des durées réglées. */
  async purge(now = new Date(this.now())): Promise<number> {
    if (!this.o.db) return 0;
    const r = this.o.settings().retention;
    const hourLimit = new Date(now.getTime() - r.hourlyDays * 86_400_000);
    const dayLimit = new Date(now.getTime() - r.dailyDays * 86_400_000);
    const rows = await this.o.db.execute(sql`
      DELETE FROM usage_stats
      WHERE (grain = 'hour' AND period_start < ${hourLimit.toISOString()}::timestamptz)
         OR (grain = 'day' AND period_start < ${dayLimit.toISOString()}::timestamptz)
      RETURNING 1`);
    return [...rows].length;
  }
}
