import { z } from 'zod';
import type { GameId, NationId, UserId } from './ids.js';
import type { GameMeta } from './protocol.js';
import type { WeaponSystem } from './catalog.js';

/**
 * Contrat REST. Client et admin sont servis par le même service que l'API (même origine),
 * authentification par cookie de session httpOnly `rl_session`.
 *
 * Public
 *   POST /api/auth/guest                      → { user }
 *   POST /api/auth/register  RegisterBody     → { user }
 *   POST /api/auth/login     LoginBody        → { user }
 *   POST /api/auth/logout                     → { ok }
 *   GET  /api/me                              → { user } | 401
 *   GET  /api/catalog                         → { systems: WeaponSystem[] }   (actifs)
 *   GET  /api/map/nations                     → { nations: NationDef[] }
 *   GET  /api/map/provinces                   → { provinces: ProvinceDef[] }
 *   GET  /api/map/provinces.geojson           → FeatureCollection (properties.id = ProvinceId)
 *   GET  /api/map/tiles                       → { satellite: string, maxzoom: number }
 *   GET  /api/scenarios                       → { scenarios: ScenarioSummary[] }
 *   POST /api/games          CreateGameBody   → { game: GameMeta }
 *   GET  /api/games                           → { games: MyGame[] }
 *   GET  /api/games/:id                       → { game: GameMeta, me: NationId }
 *   DELETE /api/games/:id                     → { ok }  (partie solo de l'appelant, définitif)
 *   WS   /ws?gameId=…                         (MessagePack, voir protocol.ts)
 *   GET  /tiles/:file.pmtiles                 (requêtes HTTP Range)
 *   GET  /basemap/:file.geojson               (côtes, mers, villes)
 *   GET  /healthz                             → { ok }
 *
 * Admin (rôle requis indiqué)
 *   GET  /admin/api/systems                           balance   → { systems: AdminSystem[] }
 *   GET  /admin/api/systems/:id                       balance   → { system: AdminSystem }
 *   POST /admin/api/systems           SaveSystemBody  balance   → { system }        (création)
 *   PUT  /admin/api/systems/:id       SaveSystemBody  balance   → { system }        (modification)
 *   POST /admin/api/systems/:id/duplicate {newId}     balance   → { system }
 *   GET  /admin/api/systems/:id/history               balance   → { changes: CatalogChange[] }
 *   POST /admin/api/systems/:id/revert {changeId}     balance   → { system }
 *   GET  /admin/api/catalog/export                    balance   → { systems: WeaponSystem[] }
 *   POST /admin/api/catalog/import    ImportBody      balance   → { created, updated, errors }
 *   GET  /admin/api/games                             moderator → { games: AdminGame[] }
 *   POST /admin/api/games/:id/pause | /resume         moderator → { ok }
 *   POST /admin/api/games/:id/players/:nationId/ai    moderator { ai, aiLevel? } → { player }
 *        (IA imposée à la place du joueur, ou nation rendue au joueur)
 *   GET  /admin/api/metrics                           moderator → Metrics
 */

export const ROLES = ['player', 'moderator', 'balance', 'superadmin'] as const;
export type Role = (typeof ROLES)[number];

/** superadmin > balance > moderator > player. */
export function hasRole(userRole: Role, required: Role): boolean {
  return ROLES.indexOf(userRole) >= ROLES.indexOf(required);
}

export interface PublicUser {
  id: UserId;
  displayName: string;
  email: string | null;
  role: Role;
  isGuest: boolean;
}

export const RegisterBodySchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().min(2).max(40),
});
export const LoginBodySchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  playableNations: NationId[] | 'all';
}

export const CreateGameBodySchema = z.object({
  scenarioId: z.string().default('world-today'),
  nationId: z.string(),
  mode: z.enum(['solo']).default('solo'), // 'multi' en phase 5
  speed: z.number().positive().default(1),
  aiLevel: z.enum(['easy', 'normal', 'hard']).default('normal'),
});
export type CreateGameBody = z.infer<typeof CreateGameBodySchema>;

export interface MyGame {
  game: GameMeta;
  nationId: NationId;
  createdAt: string;
}

export type ChangeScope = 'new_games' | 'running_games';

export const SaveSystemBodySchema = z.object({
  data: z.unknown(), // validé par WeaponSystemSchema côté serveur
  message: z.string().max(500).default(''),
  scope: z.enum(['new_games', 'running_games']).default('new_games'),
  playerMessage: z.string().max(500).optional(),
});

export const ImportBodySchema = z.object({
  systems: z.array(z.unknown()),
  message: z.string().max(500).default('Import JSON'),
});

export interface AdminSystem {
  system: WeaponSystem;
  revision: number;
  updatedAt: string;
}

