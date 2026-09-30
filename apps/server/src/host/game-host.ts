import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, asc, inArray, ne } from 'drizzle-orm';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GameSetup, GameState, World } from '@redline/engine';
import type {
  AdminGame,
  Balance,
  ClientMessage,
  ClockState,
  CreateGameBody,
  GameMeta,
  GameNotification,
  NationId,
  Order,
  OrderErrorCode,
  PlayerView,
  ServerMessage,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import {
  gameOrders,
  gamePlayers,
  games,
  gameSnapshots,
  users,
  type PauseReason,
} from '../db/schema.js';
import { stateStats, type Engine } from '../engine.js';
import type { GameData, ScenarioFile } from '../data/loader.js';
import { HttpError } from '../auth/auth.js';
import { compressSnapshot, decompressSnapshot } from '../persistence/codec.js';
import type { ProcessMetrics } from '../metrics.js';
import { gameNow, realTimeFor, reanchor } from './clock.js';
import { LeaseManager } from './lease.js';
import { Scheduler } from './scheduler.js';
import type { WorldRegistry } from './worlds.js';

/** Une connexion WebSocket d'un joueur à une partie (la passerelle l'implémente). */
export interface Connection {
  readonly id: number;
  readonly userId: string;
  readonly nationId: NationId;
  /** Dernière vue envoyée à ce joueur (base des diffs). */
  lastView: PlayerView | null;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface PlayerSlot {
  slot: number;
  userId: string | null;
  nationId: NationId;
}

export interface HostedGame {
  id: string;
  meta: GameMeta;
  seed: number;
  releaseId: number | null;
  balance: Balance;
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
  worlds: WorldRegistry;
  metrics: ProcessMetrics;
  log: FastifyBaseLogger;
  instanceId: string;
  options: HostOptions;
}

const MAX_STEPS_PER_TICK = 100_000;
const MAX_PENDING_NOTES = 2000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class GameHost {
  readonly games = new Map<string, HostedGame>();
  readonly leases: LeaseManager;
  private readonly scheduler: Scheduler;
  private readonly loading = new Map<string, Promise<HostedGame | null>>();
  /** Parties dont la restauration a échoué dans ce processus (pas de nouvel essai automatique). */
  private readonly failed = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private beating = false;
  private stopped = false;

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
    const world = await this.d.worlds.get(releaseId, row.balance);
    const state = engine.deserializeState(world, await decompressSnapshot(snap.codec, snap.state));

    const orders = await this.d.db
      .select()
      .from(gameOrders)
      .where(and(eq(gameOrders.gameId, gameId), gt(gameOrders.seq, snap.lastOrderSeq)))
      .orderBy(asc(gameOrders.seq));
    const nationOfSlot = new Map(players.map((p) => [p.slot, p.nationId]));
    for (const o of orders) {
      const nation = nationOfSlot.get(o.playerSlot);
      if (!nation) continue;
      engine.advanceTo(state, Math.max(o.gameTimeMs, state.time));
      const r = engine.applyOrder(state, nation, o.payload as Order);
      if (!r.ok) {
        this.log.warn(
          { gameId, seq: o.seq, error: r.error },
          'rejeu : ordre refusé (non-déterminisme ?)',
        );
      }
    }

    const g: HostedGame = {
      id: gameId,
      meta: {
        id: gameId,
        name: row.name,
        mode: row.mode,
        scenarioId: row.scenarioId,
        status: row.status,
        speeds: row.speeds,
      },
      seed: row.seed,
      releaseId,
      balance: row.balance,
      world,
      state,
      clock: {
        anchorGame: row.anchorGameMs,
        anchorReal: row.anchorRealAt.getTime(),
        speed: row.speed,
        paused: row.status !== 'running',
      },
      pauseReason: row.pauseReason,
      players: players.map((p) => ({ slot: p.slot, userId: p.userId, nationId: p.nationId })),
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
      for (const g of this.games.values()) keep.add(this.d.worlds.key(g.releaseId, g.balance));
      this.d.worlds.prune(keep);
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
      this.collect(g, engine.advanceTo(g.state, t));
      steps++;
      lastT = t;
      changed = true;
    }
    if (g.state.time < target) {
      const notes = engine.advanceTo(g.state, target);
      if (notes.length) changed = true;
      this.collect(g, notes);
    }
    if (steps) this.d.metrics.recordEvents(steps);
    if (changed || g.state.time !== t0) g.dirty = true;
    if (g.ended && g.meta.status !== 'ended') this.endGame(g, now);
    return changed;
  }

  private collect(g: HostedGame, notes: GameNotification[]): void {
    if (notes.length === 0) return;
    if (notes.some((n) => n.kind === 'victory')) g.ended = true;
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
    this.persistClock(g, { ended: true });
    this.broadcast(g, { t: 'clock', clock: g.clock });
    this.log.info({ gameId: g.id }, 'partie terminée');
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

  /** Envoie à chaque joueur connecté le diff de SA vue (viewFor) et SES notifications (notificationsFor). */
  private flush(g: HostedGame, now: number): void {
    g.flushDue = null;
    g.lastFlush = now;
    const notes = g.pendingNotes;
    g.pendingNotes = [];
    if (g.connections.size === 0) return;
    const engine = this.engine;
    const views = new Map<NationId, PlayerView>();
    const noteMap = new Map<NationId, GameNotification[]>();
    for (const c of g.connections) {
      let view = views.get(c.nationId);
      if (!view) {
        view = engine.viewFor(g.state, c.nationId);
        views.set(c.nationId, view);
      }
      if (c.lastView && c.lastView !== view) {
        const diff = engine.diffViews(c.lastView, view);
        if (diff) c.send({ t: 'diff', diff });
      }
      c.lastView = view;
      if (notes.length) {
        let mine = noteMap.get(c.nationId);
        if (!mine) {
          mine = engine.notificationsFor(g.state, c.nationId, notes);
          noteMap.set(c.nationId, mine);
        }
        if (mine.length) c.send({ t: 'notify', items: mine });
      }
    }
  }

  private broadcast(g: HostedGame, msg: ServerMessage): void {
    for (const c of g.connections) {
      try {
        c.send(msg);
      } catch {
        /* connexion morte : la passerelle la retirera */
      }
    }
  }

  // ───────────────────────────── Joueurs ─────────────────────────────

  /** Abonne une connexion : envoie 'welcome' avec la vue complète du joueur. */
  async attach(gameId: string, conn: Connection): Promise<HostedGame | null> {
    const g = await this.ensureLoaded(gameId);
    if (!g) return null;
    const now = Date.now();
    const ok = this.safely(g, () => {
      if (!g.errored && !g.clock.paused && this.advance(g, now)) this.flush(g, now);
      conn.lastView = this.engine.viewFor(g.state, conn.nationId);
    });
    if (!ok || !conn.lastView) {
      conn.lastView = null;
      // Partie suspendue sur erreur : on envoie quand même l'horloge, sans vue.
      return g.errored ? g : null;
    }
    conn.send({
      t: 'welcome',
      game: g.meta,
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
    if (g.connections.size === 0) {
      g.pendingNotes = [];
      g.flushDue = null;
      this.reschedule(g);
    }
  }

  handleOrder(g: HostedGame, conn: Connection, msg: Extract<ClientMessage, { t: 'order' }>): void {
    const reply = (ok: boolean, error?: OrderErrorCode, message?: string) =>
      conn.send({ t: 'orderResult', id: msg.id, ok, error, message });
    if (!this.games.has(g.id)) return reply(false, 'not_allowed', 'Partie indisponible');
    if (g.meta.status === 'ended') return reply(false, 'game_over', 'La partie est terminée');
    if (g.errored) return reply(false, 'not_allowed', 'La partie est suspendue');
    const now = Date.now();
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
      this.journal(g, { seq: g.orderSeq, slot, time: g.state.time, order: msg.order });
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

  // ───────────────────────────── Création ─────────────────────────────

  async createSoloGame(
    userId: string,
    body: CreateGameBody,
    scenario: ScenarioFile,
  ): Promise<{ meta: GameMeta; nationId: NationId }> {
    if (this.stopped) throw new HttpError(503, 'shutting_down', 'Serveur en cours d’arrêt');
    const engine = this.engine;
    const { world, releaseId, balance } = await this.d.worlds.forNewGames();
    const nation = this.d.data.nationsById.get(body.nationId)!;
    const speeds = balance.time.speeds;
    const speed = speeds.includes(body.speed) ? body.speed : (speeds[0] ?? 1);
    const seed = randomInt(0, 2 ** 31 - 1);
    const setup: GameSetup = {
      seed,
      players: [{ nationId: body.nationId, isAi: false }],
      ...(scenario.nationIds ? { nationIds: scenario.nationIds } : {}),
    };
    const state = engine.createGame(world, setup);
    const id = randomUUID();
    const now = Date.now();
    const meta: GameMeta = {
      id,
      name: `${scenario.name} — ${nation.name}`,
      mode: 'solo',
      scenarioId: scenario.id,
      status: 'running',
      speeds,
    };
    const clock: ClockState = { anchorGame: state.time, anchorReal: now, speed, paused: false };
    await this.d.db.transaction(async (tx) => {
      await tx.insert(games).values({
        id,
        name: meta.name,
        scenarioId: scenario.id,
        status: 'running',
        mode: 'solo',
        speed,
        speeds,
        seed,
        catalogReleaseId: releaseId,
        balance,
        setup: { ...setup, aiLevel: body.aiLevel } as unknown as Record<string, unknown>,
        anchorGameMs: clock.anchorGame,
        anchorRealAt: new Date(now),
        gameTimeMs: state.time,
        leaseOwner: this.d.instanceId,
        leaseUntil: new Date(now + this.d.options.leaseTtlS * 1000),
        createdBy: userId,
      });
      await tx.insert(gamePlayers).values({ gameId: id, slot: 0, userId, nationId: body.nationId });
    });
    const g: HostedGame = {
      id,
      meta,
      seed,
      releaseId,
      balance,
      world,
      state,
      clock,
      pauseReason: null,
      players: [{ slot: 0, userId, nationId: body.nationId }],
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
    };
    this.games.set(id, g);
    await this.snapshot(g, true);
    this.reschedule(g);
    return { meta, nationId: body.nationId };
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
    rec: { seq: number; slot: number; time: number; order: Order },
  ): void {
    const owner = this.d.instanceId;
    void this.chain(g, 'journal', async () => {
      const rows = await this.d.sql`
        INSERT INTO game_orders (game_id, seq, player_slot, game_time_ms, payload)
        SELECT ${g.id}::uuid, ${rec.seq}::int, ${rec.slot}::int, ${rec.time}::float8, ${JSON.stringify(rec.order)}::jsonb
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
          anchor_real_at = ${new Date(clock.anchorReal).toISOString()}::timestamptz
        WHERE id = ${g.id} AND lease_owner = ${owner}`;
      await this.d.sql`DELETE FROM game_snapshots WHERE game_id = ${g.id} AND seq <= ${seq - keep}`;
    });
  }

  async snapshotAll(force: boolean): Promise<void> {
    await Promise.all([...this.games.values()].map((g) => this.snapshot(g, force)));
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
   * Applique une nouvelle release du catalogue aux parties en cours hébergées ici :
   * serializeState puis deserializeState(nouveauMonde), instantané immédiat, avis aux joueurs.
   */
  async applyReleaseToRunning(releaseId: number, notice: string): Promise<number> {
    const engine = this.engine;
    let count = 0;
    for (const g of [...this.games.values()]) {
      if (g.errored || g.meta.status === 'ended') continue;
      const world = await this.d.worlds.get(releaseId, g.balance);
      const now = Date.now();
      const ok = this.safely(g, () => {
        if (!g.clock.paused) this.advance(g, now);
        const bytes = engine.serializeState(g.state);
        g.state = engine.deserializeState(world, bytes);
        g.world = world;
        g.releaseId = releaseId;
      });
      if (!ok) continue;
      count++;
      await this.snapshot(g, true);
      this.broadcast(g, { t: 'error', code: 'admin_notice', message: notice });
      this.safely(g, () => this.flush(g, now));
      this.reschedule(g);
    }
    return count;
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
      const meta: GameMeta = g?.meta ?? {
        id: r.id,
        name: r.name,
        mode: r.mode,
        scenarioId: r.scenarioId,
        status: r.status,
        speeds: r.speeds,
      };
      return {
        game: { ...meta },
        players: players
          .filter((x) => x.p.gameId === r.id)
          .map((x) => ({ nationId: x.p.nationId, userName: x.name, isAi: x.p.userId === null })),
        gameTime,
        ...stats,
      };
    });
  }

  connectedPlayers(): number {
    const users = new Set<string>();
    for (const g of this.games.values()) for (const c of g.connections) users.add(c.userId);
    return users.size;
  }
}
