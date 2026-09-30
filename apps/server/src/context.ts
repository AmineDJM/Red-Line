import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Engine } from './engine.js';
import type { GameData } from './data/loader.js';
import type { WorldRegistry } from './host/worlds.js';
import type { GameHost } from './host/game-host.js';
import type { Auth } from './auth/auth.js';
import type { ProcessMetrics } from './metrics.js';

export interface RuntimeOptions {
  /** Requêtes d'authentification par minute et par IP. */
  authRateLimitPerMin: number;
  /** Messages WebSocket par seconde et par connexion (seau à jetons). */
  wsMessagesPerSecond: number;
  wsBurst: number;
  /** Intervalle minimal entre deux diffs d'une partie (ms). */
  flushIntervalMs: number;
  keepSnapshots: number;
}

export interface AppContext {
  config: Config;
  options: RuntimeOptions;
  db: Db;
  sql: postgres.Sql;
  engine: Engine | null;
  engineMissing: string[];
  data: GameData;
  worlds: WorldRegistry;
  host: GameHost;
  auth: Auth;
  metrics: ProcessMetrics;
  log: FastifyBaseLogger;
}
