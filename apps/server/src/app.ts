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
import { adminDataRoutes } from './admin/data-routes.js';
import { adminOpsRoutes } from './admin/ops-routes.js';
import { wsGateway } from './ws/gateway.js';
import { ProcessMetrics } from './metrics.js';
import { DataStore } from './data/store.js';
import { loadShopConfig, type ShopConfig } from './shop/config.js';
import { stripeProvider, type PaymentProvider } from './shop/payments.js';
import { seedShop, shopRoutes } from './shop/shop.js';
import { LegalService, legalRoutes } from './legal/legal.js';
import { Fingerprints } from './security/fingerprints.js';
import { ChatService } from './chat/chat.js';
import { PushService, webPushSender, type PushSender } from './push/push.js';
import { RankingService } from './rank/rankings.js';
import { lobbyRoutes } from './multi/lobby.js';
import { gameExtraRoutes } from './http/games-extra.js';
import { clientIp, registerSecurity } from './http/security.js';
import { UsageMeter } from './costs/usage.js';
import { CostService } from './costs/service.js';
import { meteredPayments } from './costs/payments.js';
import { AnnouncementService, RuntimeSettingsStore } from './ops/ops.js';
import { adminEconomyRoutes } from './admin/economy-routes.js';
import { adminManageRoutes } from './admin/manage-routes.js';
import { publicOrigin } from './http/origin.js';
import { SitePages, siteRoutes } from './http/site.js';
import { LegalSettingsService } from './legal/settings.js';
import { adminSettingsRoutes } from './admin/settings-routes.js';

export interface BuildAppOptions {
  config: Config;
  /** Moteur injecté (le vrai en production, un faux dans les tests). null = parties indisponibles (503). */
  engine: Engine | null;
  engineMissing?: string[];
  logger?: FastifyServerOptions['logger'];
  runtime?: Partial<RuntimeOptions>;
  /**
   * Prestataire de paiement injecté (tests). Absent : Stripe si STRIPE_SECRET_KEY et
   * STRIPE_WEBHOOK_SECRET sont définies ; null : paiements indisponibles.
   */
  payments?: PaymentProvider | null;
  /** Émetteur Web Push injecté (tests). Absent : web-push. */
  pushSender?: PushSender;
  shopConfig?: ShopConfig;
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
      createRateLimitPerMin: 10,
      wsMessagesPerSecond: 20,
      wsBurst: 40,
      flushIntervalMs: 200,
      keepSnapshots: 3,
      chatPerSecond: 0.5,
      chatBurst: 5,
      pushThrottleMs: 10 * 60_000,
      maxActiveSoloPerUser: 10,
      maxActiveMultiPerUser: 5,
      sliceBudgetMs: 40,
      dormancyDelayMs: 5 * 60_000,
      multiAbandonMs: 24 * 3_600_000,
      soloAbandonMs: 48 * 3_600_000,
      idleUnloadMs: 10 * 60_000,
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
    const fingerprints = new Fingerprints(dbh.db, config.sessionSecret, log);
    auth.onSeen = (user, req) => fingerprints.record(user.id, req);

