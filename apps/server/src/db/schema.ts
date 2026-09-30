import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Balance, ChangeScope, Role, WeaponSystem } from '@redline/shared';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ───────────────────────────── Comptes ─────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    role: text('role').$type<Role>().notNull().default('player'),
    isGuest: boolean('is_guest').notNull().default(false),
    premiumBalance: integer('premium_balance').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    check('users_role_check', sql`${t.role} in ('player','moderator','balance','superadmin')`),
  ],
);

/** Sessions : l'identifiant est le SHA-256 du jeton du cookie (le jeton brut n'est jamais stocké). */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    expiresAt: tz('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

// ───────────────────────────── Catalogue ─────────────────────────────

export const weaponSystems = pgTable('weapon_systems', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<WeaponSystem>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  revision: integer('revision').notNull().default(1),
  /** 'repo' : fiche chargée depuis data/catalog ; 'admin' : créée ou modifiée dans le back-office. */
  source: text('source').$type<'repo' | 'admin'>().notNull().default('repo'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** Catalogue figé : les parties épinglent une release (reprise identique après redémarrage). */
export const catalogReleases = pgTable('catalog_releases', {
  id: serial('id').primaryKey(),
  createdAt: tz('created_at').notNull().defaultNow(),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  message: text('message').notNull().default(''),
  snapshot: jsonb('snapshot').$type<WeaponSystem[]>().notNull(),
});

export const catalogChanges = pgTable(
  'catalog_changes',
  {
    id: serial('id').primaryKey(),
    releaseId: integer('release_id').references(() => catalogReleases.id, { onDelete: 'set null' }),
    systemId: text('system_id').notNull(),
    revision: integer('revision').notNull(),
    before: jsonb('before').$type<WeaponSystem | null>(),
    after: jsonb('after').$type<WeaponSystem | null>(),
    message: text('message').notNull().default(''),
    scope: text('scope').$type<ChangeScope>().notNull().default('new_games'),
    playerMessage: text('player_message'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('catalog_changes_system_idx').on(t.systemId, t.id)],
);

// ───────────────────────────── Parties ─────────────────────────────

export type GameStatus = 'lobby' | 'running' | 'paused' | 'ended';
export type PauseReason = 'player' | 'admin' | 'error';

export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    scenarioId: text('scenario_id').notNull(),
    status: text('status').$type<GameStatus>().notNull().default('running'),
    pauseReason: text('pause_reason').$type<PauseReason | null>(),
    mode: text('mode').$type<'solo' | 'multi'>().notNull().default('solo'),
    speed: doublePrecision('speed').notNull().default(1),
    speeds: jsonb('speeds').$type<number[]>().notNull(),
    seed: bigint('seed', { mode: 'number' }).notNull(),
    catalogReleaseId: integer('catalog_release_id').references(() => catalogReleases.id),
    /** Équilibrage figé à la création (data/balance/default.json). */
    balance: jsonb('balance').$type<Balance>().notNull(),
    /** Réglages de création transmis au moteur (joueurs, nations, niveau d'IA…). */
    setup: jsonb('setup').$type<Record<string, unknown>>().notNull(),
    anchorGameMs: doublePrecision('anchor_game_ms').notNull().default(0),
    anchorRealAt: tz('anchor_real_at').notNull().defaultNow(),
    /** Dernier temps de jeu connu (mis à jour avec les instantanés), pour l'affichage. */
    gameTimeMs: doublePrecision('game_time_ms').notNull().default(0),
    lastOrderSeq: integer('last_order_seq').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: tz('lease_until'),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    endedAt: tz('ended_at'),
  },
  (t) => [
    index('games_status_idx').on(t.status),
    check('games_status_check', sql`${t.status} in ('lobby','running','paused','ended')`),
  ],
);

export const gamePlayers = pgTable(
  'game_players',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    nationId: text('nation_id').notNull(),
    aiLevel: text('ai_level').$type<'easy' | 'normal' | 'hard' | null>(),
    isAiReplacement: boolean('is_ai_replacement').notNull().default(false),
    joinedAt: tz('joined_at').notNull().defaultNow(),
    lastActiveAt: tz('last_active_at'),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.slot] }),
    uniqueIndex('game_players_nation_key').on(t.gameId, t.nationId),
    index('game_players_user_idx').on(t.userId),
  ],
);

export const gameSnapshots = pgTable(
  'game_snapshots',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    gameTimeMs: doublePrecision('game_time_ms').notNull(),
    /** Dernier ordre du journal inclus dans cet instantané. */
    lastOrderSeq: integer('last_order_seq').notNull(),
    catalogReleaseId: integer('catalog_release_id'),
    codec: text('codec').$type<'gzip' | 'br' | 'none'>().notNull().default('gzip'),
    stateHash: text('state_hash'),
    state: bytea('state').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.seq] })],
);

export const gameOrders = pgTable(
  'game_orders',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    playerSlot: integer('player_slot').notNull(),
    gameTimeMs: doublePrecision('game_time_ms').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.seq] })],
);

// ───────────────────────────── Administration ─────────────────────────────

export const adminAudit = pgTable(
  'admin_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    adminId: uuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('admin_audit_created_idx').on(t.createdAt)],
);

export const schema = {
  users,
  sessions,
  weaponSystems,
  catalogReleases,
  catalogChanges,
  games,
  gamePlayers,
  gameSnapshots,
  gameOrders,
  adminAudit,
};
