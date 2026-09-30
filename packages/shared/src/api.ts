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
  players: { nationId: NationId; userName: string | null; isAi: boolean }[];
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