    const store = new DataStore(dbh.db, data);
    await store.init();
    const worlds = new WorldRegistry(dbh.db, opts.engine, store);
    await worlds.init();
    const metrics = new ProcessMetrics();
    const costs = new CostService(dbh.db, log);
    await costs.init();
    const usage = new UsageMeter({ db: dbh.db, log, settings: () => costs.settings() });
    const host = new GameHost({
      usage,
      engine: opts.engine,
      db: dbh.db,
      sql: dbh.sql,
      data,
      store,
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
        sliceBudgetMs: options.sliceBudgetMs,
        dormancyDelayMs: options.dormancyDelayMs,
        multiAbandonMs: options.multiAbandonMs,
        soloAbandonMs: options.soloAbandonMs,
        idleUnloadMs: options.idleUnloadMs,
      },
    });

    const shop = opts.shopConfig ?? loadShopConfig();
    await seedShop(dbh.db, shop);
    let payments: PaymentProvider | null;
    if (opts.payments !== undefined) payments = opts.payments;
    else if (config.stripe)
      payments = stripeProvider(config.stripe.secretKey, config.stripe.webhookSecret);
    else {
      payments = null;
      log.warn('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absentes : paiements indisponibles');
    }
    // Appels à l'API Stripe comptés (comptabilité des coûts).
    if (payments) payments = meteredPayments(payments, usage);
    const legal = new LegalService(dbh.db, config.legalDir, log, config.siteContentDir);
    const legalSettings = new LegalSettingsService(dbh.db, log, config.legalContactEmail);
    await legalSettings.init();
    const site = new SitePages(config.siteDist, legalSettings, log);
    const chat = new ChatService({
      db: dbh.db,
      host,
      log,
      metrics,
      rate: { perSecond: options.chatPerSecond, burst: options.chatBurst },
      blockedWords: shop.chat.blockedWords,
    });
    const push = new PushService({
      db: dbh.db,
      host,
      engine: opts.engine,
      store,
      log,
      metrics,
      sender: opts.pushSender ?? webPushSender,
      subject: config.vapidSubject,
      envKeys: config.vapid,
      throttleMs: options.pushThrottleMs,
      usage,
    });
    await push.init();
    const rankings = new RankingService(dbh.db, shop, log);
    await rankings.maintain();
    host.listeners.notes.push((g, notes) => push.onNotes(g, notes));
    host.listeners.ended.push((g, stats) => rankings.onGameEnded(g, stats));
    const announcements = new AnnouncementService(dbh.db, host);
    const runtimeSettings = new RuntimeSettingsStore(dbh.db, options, host, log);
    await runtimeSettings.init();
    usage.setSources({
      games: () => host.meteredGames(),
      connectedPlayers: () => host.connectedPlayers(),
    });
    costs.live = () => {
      const m = metrics.snapshot();
      return {
        cpuPct: m.cpuPct,
        rssMb: m.rssMb,
        eventLoopP99Ms: m.eventLoopP99Ms,
        connectedPlayers: host.connectedPlayers(),
        games: host.games.size,
        gamesBehind: host.hostStats().behind,
      };
    };

    const ctx: AppContext = {
      config,
      options,
      db: dbh.db,
      sql: dbh.sql,
      engine: opts.engine,
      engineMissing: opts.engineMissing ?? [],
      data,
      store,
      worlds,
      host,
      auth,
      metrics,
      log,
      shop,
      payments,
      legal,
      fingerprints,
      chat,
      push,
      rankings,
      usage,
      costs,
      announcements,
      runtimeSettings,
    };

    await app.register(fastifyCookie, { secret: config.sessionSecret });
    registerSecurity(app, config);
    // Octets HTTP réellement écrits (réponse complète, en-têtes compris), par différence sur la socket
    // (connexions persistantes : plusieurs réponses par socket). Imputés à l'utilisateur s'il est connu.
    const written = new WeakMap<object, number>();
    app.addHook('onResponse', async (req) => {
      const sock = req.raw.socket as { bytesWritten?: number } | null;
      if (!sock || sock.bytesWritten === undefined) return;
      const prev = written.get(sock) ?? 0;
      written.set(sock, sock.bytesWritten);
      const auth = (req as unknown as { _auth?: { user: { id: string } } | null })._auth;
      usage.http(auth?.user.id ?? null, sock.bytesWritten - prev);
    });
    await app.register(fastifyRateLimit, { global: false, keyGenerator: clientIp });
    await app.register(fastifyWebsocket, {
      options: {
        maxPayload: 64 * 1024,
        // Compression permessage-deflate des gros messages (vue initiale ~270 Kio → ~25 Kio) ;
        // sans contexte conservé : pas de mémoire zlib par connexion entre deux messages.
        perMessageDeflate: {
          threshold: 2048,
          serverNoContextTakeover: true,
          clientNoContextTakeover: true,
          concurrencyLimit: 4,
        },
      },
    });

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
    await app.register(async (scope) => gameExtraRoutes(scope, ctx));
    await app.register(async (scope) => lobbyRoutes(scope, ctx));
    await app.register(async (scope) => shopRoutes(scope, ctx));
    await app.register(async (scope) =>
      legalRoutes(scope, {
        legal,
        auth,
        hashIp: (ip) => fingerprints.hashIp(ip),
        tokens: (req) => site.tokens(publicOrigin(config, req)),
      }),
    );
    await app.register(async (scope) => siteRoutes(scope, ctx, site));
    await app.register(async (scope) => adminSettingsRoutes(scope, ctx, legalSettings));
    await app.register(async (scope) => push.routes(scope, auth));
    await app.register(async (scope) => rankings.routes(scope));
    await app.register(async (scope) => adminRoutes(scope, ctx));
    await app.register(async (scope) => adminDataRoutes(scope, ctx));
    await app.register(async (scope) => adminOpsRoutes(scope, ctx));
    await app.register(async (scope) => adminEconomyRoutes(scope, ctx));
    await app.register(async (scope) => adminManageRoutes(scope, ctx));
    await app.register(async (scope) => wsGateway(scope, ctx));
    await staticRoutes(app, ctx, site);

    // Arrêt propre : instantanés + libération des baux, puis fermeture de la base.
    app.addHook('onClose', async () => {
      await host.stop();
      await usage.stop();
      rankings.stop();
      metrics.stop();
      await dbh.close();
    });

    await host.start();
    rankings.start();
    usage.start();
    return { app, ctx };
  } catch (err) {
    await dbh.close().catch(() => {});
    throw err;
  }
}
