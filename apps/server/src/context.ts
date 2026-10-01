import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Engine } from './engine.js';
import type { GameData } from './data/loader.js';
import type { DataStore } from './data/store.js';
import type { WorldRegistry } from './host/worlds.js';
import type { GameHost } from './host/game-host.js';
import type { Auth } from './auth/auth.js';
import type { ProcessMetrics } from './metrics.js';
import type { ShopConfig } from './shop/config.js';
import type { PaymentProvider } from './shop/payments.js';
import type { LegalService } from './legal/legal.js';
import type { Fingerprints } from './security/fingerprints.js';
import type { ChatService } from './chat/chat.js';
import type { PushService } from './push/push.js';
import type { RankingService } from './rank/rankings.js';

export interface RuntimeOptions {
  /** Requêtes d'authentification par minute et par IP. */
  authRateLimitPerMin: number;
  /** Créations de partie (solo, salon) par minute et par IP. */
  createRateLimitPerMin: number;
  /** Messages WebSocket par seconde et par connexion (seau à jetons). */
  wsMessagesPerSecond: number;
  wsBurst: number;
  /** Intervalle minimal entre deux diffs d'une partie (ms). */
  flushIntervalMs: number;
  keepSnapshots: number;
  /** Messagerie : messages par seconde (recharge) et rafale, par joueur et par partie. */
  chatPerSecond: number;
  chatBurst: number;
  /** Notifications push : délai minimal entre deux alertes de même catégorie (par joueur et partie). */
  pushThrottleMs: number;
  /**
   * Parties non terminées qu'un joueur peut avoir créées (chaque partie monde simule ~200 IA et pèse
   * ~0,5 Mio par instantané) : solo et multijoueur. Les modérateurs ne sont pas limités.
   */
  maxActiveSoloPerUser: number;
  maxActiveMultiPerUser: number;
  /** Budget d'une tranche de travail synchrone (ms) ; pauses et déchargements des parties inactives. */
  sliceBudgetMs: number;
  /** Sans joueur connecté : délai avant la veille des IA lointaines. */
  dormancyDelayMs: number;
  /** Multijoueur sans aucun joueur connecté : délai avant la fin pour abandon (24 h). */
  multiAbandonMs: number;
  /** Solo sans connexion du joueur : délai avant la fin pour abandon (48 h). */
  soloAbandonMs: number;
  idleUnloadMs: number;
}

export interface AppContext {
  config: Config;
  options: RuntimeOptions;
  db: Db;
  sql: postgres.Sql;
  engine: Engine | null;
  engineMissing: string[];
  /** Données du dépôt (data/). */
  data: GameData;
  /** Données effectives (dépôt + modifications versionnées du back-office). */
  store: DataStore;
  worlds: WorldRegistry;
  host: GameHost;
  auth: Auth;
  metrics: ProcessMetrics;
  log: FastifyBaseLogger;
  shop: ShopConfig;
  /** null = paiements indisponibles (clés Stripe absentes). */
  payments: PaymentProvider | null;
  legal: LegalService;
  fingerprints: Fingerprints;
  chat: ChatService;
  push: PushService;
  rankings: RankingService;
}
