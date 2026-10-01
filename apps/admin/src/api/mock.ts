/**
 * Serveur factice en mémoire (?mock=1) : mêmes routes, mêmes gardes de rôle et mêmes formes de réponse
 * que le serveur réel (apps/server/src/admin/*.ts), pour développer et tester le back-office sans serveur.
 * Chargé à la demande (pas dans le bundle principal).
 */
import {
  BalanceSchema,
  DisputedAreaSchema,
  NationDefSchema,
  OrbatSchema,
  ProvinceDefSchema,
  ROLES,
  ResearchNodeSchema,
  ScenarioFileSchema,
  WeaponSystemSchema,
  WorldEventBodySchema,
  hasRole,
  type AdminGame,
  type AdminSystem,
  type CatalogChange,
  type ChangeScope,
  type Metrics,
  type NationDef,
  type ProvinceDef,
  type PublicUser,
  type Role,
  type WeaponSystem,
} from '@redline/shared';
import type { z } from 'zod';
import { ApiError, type HttpMethod, type ImportErrorItem, type Transport } from './client';
import type {
  AdminPack,
  AuditEntry,
  DataKind,
  DataRevision,
  MetricsExtra,
  PackBody,
  PromoBody,
  UserPatch,
} from './types';
import {
  loadBalance,
  loadMap,
  loadOrbats,
  loadPhotos,
  loadResearch,
  loadScenarios,
  loadSystems,
  seedAudit,
  seedChat,
  seedGames,
  seedSecurity,
  seedShop,
  seedUsers,
} from './mock/seed';
import { registerOpsMock } from './mock/ops';

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = 3600_000;

type Body = Record<string, unknown>;

const SCHEMAS: Record<DataKind, z.ZodTypeAny> = {
  rules: BalanceSchema,
  research: ResearchNodeSchema,
  orbat: OrbatSchema,
  scenario: ScenarioFileSchema,
  nation: NationDefSchema,
  province: ProvinceDefSchema,
  disputed: DisputedAreaSchema,
};

const zodMessage = (issues: z.ZodIssue[]) =>
  issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(données)'} : ${i.message}`)
    .join(' ; ');

