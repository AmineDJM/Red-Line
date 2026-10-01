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
import type { Balance, ChangeScope, Locale, Role, ShopPolicy, WeaponSystem } from '@redline/shared';

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
    /** Bannissement (connexion refusée, sessions supprimées). */
    bannedAt: tz('banned_at'),
    banReason: text('ban_reason'),
    /** Messagerie coupée jusqu'à cette date (modération). */
    chatMutedUntil: tz('chat_muted_until'),
    /** Activité par heure UTC (24 compteurs) : détection des multi-comptes. */
    activityHours: jsonb('activity_hours').$type<number[]>(),
    /**
     * Mode illimité (compte administrateur) : argent et ressources jamais limitants dans ses parties,
     * monnaie premium illimitée, aucun quota de création ; ses parties multijoueurs sont non classées.
     * Modifiable par un superadmin seulement.
     */
    unlimited: boolean('unlimited').notNull().default(false),
    /** Langue de l'interface (fr, en, ar…) : notifications push dans cette langue. Null = inconnue. */
    locale: text('locale').$type<Locale>(),
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
/**
 * 'idle' : ancienne pause automatique (parties créées avant la fin pour abandon), reprise au retour.
 * 'abandoned' : partie terminée faute de joueur (48 h en solo, 24 h en multijoueur) — statut 'ended'.
 */
export type PauseReason = 'player' | 'admin' | 'error' | 'idle' | 'abandoned';

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
    // ——— Phases 5-6 ———
    /** Joueurs humains attendus (multijoueur). */
    maxPlayers: integer('max_players').notNull().default(1),
    shopPolicy: jsonb('shop_policy').$type<ShopPolicy>().notNull().default({ mode: 'open' }),
    victory: jsonb('victory').$type<{ provinceShare: number; allEnemyCapitals: boolean } | null>(),
    /** Remplacement par une IA d'un joueur inactif depuis N heures réelles. */
    inactiveAiAfterH: doublePrecision('inactive_ai_after_h').notNull().default(24),
    isPrivate: boolean('is_private').notNull().default(false),
    startedAt: tz('started_at'),
    /** Révision des données d'administration (data_revisions.id) épinglée par la partie. */
    dataRev: integer('data_rev').notNull().default(0),
    winner: text('winner'),
    /** Statistiques de fin de partie (moteur.stats). */
    finalStats: jsonb('final_stats').$type<Record<string, unknown> | null>(),
    /** Taille du dernier instantané (octets compressés), pour les métriques. */
    stateBytes: integer('state_bytes').notNull().default(0),
    /** Partie non classée (un joueur en mode illimité y a joué) : aucun point de classement. */
    unranked: boolean('unranked').notNull().default(false),
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
    /** Depuis quand une IA remplace le joueur inactif. */
    aiSince: tz('ai_since'),
    /** IA imposée par l'administration : le retour du joueur ne la retire pas. */
    aiForced: boolean('ai_forced').notNull().default(false),
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

// ───────────────────────────── Multijoueur ─────────────────────────────

/** Messagerie : canaux "game", "alliance:<id>", "private:<a>|<b>". */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    nationId: text('nation_id'),
    authorName: text('author_name').notNull(),
    text: text('text').notNull(),
    hidden: boolean('hidden').notNull().default(false),
    hiddenBy: uuid('hidden_by').references(() => users.id, { onDelete: 'set null' }),
    /** Mots filtrés automatiquement. */
    filtered: boolean('filtered').notNull().default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('chat_messages_game_idx').on(t.gameId, t.channel, t.id),
    index('chat_messages_created_idx').on(t.createdAt),
  ],
);

export const chatReads = pgTable(
  'chat_reads',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    upTo: bigint('up_to', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.userId, t.channel] })],
);

/** Réglages persistants du serveur (clés VAPID…). */
export const serverSettings = pgTable('server_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    lastSentAt: tz('last_sent_at'),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_key').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
);

/** Évolution des frontières : un enregistrement par jour de jeu où elles ont changé (delta). */
export const timelapseFrames = pgTable(
  'timelapse_frames',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    /** Jour 0 : propriétaires complets ; ensuite, seulement les provinces qui ont changé. */
    delta: jsonb('delta').$type<Record<string, string>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day] })],
);

// ───────────────────────────── Boutique ─────────────────────────────

export type WalletReason = 'purchase' | 'accelerate' | 'cosmetic' | 'refund' | 'admin';

/** Portefeuille de monnaie premium : journal en AJOUT SEUL (déclencheur SQL anti-modification). */
export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: text('reason').$type<WalletReason>().notNull(),
    ref: text('ref'),
    gameId: uuid('game_id').references(() => games.id, { onDelete: 'set null' }),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('wallet_ledger_user_idx').on(t.userId, t.id),
    index('wallet_ledger_game_idx').on(t.gameId, t.userId),
    check(
      'wallet_ledger_reason_check',
      sql`${t.reason} in ('purchase','accelerate','cosmetic','refund','admin')`,
    ),
  ],
);

