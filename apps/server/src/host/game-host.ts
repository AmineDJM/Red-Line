import { createHash, randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, asc, inArray, ne, sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GameSetup, GameState, GameStats, SystemCommand, World } from '@redline/engine';
import {
  BalanceSchema,
  frDe,
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
import type { CpuKind, MeteredGame, UsageMeter } from '../costs/usage.js';
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
  /** Compte en mode illimité (lu en base à l'ouverture de la connexion). */
  readonly unlimited?: boolean;
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
  /** IA imposée par l'administration : le joueur ne reprend pas la main en revenant. */
  aiForced: boolean;
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
  /**
   * Diffusion en cours, découpée en tranches (une tranche par nation) pour ne jamais bloquer la boucle
   * d'événements : clés de vue restant à traiter et notifications capturées au début de la diffusion.
   */
  flushQueue: string[] | null;
  flushNotes: GameNotification[];
  /** Une diffusion a été demandée pendant la diffusion en cours. */
  flushAgain: boolean;
  /** Coût CPU (ms) de la dernière diffusion complète : espace les diffusions suivantes (adaptatif). */
  flushCostMs: number;
  /** Simulation en retard sur l'horloge (rattrapage découpé en tranches). */
  behind: boolean;
  /** Dernier instant (réel) où la partie avait au moins une connexion de joueur. */
  idleSince: number | null;
  /** IA lointaines en veille (commande système 'dormancy' journalisée). */
  dormant: boolean;
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
  /** Taille brute du dernier état sérialisé (octets) : base de l'estimation de la mémoire résidente. */
  rawStateBytes: number;
  /** Comptes en mode illimité parmi les joueurs (users.unlimited) : nations illimitées dans le moteur. */
  unlimitedUsers: Set<string>;
}

export interface HostOptions {
  /** Intervalle minimal entre deux diffs d'une partie (ms). */
  flushIntervalMs: number;
  snapshotIntervalS: number;
  leaseTtlS: number;
  /** Nombre d'instantanés conservés par partie. */
  keepSnapshots: number;
  /**
   * Budget CPU (ms) d'une tranche de travail synchrone (simulation ou diffusion) avant de rendre la main
   * à la boucle d'événements. Défaut : 40 ms.
   */
  sliceBudgetMs?: number;
  /** Part maximale du processeur consacrée aux diffusions d'une partie (0 à 1). Défaut : 0,35. */
  flushCpuShare?: number;
  /**
   * Aucun joueur humain connecté depuis ce délai : les IA lointaines (hors de portée des joueurs, en
   * paix avec eux) mettent leurs décisions en veille jusqu'au retour d'un joueur. La partie continue.
   */
  dormancyDelayMs?: number;
  /** Partie multijoueur sans aucun joueur humain connecté depuis ce délai : terminée et fermée. */
  multiAbandonMs?: number;
  /** Partie solo dont le joueur ne s'est pas connecté depuis ce délai : terminée et fermée. */
  soloAbandonMs?: number;
  /** Partie en pause sans aucune connexion depuis ce délai : déchargée de la mémoire (instantané). */
  idleUnloadMs?: number;
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
  /** Comptabilité des coûts (CPU par partie). */
  usage?: UsageMeter;
}

type GameRow = typeof games.$inferSelect;

const MAX_STEPS_PER_TICK = 100_000;
const DEFAULT_SLICE_MS = 40;
const DEFAULT_FLUSH_SHARE = 0.35;
/** Au-delà, un travail synchrone est journalisé (latence ressentie par tous les joueurs). */
const SLOW_MS = 250;
const DEFAULT_DORMANCY_DELAY_MS = 5 * 60_000;
const DEFAULT_MULTI_ABANDON_MS = 24 * 3_600_000;
const DEFAULT_SOLO_ABANDON_MS = 48 * 3_600_000;
const DEFAULT_IDLE_UNLOAD_MS = 10 * 60_000;
/** Clé de vue des spectateurs (vue publique commune). */
const SPECTATOR_KEY = '\u0000spectator';

/** Rend la main à la boucle d'événements (E/S, autres parties) entre deux tranches de travail. */
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const nowMs = () => performance.now();
const MAX_PENDING_NOTES = 2000;
export const DAY_MS = 86_400_000;

/**
 * Cadence de base de l'horloge (équilibrage figé de la partie) ; absente = temps réel × vitesse. Les
 * vitesses d'essai (REDLINE_EXTRA_SPEEDS, hors équilibrage) restent absolues.
 */