export function createMockTransport(opts: { role?: Role; latencyMs?: number } = {}): Transport {
  const role: Role = opts.role ?? 'superadmin';
  const latency = opts.latencyMs ?? 120;
  const t0 = Date.now() - 36 * H;

  // ─────────── Catalogue ───────────
  const systems = new Map<string, AdminSystem>();
  const changes: CatalogChange[] = [];
  let changeSeq = 1;
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
  const allSystems = loadSystems();
  for (const s of allSystems) {
    const at = new Date(t0).toISOString();
    record(null, s, 'Import initial depuis data/catalog', 'new_games', 'système', at);
    systems.set(s.id, { system: s, revision: 1, updatedAt: at });
  }
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
    const at = new Date(Date.now() - hoursAgo * H).toISOString();
    const rev = record(cur.system, next, message, scope, 'Amine', at);
    systems.set(id, { system: next, revision: rev, updatedAt: at });
  };
  demo(
    'us.f-16',
    (s) => {
      s.buildTimeH = Math.round(s.buildTimeH * 1.1);
    },
    'Premier réglage après les tests internes',
    30,
  );
  demo(
    'us.f-16',
    (s) => {
      s.damage.drone = Math.max(0, s.damage.drone - 1);
    },
    'Drones un peu moins exposés',
    6,
    'running_games',
  );
  demo('ru.mig-21', (s) => void (s.enabled = false), 'Désactivé pour le scénario moderne', 3);

  // ─────────── Données versionnées (data_revisions) ───────────
  const map = loadMap();
  const repo: Record<DataKind, Map<string, unknown>> = {
    rules: new Map([['default', loadBalance()]]),
    research: new Map(loadResearch().map((n) => [n.id, n])),
    orbat: new Map(),
    scenario: new Map(loadScenarios().map((s) => [s.id, s])),
    nation: new Map(map.nations.map((n) => [n.id, n])),
    province: new Map(map.provinces.map((p) => [p.id, p])),
    disputed: new Map(map.disputed.map((d) => [d.id, d])),
  };
  for (const [set, list] of Object.entries(loadOrbats(new Set(systems.keys()))))
    for (const o of list) repo.orbat.set(`${set}/${o.nationId}`, o);
  const photos = loadPhotos();
  const revs: DataRevision[] = [];
  let revSeq = 1;

  const currentValue = (kind: DataKind, key: string): unknown => {
    for (let i = revs.length - 1; i >= 0; i--) {
      const r = revs[i]!;
      if (r.kind === kind && r.key === key) return r.data ?? repo[kind].get(key) ?? null;
    }
    return repo[kind].get(key) ?? null;
  };
  const listValues = <T>(kind: DataKind): T[] => {
    const keys = new Set([
      ...repo[kind].keys(),
      ...revs.filter((r) => r.kind === kind).map((r) => r.key),
    ]);
    return [...keys].map((k) => currentValue(kind, k)).filter((v) => v != null) as T[];
  };
  const history = (kind: DataKind, key: string) => {
    const list = revs.filter((r) => r.kind === kind && r.key === key).reverse();
    return { revisions: clone(list), source: list.length ? 'admin' : 'repo' };
  };

  // ─────────── Exploitation ───────────
  const users = seedUsers();
  const games = seedGames();
  const chat = seedChat(games, users);
  const security = seedSecurity(users, games);
  const shop = seedShop(users);
  const audit: AuditEntry[] = seedAudit(users);
  let auditSeq = 101;
  const metricsHistory = { start: Date.now() };

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
  const accounts: Record<string, PublicUser> = {};

  const need = (r: Role) => {
    if (!session) throw new ApiError(401, 'Non authentifié', 'unauthorized');
    if (!hasRole(session.role, r)) throw new ApiError(403, 'Rôle insuffisant', 'forbidden');
    return session;
  };
  const log = (action: string, target: string, before: unknown = null, after: unknown = null) => {
    audit.unshift({
      id: auditSeq++,
      adminId: session?.id ?? null,
      adminName: session?.displayName ?? null,
      action,
      target,
      before: clone(before ?? null),
      after: clone(after ?? null),
      createdAt: now(),
    });
  };

  const validateData = (kind: DataKind, key: string, data: unknown) => {
    const r = SCHEMAS[kind].safeParse(data);
    if (!r.success)
      throw new ApiError(400, zodMessage(r.error.issues), 'invalid_data', r.error.issues);
    const v = r.data as { id?: string; nationId?: string };
    if (kind === 'orbat') {
      if (`${key.split('/')[0]}/${v.nationId}` !== key)
        throw new ApiError(400, "La nation de l'ORBAT ne correspond pas au chemin", 'id_mismatch');
    } else if (kind !== 'rules' && v.id !== key) {
      throw new ApiError(400, "L'identifiant ne peut pas changer", 'id_mismatch');
    }
    return r.data as unknown;
  };
  const runningCount = () => games.filter((g) => g.game.status === 'running').length;
  const writeData = (kind: DataKind, key: string, data: unknown, body: Body, action: string) => {
    const me = need('balance');
    const before = currentValue(kind, key);
    const scope = (body.scope as ChangeScope) ?? 'new_games';
    const rev: DataRevision = {
      id: revSeq++,
      kind,
      key,
      data: clone(data),
      message: String(body.message ?? '') || `Modification de ${kind} ${key}`,
      scope,
      authorId: me.id,
      createdAt: now(),
    };
    revs.push(rev);
    log(action, `${kind}:${key}`, before, data);
    return {
      revision: clone(rev),
      runningGames: scope === 'running_games' && kind !== 'scenario' ? runningCount() : 0,
    };
  };

  // Quelques révisions d'exemple (historique et retour arrière visibles d'emblée).
  const seedRev = (
    kind: DataKind,
    key: string,
    patch: (v: never) => void,
    message: string,
    h: number,
  ) => {
    const cur = clone(currentValue(kind, key));
    if (!cur) return;
    patch(cur as never);
    revs.push({
      id: revSeq++,
      kind,
      key,
      data: cur,
      message,
      scope: 'new_games',
      authorId: users[0]!.id,
      createdAt: new Date(Date.now() - h * H).toISOString(),
    });
  };
  seedRev(
    'rules',
    'default',
    (b: { combat: { variance: number }; time: { captureMinutes: number } }) => {
      b.combat.variance = 0.25;
      b.time.captureMinutes = 120;
    },
    'Combats plus aléatoires, capture plus lente',
    40,
  );
  seedRev(
    'rules',
    'default',
    (b: { combat: { variance: number } }) => {
      b.combat.variance = 0.2;
    },
    'Retour de la variance à 20 %',
    20,
  );
  seedRev('nation', 'fra', (n: NationDef) => void (n.name = 'France'), 'Nom officiel', 90);

  // ─────────── Routage ───────────
  type Handler = (p: string[], body: Body, q: URLSearchParams) => unknown;
  const routes: [HttpMethod, RegExp, Handler][] = [];
  const on = (m: HttpMethod, pattern: string, h: Handler) => {
    const re = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
    routes.push([m, re, h]);
  };

  // ——— Session et public
  on('POST', '/api/auth/login', (_p, b) => {
    const email = String(b.email ?? '');
    if (!email || !b.password)
      throw new ApiError(401, 'Identifiants incorrects', 'invalid_credentials');
    const u = (accounts[email] ??= {
      id: users[0]!.id,
      displayName: email.split('@')[0] || 'admin',
      email,
      role,
      isGuest: false,
    });
    setSession(u);
    return { user: u };
  });
  on('POST', '/api/auth/logout', () => {
    setSession(null);
    return { ok: true };
  });
  on('GET', '/api/me', () => {
    if (!session) throw new ApiError(401, 'Non authentifié', 'unauthorized');
    return { user: session };
  });
  on('GET', '/api/map/nations', () => ({ nations: listValues('nation') }));
  on('GET', '/api/art/photos', () => ({ photos }));

  // ——— Catalogue
  const getSys = (id: string) => {
    const s = systems.get(id);
    if (!s) throw new ApiError(404, `Fiche ${id} introuvable`, 'not_found');
    return s;
  };
  const validateSys = (data: unknown): WeaponSystem => {
    const r = WeaponSystemSchema.safeParse(data);
    if (!r.success)
      throw new ApiError(400, zodMessage(r.error.issues), 'invalid_system', r.error.issues);
    return r.data;
  };
  const saveSys = (sys: WeaponSystem, message: string, scope: ChangeScope, action: string) => {
    const me = need('balance');
    const cur = systems.get(sys.id);
    const rev = record(cur?.system ?? null, sys, message, scope, me.displayName);
    const next = { system: clone(sys), revision: rev, updatedAt: now() };
    systems.set(sys.id, next);
    log(action, `system:${sys.id}`, cur?.system ?? null, sys);
    return clone(next);
  };
  on('GET', '/admin/api/systems', () => {
    need('balance');
    return { systems: [...systems.values()].map(clone) };
  });
  on('POST', '/admin/api/systems', (_p, b) => {
    need('balance');
    const sys = validateSys(b.data);
    if (systems.has(sys.id))
      throw new ApiError(409, `La fiche ${sys.id} existe déjà`, 'already_exists');
    return {
      system: saveSys(
        sys,
        String(b.message ?? '') || `Création de ${sys.id}`,
        (b.scope as ChangeScope) ?? 'new_games',
        'system.create',
      ),
    };
  });
  on('GET', '/admin/api/systems/:id', ([id]) => {
    need('balance');
    return { system: clone(getSys(id!)) };
  });
  on('PUT', '/admin/api/systems/:id', ([id], b) => {
    need('balance');
    getSys(id!);
    const sys = validateSys(b.data);
    if (sys.id !== id)
      throw new ApiError(400, "L'identifiant de la fiche ne peut pas changer", 'id_mismatch');
    return {
      system: saveSys(
        sys,
        String(b.message ?? '') || `Modification de ${id}`,
        (b.scope as ChangeScope) ?? 'new_games',
        'system.update',
      ),
    };
  });
  on('POST', '/admin/api/systems/:id/duplicate', ([id], b) => {
    need('balance');
    const src = getSys(id!);
    const newId = String(b.newId ?? '');
    if (systems.has(newId))
      throw new ApiError(409, `La fiche ${newId} existe déjà`, 'already_exists');
    const sys = validateSys({
      ...clone(src.system),
      id: newId,
      name: `${src.system.name} (copie)`,
      enabled: false,
    });
    return {
      system: saveSys(sys, `Duplication de ${id} en ${newId}`, 'new_games', 'system.duplicate'),
    };
  });
  on('GET', '/admin/api/systems/:id/history', ([id]) => {
    need('balance');
    getSys(id!);
    return {
      changes: changes
        .filter((c) => c.systemId === id)
        .reverse()
        .map(clone),
    };
  });
  on('POST', '/admin/api/systems/:id/revert', ([id], b) => {
    need('balance');
    getSys(id!);
    const ch = changes.find((c) => c.id === b.changeId && c.systemId === id);
    if (!ch) throw new ApiError(404, 'Modification introuvable pour cette fiche', 'not_found');
    if (!ch.before)
      throw new ApiError(
        400,
        'Cette modification est une création : désactivez la fiche plutôt que de la supprimer',
        'revert_creation',
      );
    return {
      system: saveSys(
        ch.before,
        String(b.message ?? '') || `Retour arrière (modification n° ${ch.id})`,
        (b.scope as ChangeScope) ?? 'new_games',
        'system.revert',
      ),
    };
  });
  on('GET', '/admin/api/catalog/export', () => {
    need('balance');
    return { systems: [...systems.values()].map((s) => clone(s.system)) };
  });
  on('POST', '/admin/api/catalog/import', (_p, b) => {
    need('balance');
    const created: string[] = [];
    const updated: string[] = [];
    const errors: ImportErrorItem[] = [];
    ((b.systems as unknown[]) ?? []).forEach((raw, index) => {
      const r = WeaponSystemSchema.safeParse(raw);
      if (!r.success) {
        const id = (raw as { id?: unknown } | null)?.id;
        errors.push({
          index,
          id: typeof id === 'string' ? id : undefined,
          message: zodMessage(r.error.issues),
        });
        return;
      }
      (systems.has(r.data.id) ? updated : created).push(r.data.id);
      saveSys(r.data, String(b.message ?? 'Import JSON'), 'new_games', 'catalog.import');
    });
    return { created, updated, errors };
  });

  // ——— Règles
  on('GET', '/admin/api/rules', () => {
    need('balance');
    return { rules: clone(currentValue('rules', 'default')), ...history('rules', 'default') };
  });
  on('PUT', '/admin/api/rules', (_p, b) => {
    need('balance');
    const data = validateData('rules', 'default', b.data);
    return writeData(
      'rules',
      'default',
      data,
      { ...b, message: b.message || "Modification de l'équilibrage" },
      'data.rules.update',
    );
  });
  on('GET', '/admin/api/rules/history', () => {
    need('balance');
    return history('rules', 'default');
  });
  on('POST', '/admin/api/rules/revert', (_p, b) => {
    need('balance');
    const rev = revs.find((r) => r.id === b.revisionId && r.kind === 'rules');
    if (!rev) throw new ApiError(404, 'Révision introuvable', 'not_found');
    if (rev.data === null) throw new ApiError(400, 'données : Required', 'invalid_data');
    return writeData(
      'rules',
      'default',
      rev.data,
      { ...b, message: b.message || `Retour à la révision n° ${rev.id}` },
      'data.rules.revert',
    );
  });
  on('POST', '/admin/api/rules/reset', (_p, b) => {
    need('balance');
    return writeData(
      'rules',
      'default',
      null,
      { ...b, message: b.message || 'Retour à l’équilibrage du dépôt' },
      'data.rules.reset',
    );
  });

  // ——— Ressources versionnées génériques
  const resource = (
    kind: DataKind,
    base: string,
    keyOf: (p: string[]) => string,
    withReset = true,
  ) => {
    const one = `${base}/${kind === 'orbat' ? ':set/:nation' : ':id'}`;
    on('GET', one, (p) => {
      need('balance');
      const key = keyOf(p);
      const v = currentValue(kind, key);
      if (v == null) throw new ApiError(404, 'Introuvable', 'not_found');
      return { data: clone(v), ...history(kind, key) };
    });
    on('PUT', one, (p, b) => {
      need('balance');
      const key = keyOf(p);
      if (kind === 'nation' && typeof b.mergeInto === 'string') return mergeNation(key, b);
      const data = validateData(kind, key, b.data);
      return writeData(kind, key, data, b, `data.${kind}.update`);
    });
    on('GET', `${one}/history`, (p) => {
      need('balance');
      return history(kind, keyOf(p));
    });
    on('POST', `${one}/revert`, (p, b) => {
      need('balance');
      const key = keyOf(p);
      const rev = revs.find((r) => r.id === b.revisionId);
      if (!rev || rev.kind !== kind || rev.key !== key)
        throw new ApiError(404, 'Révision introuvable pour cette donnée', 'not_found');
      return writeData(
        kind,
        key,
        rev.data,
        { ...b, message: b.message || `Retour à la révision n° ${rev.id}` },
        `data.${kind}.revert`,
      );
    });
    if (withReset)
      on('POST', `${one}/reset`, (p, b) => {
        need('balance');
        return writeData(
          kind,
          keyOf(p),
          null,
          { ...b, message: b.message || 'Retour à la valeur du dépôt' },
          `data.${kind}.reset`,
        );
      });
  };
  const mergeNation = (key: string, b: Body) => {
    const from = currentValue('nation', key) as NationDef | null;
    const into = currentValue('nation', String(b.mergeInto)) as NationDef | null;
    if (!from || !into || from.id === into.id)
      throw new ApiError(400, 'Nations de fusion invalides', 'invalid_merge');
    const moved = listValues<ProvinceDef>('province').filter((p) => p.nationId === key);
    let last: ReturnType<typeof writeData> | null = null;
    for (const pr of moved)
      last = writeData(
        'province',
        pr.id,
        { ...pr, nationId: into.id, isCapital: false },
        { message: b.message || `Fusion de ${from.name} dans ${into.name}`, scope: 'new_games' },
        'data.nation.merge',
      );
    return {
      merged: moved.length,
      revision: last?.revision ?? null,
      runningGames: b.scope === 'running_games' ? runningCount() : 0,
    };
  };

  on('GET', '/admin/api/research', () => {
    need('balance');
    return { nodes: listValues('research') };
  });
  resource('research', '/admin/api/research', ([id]) => id!);
  on('GET', '/admin/api/orbat', () => {
    need('balance');
    const sets: Record<string, string[]> = {};
    for (const k of new Set([
      ...repo.orbat.keys(),
      ...revs.filter((r) => r.kind === 'orbat').map((r) => r.key),
    ])) {
      if (currentValue('orbat', k) == null) continue;
      const [s, n] = k.split('/');
      (sets[s!] ??= []).push(n!);
    }
    for (const s of Object.values(sets)) s.sort();
    return { sets };
  });
  resource('orbat', '/admin/api/orbat', ([s, n]) => `${s}/${n}`);
  on('GET', '/admin/api/scenarios', () => {
    need('balance');
    return { scenarios: listValues('scenario') };
  });
  resource('scenario', '/admin/api/scenarios', ([id]) => id!);
  on('GET', '/admin/api/map/nations', () => {
    need('balance');
    return { nations: listValues('nation') };
  });
  resource('nation', '/admin/api/map/nations', ([id]) => id!);
  on('GET', '/admin/api/map/provinces', () => {
    need('balance');
    return { provinces: listValues('province') };
  });
  resource('province', '/admin/api/map/provinces', ([id]) => id!);
  on('GET', '/admin/api/map/disputed', () => {
    need('balance');
    return { disputed: listValues('disputed') };
  });
  resource('disputed', '/admin/api/map/disputed', ([id]) => id!);
  on('GET', '/admin/api/data/status', () => {
    need('balance');
    const orbats: Record<string, number> = {};
    for (const k of repo.orbat.keys()) {
      const s = k.split('/')[0]!;
      orbats[s] = (orbats[s] ?? 0) + 1;
    }
    return {
      rev: revs.at(-1)?.id ?? 0,
      warnings: [
        'orbat : fichiers absents du dépôt, jeu d’exemple du mode démonstration',
        'photos.json : 5 photos seulement (démonstration)',
      ],
      catalogErrors: [],
      research: listValues('research').length,
      orbats,
      scenarios: listValues('scenario').length,
      photos: Object.keys(photos).length,
    };
  });

  // ——— Parties
  const gameOr = (id: string): AdminGame => {
    const g = games.find((x) => x.game.id === id);
    if (!g) throw new ApiError(404, 'Partie introuvable', 'not_found');
    return g;
  };
  on('GET', '/admin/api/games', () => {
    need('moderator');
    for (const g of games) if (g.game.status === 'running') g.gameTime += 60_000;
    return { games: clone(games) };
  });
  for (const action of ['pause', 'resume'] as const)
    on('POST', `/admin/api/games/:id/${action}`, ([id]) => {
      need('moderator');
      const g = gameOr(id!);
      if (g.game.status === 'ended' || g.game.status === 'lobby')
        throw new ApiError(
          409,
          'Partie introuvable, terminée ou hébergée ailleurs',
          'game_unavailable',
        );
      g.game.status = action === 'pause' ? 'paused' : 'running';
      log(action === 'pause' ? 'game.pause' : 'game.resume', `game:${id}`);
      return { ok: true };
    });
  on('POST', '/admin/api/games/:id/players/:nation/ai', ([id, nation], b) => {
    need('moderator');
    const g = gameOr(id!);
    if (g.game.status === 'ended' || g.game.status === 'lobby')
      throw new ApiError(409, 'Partie introuvable ou hébergée ailleurs', 'game_unavailable');
    const p = g.players.find((x) => x.nationId === nation);
    if (!p?.userId)
      throw new ApiError(404, 'Aucun joueur humain ne tient cette nation', 'no_player');
    const ai = b.ai === true;
    p.isAi = ai;
    p.aiForced = ai;
    log(ai ? 'game.player_ai' : 'game.player_restore', `game:${id}`, null, { nationId: nation });
    return { player: { nationId: p.nationId, userId: p.userId, isAi: ai, aiForced: ai } };
  });
  on('POST', '/admin/api/games/:id/event', ([id], b) => {
    need('moderator');
    const g = gameOr(id!);
    const r = WorldEventBodySchema.safeParse(b);
    if (!r.success) throw new ApiError(400, zodMessage(r.error.issues), 'invalid_body');
    if (g.game.status === 'lobby')
      throw new ApiError(409, 'Partie non démarrée', 'game_unavailable');
    log('game.world_event', `game:${id}`, null, r.data);
    return { ok: true };
  });
  on('GET', '/admin/api/metrics', () => {
    need('moderator');
    const s = Date.now() / 1000;
    const m: Metrics & MetricsExtra = {
      uptimeS: Math.round((Date.now() - t0) / 1000),
      rssMb: Math.round(412 + 30 * Math.sin(s / 20)),
      heapMb: Math.round(188 + 20 * Math.sin(s / 13)),
      cpuPct: Math.round(24 + 12 * Math.sin(s / 7) + 4 * Math.sin(s / 2.3)),
      eventLoopLagMs: Math.round((6 + 4 * Math.sin(s / 5)) * 10) / 10,
      games: games.filter((g) => g.game.status !== 'ended').length,
      connectedPlayers: 14,
      eventsProcessedPerMin: Math.round(5400 + 1200 * Math.sin(s / 11)),
      gamesByStatus: games.reduce<Record<string, number>>((a, g) => {
        a[g.game.status] = (a[g.game.status] ?? 0) + 1;
        return a;
      }, {}),
      spectators: 3,
      stateBytes: 18_400_000 + Math.round(900_000 * Math.sin(s / 30)),
      wsBytesOutPerMin: Math.round(2_600_000 + 500_000 * Math.sin(s / 9)),
      wsMessagesOutPerMin: Math.round(4200 + 800 * Math.sin(s / 6)),
      chatMessagesPerMin: Math.max(0, Math.round(6 + 5 * Math.sin(s / 8))),
      pushSentPerMin: Math.max(0, Math.round(2 + 2 * Math.sin(s / 17))),
    };
    void metricsHistory;
    return m;
  });

  // ——— Messagerie
  on('GET', '/admin/api/chat', (_p, _b, q) => {
    need('moderator');
    const text = (q.get('q') ?? '').toLowerCase();
    const limit = Number(q.get('limit') ?? 200);
    return {
      messages: clone(
        chat
          .filter((m) => !q.get('gameId') || m.gameId === q.get('gameId'))
          .filter((m) => !q.get('userId') || m.from.userId === q.get('userId'))
          .filter((m) => !text || m.text.toLowerCase().includes(text))
          .slice(0, limit),
      ),
    };
  });
  on('POST', '/admin/api/chat/mute', (_p, b) => {
    need('moderator');
    const u = users.find((x) => x.id === b.userId);
    if (!u) throw new ApiError(404, 'Utilisateur introuvable', 'not_found');
    const hours = Number(b.hours ?? 0);
    u.chatMutedUntil = hours > 0 ? new Date(Date.now() + hours * H).toISOString() : null;
    log('chat.mute', `user:${u.id}`, null, { until: u.chatMutedUntil });
    return { ok: true, mutedUntil: u.chatMutedUntil };
  });
  on('POST', '/admin/api/chat/:mid/hide', ([mid], b) => {
    need('moderator');
    const m = chat.find((x) => x.id === Number(mid));
    if (!m) throw new ApiError(404, 'Message introuvable', 'not_found');
    const hidden = b.hidden !== false;
    if (hidden) m.hidden = true;
    else delete m.hidden;
    log(hidden ? 'chat.hide' : 'chat.unhide', `chat:${mid}`);
    return { ok: true, message: clone(m) };
  });

  // ——— Sécurité et utilisateurs
  on('GET', '/admin/api/security/suspicious', () => {
    need('moderator');
    return clone(security);
  });
  const userOr = (id: string) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'Utilisateur introuvable', 'not_found');
    return u;
  };
  on('GET', '/admin/api/users', (_p, _b, q) => {
    need('superadmin');
    const t = (q.get('q') ?? '').toLowerCase();
    const f = q.get('filter');
    const keep = (u: (typeof users)[number]) =>
      !f ||
      (f === 'banned' && !!u.bannedAt) ||
      (f === 'guest' && u.isGuest) ||
      (f === 'staff' && u.role !== 'player') ||
      (f === 'unlimited' && !!u.unlimited) ||
      (f === 'deleted' && !!u.deletedAt) ||
      (f === 'paying' && shop.purchases.some((p) => p.userId === u.id && p.status === 'paid'));
    return {
      users: clone(
        users
          .filter(
            (u) =>
              keep(u) &&
              (!t ||
                u.id === t ||
                u.displayName.toLowerCase().includes(t) ||
                (u.email ?? '').includes(t)),
          )
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          .slice(0, Number(q.get('limit') ?? 100)),
      ),
    };
  });
  on('GET', '/admin/api/users/:id', ([id]) => {
    need('superadmin');
    const u = userOr(id!);
    const i = users.indexOf(u);
    return clone({
      user: u,
      activityHours: Array.from({ length: 24 }, (_, h) =>
        Math.max(0, Math.round(8 * Math.sin(((h - 6 - i) / 24) * Math.PI * 2) + 6)),
      ),
      fingerprints: [
        {
          ipHash: `ip_${(i * 7919).toString(36)}`,
          uaHash: `ua_${(i * 104729).toString(36)}`,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
          firstSeen: u.createdAt,
          lastSeen: u.lastSeenAt,
          hits: 120 + i * 13,
        },
      ],
      games: games
        .filter((g) => g.players.some((p) => p.userName === u.displayName))
        .map((g) => ({
          gameId: g.game.id,
          nationId: g.players.find((p) => p.userName === u.displayName)!.nationId,
          name: g.game.name,
        })),
      purchases: shop.purchases.filter((p) => p.userId === u.id),
      wallet: [],
    });
  });
  on('PUT', '/admin/api/users/:id', ([id], b) => {
    const me = need('superadmin');
    const u = userOr(id!);
    const patch = b as UserPatch;
    if (patch.role && !ROLES.includes(patch.role))
      throw new ApiError(400, 'role : Invalid enum value', 'invalid_body');
    if (id === me.id && (patch.banned || (patch.role && patch.role !== 'superadmin')))
      throw new ApiError(400, 'Impossible de vous retirer vos propres droits', 'self_lockout');
    const before = clone(u);
    if (patch.role) u.role = patch.role;
    if (patch.displayName) u.displayName = patch.displayName;
    if (patch.chatMutedUntil !== undefined) u.chatMutedUntil = patch.chatMutedUntil;
    const unlimitedChanged = patch.unlimited !== undefined && patch.unlimited !== !!u.unlimited;
    if (patch.unlimited !== undefined) u.unlimited = patch.unlimited;
    if (patch.banned === true) {
      u.bannedAt = now();
      u.banReason = patch.banReason ?? null;
    } else if (patch.banned === false) {
      u.bannedAt = null;
      u.banReason = null;
    }
    log(unlimitedChanged ? 'user.unlimited' : 'user.update', `user:${id}`, before, u);
    return { user: clone(u) };
  });

  // ——— Boutique
  const packView = (p: Omit<AdminPack, 'view'>): AdminPack => {
    const t = Date.now();
    const promo = shop.promotions
      .filter(
        (x) =>
          x.active &&
          (!x.packId || x.packId === p.id) &&
          new Date(x.startsAt).getTime() <= t &&
          new Date(x.endsAt).getTime() > t,
      )
      .sort((a, b) => b.percentOff - a.percentOff)[0];
    return {
      ...p,
      view: {
        id: p.id,
        name: p.name,
        amount: p.amount,
        bonus: p.bonus,
        priceCents: promo
          ? Math.round((p.priceCents * (100 - promo.percentOff)) / 100)
          : p.priceCents,
        currency: p.currency,
        promo: promo
          ? { label: promo.label, percentOff: promo.percentOff, until: promo.endsAt }
          : null,
      },
    };
  };
  const checkPack = (b: Body): PackBody => {
    const p = b as unknown as PackBody;
    if (!/^[a-z0-9._-]+$/.test(String(p.id ?? '')))
      throw new ApiError(400, 'id : Invalid', 'invalid_body');
    if (!p.name || !(p.amount > 0) || !(p.priceCents > 0))
      throw new ApiError(400, 'name, amount, priceCents : valeurs invalides', 'invalid_body');
    return {
      id: p.id,
      name: p.name,
      amount: Math.round(p.amount),
      bonus: Math.round(p.bonus ?? 0),
      priceCents: Math.round(p.priceCents),
      currency: p.currency ?? 'eur',
      active: p.active ?? true,
      sort: Math.round(p.sort ?? 0),
    };
  };
  on('GET', '/admin/api/shop/packs', () => {
    need('superadmin');
    return { packs: clone([...shop.packs].sort((a, b) => a.sort - b.sort).map(packView)) };
  });
  on('POST', '/admin/api/shop/packs', (_p, b) => {
    need('superadmin');
    const p = checkPack(b);
    if (shop.packs.some((x) => x.id === p.id))
      throw new ApiError(409, 'Ce pack existe déjà', 'already_exists');
    const row = { ...p, updatedAt: now() };
    shop.packs.push(row);
    log('shop.pack.create', `pack:${p.id}`, null, p);
    return { pack: clone(packView(row)) };
  });
  on('PUT', '/admin/api/shop/packs/:id', ([id], b) => {
    need('superadmin');
    const i = shop.packs.findIndex((x) => x.id === id);
    if (i < 0) throw new ApiError(404, 'Pack introuvable', 'not_found');
    const before = shop.packs[i];
    const row = { ...checkPack({ ...b, id }), updatedAt: now() };
    shop.packs[i] = row;
    log('shop.pack.update', `pack:${id}`, before, row);
    return { pack: clone(packView(row)) };
  });
  const checkPromo = (b: Body): PromoBody => {
    const p = b as unknown as PromoBody;
    if (!p.label || !(p.percentOff >= 1 && p.percentOff <= 90))
      throw new ApiError(400, 'percentOff : entre 1 et 90', 'invalid_body');
    if (new Date(p.endsAt) <= new Date(p.startsAt))
      throw new ApiError(400, 'Fin avant le début', 'invalid_dates');
    return {
      packId: p.packId ?? null,
      label: p.label,
      percentOff: p.percentOff,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      active: p.active ?? true,
    };
  };
  on('GET', '/admin/api/shop/promotions', () => {
    need('superadmin');
    return { promotions: clone([...shop.promotions].sort((a, b) => b.id - a.id)) };
  });
  on('POST', '/admin/api/shop/promotions', (_p, b) => {
    need('superadmin');
    const row = {
      ...checkPromo(b),
      id: Math.max(0, ...shop.promotions.map((x) => x.id)) + 1,
      createdAt: now(),
    };
    shop.promotions.push(row);
    log('shop.promo.create', `promo:${row.id}`, null, row);
    return { promotion: clone(row) };
  });
  on('PUT', '/admin/api/shop/promotions/:id', ([id], b) => {
    need('superadmin');
    const i = shop.promotions.findIndex((x) => x.id === Number(id));
    if (i < 0) throw new ApiError(404, 'Promotion introuvable', 'not_found');
    const before = shop.promotions[i]!;
    const row = { ...before, ...checkPromo(b) };
    shop.promotions[i] = row;
    log('shop.promo.update', `promo:${id}`, before, row);
    return { promotion: clone(row) };
  });
  on('GET', '/admin/api/purchases', (_p, _b, q) => {
    need('superadmin');
    return {
      purchases: clone(
        shop.purchases
          .filter((p) => !q.get('status') || p.status === q.get('status'))
          .filter((p) => !q.get('userId') || p.userId === q.get('userId')),
      ),
    };
  });
  on('POST', '/admin/api/purchases/:id/refund', ([id]) => {
    need('superadmin');
    const p = shop.purchases.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'Achat introuvable', 'not_found');
    if (p.status !== 'paid')
      throw new ApiError(409, 'Achat non remboursable (statut ' + p.status + ')', 'not_refundable');
    p.status = 'refunded';
    p.refundedAt = now();
    const u = users.find((x) => x.id === p.userId);
    if (u) u.premiumBalance = Math.max(0, u.premiumBalance - p.credits);
    log('shop.refund', `purchase:${id}`);
    return { ok: true, balance: u?.premiumBalance ?? 0 };
  });

  // ——— Journal
  on('GET', '/admin/api/audit', (_p, _b, q) => {
    need('superadmin');
    const action = q.get('action');
    const target = q.get('target');
    const from = q.get('from');
    const to = q.get('to');
    const before = Number(q.get('before') ?? 0);
    const adminId = q.get('adminId');
    return {
      entries: clone(
        audit
          .filter(
            (e) =>
              (!action || e.action.startsWith(action)) &&
              (!target || (e.target ?? '').startsWith(target)) &&
              (!adminId || e.adminId === adminId) &&
              (!from || e.createdAt >= from) &&
              (!to || e.createdAt <= to) &&
              (!before || e.id < before),
          )
          .slice(0, Number(q.get('limit') ?? 200)),
      ),
    };
  });

  // ——— Économie du service, annonces, paramètres, gestion des comptes et des parties
  registerOpsMock({ on, need, log, users, games, purchases: shop.purchases });

  async function handle(method: HttpMethod, path: string, body: Body): Promise<unknown> {
    const [p, qs] = path.split('?') as [string, string | undefined];
    const q = new URLSearchParams(qs ?? '');
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const hit = re.exec(p);
      if (hit) return h(hit.slice(1).map(decodeURIComponent), body, q);
    }
    throw new ApiError(404, `Route inconnue : ${method} ${p}`, 'not_found');
  }

  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      if (latency) await delay(latency);
      return clone((await handle(method, path, (body ?? {}) as Body)) as T);
    },
  };
}