export const shopPacks = pgTable('shop_packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  amount: integer('amount').notNull(),
  bonus: integer('bonus').notNull().default(0),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').$type<'eur' | 'usd'>().notNull().default('eur'),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const shopPromotions = pgTable('shop_promotions', {
  id: serial('id').primaryKey(),
  /** null = tous les packs. */
  packId: text('pack_id').references(() => shopPacks.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  percentOff: integer('percent_off').notNull(),
  startsAt: tz('starts_at').notNull(),
  endsAt: tz('ends_at').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export type PurchaseStatus = 'pending' | 'paid' | 'refunded' | 'failed';

export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    packId: text('pack_id').notNull(),
    /** Monnaie premium créditée (montant + bonus). */
    credits: integer('credits').notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<PurchaseStatus>().notNull().default('pending'),
    stripeSessionId: text('stripe_session_id'),
    paymentIntent: text('payment_intent'),
    createdAt: tz('created_at').notNull().defaultNow(),
    paidAt: tz('paid_at'),
    refundedAt: tz('refunded_at'),
  },
  (t) => [
    uniqueIndex('purchases_session_key').on(t.stripeSessionId),
    index('purchases_user_idx').on(t.userId),
    index('purchases_intent_idx').on(t.paymentIntent),
  ],
);

/** Idempotence des webhooks Stripe. */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: tz('received_at').notNull().defaultNow(),
});

export type CosmeticKind = 'unit_skin' | 'flag' | 'map_theme' | 'terminal_theme';

export const cosmetics = pgTable('cosmetics', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<CosmeticKind>().notNull(),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  preview: text('preview').notNull().default(''),
  /** Achetable en boutique (faux = récompense de saison uniquement). */
  purchasable: boolean('purchasable').notNull().default(true),
  active: boolean('active').notNull().default(true),
});

export const userCosmetics = pgTable(
  'user_cosmetics',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cosmeticId: text('cosmetic_id').notNull(),
    source: text('source').$type<'purchase' | 'season' | 'admin'>().notNull(),
    acquiredAt: tz('acquired_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cosmeticId] })],
);

// ───────────────────────────── Classements ─────────────────────────────

export const seasons = pgTable('seasons', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startsAt: tz('starts_at').notNull(),
  endsAt: tz('ends_at').notNull(),
  rewards: jsonb('rewards').$type<{ rank: number; cosmeticId: string }[]>().notNull(),
  closedAt: tz('closed_at'),
});

export const rankings = pgTable(
  'rankings',
  {
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    points: integer('points').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    games: integer('games').notNull().default(0),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.userId] }),
    index('rankings_points_idx').on(t.seasonId, t.points),
  ],
);

export const gameResults = pgTable(
  'game_results',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nationId: text('nation_id').notNull(),
    seasonId: text('season_id'),
    won: boolean('won').notNull(),
    points: integer('points').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.userId] })],
);

// ───────────────────────────── Légal, sécurité, données ─────────────────────────────

export const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docId: text('doc_id').notNull(),
    version: integer('version').notNull(),
    acceptedAt: tz('accepted_at').notNull().defaultNow(),
    ipHash: text('ip_hash'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.docId, t.version] })],
);

/** Empreintes de connexion (IP hachée, user-agent haché) : détection des multi-comptes. */
export const userFingerprints = pgTable(
  'user_fingerprints',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash').notNull(),
    uaHash: text('ua_hash').notNull(),
    userAgent: text('user_agent'),
    firstSeen: tz('first_seen').notNull().defaultNow(),
    lastSeen: tz('last_seen').notNull().defaultNow(),
    hits: integer('hits').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ipHash, t.uaHash] }),
    index('user_fingerprints_ip_idx').on(t.ipHash),
  ],
);

export type DataKind =
  'rules' | 'research' | 'orbat' | 'scenario' | 'nation' | 'province' | 'disputed';

/** Données de jeu modifiées depuis le back-office : chaque modification est une révision (retour arrière). */
export const dataRevisions = pgTable(
  'data_revisions',
  {
    id: serial('id').primaryKey(),
    kind: text('kind').$type<DataKind>().notNull(),
    key: text('key').notNull(),
    /** null = retour à la valeur du dépôt. */
    data: jsonb('data'),
    message: text('message').notNull().default(''),
    scope: text('scope').$type<ChangeScope>().notNull().default('new_games'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('data_revisions_key_idx').on(t.kind, t.key, t.id)],
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
  chatMessages,
  chatReads,
  serverSettings,
  pushSubscriptions,
  timelapseFrames,
  walletLedger,
  shopPacks,
  shopPromotions,
  purchases,
  stripeEvents,
  cosmetics,
  userCosmetics,
  seasons,
  rankings,
  gameResults,
  legalAcceptances,
  userFingerprints,
  dataRevisions,
};
