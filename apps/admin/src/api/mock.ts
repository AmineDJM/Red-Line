/**
 * Serveur factice en mémoire (?mock=1) : mêmes routes et mêmes réponses que le contrat,
 * pour développer et tester le back-office sans serveur. Chargé à la demande (pas dans le bundle principal).
 */
import {
  CatalogFileSchema,
  WeaponSystemSchema,
  hasRole,
  type AdminGame,
  type AdminSystem,
  type CatalogChange,
  type ChangeScope,
  type Metrics,
  type PublicUser,
  type Role,
  type WeaponSystem,
} from '@redline/shared';
import { ApiError, type HttpMethod, type ImportErrorItem, type Transport } from './client';

const files = import.meta.glob('../../../../data/catalog/*.json', {
  eager: true,
  import: 'default',
});

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Body {
  data?: unknown;
  message?: string;
  scope?: ChangeScope;
  playerMessage?: string;
  newId?: string;
  changeId?: number;
  systems?: unknown[];
  email?: string;
  password?: string;
}

export function createMockTransport(opts: { role?: Role; latencyMs?: number } = {}): Transport {
  const role: Role = opts.role ?? 'superadmin';
  const latency = opts.latencyMs ?? 120;
  const systems = new Map<string, AdminSystem>();
  const changes: CatalogChange[] = [];
  let changeSeq = 1;
  const t0 = Date.now() - 36 * 3600_000;

  const record = (
    before: WeaponSystem | null,
    after: WeaponSystem | null,
    message: string,
    scope: ChangeScope,
    author: string,
    at = now(),
  ): number => {
    const id = (after ?? before)!.id;
    const rev = (systems.get(id)?.revision ?? 0) + (before ? 1 : 0);
    changes.push({
      id: changeSeq++,
      systemId: id,
      revision: before ? rev : 1,
      before: before && clone(before),
      after: after && clone(after),
      message,
      scope,
      author,
      createdAt: at,
    });
    return before ? rev : 1;
  };

  // Catalogue initial : les fichiers de data/catalog, avec un historique de création.
  for (const raw of Object.values(files)) {
    const parsed = CatalogFileSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const s of parsed.data.systems) {
      const at = new Date(t0).toISOString();
      record(null, s, 'Import initial depuis data/catalog', 'new_games', 'système', at);
      systems.set(s.id, { system: s, revision: 1, updatedAt: at });
    }
  }
  // Quelques révisions d'exemple pour l'historique.
  const demo = (
    id: string,
    patch: (s: WeaponSystem) => void,
    message: string,
    hoursAgo: number,
    scope: ChangeScope = 'new_games',
  ) => {
    const cur = systems.get(id);
    if (!cur) return;
    const next = clone(cur.system);
    patch(next);
    const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const rev = record(cur.system, next, message, scope, 'amine', at);
    systems.set(id, { system: next, revision: rev, updatedAt: at });
  };
  demo(
    'us.f-16',
    (s) => {
      s.cost.money = 1300;
      s.buildTimeH = 40;
    },
    'Premier réglage après les tests internes',
    30,
  );
  demo(
    'us.f-16',
    (s) => {
      s.cost.money = 1200;
      s.buildTimeH = 36;
      s.damage.drone = 8;
    },
    'Retour au coût initial, drones un peu moins exposés',
    6,
    'running_games',
  );
  demo(
    'ru.mig-21',
    (s) => {
      s.enabled = false;
    },
    'Désactivé pour le scénario moderne',
    3,
  );

  const users: Record<string, PublicUser> = {};
  let session: PublicUser | null = null;
  try {
    const saved = sessionStorage.getItem('rl-mock-session');
    if (saved) session = JSON.parse(saved) as PublicUser;
  } catch {
    /* stockage indisponible */
  }
  const setSession = (u: PublicUser | null) => {
    session = u;
    try {
      if (u) sessionStorage.setItem('rl-mock-session', JSON.stringify(u));
      else sessionStorage.removeItem('rl-mock-session');
    } catch {
      /* stockage indisponible */
    }
  };

  const games: AdminGame[] = [
    {
      game: {
        id: 'g-7f3a',
        name: 'Opération Levant',
        mode: 'solo',
        scenarioId: 'world-today',
        status: 'running',
        speeds: [1, 2, 4, 8, 16],
      },
      players: [
        { nationId: 'fra', userName: 'Amine', isAi: false },
        { nationId: 'dza', userName: null, isAi: true },
        { nationId: 'esp', userName: null, isAi: true },
      ],
      gameTime: (2 * 24 + 14) * 3600_000 + 20 * 60_000,
      queueSize: 412,
      unitCount: 186,
    },
    {
      game: {
        id: 'g-91bc',
        name: 'Test équilibrage chasseurs',
        mode: 'solo',
        scenarioId: 'world-today',
        status: 'paused',
        speeds: [1, 2, 4, 8, 16],
      },
      players: [
        { nationId: 'usa', userName: 'testeur', isAi: false },
        { nationId: 'chn', userName: null, isAi: true },
      ],
      gameTime: 9 * 3600_000 + 45 * 60_000,
      queueSize: 88,
      unitCount: 74,
    },
    {
      game: {
        id: 'g-c210',
        name: 'Partie invitée',
        mode: 'solo',
        scenarioId: 'world-today',
        status: 'running',
        speeds: [1, 2, 4, 8, 16],
      },
      players: [
        { nationId: 'ind', userName: 'Invité 4821', isAi: false },
        { nationId: 'pak', userName: null, isAi: true },
      ],
      gameTime: 17 * 24 * 3600_000 + 3 * 3600_000,
      queueSize: 1290,
      unitCount: 402,
    },
  ];

  const need = (r: Role) => {
    if (!session) throw new ApiError(401, 'Non authentifié', 'unauthorized');
    if (!hasRole(session.role, r)) throw new ApiError(403, 'Rôle insuffisant', 'forbidden');
    return session;
  };
  const getOr404 = (id: string) => {
    const s = systems.get(id);
    if (!s) throw new ApiError(404, `Système inconnu : ${id}`, 'not_found');
    return s;
  };
  const validate = (data: unknown): WeaponSystem => {
    const r = WeaponSystemSchema.safeParse(data);
    if (!r.success) throw new ApiError(400, 'Fiche invalide', 'validation', r.error.issues);
    return r.data;
  };
  const save = (
    sys: WeaponSystem,
    message: string,
    scope: ChangeScope,
    author: string,
  ): AdminSystem => {
    const cur = systems.get(sys.id);
    const rev = record(cur?.system ?? null, sys, message, scope, author);
    const next = { system: clone(sys), revision: rev, updatedAt: now() };
    systems.set(sys.id, next);
    return clone(next);
  };

  async function handle(method: HttpMethod, path: string, body: Body): Promise<unknown> {
    const p = path.split('?')[0]!;
    const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
    // ----- Public
    if (method === 'POST' && p === '/api/auth/login') {
      if (!body.email || !body.password)
        throw new ApiError(401, 'Identifiants incorrects', 'invalid_credentials');
      const u =
        users[body.email] ??
        (users[body.email] = {
          id: `u-${Object.keys(users).length + 1}`,
          displayName: body.email.split('@')[0] ?? 'admin',
          email: body.email,
          role,
          isGuest: false,
        });
      setSession(u);
      return { user: u };
    }
    if (method === 'POST' && p === '/api/auth/logout') {
      setSession(null);
      return { ok: true };
    }
    if (method === 'GET' && p === '/api/me') {
      if (!session) throw new ApiError(401, 'Non authentifié', 'unauthorized');
      return { user: session };
    }
    // ----- Catalogue (balance)
    if (seg[0] === 'admin' && seg[1] === 'api' && seg[2] === 'systems') {
      const me = need('balance');
      const id = seg[3];
      const action = seg[4];
      if (!id) {
        if (method === 'GET') return { systems: [...systems.values()].map(clone) };
        if (method === 'POST') {
          const sys = validate(body.data);
          if (systems.has(sys.id))
            throw new ApiError(409, `L'identifiant ${sys.id} existe déjà`, 'exists');
          return {
            system: save(sys, body.message ?? '', body.scope ?? 'new_games', me.displayName),
          };
        }
      } else if (!action) {
        if (method === 'GET') return { system: clone(getOr404(id)) };
        if (method === 'PUT') {
          getOr404(id);
          const sys = validate(body.data);
          if (sys.id !== id)
            throw new ApiError(400, "L'identifiant ne peut pas être modifié", 'id_mismatch');
          return {
            system: save(sys, body.message ?? '', body.scope ?? 'new_games', me.displayName),
          };
        }
      } else if (action === 'duplicate' && method === 'POST') {
        const src = getOr404(id);
        const newId = String(body.newId ?? '');
        if (systems.has(newId))
          throw new ApiError(409, `L'identifiant ${newId} existe déjà`, 'exists');
        const sys = validate({
          ...clone(src.system),
          id: newId,
          name: `${src.system.name} (copie)`,
          enabled: false,
        });
        return { system: save(sys, `Copie de ${id}`, 'new_games', me.displayName) };
      } else if (action === 'history' && method === 'GET') {
        getOr404(id);
        return {
          changes: changes
            .filter((c) => c.systemId === id)
            .reverse()
            .map(clone),
        };
      } else if (action === 'revert' && method === 'POST') {
        getOr404(id);
        const ch = changes.find((c) => c.id === body.changeId && c.systemId === id);
        if (!ch) throw new ApiError(404, 'Modification inconnue', 'not_found');
        if (!ch.before)
          throw new ApiError(400, 'Impossible de revenir avant la création', 'no_before');
        return {
          system: save(
            ch.before,
            `Retour arrière : révision ${ch.revision}`,
            'new_games',
            me.displayName,
          ),
        };
      }
    }
    if (method === 'GET' && p === '/admin/api/catalog/export') {
      need('balance');
      return { systems: [...systems.values()].map((s) => clone(s.system)) };
    }
    if (method === 'POST' && p === '/admin/api/catalog/import') {
      const me = need('balance');
      const created: string[] = [];
      const updated: string[] = [];
      const errors: ImportErrorItem[] = [];
      (body.systems ?? []).forEach((raw, index) => {
        const r = WeaponSystemSchema.safeParse(raw);
        if (!r.success) {
          const id = (raw as { id?: unknown } | null)?.id;
          errors.push({
            index,
            id: typeof id === 'string' ? id : undefined,
            message: r.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; '),
          });
          return;
        }
        (systems.has(r.data.id) ? updated : created).push(r.data.id);
        save(r.data, body.message ?? 'Import JSON', 'new_games', me.displayName);
      });
      return { created, updated, errors };
    }
    // ----- Parties (moderator)
    if (method === 'GET' && p === '/admin/api/games') {
      need('moderator');
      for (const g of games) if (g.game.status === 'running') g.gameTime += 60_000;
      return { games: clone(games) };
    }
    if (
      method === 'POST' &&
      seg[2] === 'games' &&
      seg[3] &&
      (seg[4] === 'pause' || seg[4] === 'resume')
    ) {
      need('moderator');
      const g = games.find((x) => x.game.id === seg[3]);
      if (!g) throw new ApiError(404, 'Partie inconnue', 'not_found');
      g.game.status = seg[4] === 'pause' ? 'paused' : 'running';
      return { ok: true };
    }
    if (method === 'GET' && p === '/admin/api/metrics') {
      need('moderator');
      const s = Date.now() / 1000;
      const m: Metrics = {
        uptimeS: Math.round(s - t0 / 1000),
        rssMb: Math.round(412 + 30 * Math.sin(s / 20)),
        heapMb: Math.round(188 + 20 * Math.sin(s / 13)),
        cpuPct: Math.round(24 + 12 * Math.sin(s / 7) + 4 * Math.sin(s / 2.3)),
        eventLoopLagMs: Math.round((6 + 4 * Math.sin(s / 5)) * 10) / 10,
        games: games.filter((g) => g.game.status !== 'ended').length,
        connectedPlayers: 3,
        eventsProcessedPerMin: Math.round(5400 + 1200 * Math.sin(s / 11)),
      };
      return m;
    }
    throw new ApiError(404, `Route inconnue : ${method} ${p}`, 'not_found');
  }

  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      await delay(latency);
      return clone((await handle(method, path, (body ?? {}) as Body)) as T);
    },
  };
}
