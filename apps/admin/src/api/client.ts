/**
 * Client typé de l'API (contrat : packages/shared/src/api.ts).
 * Le transport est interchangeable : `fetchTransport` (serveur réel) ou le mock en mémoire (?mock=1).
 */
import type {
  AdminGame,
  AdminSystem,
  CatalogChange,
  ImportBodySchema,
  Metrics,
  PublicUser,
  Role,
  SaveSystemBodySchema,
  WeaponSystem,
} from '@redline/shared';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Corps exacts attendus par le serveur (types de sortie des schémas zod partagés). */
export type SaveSystemBody = ReturnType<(typeof SaveSystemBodySchema)['parse']>;
export type ImportBody = ReturnType<(typeof ImportBodySchema)['parse']>;
export interface LoginBody {
  email: string;
  password: string;
}

/** Une erreur d'import telle que le serveur peut la décrire (forme non figée par le contrat). */
export type ImportErrorItem =
  string | { id?: string; index?: number; message?: string; error?: string; issues?: unknown };

/** Réponse d'import. Le contrat nomme les champs sans les typer : nombres ou listes d'identifiants. */
export interface ImportResult {
  created: number | string[];
  updated: number | string[];
  errors: ImportErrorItem[] | number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export interface Transport {
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
}

/** Transport HTTP réel : même origine, cookie de session httpOnly. */
export const fetchTransport: Transport = {
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
              },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, e instanceof Error ? e.message : String(e), 'network');
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const o = (json ?? {}) as {
        error?: unknown;
        message?: unknown;
        code?: unknown;
        issues?: unknown;
      };
      const message =
        typeof o.message === 'string'
          ? o.message
          : typeof o.error === 'string'
            ? o.error
            : res.statusText || `HTTP ${res.status}`;
      const code =
        typeof o.code === 'string' ? o.code : typeof o.error === 'string' ? o.error : undefined;
      throw new ApiError(res.status, message, code, o.issues ?? json);
    }
    return json as T;
  },
};

const enc = encodeURIComponent;

export function createApi(t: Transport, onUnauthorized?: () => void) {
  const req = async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    try {
      return await t.request<T>(method, path, body);
    } catch (e) {
      // /api/me et /api/auth/login gèrent eux-mêmes le 401.
      if (e instanceof ApiError && e.isUnauthorized && !path.startsWith('/api/'))
        onUnauthorized?.();
      throw e;
    }
  };
  return {
    login: (b: LoginBody) => req<{ user: PublicUser }>('POST', '/api/auth/login', b),
    logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
    me: () => req<{ user: PublicUser }>('GET', '/api/me'),

    listSystems: () => req<{ systems: AdminSystem[] }>('GET', '/admin/api/systems'),
    getSystem: (id: string) => req<{ system: AdminSystem }>('GET', `/admin/api/systems/${enc(id)}`),
    createSystem: (b: SaveSystemBody) =>
      req<{ system: AdminSystem }>('POST', '/admin/api/systems', b),
    updateSystem: (id: string, b: SaveSystemBody) =>
      req<{ system: AdminSystem }>('PUT', `/admin/api/systems/${enc(id)}`, b),
    duplicateSystem: (id: string, newId: string) =>
      req<{ system: AdminSystem }>('POST', `/admin/api/systems/${enc(id)}/duplicate`, { newId }),
    history: (id: string) =>
      req<{ changes: CatalogChange[] }>('GET', `/admin/api/systems/${enc(id)}/history`),
    revert: (id: string, changeId: number) =>
      req<{ system: AdminSystem }>('POST', `/admin/api/systems/${enc(id)}/revert`, { changeId }),
    exportCatalog: () => req<{ systems: WeaponSystem[] }>('GET', '/admin/api/catalog/export'),
    importCatalog: (b: ImportBody) => req<ImportResult>('POST', '/admin/api/catalog/import', b),

    listGames: () => req<{ games: AdminGame[] }>('GET', '/admin/api/games'),
    pauseGame: (id: string) => req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/pause`),
    resumeGame: (id: string) => req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/resume`),
    metrics: () => req<Metrics>('GET', '/admin/api/metrics'),
  };
}

export type Api = ReturnType<typeof createApi>;

/** Rôle minimal requis par section (voir le contrat). */
export const REQUIRED_ROLE = {
  catalog: 'balance',
  games: 'moderator',
} as const satisfies Record<string, Role>;
