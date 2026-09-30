import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { REPO_ROOT, SERVER_ROOT } from './paths.js';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  SESSION_SECRET: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  DATA_DIR: z.string().optional(),
  TILES_DIR: z.string().optional(),
  CLIENT_DIST: z.string().optional(),
  ADMIN_DIST: z.string().optional(),
  SNAPSHOT_INTERVAL_S: z.coerce.number().positive().default(60),
  INSTANCE_ID: z.string().min(1).optional(),
  MIGRATE_ON_START: boolish.default(false),
  /** Durée du bail d'une partie (secondes). Le battement de cœur passe toutes les LEASE_TTL_S / 3. */
  LEASE_TTL_S: z.coerce.number().positive().default(30),
  /** Développement et tests uniquement : vitesses supplémentaires (ex. "600,3600"). Refusé en production. */
  REDLINE_EXTRA_SPEEDS: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // ——— Phases 5-6 ———
  /** URL publique du site (retours de Stripe Checkout). Défaut : déduite de la requête. */
  PUBLIC_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Clés VAPID imposées (sinon générées au premier démarrage et stockées en base). */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
  /** Dossier des documents légaux (défaut : apps/server/legal). */
  LEGAL_DIR: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  isProd: boolean;
  databaseUrl: string;
  port: number;
  host: string;
  sessionSecret: string;
  adminEmail: string | null;
  adminPassword: string | null;
  dataDir: string;
  /** Dossier des tuiles configuré (disque Render). */
  tilesDir: string;
  /** Dossier de repli des tuiles (DATA_DIR/tiles, contient satellite-lowzoom.pmtiles commité). */
  tilesFallbackDir: string;
  clientDist: string;
  adminDist: string;
  snapshotIntervalS: number;
  instanceId: string;
  migrateOnStart: boolean;
  leaseTtlS: number;
  logLevel: string;
  /** Vitesses ajoutées à celles de l'équilibrage (tests de bout en bout). Toujours vide en production. */
  extraSpeeds: number[];
  publicUrl: string | null;
  /** Clés Stripe (les deux ensemble) ; null = boutique en « paiements indisponibles ». */
  stripe: { secretKey: string; webhookSecret: string } | null;
  vapid: { publicKey: string; privateKey: string } | null;
  vapidSubject: string;
  legalDir: string;
}

const DEV_SECRET = 'redline-dev-secret-ne-pas-utiliser-en-production';

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

/** Base du PostgreSQL jetable (scripts/dev-db.sh), utilisée par défaut en développement. */
export const DEV_DATABASE_URL = 'postgres://postgres@127.0.0.1:54329/redline';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isDev = (env.NODE_ENV ?? 'development') === 'development';
  const withDefaults = {
    ...env,
    ...(isDev && !env.DATABASE_URL ? { DATABASE_URL: DEV_DATABASE_URL } : {}),
    ...(isDev && env.MIGRATE_ON_START === undefined ? { MIGRATE_ON_START: 'true' } : {}),
  };
  const parsed = EnvSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  if (isProd && (!e.SESSION_SECRET || e.SESSION_SECRET.length < 32)) {
    throw new Error(
      'Configuration invalide : SESSION_SECRET (32 caractères minimum) est obligatoire en production',
    );
  }
  if ((e.ADMIN_EMAIL && !e.ADMIN_PASSWORD) || (!e.ADMIN_EMAIL && e.ADMIN_PASSWORD)) {
    throw new Error('Configuration invalide : ADMIN_EMAIL et ADMIN_PASSWORD vont ensemble');
  }
  const extraSpeeds = (e.REDLINE_EXTRA_SPEEDS ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (isProd && extraSpeeds.length > 0) {
    throw new Error('Configuration invalide : REDLINE_EXTRA_SPEEDS est interdit en production');
  }
  const dataDir = abs(e.DATA_DIR ?? join(REPO_ROOT, 'data'));
  return {
    nodeEnv: e.NODE_ENV,
    isProd,
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    sessionSecret: e.SESSION_SECRET ?? DEV_SECRET,
    adminEmail: e.ADMIN_EMAIL?.toLowerCase() ?? null,
    adminPassword: e.ADMIN_PASSWORD ?? null,
    dataDir,
    tilesDir: abs(e.TILES_DIR ?? join(dataDir, 'tiles')),
    tilesFallbackDir: join(dataDir, 'tiles'),
    clientDist: abs(e.CLIENT_DIST ?? join(REPO_ROOT, 'apps/client/dist')),
    adminDist: abs(e.ADMIN_DIST ?? join(REPO_ROOT, 'apps/admin/dist')),
    snapshotIntervalS: e.SNAPSHOT_INTERVAL_S,
    instanceId: e.INSTANCE_ID ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`,
    migrateOnStart: e.MIGRATE_ON_START,
    leaseTtlS: e.LEASE_TTL_S,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'warn' : 'info'),
    extraSpeeds,
    publicUrl: e.PUBLIC_URL?.replace(/\/+$/, '') ?? null,
    stripe:
      e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET
        ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET }
        : null,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }
        : null,
    vapidSubject: e.VAPID_SUBJECT ?? (e.PUBLIC_URL ? e.PUBLIC_URL : 'mailto:noreply@redline.invalid'),
    legalDir: abs(e.LEGAL_DIR ?? join(SERVER_ROOT, 'legal')),
  };
}