function rateOf(balance: Balance | null | undefined, speed: number): { rate?: number } {
  const r = balance?.time?.realtimeFactor;
  if (!r || r === 1) return {};
  return balance?.time.speeds.includes(speed) ? { rate: r } : {};
}
/** Horloge dont la cadence suit sa vitesse courante. */
function withRate(clock: ClockState, balance: Balance | null | undefined): ClockState {
  const { rate: _old, ...rest } = clock;
  return { ...rest, ...rateOf(balance, clock.speed) };
}
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
    ...(r.status === 'ended'
      ? {
          endReason:
            r.pauseReason === 'abandoned'
              ? ('abandoned' as const)
              : r.pauseReason === 'admin'
                ? ('admin' as const)
                : ('victory' as const),
        }
      : {}),
    ...(r.unranked ? { unranked: true } : {}),
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
      // Mode illimité modifié pendant que la partie n'était pas chargée.
      await this.refreshUnlimited(g);
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
    const raw = await decompressSnapshot(snap.codec, snap.state);
    const tLoad = nowMs();
    const state = engine.deserializeState(world, raw);
    const deserMs = nowMs() - tLoad;

    const orders = await this.d.db
      .select()
      .from(gameOrders)
      .where(and(eq(gameOrders.gameId, gameId), gt(gameOrders.seq, snap.lastOrderSeq)))
      .orderBy(asc(gameOrders.seq));
    const nationOfSlot = new Map(players.map((p) => [p.slot, p.nationId]));
    let sliceStart = nowMs();
    let replayMs = 0;
    for (const o of orders) {
      // Rejeu long (journal volumineux) : on rend la main entre deux tranches.
      if (nowMs() - sliceStart > this.sliceMs) {
        replayMs += nowMs() - sliceStart;
        await yieldLoop();
        sliceStart = nowMs();
      }
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

    replayMs += nowMs() - sliceStart;
    this.cpu(gameId, 'other', deserMs + replayMs);
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
        ...rateOf(row.balance, row.speed),
      },
      pauseReason: row.pauseReason,
      players: players.map((p) => ({
        slot: p.slot,
        userId: p.userId,
        nationId: p.nationId,
        isAi: p.isAiReplacement,
        aiForced: p.aiForced,
        lastActiveAt: p.lastActiveAt?.getTime() ?? null,
      })),
      orderSeq: Math.max(snap.lastOrderSeq, orders.at(-1)?.seq ?? 0, row.lastOrderSeq),
      snapshotSeq: snap.seq,
      dirty: orders.length > 0,
      connections: new Set(),
      pendingNotes: [],
      flushDue: null,
      lastFlush: 0,
      flushQueue: null,
      flushNotes: [],
      flushAgain: false,
      flushCostMs: 0,
      behind: false,
      // Délai d'abandon compté depuis la dernière connexion d'un joueur (survit aux redémarrages).
      idleSince:
        Math.max(
          0,
          ...players.filter((p) => p.userId).map((p) => p.lastActiveAt?.getTime() ?? 0),
        ) || (row.startedAt ?? row.createdAt).getTime(),
      dormant: engine.isDormant?.(state) ?? false,
      writes: Promise.resolve(),
      errored: false,
      stuckWarned: false,
      ended: row.status === 'ended',
      winner: row.winner as NationId | null,
      lastFrameDay: frames.at(-1)?.day ?? -1,
      lastFrame,
      stateBytes: row.stateBytes,
      rawStateBytes: raw.length,
      unlimitedUsers: new Set(),
    };
    // Rattrapage du temps écoulé pendant l'arrêt (aucun joueur connecté : pas de notification),
    // par tranches pour ne pas bloquer les autres parties ni les requêtes. En pause, l'horloge vaut
    // l'instant de la pause (postérieur au dernier ordre rejoué) : on avance jusque-là.
    for (;;) {
      this.advance(g, Date.now(), this.sliceMs);
      if (!g.behind || this.stopped) break;
      await yieldLoop();
    }
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
      // Parties terminées sans spectateur, parties en pause abandonnées : on libère la mémoire.
      // Sans joueur connecté : IA lointaines en veille ; multijoueur abandonné 24 h : pause.
      await this.manageIdle(Date.now());
      if (!this.d.worlds.unavailableReason()) await this.adoptOrphans();
      const keep = new Set<string>();
      for (const g of this.games.values()) keep.add(this.d.worlds.key(this.pinOf(g)));
      this.d.worlds.prune(keep);
      const now = Date.now();
      if (now - this.lastInactiveCheck >= INACTIVE_CHECK_MS) {
        this.lastInactiveCheck = now;
        // Révisions de données écrites par une autre instance (back-office servi ailleurs).
        await this.d.store.refreshIfStale();
        await this.checkInactive(now);
        await this.abandonUnloaded(now);
      }
    } catch (err) {
      this.log.error({ err }, 'battement de cœur des baux en échec');
    } finally {
      this.beating = false;
    }
  }

  /**
   * Gestion des parties sans joueur. Une partie continue toujours en l'absence de ses joueurs
   * (constructions, attaques nocturnes, guerres en cours) : après `dormancyDelayMs` sans joueur humain
   * connecté, seules les IA lointaines et en paix avec les joueurs suspendent leurs décisions (moteur,
   * commande 'dormancy'). Sans aucune connexion humaine depuis `soloAbandonMs` (solo, 48 h) ou
   * `multiAbandonMs` (multijoueur, 24 h), la partie est terminée pour abandon et fermée. Une partie
   * terminée, ou en pause sans connexion depuis `idleUnloadMs`, est déchargée (instantané, bail libéré).
   */
  async manageIdle(now: number): Promise<void> {
    const dormancyMs = this.d.options.dormancyDelayMs ?? DEFAULT_DORMANCY_DELAY_MS;
    const unloadMs = this.d.options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    for (const g of [...this.games.values()]) {
      if (this.stopped) return;
      if (g.ended && g.connections.size === 0) {
        await this.unload(g, true);
        continue;
      }
      if (g.idleSince === null || g.errored) continue;
      const idle = now - g.idleSince;
      const imposed = g.pauseReason === 'admin' || g.pauseReason === 'error';
      if (g.meta.status !== 'ended' && !imposed && idle >= this.abandonMs(g.meta.mode)) {
        await this.abandon(g, now);
        continue;
      }
      if (g.meta.status === 'running' && !g.dormant && idle >= dormancyMs) {
        if (this.applySystemNow(g, { kind: 'dormancy', on: true }).ok) {
          g.dormant = true;
          this.log.info({ gameId: g.id }, 'aucun joueur connecté : IA lointaines en veille');
        }
      }
      if (g.meta.status === 'paused' && g.connections.size === 0 && idle >= unloadMs) {
        this.log.info({ gameId: g.id }, 'partie en pause inactive déchargée de la mémoire');
        await this.unload(g, true);
      }
    }
  }

  private abandonMs(mode: 'solo' | 'multi'): number {
    return mode === 'solo'
      ? (this.d.options.soloAbandonMs ?? DEFAULT_SOLO_ABANDON_MS)
      : (this.d.options.multiAbandonMs ?? DEFAULT_MULTI_ABANDON_MS);
  }

  /** Fin de partie pour abandon (aucun joueur connecté depuis le délai), puis fermeture. */
  private async abandon(g: HostedGame, now: number): Promise<void> {
    this.safely(g, () => {
      if (!g.clock.paused) this.advance(g, now);
    });
    if (g.meta.status === 'ended') return; // victoire atteinte pendant le rattrapage
    g.ended = true;
    this.endGame(g, now, 'abandoned');
    this.log.info({ gameId: g.id, mode: g.meta.mode }, 'partie terminée : abandon (aucun joueur)');
    for (const c of g.connections) c.close(1000, 'Partie terminée');
    g.connections.clear();
    await this.unload(g, true);
  }

  /**
   * Parties absentes de la mémoire (en pause, déchargées) dont aucun joueur ne s'est connecté depuis le
   * délai d'abandon : terminées directement en base. Les pauses imposées (administration, erreur) sont
   * laissées à l'administration.
   */
  async abandonUnloaded(now = Date.now()): Promise<number> {
    const loaded = [...this.games.keys()];
    const rows = await this.d.sql<{ id: string }[]>`
      UPDATE games g SET status = 'ended', pause_reason = 'abandoned', ended_at = now()
      WHERE g.status IN ('running', 'paused')
        AND (g.pause_reason IS NULL OR g.pause_reason IN ('player', 'idle'))
        AND (g.lease_owner IS NULL OR g.lease_until < now())
        AND NOT (g.id = ANY(${loaded}::uuid[]))
        AND COALESCE(
          (SELECT max(p.last_active_at) FROM game_players p
            WHERE p.game_id = g.id AND p.user_id IS NOT NULL),
          g.started_at, g.created_at
        ) < ${new Date(now).toISOString()}::timestamptz
          - make_interval(secs => CASE WHEN g.mode = 'solo' THEN ${this.abandonMs('solo') / 1000}::float8 ELSE ${this.abandonMs('multi') / 1000}::float8 END)
      RETURNING g.id`;
    for (const r of rows) this.log.info({ gameId: r.id }, 'partie déchargée terminée : abandon');
    return rows.length;
  }

  /**
   * Suppression définitive d'une partie solo par son créateur (journal, instantanés, résultats : tout
   * part en cascade). Refusée si la partie est simulée par une autre instance.
   */
  async deleteSoloGame(
    gameId: string,
    userId: string,
  ): Promise<'ok' | 'not_found' | 'not_allowed' | 'busy'> {
    const [row] = await this.d.db.select().from(games).where(eq(games.id, gameId)).limit(1);
    if (!row) return 'not_found';
    if (row.mode !== 'solo' || row.createdBy !== userId) return 'not_allowed';
    const g = this.games.get(gameId);
    if (g) {
      this.scheduler.delete(g.id);
      this.games.delete(g.id);
      for (const c of g.connections) {
        c.send({ t: 'error', code: 'game_deleted', message: 'La partie a été supprimée.' });
        c.close(1000, 'Partie supprimée');
      }
      g.connections.clear();
      await g.writes.catch(() => {});
    }
    const owner = this.d.instanceId;
    const deleted = await this.d.sql`
      DELETE FROM games WHERE id = ${gameId}::uuid
        AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_until < now())
      RETURNING id`;
    if (deleted.length === 0) return 'busy';
    this.log.info({ gameId }, 'partie solo supprimée par son joueur');
    return 'ok';
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

  private get sliceMs(): number {
    return this.d.options.sliceBudgetMs ?? DEFAULT_SLICE_MS;
  }

  /**
   * Avance la partie jusqu'au temps de jeu courant. Renvoie vrai si des événements ont été traités.
   * Avec `budgetMs`, s'arrête dès que le budget CPU est dépassé (entre deux événements) et marque la
   * partie « en retard » : l'ordonnanceur reprend le rattrapage au tour suivant de la boucle.
   */
  private advance(g: HostedGame, now: number, budgetMs = Infinity): boolean {
    const tCpu = nowMs();
    try {
      return this.advanceInner(g, now, budgetMs);
    } finally {
      this.cpu(g.id, 'sim', nowMs() - tCpu);
    }
  }

  private advanceInner(g: HostedGame, now: number, budgetMs: number): boolean {
    const engine = this.engine;
    const target = Math.max(g.state.time, gameNow(g.clock, now));
    const t0 = g.state.time;
    const start = budgetMs === Infinity ? 0 : nowMs();
    let steps = 0;
    let lastT = -Infinity;
    let changed = false;
    g.behind = false;
    while (steps < MAX_STEPS_PER_TICK) {
      const next = engine.nextEventTime(g.state);
      if (next === null || next > target) break;
      const t = Math.max(next, g.state.time);
      if (steps > 0 && t <= lastT) break; // garde-fou : événement non consommé
      if (steps > 0 && budgetMs !== Infinity && nowMs() - start > budgetMs) {
        g.behind = true;
        break;
      }
      this.recordFrame(g, t);
      this.collect(g, engine.advanceTo(g.state, t));
      steps++;
      lastT = t;
      changed = true;
    }
    if (!g.behind && g.state.time < target) {
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

  private endGame(
    g: HostedGame,
    now: number,
    reason: 'victory' | 'abandoned' | 'admin' = 'victory',
  ): void {
    g.meta.status = 'ended';
    g.meta.endReason = reason;
    g.clock = reanchor(g.clock, now, g.state.time, { paused: true });
    g.pauseReason = reason === 'victory' ? null : reason;
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
    const t0 = nowMs();
    let phase = 'simulation';
    this.safely(g, () => {
      if (g.flushQueue) {
        // Suite d'une diffusion découpée en tranches.
        phase = 'diffusion';
        this.flushSlice(g);
      } else if (!g.errored && !g.clock.paused) {
        if (this.advance(g, now, this.sliceMs)) this.requestFlush(g, now);
      }
      if (!g.flushQueue && g.flushDue !== null && g.flushDue <= now) {
        phase += '+diffusion';
        this.flush(g, now);
      }
    });
    this.slow(g, phase, t0);
    this.reschedule(g, true);
  }

  /** Signale un travail synchrone anormalement long (bloque toutes les parties et requêtes). */
  private slow(g: HostedGame, what: string, t0: number): void {
    const ms = nowMs() - t0;
    if (ms < SLOW_MS) return;
    this.d.metrics.count('slowTicks');
    this.log.warn({ gameId: g.id, ms: Math.round(ms), what }, 'travail synchrone long');
  }

  private reschedule(g: HostedGame, afterTick = false): void {
    if (this.stopped || !this.games.has(g.id)) return;
    const now = Date.now();
    let at: number | null = null;
    if (!g.errored && !g.clock.paused && g.meta.status !== 'ended') {
      try {
        const next = this.engine.nextEventTime(g.state);
        if (next !== null) {
          if (afterTick && next <= g.state.time && !g.behind) {
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
    // Travail restant (rattrapage ou diffusion en tranches) : dès le prochain tour de boucle.
    if ((g.behind && !g.clock.paused && !g.errored) || g.flushQueue) at = now;
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
    g.clock = { ...g.clock, anchorGame: g.state.time, anchorReal: now, paused: true };
    if (g.meta.status !== 'ended') g.meta.status = 'paused';
    g.pauseReason = 'error';
    g.flushDue = null;
    g.flushQueue = null;
    g.flushNotes = [];
    g.pendingNotes = [];
    g.behind = false;
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

  /**
   * Demande une diffusion groupée. Les diffusions d'une partie sont espacées d'au moins
   * `flushIntervalMs`, et d'un écart proportionnel à leur coût CPU (adaptatif) : les diffusions d'une
   * partie n'occupent jamais plus de `flushCpuShare` du processeur, même avec 64 joueurs.
   */
  private requestFlush(g: HostedGame, now: number): void {
    if (g.connections.size === 0) {
      g.pendingNotes = [];
      return;
    }
    if (g.flushQueue) {
      // Diffusion en cours : la suivante sera programmée à sa fin, d'après son coût complet.
      g.flushAgain = true;
      return;
    }
    if (g.flushDue === null) {
      // Part maximale du processeur consacrée aux diffusions d'une partie : écart = coût × (1 − p) / p.
      const share = this.d.options.flushCpuShare ?? DEFAULT_FLUSH_SHARE;
      const gap = Math.max(this.d.options.flushIntervalMs, (g.flushCostMs * (1 - share)) / share);
      g.flushDue = Math.max(now, g.lastFlush + gap);
    }
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

  private static keyOf(c: Connection): string {
    return c.spectator ? SPECTATOR_KEY : c.nationId;
  }

  /**
   * Envoie aux connexions d'une même clé (nation, ou spectateurs) le diff de LEUR vue et, si fournies,
   * LEURS notifications (notificationsFor, ou notifications publiques pour un spectateur).
   * Un seul viewFor et un seul diffViews par vue précédente distincte.
   */
  private flushKey(g: HostedGame, key: string, notes: GameNotification[]): void {
    const engine = this.engine;
    let view: PlayerView | null = null;
    let mine: GameNotification[] | null = null;
    const diffs = new Map<PlayerView, ReturnType<Engine['diffViews']>>();
    for (const c of g.connections) {
      if (GameHost.keyOf(c) !== key) continue;
      view ??= this.viewOf(g, c);
      if (c.lastView && c.lastView !== view) {
        let diff = diffs.get(c.lastView);
        if (diff === undefined) {
          diff = engine.diffViews(c.lastView, view);
          diffs.set(c.lastView, diff);
        }
        if (diff) c.send({ t: 'diff', diff });
      }
      c.lastView = view;
      if (notes.length) {
        mine ??= c.spectator
          ? notes.filter((n) => PUBLIC_NOTES.has(n.kind))
          : engine.notificationsFor(g.state, c.nationId, notes);
        if (mine.length) c.send({ t: 'notify', items: mine });
      }
    }
  }

  /**
   * Diffusion à toutes les connexions, découpée en tranches : une nation après l'autre, en rendant la
   * main à la boucle d'événements dès que le budget d'une tranche est dépassé (suite au prochain tick).
   */
  private flush(g: HostedGame, now: number): void {
    g.flushDue = null;
    const notes = g.pendingNotes;
    g.pendingNotes = [];
    if (g.connections.size === 0) {
      g.lastFlush = now;
      return;
    }
    if (g.flushQueue) {
      // Diffusion déjà en cours : les nouvelles notifications partiront avec la suivante.
      g.pendingNotes = notes.concat(g.pendingNotes);
      g.flushAgain = true;
      return;
    }
    const keys = new Set<string>();
    for (const c of g.connections) keys.add(GameHost.keyOf(c));
    g.flushQueue = [...keys];
    g.flushNotes = notes;
    g.flushCostMs = 0;
    this.flushSlice(g);
  }

  private flushSlice(g: HostedGame): void {
    const queue = g.flushQueue;
    if (!queue) return;
    const start = nowMs();
    while (queue.length > 0) {
      const key = queue.shift()!;
      this.flushKey(g, key, g.flushNotes);
      if (queue.length > 0 && nowMs() - start > this.sliceMs) break;
    }
    g.flushCostMs += nowMs() - start;
    this.cpu(g.id, 'flush', nowMs() - start);
    if (queue.length === 0) {
      g.flushQueue = null;
      g.flushNotes = [];
      g.lastFlush = Date.now();
      this.d.metrics.recordFlush(g.flushCostMs);
      if (g.flushAgain || g.pendingNotes.length > 0) {
        g.flushAgain = false;
        this.requestFlush(g, g.lastFlush);
      }
    }
  }

  /** Diffusion immédiate aux seules connexions d'une nation (retour d'un ordre), sans notifications. */
  private flushNation(g: HostedGame, nationId: NationId): void {
    if (!nationId) return;
    for (const c of g.connections) {
      if (!c.spectator && c.nationId === nationId) {
        const t0 = nowMs();
        this.flushKey(g, nationId, []);
        this.cpu(g.id, 'flush', nowMs() - t0);
        return;
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
    if (!conn.spectator) {
      this.playerReturned(g, conn.userId, now);
      g.idleSince = null;
      // Partie mise en pause faute de joueur (24 h en multi, 48 h en solo) : reprise au retour.
      if (g.meta.status === 'paused' && g.pauseReason === 'idle' && !g.errored) {
        this.setClock(g, { paused: false }, 'player');
      }
      // Retour d'un joueur : toutes les IA reprennent leurs décisions.
      if (
        g.dormant &&
        g.meta.status !== 'ended' &&
        this.applySystemNow(g, { kind: 'dormancy', on: false }).ok
      ) {
        g.dormant = false;
      }
      // Mode illimité du compte (lu à la connexion : changé ailleurs, sur une autre instance…).
      if (conn.unlimited !== undefined && conn.unlimited !== g.unlimitedUsers.has(conn.userId)) {
        if (conn.unlimited) g.unlimitedUsers.add(conn.userId);
        else g.unlimitedUsers.delete(conn.userId);
      }
      this.syncUnlimited(g);
    }
    const ok = this.safely(g, () => {
      // Rattrapage borné ; les autres connexions recevront leur diff par la diffusion groupée.
      if (!g.errored && !g.clock.paused && this.advance(g, now, this.sliceMs)) {
        this.requestFlush(g, now);
      }
      const tView = nowMs();
      conn.lastView = this.viewOf(g, conn);
      this.cpu(g.id, 'flush', nowMs() - tView);
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
    // Équité multijoueur : avis rappelé à chaque arrivée tant qu'une nation est illimitée.
    if (g.meta.mode === 'multi') {
      for (const n of this.unlimitedNationsOf(g)) {
        conn.send({ t: 'notice', level: 'warn', text: this.unlimitedNotice(n) });
      }
    }
    return g;
  }

  detach(gameId: string, conn: Connection): void {
    const g = this.games.get(gameId);
    if (!g) return;
    g.connections.delete(conn);
    const now = Date.now();
    if (!conn.spectator) this.touch(g, conn.userId, now, true);
    if (![...g.connections].some((c) => !c.spectator)) g.idleSince ??= now;
    if (g.connections.size === 0) {
      g.pendingNotes = [];
      g.flushDue = null;
      g.flushQueue = null;
      g.flushNotes = [];
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
    if (!p.isAi || p.aiForced || g.meta.status === 'ended') return;
    const r = this.applySystemNow(g, { kind: 'setAi', nationId: p.nationId, isAi: false });
    if (!r.ok && r.error !== 'unsupported') return;
    p.isAi = false;
    void this.chain(g, 'retour du joueur', async () => {
      await this.d.db
        .update(gamePlayers)
        .set({ isAiReplacement: false, aiSince: null })
        .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, p.slot)));
    });
    this.notice(g, `${this.nationName(p.nationId)} : le joueur a repris le contrôle de sa nation.`);
    this.log.info({ gameId: g.id, nation: p.nationId }, 'joueur de retour : IA retirée');
    this.syncUnlimited(g);
  }

  private nationName(id: NationId): string {
    return this.d.store.current().nationsById.get(id)?.name ?? id;
  }

  /** « du Maroc », « de l'Algérie », « des États-Unis » (article des données de carte). */
  private nationDe(id: NationId): string {
    const d = this.d.store.current().nationsById.get(id);
    return frDe(d?.name ?? id, d?.article);
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
        // Une IA ne profite jamais du mode illimité de son joueur.
        this.syncUnlimited(g);
        const slot = p.slot;
        await this.chain(g, 'remplacement IA', async () => {
          await this.d.db
            .update(gamePlayers)
            .set({ isAiReplacement: true, aiSince: new Date(now) })
            .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, slot)));
        });
        this.notice(g, `L'IA prend le contrôle ${this.nationDe(p.nationId)} (joueur inactif).`);
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
    const slot = g.players.find((p) => p.userId === conn.userId);
    if (slot?.aiForced) {
      return reply(
        false,
        'not_allowed',
        "Votre nation est confiée à une IA par l'administration : ordres suspendus.",
      );
    }
    const now = Date.now();
    this.playerReturned(g, conn.userId, now);
    let result: { ok: boolean; error?: OrderErrorCode; message?: string } = { ok: false };
    const t0 = nowMs();
    const ok = this.safely(g, () => {
      this.advance(g, now);
      const tOrder = nowMs();
      result = this.engine.applyOrder(g.state, conn.nationId, msg.order);
      this.cpu(g.id, 'sim', nowMs() - tOrder);
    });
    this.slow(g, `ordre ${msg.order.kind}`, t0);
    if (!ok) return reply(false, 'not_allowed', 'Erreur interne : la partie est suspendue');
    if (result.ok) {
      g.orderSeq += 1;
      g.dirty = true;
      const slot = g.players.find((p) => p.nationId === conn.nationId)?.slot ?? 0;
      this.journal(g, { seq: g.orderSeq, slot, time: g.state.time, payload: msg.order });
      this.d.usage?.order(g.id, conn.userId);
    }
    reply(result.ok, result.error, result.message);
    // Retour immédiat au joueur qui a donné l'ordre ; les autres nations (qui peuvent voir l'effet de
    // l'ordre) le reçoivent avec la prochaine diffusion groupée.
    this.safely(g, () => {
      this.flushNation(g, conn.nationId);
      this.requestFlush(g, now);
    });
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
    g.clock = withRate(reanchor(g.clock, now, g.state.time, change), g.balance);
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
      return {
        ok: false,
        error: 'unsupported',
        message: 'Commande système non gérée par le moteur',
      };
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
      this.safely(g, () => {
        if ('nationId' in cmd) this.flushNation(g, cmd.nationId);
        this.requestFlush(g, now);
      });
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

  /**
   * Administration : confie à une IA la nation d'un joueur (`ai: true`, IA « imposée » que le retour du
   * joueur ne retire pas, ordres du joueur suspendus), ou la lui rend (`ai: false`).
   */
  async adminSetAi(
    gameId: string,
    nationId: NationId,
    ai: boolean,
    aiLevel: 'easy' | 'normal' | 'hard' = 'normal',
  ): Promise<{ nationId: NationId; userId: string | null; isAi: boolean; aiForced: boolean }> {
    const g = await this.ensureLoaded(gameId);
    if (!g) {
      throw new HttpError(409, 'game_unavailable', 'Partie introuvable ou hébergée ailleurs');
    }
    if (g.meta.status === 'ended') throw new HttpError(409, 'game_over', 'La partie est terminée');
    if (g.errored) throw new HttpError(409, 'game_error', 'La partie est suspendue sur erreur');
    const p = g.players.find((x) => x.nationId === nationId);
    if (!p?.userId) {
      throw new HttpError(404, 'no_player', 'Aucun joueur humain ne tient cette nation');
    }
    if (ai === p.isAi && ai === p.aiForced) {
      return { nationId, userId: p.userId, isAi: p.isAi, aiForced: p.aiForced };
    }
    const r = this.applySystemNow(g, { kind: 'setAi', nationId, isAi: ai, aiLevel });
    if (!r.ok && r.error !== 'unsupported') {
      throw new HttpError(409, r.error ?? 'refused', r.message ?? 'Refusé par le moteur');
    }
    const now = Date.now();
    p.isAi = ai;
    p.aiForced = ai;
    if (!ai) p.lastActiveAt = now;
    this.syncUnlimited(g);
    const slot = p.slot;
    await this.chain(g, 'IA (administration)', async () => {
      await this.d.db
        .update(gamePlayers)
        .set({
          isAiReplacement: ai,
          aiForced: ai,
          aiSince: ai ? new Date(now) : null,
          ...(ai ? {} : { lastActiveAt: new Date(now) }),
        })
        .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.slot, slot)));
    });
    const name = this.nationName(nationId);
    this.notice(
      g,
      ai
        ? `L'administration confie le contrôle ${this.nationDe(nationId)} à une IA.`
        : `${name} : l'administration a rendu la nation à son joueur.`,
      ai ? 'warn' : 'info',
    );
    this.log.info({ gameId, nation: nationId, ai }, 'IA imposée ou retirée par l’administration');
    return { nationId, userId: p.userId, isAi: ai, aiForced: ai };
  }

  // ───────────────────────────── Mode illimité ─────────────────────────────

  /** Nations illimitées d'après le moteur (vide si le moteur ne gère pas la commande). */
  private unlimitedNationsOf(g: HostedGame): NationId[] {
    try {
      return this.d.engine?.unlimitedNations?.(g.state) ?? [];
    } catch {
      return [];
    }
  }

  private unlimitedNotice(n: NationId): string {
    return `Mode illimité actif pour ${this.nationName(n)} — partie non classée.`;
  }

  /** Relit en base les comptes illimités parmi les joueurs, puis synchronise le moteur. */
  async refreshUnlimited(g: HostedGame): Promise<void> {
    const ids = [...new Set(g.players.map((p) => p.userId).filter((x): x is string => !!x))];
    const rows = ids.length
      ? await this.d.db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, ids), eq(users.unlimited, true)))
      : [];
    g.unlimitedUsers = new Set(rows.map((r) => r.id));
    this.syncUnlimited(g);
  }

  /**
   * Met le moteur en accord avec les comptes : une nation est illimitée si et seulement si un joueur
   * humain en mode illimité la tient (pas une IA de remplacement). Commandes système journalisées,
   * donc rejouées à la reprise. En multijoueur, la première activation rend la partie non classée et
   * l'annonce publiquement.
   */
  syncUnlimited(g: HostedGame): void {
    const engine = this.d.engine;
    if (!engine?.unlimitedNations || !engine.applySystem) return;
    if (g.errored || g.meta.status === 'ended') return;
    const want = new Set<NationId>();
    for (const p of g.players) {
      if (p.userId && !p.isAi && g.unlimitedUsers.has(p.userId)) want.add(p.nationId);
    }
    const have = new Set(this.unlimitedNationsOf(g));
    for (const n of [...want].sort()) {
      if (have.has(n)) continue;
      if (!this.applySystemNow(g, { kind: 'unlimited', nationId: n, on: true }).ok) continue;
      this.log.info({ gameId: g.id, nation: n }, 'mode illimité activé');
      if (g.meta.mode === 'multi') {
        this.markUnranked(g);
        this.notice(g, this.unlimitedNotice(n), 'warn');
      }
    }
    for (const n of [...have].sort()) {
      if (want.has(n)) continue;
      if (this.applySystemNow(g, { kind: 'unlimited', nationId: n, on: false }).ok) {
        this.log.info({ gameId: g.id, nation: n }, 'mode illimité désactivé');
      }
    }
  }

  /** Partie non classée, définitivement (même si le mode illimité est retiré ensuite). */
  private markUnranked(g: HostedGame): void {
    if (g.meta.unranked) return;
    g.meta.unranked = true;
    void this.chain(g, 'partie non classée', async () => {
      await this.d.db.update(games).set({ unranked: true }).where(eq(games.id, g.id));
    });
  }

  /**
   * Administration : mode illimité d'un compte activé ou retiré. Les parties chargées ici sont mises à
   * jour tout de suite ; les autres le seront à leur chargement ou à la prochaine connexion du joueur.
   */
  setUserUnlimited(userId: string, on: boolean): number {
    let n = 0;
    for (const g of this.games.values()) {
      if (!g.players.some((p) => p.userId === userId)) continue;
      if (on) g.unlimitedUsers.add(userId);
      else g.unlimitedUsers.delete(userId);
      this.syncUnlimited(g);
      n++;
    }
    return n;
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
      // Niveau de toutes les IA de la partie (nations non déclarées comprises).
      aiLevel: opts.aiLevel,
      ...(opts.scenario.nationIds ? { nationIds: opts.scenario.nationIds } : {}),
      scenario: opts.scenario,
      // Temps de jeu par temps réel (fenêtres de vote du Conseil en heures réelles) : cadence comprise.
      speed: opts.speed * (rateOf(pin.balance, opts.speed).rate ?? 1),
      ...(opts.victory ? { victory: opts.victory } : {}),
    };
    const tCreate = nowMs();
    const state = engine.createGame(world, setup);
    return { world, pin, seed, setup, state, cpuMs: nowMs() - tCreate };
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
      flushQueue: null,
      flushNotes: [],
      flushAgain: false,
      flushCostMs: 0,
      behind: false,
      idleSince: Date.now(),
      dormant: false,
      writes: Promise.resolve(),
      errored: false,
      stuckWarned: false,
      ended: false,
      winner: null,
      lastFrameDay: -1,
      lastFrame: null,
      stateBytes: 0,
      rawStateBytes: 0,
      unlimitedUsers: new Set(),
    };
    this.games.set(opts.id, g);
    this.cpu(opts.id, 'other', prepared.cpuMs);
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
      ...rateOf(prepared.pin.balance, speed),
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
        {
          slot: 0,
          userId,
          nationId: body.nationId,
          isAi: false,
          aiForced: false,
          lastActiveAt: now,
        },
      ],
      clock,
    });
    const hosted = this.games.get(id);
    if (hosted) await this.refreshUnlimited(hosted);
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
      ...rateOf(prepared.pin.balance, row0.speed),
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
        aiForced: false,
        lastActiveAt: now,
      })),
      clock,
    });
    const hosted = this.games.get(gameId);
    if (hosted) await this.refreshUnlimited(hosted);
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
      existing.aiForced = false;
      existing.lastActiveAt = now;
      await this.d.db
        .update(gamePlayers)
        .set({
          userId,
          isAiReplacement: false,
          aiForced: false,
          aiSince: null,
          lastActiveAt: new Date(now),
        })
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
      g.players.push({ slot, userId, nationId, isAi: false, aiForced: false, lastActiveAt: now });
    }
    g.meta.playerCount = g.players.filter((p) => p.userId).length;
    this.notice(g, `Un nouveau joueur prend la tête ${this.nationDe(nationId)}.`);
    await this.refreshUnlimited(g);
    return g.meta;
  }

  /** Départ définitif d'un joueur d'une partie en cours : sa nation passe à l'IA. */
  async leaveRunning(gameId: string, userId: string): Promise<void> {
    const g = await this.ensureLoaded(gameId);
    if (!g) throw new HttpError(409, 'game_unavailable', 'Partie momentanément indisponible');
    const p = g.players.find((x) => x.userId === userId);
    if (!p) throw new HttpError(404, 'not_found', 'Vous ne jouez pas dans cette partie');
    if (g.meta.status !== 'ended') {
      this.applySystemNow(g, {
        kind: 'setAi',
        nationId: p.nationId,
        isAi: true,
        aiLevel: 'normal',
      });
    }
    p.userId = null;
    p.isAi = true;
    p.aiForced = false;
    this.syncUnlimited(g);
    await this.d.db
      .update(gamePlayers)
      .set({ userId: null, isAiReplacement: true, aiForced: false, aiSince: new Date() })
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.slot, p.slot)));
    for (const c of [...g.connections]) {
      if (c.userId === userId && !c.spectator) {
        c.close(1000, 'Partie quittée');
        g.connections.delete(c);
      }
    }
    g.meta.playerCount = g.players.filter((x) => x.userId).length;
    this.notice(g, `L'IA prend le contrôle ${this.nationDe(p.nationId)}.`);
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
    const t0 = nowMs();
    const ok = this.safely(g, () => {
      if (!g.clock.paused && this.advance(g, now)) {
        this.requestFlush(g, now);
        this.reschedule(g);
      }
      // Une seule sérialisation (stateHash du moteur resérialiserait l'état : ~110 ms de plus).
      const tSer = nowMs();
      bytes = engine.serializeState(g.state);
      this.cpu(g.id, 'other', nowMs() - tSer);
      g.rawStateBytes = bytes.length;
    });
    this.slow(g, 'instantané', t0);
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
      // Empreinte des octets de l'instantané (diagnostic), calculée hors du chemin de simulation.
      const hash = createHash('sha256').update(bytes!).digest('hex').slice(0, 32);
      const { codec, data } = await compressSnapshot(bytes!);
      g.stateBytes = data.length;
      const rows = await this.d.sql`
        INSERT INTO game_snapshots (game_id, seq, game_time_ms, last_order_seq, catalog_release_id, codec, state_hash, state)
        SELECT ${g.id}::uuid, ${seq}::int, ${time}::float8, ${lastOrderSeq}::int, ${releaseId}::int, ${codec}::text, ${hash}::text, ${data}::bytea
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

  /** Instantané de chaque partie, une à la fois : la boucle d'événements respire entre deux. */
  async snapshotAll(force: boolean): Promise<void> {
    const writes: Promise<void>[] = [];
    let first = true;
    for (const g of [...this.games.values()]) {
      if (!first) await yieldLoop();
      first = false;
      if (this.games.get(g.id) !== g && !this.stopped) continue;
      writes.push(this.snapshot(g, force));
    }
    await Promise.all(writes);
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

  /** Imputation du temps CPU d'une partie (comptabilité des coûts). */
  private cpu(gameId: string, kind: CpuKind, ms: number): void {
    this.d.usage?.cpu(gameId, kind, ms);
  }

  /** Parties chargées vues par le compteur de consommation (mémoire estimée, temps de jeu). */
  *meteredGames(): Iterable<MeteredGame> {
    for (const g of this.games.values()) {
      const players: string[] = [];
      for (const c of g.connections) if (!c.spectator) players.push(c.userId);
      yield { id: g.id, rawStateBytes: g.rawStateBytes, connections: g.connections.size, players };
    }
  }

  /** Paramètres d'exploitation modifiés à chaud (back-office). */
  setOptions(o: Partial<HostOptions>): void {
    Object.assign(this.d.options, o);
  }

  /** Avis à tous les joueurs et spectateurs connectés à cette instance ; renvoie le nombre de connexions. */
  noticeAll(text: string, level: 'info' | 'warn' = 'info'): number {
    let n = 0;
    for (const g of this.games.values()) {
      n += g.connections.size;
      this.notice(g, text, level);
    }
    return n;
  }

  /**
   * Fin de partie imposée par l'administration : partie non classée (aucun point), avis aux joueurs,
   * fin ('admin'), fermeture des connexions et déchargement. Une partie du salon est terminée en base.
   */
  async adminEnd(gameId: string, notice: string): Promise<'ok' | 'not_found' | 'ended' | 'busy'> {
    const [row] = await this.d.db.select().from(games).where(eq(games.id, gameId)).limit(1);
    if (!row) return 'not_found';
    if (row.status === 'ended') return 'ended';
    const endInDb = () =>
      this.d.db
        .update(games)
        .set({ status: 'ended', pauseReason: 'admin', endedAt: new Date(), unranked: true })
        .where(eq(games.id, gameId));
    if (row.status === 'lobby') {
      await endInDb();
      return 'ok';
    }
    const g = await this.ensureLoaded(gameId);
    if (!g) {
      // Restauration impossible (partie en erreur) : fin écrite en base ; sinon simulée ailleurs.
      if (!this.failed.has(gameId)) return 'busy';
      await endInDb();
      return 'ok';
    }
    if (g.meta.status === 'ended') return 'ended';
    if (g.errored) {
      // État suspect après une erreur : pas d'instantané, fin écrite directement en base.
      await this.unload(g, false);
      await endInDb();
      return 'ok';
    }
    const now = Date.now();
    this.markUnranked(g);
    this.safely(g, () => {
      if (!g.clock.paused && !g.errored) this.advance(g, now);
    });
    if ((g.meta.status as string) !== 'ended') {
      this.notice(g, notice, 'warn');
      g.ended = true;
      this.endGame(g, now, 'admin');
    }
    for (const c of g.connections) c.close(1000, 'Partie terminée');
    g.connections.clear();
    await this.unload(g, true);
    this.log.info({ gameId }, "partie terminée par l'administration");
    return 'ok';
  }

  /** Suppression définitive d'une partie (administration) ; refusée si une autre instance la simule. */
  async adminDelete(gameId: string): Promise<'ok' | 'not_found' | 'busy'> {
    const g = this.games.get(gameId);
    if (g) {
      this.scheduler.delete(g.id);
      this.games.delete(g.id);
      for (const c of g.connections) {
        c.send({ t: 'error', code: 'game_deleted', message: 'La partie a été supprimée.' });
        c.close(1000, 'Partie supprimée');
      }
      g.connections.clear();
      await g.writes.catch(() => {});
    }
    const owner = this.d.instanceId;
    const deleted = await this.d.sql`
      DELETE FROM games WHERE id = ${gameId}::uuid
        AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_until < now())
      RETURNING id`;
    if (deleted.length) {
      this.log.info({ gameId }, "partie supprimée par l'administration");
      return 'ok';
    }
    const [exists] = await this.d.db
      .select({ id: games.id })
      .from(games)
      .where(eq(games.id, gameId));
    return exists ? 'busy' : 'not_found';
  }

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
        const tPin = nowMs();
        const bytes = engine.serializeState(g.state);
        g.state = engine.deserializeState(world, bytes);
        this.cpu(g.id, 'other', nowMs() - tPin);
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
      this.safely(g, () => this.requestFlush(g, now));
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
          ...rateOf(r.balance, r.speed),
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
        players: mine.map((x) => {
          const live = g?.players.find((p) => p.slot === x.p.slot);
          const isAi = live
            ? live.userId === null || live.isAi
            : x.p.userId === null || x.p.isAiReplacement;
          return {
            nationId: x.p.nationId,
            userName: x.name,
            isAi,
            userId: x.p.userId,
            aiForced: live?.aiForced ?? x.p.aiForced,
            connected: !!(g && x.p.userId && this.isConnected(g, x.p.userId)),
            lastActiveAt:
              (live?.lastActiveAt ?? x.p.lastActiveAt?.getTime() ?? null) !== null
                ? new Date(live?.lastActiveAt ?? x.p.lastActiveAt!.getTime()).toISOString()
                : null,
          };
        }),
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
  hostStats(): {
    running: number;
    paused: number;
    ended: number;
    stateBytes: number;
    behind: number;
  } {
    const out = { running: 0, paused: 0, ended: 0, stateBytes: 0, behind: 0 };
    for (const g of this.games.values()) {
      if (g.behind) out.behind++;
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
