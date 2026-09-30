import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, asc, inArray, ne, sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GameSetup, GameState, GameStats, SystemCommand, World } from '@redline/engine';
import {
  BalanceSchema,
  type AdminGame,
  type Balance,
  type ClientMessage,
  type ClockState,
  type CreateGameBody,
  type GameMeta,
  type GameNotification,
  type NationId,
  type Order,
  type OrderErrorCode,
  type PlayerView,
  type ServerMessage,
  type ShopPolicy,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import {
  gameOrders,
  gamePlayers,
  games,
  gameSnapshots,
  timelapseFrames,
  users,
  type PauseReason,
} from '../db/schema.js';
import { stateStats, type Engine } from '../engine.js';
import type { GameData, ScenarioFile } from '../data/loader.js';
import type { DataStore } from '../data/store.js';
import { HttpError } from '../auth/auth.js';
import { compressSnapshot, decompressSnapshot } from '../persistence/codec.js';
import type { ProcessMetrics } from '../metrics.js';
import { gameNow, realTimeFor, reanchor } from './clock.js';
import { LeaseManager } from './lease.js';
import { Scheduler } from './scheduler.js';
import type { WorldPin, WorldRegistry } from './worlds.js';

/** Une connexion WebSocket à une partie (la passerelle l'implémente). */
export interface Connection {
  readonly id: number;
  readonly userId: string;
  /** Nation du joueur ; chaîne vide pour un spectateur. */
  readonly nationId: NationId;
  /** Spectateur : vue publique, lecture seule. */
  readonly spectator?: boolean;
  readonly userName?: string;
  /** Dernière vue envoyée à ce joueur (base des diffs). */
  lastView: PlayerView | null;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface PlayerSlot {
  slot: number;
  userId: string | null;
  nationId: NationId;
  /** Une IA remplace le joueur (inactif ou parti). */
  isAi: boolean;
  lastActiveAt: number | null;
}

export interface GameSettings {
  maxPlayers: number;
  shopPolicy: ShopPolicy;
  inactiveAiAfterH: number;
  isPrivate: boolean;
  victory: { provinceShare: number; allEnemyCapitals: boolean } | null;
  createdAt: Date;
  startedAt: Date | null;
  createdBy: string | null;
}

export interface HostedGame {
  id: string;
  meta: GameMeta;
  settings: GameSettings;
  seed: number;
  releaseId: number | null;
  balance: Balance;
  dataRev: number;
  world: World;
  state: GameState;
  clock: ClockState;
  pauseReason: PauseReason | null;
  players: PlayerSlot[];
  orderSeq: number;
  snapshotSeq: number;
  /** Modifiée depuis le dernier instantané. */
  dirty: boolean;
  connections: Set<Connection>;
  pendingNotes: GameNotification[];
  flushDue: number | null;
  lastFlush: number;
  /** Écritures en base de la partie, sérialisées (journal, instantanés, horloge). */
  writes: Promise<void>;
  errored: boolean;
  stuckWarned: boolean;
  ended: boolean;
  winner: NationId | null;
  /** Timelapse : dernier jour de jeu enregistré et propriétaires correspondants. */
  lastFrameDay: number;
  lastFrame: Record<string, NationId> | null;
  /** Taille du dernier instantané compressé (octets). */
  stateBytes: number;
}

export interface HostOptions {
  /** Intervalle minimal entre deux diffs d'une partie (ms). */
  flushIntervalMs: number;
  snapshotIntervalS: number;
  leaseTtlS: number;
  /** Nombre d'instantanés conservés par partie. */
  keepSnapshots: number;
}

interface HostDeps {
  engine: Engine | null;
  db: Db;
  sql: postgres.Sql;
  data: GameData;
  store: DataStore;
  worlds: WorldRegistry;
  metrics: ProcessMetrics;
  log: FastifyBaseLogger;
  instanceId: string;
  options: HostOptions;
  /** Vitesses de test ajoutées à celles de l'équilibrage (vide en production). */
  extraSpeeds?: number[];
}

type GameRow = typeof games.$inferSelect;

const MAX_STEPS_PER_TICK = 100_000;
const MAX_PENDING_NOTES = 2000;
export const DAY_MS = 86_400_000;
/** Écriture de last_active_at au plus toutes les N ms par joueur. */
const ACTIVE_WRITE_MS = 60_000;
const INACTIVE_CHECK_MS = 60_000;
/** Notifications publiques envoyées aux spectateurs (aucun secret). */
const PUBLIC_NOTES = new Set<GameNotification['kind']>([
  'province_captured',
  'nation_defeated',
  'victory',
  'war_declared',
  'peace_signed',
  'council',
  'news',
  'alert_level',
]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Fusion profonde (objets seulement ; tableaux et scalaires remplacés). Idempotente. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out as T;
}

/** Méta publique d'une partie à partir de sa ligne en base. */
export function metaOf(r: GameRow, playerCount?: number): GameMeta {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    scenarioId: r.scenarioId,
    status: r.status,
    speeds: r.speeds,
    maxPlayers: r.maxPlayers,
    ...(playerCount !== undefined ? { playerCount } : {}),
    shopPolicy: r.shopPolicy,
    ...(r.victory ? { victory: r.victory } : {}),
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
  };
}

function settingsOf(r: GameRow): GameSettings {
  return {
    maxPlayers: r.maxPlayers,
    shopPolicy: r.shopPolicy,
    inactiveAiAfterH: r.inactiveAiAfterH,
    isPrivate: r.isPrivate,
    victory: r.victory ?? null,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    createdBy: r.createdBy,
  };
}

/** Écouteurs branchés par les autres services (notifications push, classements…). */
export interface HostListeners {
  /** Notifications brutes produites par le moteur (appel synchrone : l'état est cohérent). */
  notes: ((g: HostedGame, notes: GameNotification[]) => void)[];
  /** Partie terminée (statistiques finales du moteur si disponibles). */
  ended: ((g: HostedGame, stats: GameStats | null) => Promise<void>)[];
}

export class GameHost {
  readonly games = new Map<string, HostedGame>();
  readonly leases: LeaseManager;
  readonly listeners: HostListeners = { notes: [], ended: [] };
  private readonly scheduler: Scheduler;
  private readonly loading = new Map<string, Promise<HostedGame | null>>();
  /** Parties dont la restauration a échoué dans ce processus (pas de nouvel essai automatique). */
  private readonly failed = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private beating = false;
  private stopped = false;
  private lastInactiveCheck = 0;

  constructor(private readonly d: HostDeps) {
    this.leases = new LeaseManager(d.sql, d.instanceId, d.options.leaseTtlS);
    this.scheduler = new Scheduler((id) => this.tick(id));
  }

  private get engine(): Engine {
    if (!this.d.engine) throw new HttpError(503, 'engine_unavailable', 'Moteur indisponible');
    return this.d.engine;
  }

  private get log(): FastifyBaseLogger {
    return this.d.log;
  }

  pinOf(g: HostedGame): WorldPin {
    return { releaseId: g.releaseId, balance: g.balance, dataRev: g.dataRev };
  }

  // ───────────────────────────── Cycle de vie ─────────────────────────────

  async start(): Promise<void> {
    const reason = this.d.worlds.unavailableReason();
    if (reason) {
      this.log.warn(`parties en cours non chargées : ${reason.message}`);
    } else {
      await this.adoptOrphans();
    }
    const beatMs = Math.max(200, (this.d.options.leaseTtlS * 1000) / 3);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), beatMs);
    this.heartbeatTimer.unref();
    this.snapshotTimer = setInterval(
      () => void this.snapshotAll(false),
      this.d.options.snapshotIntervalS * 1000,
    );
    this.snapshotTimer.unref();
  }

  /** Arrêt propre : instantané de chaque partie, puis libération des baux. */
  async stop(opts: { snapshot?: boolean; release?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.scheduler.stop();
    await Promise.allSettled([...this.loading.values()]);
    for (const g of this.games.values()) {
      for (const c of g.connections) {
        try {
          c.close(1012, 'Redémarrage du serveur');
        } catch {
          /* ignore */
        }
      }
      g.connections.clear();
    }
    if (opts.snapshot !== false) {
      await this.snapshotAll(true).catch((err) =>
        this.log.error({ err }, "échec des instantanés d'arrêt"),
      );
    }
    await Promise.allSettled([...this.games.values()].map((g) => g.writes));
    if (opts.release !== false) {
      await this.leases
        .release([...this.games.keys()])
        .catch((err) => this.log.error({ err }, 'échec de la libération des baux'));
    }
    this.games.clear();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  // ───────────────────────────── Chargement, bail ─────────────────────────────

  /** Partie hébergée ici, après acquisition du bail et restauration si besoin ; null sinon. */
  async ensureLoaded(gameId: string): Promise<HostedGame | null> {
    if (this.stopped) return null;
    const g = this.games.get(gameId);
    if (g) return g;
    let p = this.loading.get(gameId);
    if (!p) {
      p = this.load(gameId).finally(() => this.loading.delete(gameId));
      this.loading.set(gameId, p);
    }
    return p;
  }

  private async load(gameId: string): Promise<HostedGame | null> {
    if (this.d.worlds.unavailableReason() || this.failed.has(gameId)) return null;
    if (!(await this.leases.tryAcquire(gameId))) return null;
    try {
      const g = await this.restore(gameId);
      if (this.stopped) return null;
      this.games.set(gameId, g);
      this.reschedule(g);
      this.log.info({ gameId, time: g.state.time, orders: g.orderSeq }, 'partie chargée');
      return g;
    } catch (err) {
      this.failed.add(gameId);
      this.log.error({ err, gameId }, 'échec de la restauration de la partie');
      await this.d.sql`
        UPDATE games SET status = CASE WHEN status = 'ended' THEN status ELSE 'paused' END,
          pause_reason = CASE WHEN status = 'ended' THEN pause_reason ELSE 'error' END,
          last_error = ${`restauration : ${errText(err)}`.slice(0, 2000)}
        WHERE id = ${gameId}`.catch(() => {});
      await this.leases.release([gameId]).catch(() => {});
      return null;
    }
  }

  /** Dernier instantané + rejeu des ordres postérieurs + rattrapage jusqu'à maintenant. */
  private async restore(gameId: string): Promise<HostedGame> {
    const engine = this.engine;
    const [row] = await this.d.db.select().from(games).where(eq(games.id, gameId));
    if (!row) throw new Error('partie introuvable');
    const players = await this.d.db
      .select()
      .from(gamePlayers)
      .where(eq(gamePlayers.gameId, gameId))
      .orderBy(asc(gamePlayers.slot));
    const [snap] = await this.d.db
      .select()
      .from(gameSnapshots)
      .where(eq(gameSnapshots.gameId, gameId))
      .orderBy(desc(gameSnapshots.seq))
      .limit(1);
    if (!snap) throw new Error('aucun instantané');
    const releaseId = snap.catalogReleaseId ?? row.catalogReleaseId;
    const pin: WorldPin = { releaseId, balance: row.balance, dataRev: row.dataRev };
    const world = await this.d.worlds.get(pin);
    const state = engine.deserializeState(world, await decompressSnapshot(snap.codec, snap.state));

    const orders = await this.d.db
      .select()
      .from(gameOrders)
      .where(and(eq(gameOrders.gameId, gameId), gt(gameOrders.seq, snap.lastOrderSeq)))
      .orderBy(asc(gameOrders.seq));
    const nationOfSlot = new Map(players.map((p) => [p.slot, p.nationId]));
    for (const o of orders) {
      engine.advanceTo(state, Math.max(o.gameTimeMs, state.time));
      const payload = o.payload as { sys?: SystemCommand };
      let r: { ok: boolean; error?: string };
      if (o.playerSlot < 0 && payload.sys) {
        if (!engine.applySystem) continue;
        r = engine.applySystem(state, payload.sys);
      } else {
        const nation = nationOfSlot.get(o.playerSlot);
        if (!nation) continue;
        r = engine.applyOrder(state, nation, o.payload as Order);
      }
      if (!r.ok) {
        this.log.warn(
          { gameId, seq: o.seq, error: r.error },
          'rejeu : ordre refusé (non-déterminisme ?)',
        );
      }
    }

    // Timelapse : reconstitue la dernière image enregistrée.
    const frames = await this.d.db
      .select()
      .from(timelapseFrames)
      .where(eq(timelapseFrames.gameId, gameId))
      .orderBy(asc(timelapseFrames.day));
    let lastFrame: Record<string, NationId> | null = null;
    for (const f of frames) lastFrame = { ...(lastFrame ?? {}), ...f.delta };

    const g: HostedGame = {
      id: gameId,
      meta: metaOf(row, players.filter((p) => p.userId).length),
      settings: settingsOf(row),
      seed: row.seed,
      releaseId,
      balance: row.balance,
      dataRev: row.dataRev,
      world,
      state,
      clock: {
        anchorGame: row.anchorGameMs,
        anchorReal: row.anchorRealAt.getTime(),
        speed: row.speed,
        paused: row.status !== 'running',
      },
      pauseReason: row.pauseReason,
      players: players.map((p) => ({
        slot: p.slot,
        userId: p.userId,
        nationId: p.nationId,
        isAi: p.isAiReplacement,
        lastActiveAt: p.lastActiveAt?.getTime() ?? null,
      })),
      orderSeq: Math.max(snap.lastOrderSeq, orders.at(-1)?.seq ?? 0, row.lastOrderSeq),
      snapshotSeq: snap.seq,
      dirty: orders.length > 0,
      connections: new Set(),
      pendingNotes: [],
      flushDue: null,
      lastFlush: 0,
      writes: Promise.resolve(),
      errored: false,
      stuckWarned: false,
      ended: row.status === 'ended',
      winner: row.winner as NationId | null,
      lastFrameDay: frames.at(-1)?.day ?? -1,
      lastFrame,
      stateBytes: row.stateBytes,
    };
    // Rattrapage du temps écoulé pendant l'arrêt (aucun joueur connecté : pas de notification).
    this.advance(g, Date.now());
    return g;
  }

  private async heartbeat(): Promise<void> {
    if (this.beating || this.stopped) return;
    this.beating = true;
    try {
      const ids = [...this.games.keys()];
      const held = await this.leases.heartbeat(ids);
      for (const id of ids) {
        const g = this.games.get(id);
        if (g && !held.has(id)) this.leaseLost(g);
      }
      // Parties terminées sans spectateur : on libère la mémoire.
      for (const g of [...this.games.values()]) {
        if (g.ended && g.connections.size === 0) await this.unload(g, true);
      }
      if (!this.d.worlds.unavailableReason()) await this.adoptOrphans();
      const keep = new Set<string>();
      for (const g of this.games.values()) keep.add(this.d.worlds.key(this.pinOf(g)));
      this.d.worlds.prune(keep);
      const now = Date.now();
      if (now - this.lastInactiveCheck >= INACTIVE_CHECK_MS) {
        this.lastInactiveCheck = now;
        await this.checkInactive(now);
      }
    } catch (err) {
      this.log.error({ err }, 'battement de cœur des baux en échec');
    } finally {
      this.beating = false;
    }
  }

  /** Force un battement (tests). */
  async beat(): Promise<void> {
    while (this.beating) await new Promise((r) => setTimeout(r, 5));
    await this.heartbeat();
  }

  private async adoptOrphans(): Promise<void> {
    const ids = await this.leases.orphans();
    for (const id of ids) {
      if (this.stopped) return;
      if (!this.games.has(id) && !this.failed.has(id)) await this.ensureLoaded(id);
    }
  }

  private leaseLost(g: HostedGame): void {
    this.log.warn({ gameId: g.id }, 'bail perdu : la partie est simulée ailleurs');
    this.scheduler.delete(g.id);
    this.games.delete(g.id);
    for (const c of g.connections) {
      c.send({ t: 'moved' });
      c.send({
        t: 'error',
        code: 'game_moved',
        message: 'La partie a changé de serveur, reconnexion…',
      });
      c.close(1012, 'Partie déplacée');
    }
    g.connections.clear();
  }

  private async unload(g: HostedGame, snapshot: boolean): Promise<void> {
    this.scheduler.delete(g.id);
    this.games.delete(g.id);
    if (snapshot && !g.errored) await this.snapshot(g, true).catch(() => {});
    await g.writes.catch(() => {});
    await this.leases.release([g.id]).catch(() => {});
  }

  // ───────────────────────────── Simulation ─────────────────────────────

  /** Avance la partie jusqu'au temps de jeu courant. Renvoie vrai si des événements ont été traités. */
  private advance(g: HostedGame, now: number): boolean {
    const engine = this.engine;
    const target = Math.max(g.state.time, gameNow(g.clock, now));
    const t0 = g.state.time;
    let steps = 0;
    let lastT = -Infinity;
    let changed = false;
    while (steps < MAX_STEPS_PER_TICK) {
      const next = engine.nextEventTime(g.state);
      if (next === null || next > target) break;
      const t = Math.max(next, g.state.time);
      if (steps > 0 && t <= lastT) break; // garde-fou : événement non consommé
      this.recordFrame(g, t);
      this.collect(g, engine.advanceTo(g.state, t));
      steps++;
      lastT = t;
      changed = true;
    }
    if (g.state.time < target) {
      this.recordFrame(g, target);
      const notes = engine.advanceTo(g.state, target);
      if (notes.length) changed = true;
      this.collect(g, notes);
    }
    if (steps) this.d.metrics.recordEvents(steps);
    if (changed || g.state.time !== t0) g.dirty = true;
    if (g.ended && g.meta.status !== 'ended') this.endGame(g, now);
    return changed;
  }

  /**
   * Timelapse : les frontières ne changent qu'aux événements, donc l'état courant vaut pour chaque
   * changement de jour franchi jusqu'à `upTo`. On n'écrit que les provinces qui ont changé.
   */
  private recordFrame(g: HostedGame, upTo: number, force = false): void {
    const engine = this.d.engine;
    if (!engine?.ownersFrame) return;
    const day = Math.floor(upTo / DAY_MS);
    if (!force && day <= g.lastFrameDay) return;
    const owners = engine.ownersFrame(g.state);
    const delta: Record<string, NationId> = {};
    if (!g.lastFrame) Object.assign(delta, owners);
    else for (const [p, o] of Object.entries(owners)) if (g.lastFrame[p] !== o) delta[p] = o;
    const frameDay = Math.max(day, g.lastFrameDay, 0);
    g.lastFrameDay = frameDay;
    g.lastFrame = owners;
    if (Object.keys(delta).length === 0) return;
    const json = JSON.stringify(delta);
    void this.chain(g, 'timelapse', async () => {
      await this.d.sql`
        INSERT INTO timelapse_frames (game_id, day, delta)
        VALUES (${g.id}::uuid, ${frameDay}::int, ${json}::jsonb)
        ON CONFLICT (game_id, day) DO UPDATE SET delta = timelapse_frames.delta || EXCLUDED.delta`;
    });
  }

  private collect(g: HostedGame, notes: GameNotification[]): void {
    if (notes.length === 0) return;
    for (const n of notes) {
      if (n.kind === 'victory') {
        g.ended = true;
        g.winner = n.winner;
      }
    }
    for (const l of this.listeners.notes) {
      try {
        l(g, notes);
      } catch (err) {
        this.log.error({ err, gameId: g.id }, 'écouteur de notifications en échec');
      }
    }
    if (g.connections.size === 0) return;
    for (const n of notes) g.pendingNotes.push(n);
    if (g.pendingNotes.length > MAX_PENDING_NOTES) {
      g.pendingNotes.splice(0, g.pendingNotes.length - MAX_PENDING_NOTES);
    }
  }

  private endGame(g: HostedGame, now: number): void {
    g.meta.status = 'ended';
    g.clock = reanchor(g.clock, now, g.state.time, { paused: true });
    g.pauseReason = null;
    g.dirty = true;
    this.recordFrame(g, g.state.time, true);
    this.persistClock(g, { ended: true });
    this.broadcast(g, { t: 'clock', clock: g.clock });
    this.log.info({ gameId: g.id, winner: g.winner }, 'partie terminée');
    let stats: GameStats | null = null;
    try {
      stats = this.d.engine?.stats?.(g.state) ?? null;
    } catch (err) {
      this.log.error({ err, gameId: g.id }, 'statistiques de fin de partie en échec');
    }
    const winner = g.winner;
    const owner = this.d.instanceId;
    void this.chain(g, 'fin de partie', async () => {
      await this.d.sql`
        UPDATE games SET winner = ${winner}, final_stats = ${stats ? JSON.stringify(stats) : null}::jsonb
        WHERE id = ${g.id} AND lease_owner = ${owner}`;
      for (const l of this.listeners.ended) {
        try {
          await l(g, stats);
        } catch (err) {
          this.log.error({ err, gameId: g.id }, 'traitement de fin de partie en échec');
        }
      }
    });
  }

  /** Appelé par l'ordonnanceur global à l'échéance de la partie. */
  private tick(id: string): void {
    const g = this.games.get(id);
    if (!g || this.stopped) return;
    const now = Date.now();
    this.safely(g, () => {
      if (!g.errored && !g.clock.paused) {
        if (this.advance(g, now)) this.requestFlush(g, now);
      }
      if (g.flushDue !== null && g.flushDue <= now) this.flush(g, now);
    });
    this.reschedule(g, true);
  }

  private reschedule(g: HostedGame, afterTick = false): void {
    if (this.stopped || !this.games.has(g.id)) return;
    const now = Date.now();
    let at: number | null = null;
    if (!g.errored && !g.clock.paused && g.meta.status !== 'ended') {
      try {
        const next = this.engine.nextEventTime(g.state);
        if (next !== null) {
          if (afterTick && next <= g.state.time) {
            // Le moteur annonce un événement déjà passé : on évite de boucler à vide.
            if (!g.stuckWarned) {
              this.log.warn({ gameId: g.id, next, time: g.state.time }, 'événement non consommé');
              g.stuckWarned = true;
            }
            at = now + 1000;
          } else {
            at = realTimeFor(g.clock, Math.max(next, g.state.time));
          }
        }
        // Timelapse : on se réveille au moins à chaque changement de jour de jeu.
        if (this.d.engine?.ownersFrame) {
          const nextDay = realTimeFor(g.clock, (Math.floor(g.state.time / DAY_MS) + 1) * DAY_MS);
          if (nextDay !== null) at = at === null ? nextDay : Math.min(at, nextDay);
        }
      } catch (err) {
        this.fail(g, err);
      }
    }
    if (g.flushDue !== null) at = at === null ? g.flushDue : Math.min(at, g.flushDue);
    this.scheduler.set(g.id, at);
  }

  private safely(g: HostedGame, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.fail(g, err);
      return false;
    }
  }

  /** Isolation : une exception suspend la partie concernée, jamais le processus ni les autres parties. */
  private fail(g: HostedGame, err: unknown): void {
    if (g.errored) return;
    this.log.error({ err, gameId: g.id }, 'erreur de simulation : partie suspendue');
    g.errored = true;
    const now = Date.now();
    g.clock = { anchorGame: g.state.time, anchorReal: now, speed: g.clock.speed, paused: true };
    if (g.meta.status !== 'ended') g.meta.status = 'paused';
    g.pauseReason = 'error';
    g.flushDue = null;
    g.pendingNotes = [];
    this.scheduler.delete(g.id);
    this.persistClock(g, { lastError: errText(err) });
    this.broadcast(g, {
      t: 'error',
      code: 'game_error',
      message: 'Erreur interne : la partie est suspendue. Un administrateur a été prévenu.',
    });
    this.broadcast(g, { t: 'clock', clock: g.clock });
  }

  // ───────────────────────────── Diffusion ─────────────────────────────

  private requestFlush(g: HostedGame, now: number): void {
    if (g.connections.size === 0) {
      g.pendingNotes = [];
      return;
    }
    if (g.flushDue === null)
      g.flushDue = Math.max(now, g.lastFlush + this.d.options.flushIntervalMs);
  }

  /** Vue d'une connexion : vue du joueur (viewFor) ou vue publique (spectateur). */
  private viewOf(g: HostedGame, c: Connection): PlayerView {
    if (c.spectator) {
      const pv = this.engine.publicView;
      if (!pv) throw new HttpError(503, 'spectate_unavailable', 'Mode spectateur indisponible');
      return pv(g.state);
    }
    return this.engine.viewFor(g.state, c.nationId);
  }

  /**
   * Envoie à chaque connexion le diff de SA vue (viewFor, ou publicView pour un spectateur) et SES
   * notifications (notificationsFor, ou notifications publiques pour un spectateur).
   */
  private flush(g: HostedGame, now: number): void {
    g.flushDue = null;
    g.lastFlush = now;
    const notes = g.pendingNotes;
    g.pendingNotes = [];
    if (g.connections.size === 0) return;
    const engine = this.engine;
    const views = new Map<string, PlayerView>();
    const noteMap = new Map<string, GameNotification[]>();
    for (const c of g.connections) {
      const key = c.spectator ? '\u0000spectator' : c.nationId;
      let view = views.get(key);
      if (!view) {
        view = this.viewOf(g, c);
        views.set(key, view);
      }
      if (c.lastView && c.lastView !== view) {
        const diff = engine.diffViews(c.lastView, view);
        if (diff) c.send({ t: 'diff', diff });
      }
      c.lastView = view;
      if (notes.length) {
        let mine = noteMap.get(key);
        if (!mine) {
          mine = c.spectator
            ? notes.filter((n) => PUBLIC_NOTES.has(n.kind))
            : engine.notificationsFor(g.state, c.nationId, notes);
          noteMap.set(key, mine);
        }
        if (mine.length) c.send({ t: 'notify', items: mine });
      }
    }
  }

  broadcast(g: HostedGame, msg: ServerMessage, filter?: (c: Connection) => boolean): void {
    for (const c of g.connections) {
      if (filter && !filter(c)) continue;
      try {
        c.send(msg);
      } catch {
        /* connexion morte : la passerelle la retirera */
      }
    }
  }

  /** Avis (administration, remplacement par une IA…) à tous les joueurs connectés. */
  notice(g: HostedGame, text: string, level: 'info' | 'warn' = 'info'): void {
    this.broadcast(g, { t: 'notice', level, text });
  }

  // ───────────────────────────── Joueurs ─────────────────────────────

  /** Abonne une connexion : envoie 'welcome' avec la vue complète (ou publique pour un spectateur). */
  async attach(gameId: string, conn: Connection): Promise<HostedGame | null> {
    const g = await this.ensureLoaded(gameId);
    if (!g) return null;
    const now = Date.now();
    if (!conn.spectator) this.playerReturned(g, conn.userId, now);
    const ok = this.safely(g, () => {
      if (!g.errored && !g.clock.paused && this.advance(g, now)) this.flush(g, now);
      conn.lastView = this.viewOf(g, conn);
    });
    if (!ok || !conn.lastView) {
      conn.lastView = null;
      // Partie suspendue sur erreur : on envoie quand même l'horloge, sans vue.
      return g.errored ? g : null;
    }
    conn.send({
      t: 'welcome',
      game: conn.spectator ? { ...g.meta, spectator: true } : g.meta,
      me: conn.nationId,
      clock: g.clock,
      view: conn.lastView,
    });
    if (g.errored) {
      conn.send({
        t: 'error',
        code: 'game_error',
        message: 'La partie est suspendue après une erreur interne.',
      });
    }
    g.connections.add(conn);
    this.reschedule(g);
    return g;
  }

  detach(gameId: string, conn: Connection): void {
    const g = this.games.get(gameId);
    if (!g) return;
    g.connections.delete(conn);
    if (!conn.spectator) this.touch(g, conn.userId, Date.now(), true);
    if (g.connections.size === 0) {
      g.pendingNotes = [];
      g.flushDue = null;
      this.reschedule(g);
    }
  }

  /** Vrai si l'utilisateur a une connexion de joueur ouverte sur la partie. */
  isConnected(g: HostedGame, userId: string): boolean {
    for (const c of g.connections) if (!c.spectator && c.userId === userId) return true;
    return false;
  }

  /** Activité du joueur (ordres, connexion) : base du remplacement par une IA. */
  private touch(g: HostedGame, userId: string, now: number, force = false): void {
    const p = g.players.find((x) => x.userId === userId);
    if (!p) return;
    const prev = p.lastActiveAt;
    p.lastActiveAt = now;
    if (!force && prev !== null && now - prev < ACTIVE_WRITE_MS) return;
    void this.chain(g, 'activité', async () => {
      await this.d.db
        .update(gamePlayers)
        .set({ lastActiveAt: new Date(now) })
        .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, p.slot)));
    });
  }

  /** Retour d'un joueur remplacé par une IA pour inactivité : il reprend la main. */
  private playerReturned(g: HostedGame, userId: string, now: number): void {
    const p = g.players.find((x) => x.userId === userId);
    if (!p) return;
    this.touch(g, userId, now, true);
    if (!p.isAi || g.meta.status === 'ended') return;
    const r = this.applySystemNow(g, { kind: 'setAi', nationId: p.nationId, isAi: false });
    if (!r.ok && r.error !== 'unsupported') return;
    p.isAi = false;
    void this.chain(g, 'retour du joueur', async () => {
      await this.d.db
        .update(gamePlayers)
        .set({ isAiReplacement: false, aiSince: null })
        .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, p.slot)));
    });
    this.notice(g, `Le joueur de ${this.nationName(p.nationId)} a repris le contrôle de sa nation.`);
    this.log.info({ gameId: g.id, nation: p.nationId }, 'joueur de retour : IA retirée');
  }

  private nationName(id: NationId): string {
    return this.d.store.current().nationsById.get(id)?.name ?? id;
  }

  /**
   * Remplace par une IA les joueurs inactifs depuis `inactiveAiAfterH` heures réelles (multijoueur,
   * joueurs non connectés). Appelé périodiquement ; `now` injectable pour les tests.
   */
  async checkInactive(now = Date.now()): Promise<number> {
    let replaced = 0;
    for (const g of this.games.values()) {
      if (g.meta.mode !== 'multi' || g.meta.status === 'ended' || g.errored) continue;
      const limitMs = g.settings.inactiveAiAfterH * 3_600_000;
      for (const p of g.players) {
        if (!p.userId || p.isAi) continue;
        if (this.isConnected(g, p.userId)) continue;
        const last = p.lastActiveAt ?? g.settings.startedAt?.getTime() ?? now;
        if (now - last < limitMs) continue;
        const r = this.applySystemNow(g, {
          kind: 'setAi',
          nationId: p.nationId,
          isAi: true,
          aiLevel: 'normal',
        });
        if (!r.ok && r.error !== 'unsupported') continue;
        p.isAi = true;
        replaced++;
        const slot = p.slot;
        await this.chain(g, 'remplacement IA', async () => {
          await this.d.db
            .update(gamePlayers)
            .set({ isAiReplacement: true, aiSince: new Date(now) })
            .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, slot)));
        });
        this.notice(
          g,
          `${this.nationName(p.nationId)} est désormais tenue par une IA (joueur inactif).`,
        );
        this.log.info({ gameId: g.id, nation: p.nationId }, 'joueur inactif remplacé par une IA');
      }
    }
    return replaced;
  }

  handleOrder(g: HostedGame, conn: Connection, msg: Extract<ClientMessage, { t: 'order' }>): void {
    const reply = (ok: boolean, error?: OrderErrorCode, message?: string) =>
      conn.send({ t: 'orderResult', id: msg.id, ok, error, message });
    if (conn.spectator) return reply(false, 'not_allowed', 'Mode spectateur : lecture seule');
    if (!this.games.has(g.id)) return reply(false, 'not_allowed', 'Partie indisponible');
    if (g.meta.status === 'ended') return reply(false, 'game_over', 'La partie est terminée');
    if (g.errored) return reply(false, 'not_allowed', 'La partie est suspendue');
    const now = Date.now();
    this.playerReturned(g, conn.userId, now);
    let result: { ok: boolean; error?: OrderErrorCode; message?: string } = { ok: false };
    const ok = this.safely(g, () => {
      this.advance(g, now);
      result = this.engine.applyOrder(g.state, conn.nationId, msg.order);
    });
    if (!ok) return reply(false, 'not_allowed', 'Erreur interne : la partie est suspendue');
    if (result.ok) {
      g.orderSeq += 1;
      g.dirty = true;
      const slot = g.players.find((p) => p.nationId === conn.nationId)?.slot ?? 0;
      this.journal(g, { seq: g.orderSeq, slot, time: g.state.time, payload: msg.order });
    }
    reply(result.ok, result.error, result.message);
    // Rediffusion immédiate (pas d'attente de la fenêtre de 200 ms).
    this.safely(g, () => this.flush(g, now));
    this.reschedule(g);
  }

  handleControl(
    g: HostedGame,
    conn: Connection,
    msg: Extract<ClientMessage, { t: 'control' }>,
  ): void {
    const err = (code: string, message: string) => conn.send({ t: 'error', code, message });
    if (conn.spectator) return err('read_only', 'Mode spectateur : lecture seule');
    if (g.meta.mode !== 'solo')
      return err('not_allowed', 'Vitesse et pause : parties solo uniquement');
    if (g.meta.status === 'ended') return err('game_over', 'La partie est terminée');
    if (msg.speed !== undefined && !g.meta.speeds.includes(msg.speed)) {
      return err('invalid_speed', `Vitesses autorisées : ${g.meta.speeds.join(', ')}`);
    }
    if (msg.paused === false && (g.pauseReason === 'admin' || g.pauseReason === 'error')) {
      return err('not_allowed', "La partie a été suspendue par l'administration");
    }
    if (msg.speed === undefined && msg.paused === undefined) return;
    this.setClock(g, { speed: msg.speed, paused: msg.paused }, 'player');
  }

  private setClock(
    g: HostedGame,
    change: { speed?: number; paused?: boolean },
    reason: PauseReason,
  ): void {
    const now = Date.now();
    if (!g.errored && !g.clock.paused) {
      this.safely(g, () => {
        if (this.advance(g, now)) this.requestFlush(g, now);
      });
    }
    g.clock = reanchor(g.clock, now, g.state.time, change);
    if (change.paused !== undefined && g.meta.status !== 'ended') {
      g.meta.status = change.paused ? 'paused' : 'running';
      g.pauseReason = change.paused ? reason : null;
    }
    g.dirty = true;
    this.persistClock(g);
    this.broadcast(g, { t: 'clock', clock: g.clock });
    this.reschedule(g);
  }

  // ───────────────────────────── Commandes système ─────────────────────────────

  /**
   * Applique une commande système (IA, joueur ajouté, accélération, événement mondial) à l'instant
   * courant, la journalise (rejouée à la reprise) et rediffuse. `unsupported` si le moteur ne l'expose pas.
   */
  private applySystemNow(
    g: HostedGame,
    cmd: SystemCommand,
  ): { ok: boolean; error?: OrderErrorCode | 'unsupported'; message?: string } {
    const engine = this.engine;
    if (!engine.applySystem) {
      return { ok: false, error: 'unsupported', message: 'Commande système non gérée par le moteur' };
    }
    if (g.errored) return { ok: false, error: 'not_allowed', message: 'La partie est suspendue' };
    const now = Date.now();
    let result: { ok: boolean; error?: OrderErrorCode; message?: string } = { ok: false };
    const ok = this.safely(g, () => {
      if (!g.clock.paused) this.advance(g, now);
      result = engine.applySystem!(g.state, cmd);
    });
    if (!ok) return { ok: false, error: 'not_allowed', message: 'Erreur interne' };
    if (result.ok) {
      g.orderSeq += 1;
      g.dirty = true;
      this.journal(g, { seq: g.orderSeq, slot: -1, time: g.state.time, payload: { sys: cmd } });
      this.safely(g, () => this.flush(g, now));
      this.reschedule(g);
    }
    return result;
  }

  /** Commande système sur une partie (chargée ici si besoin). */
  async system(
    gameId: string,
    cmd: SystemCommand,
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const g = await this.ensureLoaded(gameId);
    if (!g) return { ok: false, error: 'game_unavailable', message: 'Partie indisponible' };
    if (g.meta.status === 'ended') {
      return { ok: false, error: 'game_over', message: 'La partie est terminée' };
    }
    return this.applySystemNow(g, cmd);
  }

  /** Ferme les connexions d'un utilisateur (bannissement). */
  kickUser(userId: string, reason: string): void {
    for (const g of this.games.values()) {
      for (const c of [...g.connections]) {
        if (c.userId !== userId) continue;
        c.send({ t: 'error', code: 'banned', message: reason });
        c.close(1008, 'Compte suspendu');
        g.connections.delete(c);
      }
    }
  }

  // ───────────────────────────── Création ─────────────────────────────

  /** Équilibrage d'une nouvelle partie : courant + surcharges du scénario (si valides). */
  private balanceFor(scenario: ScenarioFile): Balance {
    const base = this.d.store.current().balance!;
    if (!scenario.balanceOverrides) return base;
    const r = BalanceSchema.safeParse(deepMerge(base, scenario.balanceOverrides));
    if (!r.success) {
      this.log.warn({ scenario: scenario.id }, 'surcharges d’équilibrage du scénario invalides');
      return base;
    }
    return r.data;
  }

  private async prepare(opts: {
    scenario: ScenarioFile;
    players: { nationId: NationId; isAi: boolean }[];
    speed: number;
    victory: { provinceShare: number; allEnemyCapitals: boolean } | null;
    aiLevel: 'easy' | 'normal' | 'hard';
  }) {
    if (this.stopped) throw new HttpError(503, 'shutting_down', 'Serveur en cours d’arrêt');
    const engine = this.engine;
    const { world, pin } = await this.d.worlds.forNewGames(this.balanceFor(opts.scenario));
    const seed = randomInt(0, 2 ** 31 - 1);
    const setup: GameSetup = {
      seed,
      players: opts.players.map((p) => ({ ...p, aiLevel: opts.aiLevel })),
      ...(opts.scenario.nationIds ? { nationIds: opts.scenario.nationIds } : {}),
      scenario: opts.scenario,
      speed: opts.speed,
      ...(opts.victory ? { victory: opts.victory } : {}),
    };
    const state = engine.createGame(world, setup);
    return { world, pin, seed, setup, state };
  }

  /** Vitesses autorisées (équilibrage + vitesses d'essai). */
  allowedSpeeds(): number[] {
    const b = this.d.store.current().balance;
    return [...(b?.time.speeds ?? []), ...(this.d.extraSpeeds ?? [])];
  }

  private hostNew(opts: {
    id: string;
    row: GameRow;
    prepared: Awaited<ReturnType<GameHost['prepare']>>;
    players: PlayerSlot[];
    clock: ClockState;
  }): Promise<void> {
    const { prepared, row } = opts;
    const g: HostedGame = {
      id: opts.id,
      meta: metaOf(row, opts.players.filter((p) => p.userId).length),
      settings: settingsOf(row),
      seed: prepared.seed,
      releaseId: prepared.pin.releaseId,
      balance: prepared.pin.balance,
      dataRev: prepared.pin.dataRev,
      world: prepared.world,
      state: prepared.state,
      clock: opts.clock,
      pauseReason: null,
      players: opts.players,
      orderSeq: 0,
      snapshotSeq: 0,
      dirty: true,
      connections: new Set(),
      pendingNotes: [],
      flushDue: null,
      lastFlush: 0,
      writes: Promise.resolve(),
      errored: false,
      stuckWarned: false,
      ended: false,
      winner: null,
      lastFrameDay: -1,
      lastFrame: null,
      stateBytes: 0,
    };
    this.games.set(opts.id, g);
    this.recordFrame(g, g.state.time, true);
    const p = this.snapshot(g, true);
    this.reschedule(g);
    return p;
  }

  async createSoloGame(
    userId: string,
    body: CreateGameBody,
    scenario: ScenarioFile,
  ): Promise<{ meta: GameMeta; nationId: NationId }> {
    const nation = this.d.store.current().nationsById.get(body.nationId)!;
    const speeds = this.allowedSpeeds();
    const speed = speeds.includes(body.speed) ? body.speed : (speeds[0] ?? 1);
    const prepared = await this.prepare({
      scenario,
      players: [{ nationId: body.nationId, isAi: false }],
      speed,
      victory: null,
      aiLevel: body.aiLevel,
    });
    const id = randomUUID();
    const now = Date.now();
    const clock: ClockState = {
      anchorGame: prepared.state.time,
      anchorReal: now,
      speed,
      paused: false,
    };
    const row = await this.d.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(games)
        .values({
          id,
          name: `${scenario.name} — ${nation.name}`,
          scenarioId: scenario.id,
          status: 'running',
          mode: 'solo',
          speed,
          speeds,
          seed: prepared.seed,
          catalogReleaseId: prepared.pin.releaseId,
          balance: prepared.pin.balance,
          dataRev: prepared.pin.dataRev,
          setup: {
            ...prepared.setup,
            scenario: undefined,
            scenarioId: scenario.id,
            aiLevel: body.aiLevel,
          } as unknown as Record<string, unknown>,
          anchorGameMs: clock.anchorGame,
          anchorRealAt: new Date(now),
          gameTimeMs: prepared.state.time,
          leaseOwner: this.d.instanceId,
          leaseUntil: new Date(now + this.d.options.leaseTtlS * 1000),
          createdBy: userId,
          maxPlayers: 1,
          startedAt: new Date(now),
        })
        .returning();
      await tx.insert(gamePlayers).values({
        gameId: id,
        slot: 0,
        userId,
        nationId: body.nationId,
        lastActiveAt: new Date(now),
      });
      return r!;
    });
    await this.hostNew({
      id,
      row,
      prepared,
      players: [
        { slot: 0, userId, nationId: body.nationId, isAi: false, lastActiveAt: now },
      ],
      clock,
    });
    return { meta: this.games.get(id)?.meta ?? metaOf(row, 1), nationId: body.nationId };
  }

  /**
   * Démarre une partie du salon : création de l'état moteur avec les joueurs inscrits, puis passage à
   * 'running' (transition atomique : un seul démarrage même en cas d'appels concurrents).
   */
  async startLobbyGame(gameId: string, scenario: ScenarioFile): Promise<GameMeta> {
    const [row0] = await this.d.db.select().from(games).where(eq(games.id, gameId));
    if (!row0) throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (row0.status !== 'lobby') throw new HttpError(409, 'already_started', 'Partie déjà lancée');
    const players = await this.d.db
      .select()
      .from(gamePlayers)
      .where(eq(gamePlayers.gameId, gameId))
      .orderBy(asc(gamePlayers.slot));
    const setupAi = (row0.setup as { aiLevel?: 'easy' | 'normal' | 'hard' }).aiLevel ?? 'normal';
    // Multijoueur : toutes les nations sans joueur humain sont des IA ACTIVES au niveau choisi.
    const humans = new Set(players.map((p) => p.nationId));
    const all = scenario.nationIds ?? (this.d.store.current().map?.nations ?? []).map((n) => n.id);
    const prepared = await this.prepare({
      scenario,
      players: [
        ...players.map((p) => ({ nationId: p.nationId, isAi: false })),
        ...all.filter((n) => !humans.has(n)).map((nationId) => ({ nationId, isAi: true })),
      ],
      speed: row0.speed,
      victory: row0.victory ?? null,
      aiLevel: setupAi,
    });
    const now = Date.now();
    const clock: ClockState = {
      anchorGame: prepared.state.time,
      anchorReal: now,
      speed: row0.speed,
      paused: false,
    };
    const [row] = await this.d.db
      .update(games)
      .set({
        status: 'running',
        seed: prepared.seed,
        catalogReleaseId: prepared.pin.releaseId,
        balance: prepared.pin.balance,
        dataRev: prepared.pin.dataRev,
        setup: {
          ...prepared.setup,
          scenario: undefined,
          scenarioId: scenario.id,
          aiLevel: setupAi,
        } as unknown as Record<string, unknown>,
        anchorGameMs: clock.anchorGame,
        anchorRealAt: new Date(now),
        gameTimeMs: prepared.state.time,
        leaseOwner: this.d.instanceId,
        leaseUntil: new Date(now + this.d.options.leaseTtlS * 1000),
        startedAt: new Date(now),
      })
      .where(and(eq(games.id, gameId), eq(games.status, 'lobby')))
      .returning();
    if (!row) throw new HttpError(409, 'already_started', 'Partie déjà lancée');
    await this.hostNew({
      id: gameId,
      row,
      prepared,
      players: players.map((p) => ({
        slot: p.slot,
        userId: p.userId,
        nationId: p.nationId,
        isAi: false,
        lastActiveAt: now,
      })),
      clock,
    });
    this.log.info({ gameId, players: players.length }, 'partie multijoueur démarrée');
    return this.games.get(gameId)?.meta ?? metaOf(row, players.length);
  }

  /** Arrivée d'un joueur dans une partie multijoueur en cours (nation tenue par une IA). */
  async joinRunning(gameId: string, userId: string, nationId: NationId): Promise<GameMeta> {
    const g = await this.ensureLoaded(gameId);
    if (!g) throw new HttpError(409, 'game_unavailable', 'Partie momentanément indisponible');
    if (g.meta.status === 'ended') throw new HttpError(409, 'game_over', 'Partie terminée');
    if (g.players.some((p) => p.userId === userId)) {
      throw new HttpError(409, 'already_joined', 'Vous jouez déjà dans cette partie');
    }
    const humans = g.players.filter((p) => p.userId).length;
    if (humans >= g.settings.maxPlayers) throw new HttpError(409, 'game_full', 'Partie complète');
    const existing = g.players.find((p) => p.nationId === nationId);
    if (existing?.userId) throw new HttpError(409, 'nation_taken', 'Nation déjà prise');
    const r = this.applySystemNow(g, { kind: 'addPlayer', nationId });
    if (!r.ok && r.error !== 'unsupported') {
      throw new HttpError(409, 'join_refused', r.message ?? 'Arrivée refusée par le moteur');
    }
    const now = Date.now();
    if (existing) {
      existing.userId = userId;
      existing.isAi = false;
      existing.lastActiveAt = now;
      await this.d.db
        .update(gamePlayers)
        .set({ userId, isAiReplacement: false, aiSince: null, lastActiveAt: new Date(now) })
        .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.slot, existing.slot)));
    } else {
      const slot = Math.max(-1, ...g.players.map((p) => p.slot)) + 1;
      await this.d.db.insert(gamePlayers).values({
        gameId,
        slot,
        userId,
        nationId,
        lastActiveAt: new Date(now),
      });
      g.players.push({ slot, userId, nationId, isAi: false, lastActiveAt: now });
    }
    g.meta.playerCount = g.players.filter((p) => p.userId).length;
    this.notice(g, `Un nouveau joueur prend la tête de ${this.nationName(nationId)}.`);
    return g.meta;
  }

  /** Départ définitif d'un joueur d'une partie en cours : sa nation passe à l'IA. */
  async leaveRunning(gameId: string, userId: string): Promise<void> {
    const g = await this.ensureLoaded(gameId);
    if (!g) throw new HttpError(409, 'game_unavailable', 'Partie momentanément indisponible');
    const p = g.players.find((x) => x.userId === userId);
    if (!p) throw new HttpError(404, 'not_found', 'Vous ne jouez pas dans cette partie');
    if (g.meta.status !== 'ended') {
      this.applySystemNow(g, { kind: 'setAi', nationId: p.nationId, isAi: true, aiLevel: 'normal' });
    }
    p.userId = null;
    p.isAi = true;
    await this.d.db
      .update(gamePlayers)
      .set({ userId: null, isAiReplacement: true, aiSince: new Date() })
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.slot, p.slot)));
    for (const c of [...g.connections]) {
      if (c.userId === userId && !c.spectator) {
        c.close(1000, 'Partie quittée');
        g.connections.delete(c);
      }
    }
    g.meta.playerCount = g.players.filter((x) => x.userId).length;
    this.notice(g, `${this.nationName(p.nationId)} est désormais tenue par une IA.`);
  }

  // ───────────────────────────── Persistance ─────────────────────────────

  private chain(g: HostedGame, what: string, fn: () => Promise<void>): Promise<void> {
    const p = g.writes.then(fn).catch((err) => {
      this.log.error({ err, gameId: g.id }, `écriture en base en échec (${what})`);
    });
    g.writes = p;
    return p;
  }

  private journal(
    g: HostedGame,
    rec: { seq: number; slot: number; time: number; payload: unknown },
  ): void {
    const owner = this.d.instanceId;
    void this.chain(g, 'journal', async () => {
      const rows = await this.d.sql`
        INSERT INTO game_orders (game_id, seq, player_slot, game_time_ms, payload)
        SELECT ${g.id}::uuid, ${rec.seq}::int, ${rec.slot}::int, ${rec.time}::float8, ${JSON.stringify(rec.payload)}::jsonb
        WHERE EXISTS (SELECT 1 FROM games WHERE id = ${g.id} AND lease_owner = ${owner})
        RETURNING seq`;
      if (rows.length === 0 && this.games.get(g.id) === g) this.leaseLost(g);
    });
  }

  private persistClock(g: HostedGame, extra: { lastError?: string; ended?: boolean } = {}): void {
    const owner = this.d.instanceId;
    const status = g.meta.status;
    const c = g.clock;
    const time = g.state.time;
    void this.chain(g, 'horloge', async () => {
      await this.d.sql`
        UPDATE games SET status = ${status}, pause_reason = ${g.pauseReason}, speed = ${c.speed},
          anchor_game_ms = ${c.anchorGame}, anchor_real_at = ${new Date(c.anchorReal).toISOString()}::timestamptz,
          game_time_ms = ${time},
          last_error = COALESCE(${extra.lastError?.slice(0, 2000) ?? null}::text, last_error),
          ended_at = CASE WHEN ${extra.ended ?? false}::boolean THEN now() ELSE ended_at END
        WHERE id = ${g.id} AND lease_owner = ${owner}`;
    });
  }

  /** Instantané compressé de la partie (si modifiée, ou forcé). */
  snapshot(g: HostedGame, force = false): Promise<void> {
    const now = Date.now();
    // Modifiée = ordres, horloge ou événements depuis le dernier instantané, ou temps de jeu qui a avancé.
    const modified = g.dirty || (!g.clock.paused && gameNow(g.clock, now) > g.state.time);
    if (g.errored || (!force && !modified)) return g.writes;
    const engine = this.engine;
    let bytes: Uint8Array;
    let hash: string;
    const ok = this.safely(g, () => {
      if (!g.clock.paused && this.advance(g, now)) {
        this.requestFlush(g, now);
        this.reschedule(g);
      }
      bytes = engine.serializeState(g.state);
      hash = engine.stateHash(g.state);
    });
    if (!ok) return g.writes;
    g.dirty = false;
    const seq = ++g.snapshotSeq;
    const lastOrderSeq = g.orderSeq;
    const time = g.state.time;
    const releaseId = g.releaseId;
    const owner = this.d.instanceId;
    const keep = this.d.options.keepSnapshots;
    const clock = g.clock;
    const status = g.meta.status;
    return this.chain(g, 'instantané', async () => {
      const { codec, data } = await compressSnapshot(bytes!);
      g.stateBytes = data.length;
      const rows = await this.d.sql`
        INSERT INTO game_snapshots (game_id, seq, game_time_ms, last_order_seq, catalog_release_id, codec, state_hash, state)
        SELECT ${g.id}::uuid, ${seq}::int, ${time}::float8, ${lastOrderSeq}::int, ${releaseId}::int, ${codec}::text, ${hash!}::text, ${data}::bytea
        WHERE EXISTS (SELECT 1 FROM games WHERE id = ${g.id} AND lease_owner = ${owner})
        RETURNING seq`;
      if (rows.length === 0) {
        if (this.games.get(g.id) === g) this.leaseLost(g);
        return;
      }
      await this.d.sql`
        UPDATE games SET game_time_ms = ${time}, last_order_seq = ${lastOrderSeq},
          catalog_release_id = ${releaseId}, status = ${status}, pause_reason = ${g.pauseReason},
          speed = ${clock.speed}, anchor_game_ms = ${clock.anchorGame},
          anchor_real_at = ${new Date(clock.anchorReal).toISOString()}::timestamptz,
          state_bytes = ${data.length}
        WHERE id = ${g.id} AND lease_owner = ${owner}`;
      await this.d.sql`DELETE FROM game_snapshots WHERE game_id = ${g.id} AND seq <= ${seq - keep}`;
    });
  }

  async snapshotAll(force: boolean): Promise<void> {
    await Promise.all([...this.games.values()].map((g) => this.snapshot(g, force)));
  }

  /** Attend la fin des écritures en cours d'une partie (tests, routes qui relisent la base). */
  async settle(gameId: string): Promise<void> {
    const g = this.games.get(gameId);
    if (!g) return;
    let w: Promise<void>;
    do {
      w = g.writes;
      await w;
    } while (w !== g.writes);
  }

  // ───────────────────────────── Administration ─────────────────────────────

  async adminSetPaused(gameId: string, paused: boolean): Promise<boolean> {
    let g = this.games.get(gameId);
    if (!paused) {
      if (g?.errored) {
        // Reprise après erreur : on repart du dernier instantané + journal.
        await this.unload(g, false);
        g = undefined;
      }
      this.failed.delete(gameId);
      if (!g) {
        await this.d.sql`
          UPDATE games SET pause_reason = NULL, last_error = NULL
          WHERE id = ${gameId} AND status = 'paused' AND pause_reason = 'error'`;
      }
    }
    g ??= (await this.ensureLoaded(gameId)) ?? undefined;
    if (!g || g.meta.status === 'ended') return false;
    this.setClock(g, { paused }, 'admin');
    return true;
  }

  /**
   * Applique une nouvelle épingle (release du catalogue, équilibrage, révision des données) aux parties
   * en cours hébergées ici : serializeState puis deserializeState(nouveauMonde), instantané immédiat,
   * avis aux joueurs.
   */
  async applyPinToRunning(
    change: (g: HostedGame) => Partial<WorldPin> | null,
    notice: string,
  ): Promise<number> {
    const engine = this.engine;
    let count = 0;
    for (const g of [...this.games.values()]) {
      if (g.errored || g.meta.status === 'ended') continue;
      const delta = change(g);
      if (!delta) continue;
      const pin: WorldPin = { ...this.pinOf(g), ...delta };
      const world = await this.d.worlds.get(pin);
      const now = Date.now();
      const ok = this.safely(g, () => {
        if (!g.clock.paused) this.advance(g, now);
        const bytes = engine.serializeState(g.state);
        g.state = engine.deserializeState(world, bytes);
        g.world = world;
        g.releaseId = pin.releaseId;
        g.balance = pin.balance;
        g.dataRev = pin.dataRev;
      });
      if (!ok) continue;
      count++;
      const owner = this.d.instanceId;
      void this.chain(g, 'épingle', async () => {
        await this.d.sql`
          UPDATE games SET catalog_release_id = ${pin.releaseId}, data_rev = ${pin.dataRev},
            balance = ${JSON.stringify(pin.balance)}::jsonb
          WHERE id = ${g.id} AND lease_owner = ${owner}`;
      });
      await this.snapshot(g, true);
      this.notice(g, notice);
      this.safely(g, () => this.flush(g, now));
      this.reschedule(g);
    }
    return count;
  }

  /** Compatibilité : nouvelle release du catalogue appliquée aux parties en cours. */
  applyReleaseToRunning(releaseId: number, notice: string): Promise<number> {
    return this.applyPinToRunning(() => ({ releaseId }), notice);
  }

  async adminGames(): Promise<AdminGame[]> {
    const rows = await this.d.db
      .select()
      .from(games)
      .where(ne(games.status, 'ended'))
      .orderBy(desc(games.createdAt))
      .limit(500);
    const ids = rows.map((r) => r.id);
    const players = ids.length
      ? await this.d.db
          .select({ p: gamePlayers, name: users.displayName })
          .from(gamePlayers)
          .leftJoin(users, eq(users.id, gamePlayers.userId))
          .where(inArray(gamePlayers.gameId, ids))
      : [];
    return rows.map((r) => {
      const g = this.games.get(r.id);
      let gameTime = gameNow(
        {
          anchorGame: r.anchorGameMs,
          anchorReal: r.anchorRealAt.getTime(),
          speed: r.speed,
          paused: r.status !== 'running',
        },
        Date.now(),
      );
      let stats = { unitCount: 0, queueSize: 0 };
      if (g && this.d.engine) {
        gameTime = g.state.time;
        stats = stateStats(this.d.engine, g.state);
      }
      const mine = players.filter((x) => x.p.gameId === r.id);
      const meta: GameMeta = g?.meta ?? metaOf(r, mine.filter((x) => x.p.userId).length);
      return {
        game: { ...meta },
        players: mine.map((x) => ({
          nationId: x.p.nationId,
          userName: x.name,
          isAi: x.p.userId === null || x.p.isAiReplacement,
        })),
        gameTime,
        ...stats,
      };
    });
  }

  connectedPlayers(): number {
    const users = new Set<string>();
    for (const g of this.games.values())
      for (const c of g.connections) if (!c.spectator) users.add(c.userId);
    return users.size;
  }

  spectators(): number {
    let n = 0;
    for (const g of this.games.values()) for (const c of g.connections) if (c.spectator) n++;
    return n;
  }

  /** Métriques étendues (parties hébergées ici). */
  hostStats(): { running: number; paused: number; ended: number; stateBytes: number } {
    const out = { running: 0, paused: 0, ended: 0, stateBytes: 0 };
    for (const g of this.games.values()) {
      if (g.meta.status === 'running') out.running++;
      else if (g.meta.status === 'paused') out.paused++;
      else if (g.meta.status === 'ended') out.ended++;
      out.stateBytes += g.stateBytes;
    }
    return out;
  }

  /** Nombre de parties par statut en base (toutes instances). */
  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.d.db
      .select({ status: games.status, n: dsql<number>`count(*)::int` })
      .from(games)
      .groupBy(games.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
