/**
 * Client typé de l'API (contrat : packages/shared/src/api.ts ; formes exactes relevées dans
 * apps/server/src/admin/*.ts). Le transport est interchangeable : `fetchTransport` (serveur réel)
 * ou le serveur factice en mémoire (?mock=1).
 */
import type {
  AdminGame,
  AdminSystem,
  Balance,
  CatalogChange,
  ChangeScope,
  DisputedArea,
  ImportBodySchema,
  Metrics,
  NationDef,
  Orbat,
  ProvinceDef,
  PublicUser,
  ResearchNode,
  Role,
  SaveSystemBodySchema,
  ScenarioFile,
  WeaponSystem,
} from '@redline/shared';
import type {
  AdminChatMessage,
  AdminPack,
  AdminUser,
  Anomaly,
  AuditEntry,
  DataStatus,
  History,
  MergeResult,
  MetricsExtra,
  PackBody,
  PhotoEntry,
  PromoBody,
  Promotion,
  Purchase,
  PurchaseStatus,
  RulesResponse,
  SaveMeta,
  SuspiciousPair,
  UserDetail,
  UserPatch,
  Versioned,
  WorldEventBody,
  WriteResult,
} from './types';
import { opsApi } from './ops';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Corps exacts attendus par le serveur (types de sortie des schémas zod partagés). */
export type SaveSystemBody = ReturnType<(typeof SaveSystemBodySchema)['parse']>;
export type ImportBody = ReturnType<(typeof ImportBodySchema)['parse']> & {
  scope?: ChangeScope;
  playerMessage?: string;
};
export interface LoginBody {
  email: string;
  password: string;
}

/** Une erreur d'import telle que le serveur la décrit ({ index, id, message }). */
export type ImportErrorItem =
  | string
  | { id?: string | null; index?: number; message?: string; error?: string; issues?: unknown };