export interface CatalogChange {
  id: number;
  systemId: string;
  revision: number;
  before: WeaponSystem | null;
  after: WeaponSystem | null;
  message: string;
  scope: ChangeScope;
  author: string;
  createdAt: string;
}

export interface AdminGame {
  game: GameMeta;
  players: {
    nationId: NationId;
    userName: string | null;
    isAi: boolean;
    /** Joueur humain de la nation (null : nation tenue par une IA depuis le début ou partie quittée). */
    userId?: string | null;
    /** IA imposée par l'administration (le retour du joueur ne la retire pas). */
    aiForced?: boolean;
    /** Joueur connecté à la partie en ce moment. */
    connected?: boolean;
    lastActiveAt?: string | null;
  }[];
  gameTime: number;
  queueSize: number;
  unitCount: number;
}

export interface Metrics {
  uptimeS: number;
  rssMb: number;
  heapMb: number;
  cpuPct: number;
  eventLoopLagMs: number;
  games: number;
  connectedPlayers: number;
  eventsProcessedPerMin: number;
}

/*
 * ——— Phases 5 et 6 : REST supplémentaire ———
 *
 * Multijoueur
 *   GET  /api/lobby                              → { games: LobbyGame[] }        (parties ouvertes)
 *   POST /api/lobby            CreateLobbyBody    → { game: GameMeta }
 *   POST /api/lobby/:id/join   { nationId }       → { game: GameMeta }
 *   POST /api/lobby/:id/leave                     → { ok }
 *   POST /api/lobby/:id/start                     → { game }          (créateur, ou automatique quand plein)
 *   GET  /api/research                          → { nodes: ResearchNode[] }  (arbre effectif)
 *   GET  /api/balance                           → { balance: Balance | null } (équilibrage effectif)
 *   GET  /api/nations/info                    → { nations: NationInfo[] }  (description, doctrine, budget, drapeau)
 *   GET  /api/games/:id/spectate                  → { game }          (puis WS /ws?gameId=…&spectate=1)
 *   GET  /api/games/:id/stats                     → GameStatsView     (fin de partie)
 *   GET  /api/games/:id/timelapse                 → TimelapseView     (évolution des frontières)
 *   GET  /api/games/:id/battle-reports/:rid       → { report: BattleReport }
 *   Messagerie : WS { t:'chat' } ; historique envoyé à la connexion ({ t:'chatHistory' }).
 *
 * Notifications
 *   GET  /api/push/key                            → { publicKey }      (VAPID)
 *   POST /api/push/subscribe   PushSubscriptionJSON → { ok }
 *   DELETE /api/push/subscribe                    → { ok }
 *
 * Boutique (monnaie premium, Stripe Checkout, webhooks vérifiés côté serveur)
 *   GET  /api/shop/packs                          → { packs: ShopPack[] }
 *   GET  /api/shop/wallet                         → { balance, history: WalletEntry[] }
 *   POST /api/shop/checkout    { packId }         → { url }            (redirection Stripe Checkout)
 *   POST /api/stripe/webhook   (brut, signature Stripe-Signature)
 *   POST /api/games/:id/accelerate AccelerateBody → { ok, balance }   (dépense premium ; politique de la partie)
 *   GET  /api/shop/cosmetics                      → { items: CosmeticItem[], owned: string[] }
 *   POST /api/shop/cosmetics/:id/buy              → { ok, balance }
 *
 * Classements et saisons
 *   GET  /api/rankings?season=…                   → { season: SeasonView, entries: RankingEntry[] }
 *   GET  /api/seasons                             → { seasons: SeasonView[] }
 *
 * Légal (textes à faire valider par un professionnel)
 *   GET  /api/legal/:doc      doc ∈ cgu|cgv|privacy|withdrawal → { doc: LegalDoc }
 *   POST /api/legal/accept     { docs: {id, version}[] } → { ok }
 *   GET  /api/me → { user, legal: { needsAcceptance: LegalDocRef[] } }   (champ ajouté)
 *
 * Admin (phases 5-6)
 *   GET/PUT  /admin/api/rules                     balance   (data/balance, versionné, portée)
 *   GET/PUT  /admin/api/research[/:id]            balance
 *   GET/PUT  /admin/api/orbat/:set/:nationId      balance
 *   GET/PUT  /admin/api/scenarios[/:id]           balance
 *   GET/PUT  /admin/api/map/nations[/:id]         balance   (nom, couleur, capitale, kind, fusion)
 *   GET/PUT  /admin/api/map/provinces[/:id]       balance   (propriétaire initial, nom, revenus, bâtiments)
 *   GET/PUT  /admin/api/map/disputed[/:id]        balance
 *   POST     /admin/api/games/:id/event  WorldEventBody moderator (crise pétrolière, séance d'urgence…)
 *   GET      /admin/api/chat?gameId=&q=           moderator
 *   POST     /admin/api/chat/:messageId/hide      moderator
 *   GET      /admin/api/security/suspicious       moderator (multi-comptes, anomalies)
 *   GET/PUT  /admin/api/users[/:id]               superadmin (rôle, bannissement)
 *   GET/POST/PUT /admin/api/shop/packs[/:id]      superadmin
 *   GET/POST/PUT /admin/api/shop/promotions[/:id] superadmin
 *   GET      /admin/api/purchases                 superadmin
 *   POST     /admin/api/purchases/:id/refund      superadmin
 */

