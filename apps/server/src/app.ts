import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import type { Config } from './config.js';
import type { AppContext, RuntimeOptions } from './context.js';
import { createDb, runMigrations } from './db/client.js';
import type { Engine } from './engine.js';
import { loadGameData } from './data/loader.js';
import { syncRepoCatalog } from './data/catalog-store.js';
import { WorldRegistry } from './host/worlds.js';
import { GameHost } from './host/game-host.js';
import { Auth, HttpError } from './auth/auth.js';
import { authRoutes } from './auth/routes.js';
import { publicRoutes } from './http/public.js';
import { staticRoutes } from './http/static.js';
import { adminRoutes } from './admin/routes.js';
import { wsGateway } from './ws/gateway.js';
import { ProcessMetrics } from './metrics.js';

export interface BuildAppOptions {
  config: Config;
  /** Moteur injecté (le vrai en production, un faux dans les tests). null = parties indisponibles (503). */
  engine: Engine | null;
  engineMissing?: string[];
  logger?: FastifyServerOptions['logger'];
  runtime?: Partial<RuntimeOptions>;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export function defaultLogger(config: Config): FastifyServerOptions['logger'] {
  if (config.nodeEnv === 'development') {
    return {
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: config.logLevel };
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? defaultLogger(config),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: config.nodeEnv !== 'development' }),
  });
  const log = app.log;

  if (config.migrateOnStart) {
    await runMigrations(config.databaseUrl);
    log.info('migrations appliquées');
  }

  const dbh = createDb(config.databaseUrl);
  try {
    const options: RuntimeOptions = {
      authRateLimitPerMin: 20,
      wsMessagesPerSecond: 20,
      wsBurst: 40,
      flushIntervalMs: 200,
      keepSnapshots: 3,
      ...opts.runtime,
    };

    if (!opts.engine) {
      log.warn(
        `moteur indisponible (fonctions manquantes : ${(opts.engineMissing ?? []).join(', ') || '?'}) : les parties renverront 503`,
      );
    }

    const data = await loadGameData(config.dataDir, log);
    if (data.repoCatalog.length > 0 || data.catalogErrors.length === 0) {
      const sync = await syncRepoCatalog(dbh.db, data.repoCatalog);
      if (sync.inserted.length)
        log.info({ inserted: sync.inserted.length }, 'catalogue du dépôt chargé en base');
    }

    const auth = new Auth(dbh.db, { secure: config.isProd });
    if (config.adminEmail && config.adminPassword) {
      await auth.ensureSuperAdmin(config.adminEmail, config.adminPassword);
      log.info({ email: config.adminEmail }, 'super-admin à jour');
    }
    await auth.purgeExpired();

    const worlds = new WorldRegistry(dbh.db, opts.engine, data);
    await worlds.init();
    const metrics = new ProcessMetrics();
    const host = new GameHost({
      engine: opts.engine,
      db: dbh.db,
      sql: dbh.sql,
      data,
      worlds,
      metrics,
      log,
      instanceId: config.instanceId,
      extraSpeeds: config.extraSpeeds,
      options: {
        flushIntervalMs: options.flushIntervalMs,
        snapshotIntervalS: config.snapshotIntervalS,
        leaseTtlS: config.leaseTtlS,
        keepSnapshots: options.keepSnapshots,
      },
    });

    const ctx: AppContext = {
      config,
      options,
      db: dbh.db,
      sql: dbh.sql,
      engine: opts.engine,
      engineMissing: opts.engineMissing ?? [],
      data,
      worlds,
      host,
      auth,
      metrics,
      log,
    };

    await app.register(fastifyCookie, { secret: config.sessionSecret });
    await app.register(fastifyRateLimit, { global: false });
    await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      const e = err as { statusCode?: number; code?: string; message?: string };
      const status = e.statusCode ?? 500;
      if (status >= 500) req.log.error({ err }, 'erreur serveur');
      if (status === 429) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: 'Trop de tentatives, réessayez plus tard.' });
      }
      return reply.code(status).send({
        error: status >= 500 ? 'internal' : (e.code ?? 'bad_request'),
        message: status >= 500 ? 'Erreur interne' : (e.message ?? 'Requête invalide'),
      });
    });

    app.get('/healthz', async (_req, reply) => {
      try {
        await dbh.sql`SELECT 1`;
        return { ok: true, instance: config.instanceId, games: host.games.size };
      } catch {
        return reply.code(503).send({ ok: false });
      }
    });

    await app.register(async (scope) => authRoutes(scope, ctx));
    await app.register(async (scope) => publicRoutes(scope, ctx));
    await app.register(async (scope) => adminRoutes(scope, ctx));
    await app.register(async (scope) => wsGateway(scope, ctx));
    await staticRoutes(app, ctx);

    // Arrêt propre : instantanés + libération des baux, puis fermeture de la base.
    app.addHook('onClose', async () => {
      await host.stop();
      metrics.stop();
      await dbh.close();
    });

    await host.start();
    return { app, ctx };
  } catch (err) {
    await dbh.close().catch(() => {});
    throw err;
  }
}