/** Réponse d'import : le serveur renvoie des nombres, le mock des listes d'identifiants. */
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
  get isConflict() {
    return this.status === 409;
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
            : { accept: 'application/json', 'content-type': 'application/json' },
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
/** Clé composée (« 2025/fra ») : chaque segment est encodé. */
const encKey = (key: string) => key.split('/').map(enc).join('/');

/** Chaîne de requête sans les valeurs vides. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

/** Corps d'écriture : champs vides retirés (le serveur applique ses défauts). */
function meta(m: SaveMeta = {}): SaveMeta {
  const out: SaveMeta = {};
  if (m.message?.trim()) out.message = m.message.trim();
  if (m.scope) out.scope = m.scope;
  if (m.playerMessage?.trim() && m.scope === 'running_games')
    out.playerMessage = m.playerMessage.trim();
  return out;
}

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

  /** Ressource versionnée : lecture, écriture, historique, retour arrière, réinitialisation. */
  const resource = <T>(base: string) => ({
    get: (key: string) => req<Versioned<T>>('GET', `${base}/${encKey(key)}`),
    save: (key: string, data: T, m?: SaveMeta) =>
      req<WriteResult<T>>('PUT', `${base}/${encKey(key)}`, { data, ...meta(m) }),
    history: (key: string) => req<History<T>>('GET', `${base}/${encKey(key)}/history`),
    revert: (key: string, revisionId: number, m?: SaveMeta) =>
      req<WriteResult<T>>('POST', `${base}/${encKey(key)}/revert`, { revisionId, ...meta(m) }),
    reset: (key: string, m?: SaveMeta) =>
      req<WriteResult<T>>('POST', `${base}/${encKey(key)}/reset`, meta(m)),
  });

  return {
    // ——— Session
    login: (b: LoginBody) => req<{ user: PublicUser }>('POST', '/api/auth/login', b),
    logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
    me: () => req<{ user: PublicUser }>('GET', '/api/me'),

    // ——— Public (lecture)
    publicNations: () => req<{ nations: NationDef[] }>('GET', '/api/map/nations'),
    photos: () => req<{ photos: Record<string, PhotoEntry> }>('GET', '/api/art/photos'),

    // ——— Catalogue
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
    revert: (id: string, changeId: number, m?: SaveMeta) =>
      req<{ system: AdminSystem }>('POST', `/admin/api/systems/${enc(id)}/revert`, {
        changeId,
        ...meta(m),
      }),
    exportCatalog: () => req<{ systems: WeaponSystem[] }>('GET', '/admin/api/catalog/export'),
    importCatalog: (b: ImportBody) => req<ImportResult>('POST', '/admin/api/catalog/import', b),

    // ——— Règles (data/balance)
    getRules: () => req<RulesResponse>('GET', '/admin/api/rules'),
    saveRules: (data: Balance, m?: SaveMeta) =>
      req<WriteResult<Balance>>('PUT', '/admin/api/rules', { data, ...meta(m) }),
    rulesHistory: () => req<History<Balance>>('GET', '/admin/api/rules/history'),
    revertRules: (revisionId: number, m?: SaveMeta) =>
      req<WriteResult<Balance>>('POST', '/admin/api/rules/revert', { revisionId, ...meta(m) }),
    resetRules: (m?: SaveMeta) =>
      req<WriteResult<Balance>>('POST', '/admin/api/rules/reset', meta(m)),

    // ——— Recherche, ORBAT, scénarios, carte
    listResearch: () => req<{ nodes: ResearchNode[] }>('GET', '/admin/api/research'),
    research: resource<ResearchNode>('/admin/api/research'),
    orbatSets: () => req<{ sets: Record<string, string[]> }>('GET', '/admin/api/orbat'),
    orbat: resource<Orbat>('/admin/api/orbat'),
    listScenarios: () => req<{ scenarios: ScenarioFile[] }>('GET', '/admin/api/scenarios'),
    scenario: resource<ScenarioFile>('/admin/api/scenarios'),
    listNations: () => req<{ nations: NationDef[] }>('GET', '/admin/api/map/nations'),
    nation: {
      ...resource<NationDef>('/admin/api/map/nations'),
      /** Fusion : les provinces de `id` passent à `into`. */
      merge: (id: string, into: string, m?: SaveMeta) =>
        req<MergeResult>('PUT', `/admin/api/map/nations/${enc(id)}`, {
          mergeInto: into,
          ...meta(m),
        }),
    },
    listProvinces: () => req<{ provinces: ProvinceDef[] }>('GET', '/admin/api/map/provinces'),
    province: resource<ProvinceDef>('/admin/api/map/provinces'),
    listDisputed: () => req<{ disputed: DisputedArea[] }>('GET', '/admin/api/map/disputed'),
    disputed: resource<DisputedArea>('/admin/api/map/disputed'),
    dataStatus: () => req<DataStatus>('GET', '/admin/api/data/status'),

    // ——— Parties en direct
    listGames: () => req<{ games: AdminGame[] }>('GET', '/admin/api/games'),
    pauseGame: (id: string) => req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/pause`),
    resumeGame: (id: string) => req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/resume`),
    /** IA imposée à la place du joueur (ai: true) ou nation rendue au joueur (ai: false). */
    setPlayerAi: (
      id: string,
      nationId: string,
      ai: boolean,
      aiLevel: 'easy' | 'normal' | 'hard' = 'normal',
    ) =>
      req<{
        player: { nationId: string; userId: string | null; isAi: boolean; aiForced: boolean };
      }>('POST', `/admin/api/games/${enc(id)}/players/${enc(nationId)}/ai`, { ai, aiLevel }),
    worldEvent: (id: string, b: WorldEventBody) =>
      req<{ ok: boolean }>('POST', `/admin/api/games/${enc(id)}/event`, b),
    metrics: () => req<Metrics & MetricsExtra>('GET', '/admin/api/metrics'),

    // ——— Messagerie
    listChat: (q: { gameId?: string; q?: string; userId?: string; limit?: number } = {}) =>
      req<{ messages: AdminChatMessage[] }>('GET', `/admin/api/chat${query(q)}`),
    hideMessage: (id: number, hidden = true) =>
      req<{ ok: boolean }>('POST', `/admin/api/chat/${id}/hide`, { hidden }),
    mute: (userId: string, hours: number) =>
      req<{ ok: boolean; mutedUntil: string | null }>('POST', '/admin/api/chat/mute', {
        userId,
        hours,
      }),

    // ——— Sécurité et utilisateurs
    suspicious: () =>
      req<{ pairs: SuspiciousPair[]; anomalies: Anomaly[] }>(
        'GET',
        '/admin/api/security/suspicious',
      ),
    listUsers: (q: { q?: string; limit?: number } = {}) =>
      req<{ users: AdminUser[] }>('GET', `/admin/api/users${query(q)}`),
    getUser: (id: string) => req<UserDetail>('GET', `/admin/api/users/${enc(id)}`),
    patchUser: (id: string, patch: UserPatch) =>
      req<{ user: AdminUser }>('PUT', `/admin/api/users/${enc(id)}`, patch),

    // ——— Boutique
    listPacks: () => req<{ packs: AdminPack[] }>('GET', '/admin/api/shop/packs'),
    createPack: (b: PackBody) => req<{ pack: AdminPack }>('POST', '/admin/api/shop/packs', b),
    updatePack: (id: string, b: PackBody) =>
      req<{ pack: AdminPack }>('PUT', `/admin/api/shop/packs/${enc(id)}`, b),
    listPromotions: () => req<{ promotions: Promotion[] }>('GET', '/admin/api/shop/promotions'),
    createPromotion: (b: PromoBody) =>
      req<{ promotion: Promotion }>('POST', '/admin/api/shop/promotions', b),
    updatePromotion: (id: number, b: PromoBody) =>
      req<{ promotion: Promotion }>('PUT', `/admin/api/shop/promotions/${id}`, b),
    listPurchases: (q: { status?: PurchaseStatus; userId?: string; limit?: number } = {}) =>
      req<{ purchases: Purchase[] }>('GET', `/admin/api/purchases${query(q)}`),
    refund: (id: string) =>
      req<{ ok: boolean; balance: number }>('POST', `/admin/api/purchases/${enc(id)}/refund`),

    // ——— Journal
    audit: (limit = 300) =>
      req<{ entries: AuditEntry[] }>('GET', `/admin/api/audit${query({ limit })}`),

    // ——— Économie du service, annonces, paramètres, gestion des comptes et des parties
    ...opsApi(req),
  };
}

export type Api = ReturnType<typeof createApi>;

/** Rôle minimal requis par groupe de routes (voir le contrat et les gardes du serveur). */
export const REQUIRED_ROLE = {
  catalog: 'balance',
  data: 'balance',
  games: 'moderator',
  moderation: 'moderator',
  superadmin: 'superadmin',
} as const satisfies Record<string, Role>;