export interface LobbyGame {
  game: GameMeta;
  scenarioName: string;
  takenNations: NationId[];
  /** Pseudonyme du joueur qui tient chaque nation prise (écran de sélection). */
  takenBy?: Record<NationId, string>;
  creator: string;
  speed: number;
}

export const CreateLobbyBodySchema = z.object({
  scenarioId: z.string().default('world-today'),
  name: z.string().min(2).max(60),
  speed: z.number().positive().default(1),
  /** 64 joueurs humains au plus ; toutes les autres nations sont tenues par des IA. */
  maxPlayers: z.number().int().min(1).max(64).default(64),
  nationId: z.string(),
  victory: z
    .object({ provinceShare: z.number().min(0.1).max(1), allEnemyCapitals: z.boolean() })
    .optional(),
  shopPolicy: z
    .object({
      mode: z.enum(['open', 'limited', 'disabled']),
      capPerPlayer: z.number().int().min(0).optional(),
    })
    .default({ mode: 'open' }),
  /** Remplacer par une IA un joueur inactif depuis N heures réelles. */
  inactiveAiAfterH: z.number().positive().default(24),
  private: z.boolean().default(false),
  /** Niveau des IA actives qui tiennent toutes les nations sans joueur humain (facultatif). */
  aiLevel: z.enum(['easy', 'normal', 'hard']).default('normal'),
});
export type CreateLobbyBody = z.infer<typeof CreateLobbyBodySchema>;

export interface ShopPack {
  id: string;
  name: string;
  /** Monnaie premium créditée. */
  amount: number;
  bonus: number;
  priceCents: number;
  currency: 'eur' | 'usd';
  promo?: { label: string; percentOff: number; until: string } | null;
}

export interface WalletEntry {
  id: number;
  delta: number;
  reason: 'purchase' | 'accelerate' | 'cosmetic' | 'refund' | 'admin';
  ref: string | null;
  createdAt: string;
}

export const AccelerateBodySchema = z.object({
  target: z.object({
    type: z.enum(['production', 'research', 'build', 'repair']),
    id: z.string().max(64),
  }),
  /** Heures de jeu retirées. */
  hours: z
    .number()
    .positive()
    .max(24 * 30),
});

export interface CosmeticItem {
  id: string;
  kind: 'unit_skin' | 'flag' | 'map_theme' | 'terminal_theme';
  name: string;
  price: number;
  preview: string;
}

export interface SeasonView {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  rewards: { rank: number; cosmeticId: string }[];
}

export interface RankingEntry {
  rank: number;
  userId: UserId;
  name: string;
  points: number;
  wins: number;
  games: number;
}

export interface GameStatsView {
  winner: NationId | null;
  durationDays: number;
  nations: {
    nationId: NationId;
    player: string | null;
    provincesStart: number;
    provincesEnd: number;
    conquered: number;
    kills: number;
    losses: number;
    spentUsd: number;
    bestUnits: { systemId: string; kills: number }[];
  }[];
}

export interface TimelapseView {
  /** Un instantané des propriétaires par jour de jeu. */
  frames: { day: number; owners: Record<string, NationId> }[];
}

export interface LegalDocRef {
  id: 'cgu' | 'cgv' | 'privacy' | 'withdrawal';
  version: number;
}
export interface LegalDoc extends LegalDocRef {
  title: string;
  markdown: string;
  updatedAt: string;
}

export const WorldEventBodySchema = z.object({
  event: z.enum(['oil_crisis', 'emergency_council', 'market_crash', 'pandemic', 'arms_fair']),
  message: z.string().max(500).optional(),
  params: z.record(z.string(), z.number()).optional(),
});

/** POST /admin/api/games/:id/players/:nationId/ai : IA imposée (ai: true) ou nation rendue (false). */
export const AdminSetAiBodySchema = z.object({
  ai: z.boolean(),
  aiLevel: z.enum(['easy', 'normal', 'hard']).default('normal'),
});

/** Fiche d'une nation pour l'écran de sélection (données ORBAT publiques). */
export interface NationInfo {
  id: NationId;
  name: string;
  description: string;
  doctrine: string;
  doctrineText: string;
  defenseBudgetUsd: number;
  activePersonnel: number | null;
  provinceCount: number;
  /** Principaux systèmes en service (identifiants et quantités). */
  highlights: { systemId: string; count: number }[];
}
