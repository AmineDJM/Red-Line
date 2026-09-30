/**
 * Formes des réponses des routes admin des phases 2 à 6, relevées dans le code du serveur
 * (apps/server/src/admin/data-routes.ts et ops-routes.ts) : le contrat partagé les nomme sans les typer.
 */
import type {
  Balance,
  ChangeScope,
  ChatMessage,
  DisputedArea,
  NationDef,
  Orbat,
  ProvinceDef,
  ResearchNode,
  Role,
  ScenarioFile,
  ShopPack,
  WorldEventBodySchema,
} from '@redline/shared';
import type { z } from 'zod';

export type DataKind =
  'rules' | 'research' | 'orbat' | 'scenario' | 'nation' | 'province' | 'disputed';

/** Révision de données (table data_revisions). `data: null` = retour à la valeur du dépôt. */
export interface DataRevision<T = unknown> {
  id: number;
  kind: DataKind;
  key: string;
  data: T | null;
  message: string;
  scope: ChangeScope;
  authorId: string | null;
  createdAt: string;
}

/** Historique d'une donnée : révisions (récentes d'abord) et origine de la valeur en vigueur. */
export interface History<T = unknown> {
  revisions: DataRevision<T>[];
  source: 'admin' | 'repo';
}

/** GET d'une ressource versionnée. */
export interface Versioned<T> extends History<T> {
  data: T;
}

export interface RulesResponse extends History<Balance> {
  rules: Balance;
}

/** Réponse d'une écriture (PUT, revert, reset). */
export interface WriteResult<T = unknown> {
  revision: DataRevision<T>;
  /** Parties en cours mises à jour (portée « parties en cours »). */
  runningGames: number;
}

export interface MergeResult {
  merged: number;
  revision: DataRevision | null;
  runningGames: number;
}

export interface SaveMeta {
  message?: string;
  scope?: ChangeScope;
  playerMessage?: string;
}

export interface DataStatus {
  rev: number;
  warnings: string[];
  catalogErrors: string[];
  research: number;
  orbats: Record<string, number>;
  scenarios: number;
  photos: number;
}

export interface PhotoEntry {
  file: string;
  credit: string;
  license: string;
  sourceUrl: string;
  [k: string]: unknown;
}

export type WorldEventBody = z.input<typeof WorldEventBodySchema>;
export type WorldEventId = WorldEventBody['event'];

/** Message vu par la modération : texte toujours présent, même masqué. */
export interface AdminChatMessage extends ChatMessage {
  filtered: boolean;
}

export interface SuspiciousPair {
  users: { id: string; name: string; email: string | null; isGuest: boolean; banned: boolean }[];
  score: number;
  reasons: string[];
  sharedGames: string[];
}

export interface Anomaly {
  kind: 'order_rate' | string;
  userId: string;
  gameId: string;
  orders: number;
}

export interface AdminUser {
  id: string;
  displayName: string;
  email: string | null;
  role: Role;
  isGuest: boolean;
  premiumBalance: number;
  createdAt: string;
  lastSeenAt: string;
  bannedAt: string | null;
  banReason: string | null;
  chatMutedUntil: string | null;
}

export interface UserDetail {
  user: AdminUser;
  activityHours: number[];
  fingerprints: {
    ipHash: string;
    uaHash: string;
    userAgent: string | null;
    firstSeen: string;
    lastSeen: string;
    hits: number;
  }[];
  games: { gameId: string; nationId: string; name: string }[];
  purchases: Purchase[];
  wallet: {
    id: number;
    delta: number;
    reason: string;
    ref: string | null;
    gameId: string | null;
    balanceAfter: number;
    createdAt: string;
  }[];
}

export interface UserPatch {
  role?: Role;
  banned?: boolean;
  banReason?: string;
  chatMutedUntil?: string | null;
  displayName?: string;
}

export interface AdminPack {
  id: string;
  name: string;
  amount: number;
  bonus: number;
  priceCents: number;
  currency: 'eur' | 'usd';
  active: boolean;
  sort: number;
  updatedAt: string;
  /** Vue joueur (prix remisé, promotion en cours). */
  view: ShopPack;
}
export type PackBody = Omit<AdminPack, 'updatedAt' | 'view'>;

export interface Promotion {
  id: number;
  packId: string | null;
  label: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
}
export type PromoBody = Omit<Promotion, 'id' | 'createdAt'>;

export type PurchaseStatus = 'pending' | 'paid' | 'refunded' | 'failed';
export interface Purchase {
  id: string;
  userId: string | null;
  packId: string;
  credits: number;
  priceCents: number;
  currency: string;
  status: PurchaseStatus;
  stripeSessionId: string | null;
  paymentIntent: string | null;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  userName?: string | null;
  userEmail?: string | null;
}

export interface AuditEntry {
  id: number;
  adminId: string | null;
  adminName: string | null;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/** Métriques étendues (MetricsExtra du serveur), en plus du contrat `Metrics`. */
export interface MetricsExtra {
  gamesByStatus?: Record<string, number>;
  spectators?: number;
  stateBytes?: number;
  wsBytesOutPerMin?: number;
  wsMessagesOutPerMin?: number;
  chatMessagesPerMin?: number;
  pushSentPerMin?: number;
  eventLoopP99Ms?: number;
  eventLoopMaxMs?: number;
  flushesPerMin?: number;
  flushMsPerMin?: number;
  flushMaxMs?: number;
  gamesBehind?: number;
}

export type { NationDef, ProvinceDef, DisputedArea, ResearchNode, Orbat, ScenarioFile };
