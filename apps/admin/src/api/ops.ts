/**
 * Routes de l'économie du service et de la gestion complète (apps/server/src/admin/economy-routes.ts et
 * manage-routes.ts). Branchées dans `createApi` (client.ts).
 */
import type {
  Announcement,
  AnnouncementBody,
  CostDashboard,
  CostEntry,
  CostEntryBody,
  CostPeriod,
  CostReport,
  CostSettings,
  GameCost,
  RuntimeSettings,
  UserCost,
  UserKind,
} from '@redline/shared';
import type { AdminUser, AuditEntry } from './types';

type Req = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<T>;

const enc = encodeURIComponent;
function qs(params: Record<string, string | number | undefined | null>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

export interface UserOverview {
  sessions: { n: number; createdAt: string; expiresAt: string; userAgent: string | null }[];
  games: {
    gameId: string;
    name: string;
    mode: 'solo' | 'multi';
    status: string;
    nationId: string;
    createdAt: string;
    endedAt: string | null;
    lastActiveAt: string | null;
    isAi: boolean;
    owner: boolean;
    loaded: boolean;
    stateBytes: number;
  }[];
  results: { wins: number; games: number; points: number };
  wallet: { balance: number; bought: number; spent: number; admin: number };
  costMonth: UserCost | null;
  kind: UserKind;
}

export interface ArchivedGame {
  id: string;
  name: string;
  mode: 'solo' | 'multi';
  scenarioId: string;
  endReason: 'victory' | 'abandoned' | 'admin';
  winner: string | null;
  createdAt: string;
  endedAt: string | null;
  stateBytes: number;
  unranked: boolean;
  humans: number;
}

export interface ServerSettingsInfo {
  speeds: number[];
  dormancyRadiusKm: number | null;
  snapshotIntervalS: number;
  createRateLimitPerMin: number;
  instanceId: string;
  nodeEnv: string;
  paymentsAvailable: boolean;
}

export type UserFilter = 'banned' | 'guest' | 'staff' | 'unlimited' | 'paying' | 'deleted';

export interface AuditQuery {
  limit?: number;
  action?: string;
  adminId?: string;
  target?: string;
  from?: string;
  to?: string;
  before?: number;
}

export function opsApi(req: Req) {
  return {
    // ——— Économie du service
    costDashboard: (period: CostPeriod) =>
      req<CostDashboard>('GET', `/admin/api/costs/dashboard${qs({ period })}`),
    costReportFull: (period: CostPeriod) =>
      req<{ report: CostReport }>('GET', `/admin/api/costs/report${qs({ period, full: 1 })}`),
    userCost: (id: string, period: CostPeriod = 'month') =>
      req<{ period: CostPeriod; cost: UserCost | null }>(
        'GET',
        `/admin/api/costs/users/${enc(id)}${qs({ period })}`,
      ),
    gameCost: (id: string, period: CostPeriod = 'month') =>
      req<{ period: CostPeriod; cost: GameCost | null }>(
        'GET',
        `/admin/api/costs/games/${enc(id)}${qs({ period })}`,
      ),
    costSettings: () => req<{ settings: CostSettings }>('GET', '/admin/api/costs/settings'),
    saveCostSettings: (s: CostSettings) =>
      req<{ settings: CostSettings }>('PUT', '/admin/api/costs/settings', s),
    costEntries: () => req<{ entries: CostEntry[] }>('GET', '/admin/api/costs/entries'),
    addCostEntry: (b: CostEntryBody) =>
      req<{ entry: CostEntry }>('POST', '/admin/api/costs/entries', b),
    deleteCostEntry: (id: number) =>
      req<{ ok: boolean }>('DELETE', `/admin/api/costs/entries/${id}`),

    // ——— Annonces
    announcements: () => req<{ announcements: Announcement[] }>('GET', '/admin/api/announcements'),
    createAnnouncement: (b: AnnouncementBody) =>
      req<{ announcement: Announcement; sent: number }>('POST', '/admin/api/announcements', b),
    updateAnnouncement: (id: number, b: { active?: boolean; endsAt?: string }) =>
      req<{ announcement: Announcement }>('PUT', `/admin/api/announcements/${id}`, b),
    deleteAnnouncement: (id: number) =>
      req<{ ok: boolean }>('DELETE', `/admin/api/announcements/${id}`),

    // ——— Paramètres d'exploitation
    serverSettings: () =>
      req<{ settings: RuntimeSettings; info: ServerSettingsInfo }>(
        'GET',
        '/admin/api/server/settings',
      ),
    saveServerSettings: (s: RuntimeSettings) =>
      req<{ settings: RuntimeSettings }>('PUT', '/admin/api/server/settings', s),

    // ——— Comptes
    searchUsers: (q: { q?: string; filter?: UserFilter; limit?: number }) =>
      req<{ users: AdminUser[] }>('GET', `/admin/api/users${qs(q)}`),
    userOverview: (id: string) => req<UserOverview>('GET', `/admin/api/users/${enc(id)}/overview`),
    suspendUser: (id: string, hours: number, reason?: string) =>
      req<{ ok: boolean; bannedUntil: string }>('POST', `/admin/api/users/${enc(id)}/suspend`, {
        hours,
        ...(reason ? { reason } : {}),
      }),
    revokeSessions: (id: string) =>
      req<{ ok: boolean; revoked: number }>('POST', `/admin/api/users/${enc(id)}/sessions/revoke`),
    resetPassword: (id: string) =>
      req<{ ok: boolean; password: string }>('POST', `/admin/api/users/${enc(id)}/password-reset`),
    adjustWallet: (id: string, delta: number, note: string) =>
      req<{ ok: boolean; balance: number }>('POST', `/admin/api/users/${enc(id)}/wallet`, {
        delta,
        note,
      }),
    exportUser: (id: string) =>
      req<Record<string, unknown>>('GET', `/admin/api/users/${enc(id)}/export`),
    deleteUser: (id: string, confirm: string) =>
      req<{ ok: boolean; deletedGames: number }>('DELETE', `/admin/api/users/${enc(id)}`, {
        confirm,
      }),

    // ——— Parties
    endGame: (id: string, message?: string) =>
      req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/end`, message ? { message } : {}),
    deleteGame: (id: string, confirm: string) =>
      req<{ ok: boolean }>('DELETE', `/admin/api/games/${enc(id)}`, { confirm }),
    archivedGames: (q: { q?: string; limit?: number } = {}) =>
      req<{ games: ArchivedGame[] }>('GET', `/admin/api/games/archive${qs(q)}`),

    // ——— Journal (filtres côté serveur)
    auditQuery: (q: AuditQuery) =>
      req<{ entries: AuditEntry[] }>('GET', `/admin/api/audit${qs({ ...q })}`),
  };
}
