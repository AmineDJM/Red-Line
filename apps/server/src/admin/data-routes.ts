import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BalanceSchema,
  NationDefSchema,
  type Balance,
  type ChangeScope,
  type NationDef,
  type ProvinceDef,
  type Role,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import { adminAudit, type DataKind } from '../db/schema.js';
import { HttpError, checkRole, type AuthState } from '../auth/auth.js';
import { parseBody } from '../http/util.js';
import { DATA_SCHEMAS, MAP_KINDS, WORLD_KINDS, type RevisionRow } from '../data/store.js';
import { deepMerge } from '../host/game-host.js';

const SaveBodySchema = z.object({
  data: z.unknown(),
  message: z.string().max(500).default(''),
  scope: z.enum(['new_games', 'running_games']).default('new_games'),
  playerMessage: z.string().max(500).optional(),
});

const RevertBodySchema = z.object({
  revisionId: z.number().int().positive(),
  message: z.string().max(500).optional(),
  scope: z.enum(['new_games', 'running_games']).default('new_games'),
  playerMessage: z.string().max(500).optional(),
});

const DEFAULT_NOTICE = "Les règles du jeu ont été mises à jour par l'administration.";

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(données)'} : ${i.message}`)
    .join(' ; ');
}

const revView = (r: RevisionRow) => ({
  id: r.id,
  kind: r.kind,
  key: r.key,
  data: r.data,
  message: r.message,
  scope: r.scope,
  authorId: r.authorId,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Administration des données de jeu, versionnée : chaque modification est une révision (data_revisions)
 * avec historique et retour arrière ; portée « nouvelles parties » ou « parties en cours ».
 */
export async function adminDataRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { store, host, db } = ctx;

  const guard =
    (role: Role) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      (req as FastifyRequest & { admin?: AuthState }).admin = checkRole(
        await ctx.auth.authenticate(req, reply),
        role,
      );
    };
  const adminOf = (req: FastifyRequest) => (req as FastifyRequest & { admin: AuthState }).admin;
  const balance = { preHandler: guard('balance') };

  function validate(kind: DataKind, key: string, data: unknown): unknown {
    const r = DATA_SCHEMAS[kind].safeParse(data);
    if (!r.success) throw new HttpError(400, 'invalid_data', zodMessage(r.error));
    const v = r.data as { id?: string; nationId?: string };
    if (kind === 'orbat') {
      if (`${key.split('/')[0]}/${v.nationId}` !== key) {
        throw new HttpError(400, 'id_mismatch', "La nation de l'ORBAT ne correspond pas au chemin");
      }
    } else if (kind !== 'rules' && v.id !== key) {
      throw new HttpError(400, 'id_mismatch', "L'identifiant ne peut pas changer");
    }
    return r.data;
  }

  /** Propage une révision selon sa portée (parties en cours hébergées ici). */
  async function propagate(kind: DataKind, scope: ChangeScope, playerMessage?: string) {
    if (scope !== 'running_games' || ctx.worlds.unavailableReason()) return 0;
    const notice = playerMessage || DEFAULT_NOTICE;
    if (kind === 'rules') {
      const base = store.current().balance!;
      return host.applyPinToRunning((g) => {
        const sc = store.current().scenarios.find((s) => s.id === g.meta.scenarioId);
        const merged = sc?.balanceOverrides ? deepMerge(base, sc.balanceOverrides) : base;
        const parsed = BalanceSchema.safeParse(merged);
        return { balance: (parsed.success ? parsed.data : base) as Balance };
      }, notice);
    }
    if (WORLD_KINDS.includes(kind)) {
      const rev = store.currentRev;
      return host.applyPinToRunning(() => ({ dataRev: rev }), notice);
    }
    return 0;
  }

  /** Une révision de la carte écrite pour une autre version de carte ne peut pas être restaurée. */
  function assertSameMap(rev: { kind: DataKind; mapVersion: number }) {
    if (MAP_KINDS.includes(rev.kind) && rev.mapVersion !== store.mapVersion)
      throw new HttpError(
        409,
        'map_version',
        `Révision écrite pour la carte version ${rev.mapVersion} (carte actuelle : ${store.mapVersion})`,
      );
  }

  async function write(
    req: FastifyRequest,
    kind: DataKind,
    key: string,
    data: unknown,
    meta: { message: string; scope: ChangeScope; playerMessage?: string; action: string },
  ) {
    const admin = adminOf(req);
    const before = currentValue(kind, key);
    const rev = await store.write(kind, key, data, {
      message: meta.message,
      scope: meta.scope,
      authorId: admin.user.id,
    });
    await db.insert(adminAudit).values({
      adminId: admin.user.id,
      action: meta.action,
      target: `${kind}:${key}`,
      before: (before ?? null) as object | null,
      after: (data ?? null) as object | null,
    });
    const runningGames = await propagate(kind, meta.scope, meta.playerMessage);
    return { revision: revView(rev), runningGames };
  }

  function currentValue(kind: DataKind, key: string): unknown {
    const cur = store.current();
    switch (kind) {
      case 'rules':
        return cur.balance;
      case 'research':
        return cur.research.find((n) => n.id === key) ?? null;
      case 'orbat': {
        const [set, nation] = key.split('/');
        return cur.orbats[set!]?.find((o) => o.nationId === nation) ?? null;
      }
      case 'scenario':
        return cur.scenarios.find((s) => s.id === key) ?? null;
      case 'nation':
        return cur.map?.nations.find((n) => n.id === key) ?? null;
      case 'province':
        return cur.map?.provinces.find((p) => p.id === key) ?? null;
      case 'disputed':
        return cur.map?.disputed.find((d) => d.id === key) ?? null;
    }
  }

  const history = (kind: DataKind, key: string) => ({
    revisions: store.history(kind, key).map(revView),
    source: store.history(kind, key).length ? 'admin' : 'repo',
  });

  /** Enregistre les routes GET/PUT, historique, retour arrière et réinitialisation d'une ressource. */
  function resource(opts: {
    kind: DataKind;
    base: string;
    keyOf: (req: FastifyRequest) => string;
    param: string;
    list?: () => unknown;
  }) {
    const { kind, base, keyOf } = opts;
    if (opts.list) app.get(base, balance, async () => opts.list!());
    const one = `${base}/${opts.param}`;
    app.get(one, balance, async (req) => {
      const key = keyOf(req);
      const value = currentValue(kind, key);
      if (value === null || value === undefined)
        throw new HttpError(404, 'not_found', 'Introuvable');
      return { data: value, ...history(kind, key) };
    });
    app.put(one, balance, async (req) => {
      const key = keyOf(req);
      const body = parseBody(SaveBodySchema, req.body);
      const data = validate(kind, key, body.data);
      return write(req, kind, key, data, {
        message: body.message || `Modification de ${kind} ${key}`,
        scope: body.scope,
        playerMessage: body.playerMessage,
        action: `data.${kind}.update`,
      });
    });
    app.get(`${one}/history`, balance, async (req) => history(kind, keyOf(req)));
    app.post(`${one}/revert`, balance, async (req) => {
      const key = keyOf(req);
      const body = parseBody(RevertBodySchema, req.body);
      const rev = await store.revision(body.revisionId);
      if (!rev || rev.kind !== kind || rev.key !== key) {
        throw new HttpError(404, 'not_found', 'Révision introuvable pour cette donnée');
      }
      assertSameMap(rev);
      return write(req, kind, key, rev.data, {
        message: body.message || `Retour à la révision n° ${rev.id}`,
        scope: body.scope,
        playerMessage: body.playerMessage,
        action: `data.${kind}.revert`,
      });
    });
    app.post(`${one}/reset`, balance, async (req) => {
      const key = keyOf(req);
      const body = parseBody(SaveBodySchema.omit({ data: true }), req.body);
      return write(req, kind, key, null, {
        message: body.message || 'Retour à la valeur du dépôt',
        scope: body.scope,
        playerMessage: body.playerMessage,
        action: `data.${kind}.reset`,
      });
    });
  }

  const p = (name: string) => (req: FastifyRequest) =>
    String((req.params as Record<string, string>)[name] ?? '').slice(0, 128);

  // ─────────── Règles (data/balance) ───────────
  app.get('/admin/api/rules', balance, async () => ({
    rules: store.current().balance,
    ...history('rules', 'default'),
  }));
  app.put('/admin/api/rules', balance, async (req) => {
    const body = parseBody(SaveBodySchema, req.body);
    const data = validate('rules', 'default', body.data);
    return write(req, 'rules', 'default', data, {
      message: body.message || "Modification de l'équilibrage",
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.rules.update',
    });
  });
  app.get('/admin/api/rules/history', balance, async () => history('rules', 'default'));
  app.post('/admin/api/rules/revert', balance, async (req) => {
    const body = parseBody(RevertBodySchema, req.body);
    const rev = await store.revision(body.revisionId);
    if (!rev || rev.kind !== 'rules') throw new HttpError(404, 'not_found', 'Révision introuvable');
    return write(req, 'rules', 'default', rev.data, {
      message: body.message || `Retour à la révision n° ${rev.id}`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.rules.revert',
    });
  });

  app.post('/admin/api/rules/reset', balance, async (req) => {
    const body = parseBody(SaveBodySchema.omit({ data: true }), req.body);
    return write(req, 'rules', 'default', null, {
      message: body.message || 'Retour à l’équilibrage du dépôt',
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.rules.reset',
    });
  });

  // ─────────── Recherche, ORBAT, scénarios, carte ───────────
  resource({
    kind: 'research',
    base: '/admin/api/research',
    param: ':id',
    keyOf: p('id'),
    list: () => ({ nodes: store.current().research }),
  });

  app.get('/admin/api/orbat', balance, async () => ({
    sets: Object.fromEntries(
      Object.entries(store.current().orbats).map(([set, list]) => [
        set,
        list.map((o) => o.nationId),
      ]),
    ),
  }));
  resource({
    kind: 'orbat',
    base: '/admin/api/orbat',
    param: ':set/:nationId',
    keyOf: (req) => `${p('set')(req)}/${p('nationId')(req)}`,
  });

  resource({
    kind: 'scenario',
    base: '/admin/api/scenarios',
    param: ':id',
    keyOf: p('id'),
    list: () => ({ scenarios: store.current().scenarios }),
  });

  resource({
    kind: 'province',
    base: '/admin/api/map/provinces',
    param: ':id',
    keyOf: p('id'),
    list: () => ({ provinces: store.current().map?.provinces ?? [] }),
  });
  resource({
    kind: 'disputed',
    base: '/admin/api/map/disputed',
    param: ':id',
    keyOf: p('id'),
    list: () => ({ disputed: store.current().map?.disputed ?? [] }),
  });

  // Nations : modification classique, ou fusion (`mergeInto`) : les provinces passent à la nation cible.
  app.get('/admin/api/map/nations', balance, async () => ({
    nations: store.current().map?.nations ?? [],
  }));
  app.get('/admin/api/map/nations/:id', balance, async (req) => {
    const key = p('id')(req);
    const value = currentValue('nation', key);
    if (!value) throw new HttpError(404, 'not_found', 'Nation introuvable');
    return { data: value, ...history('nation', key) };
  });
  app.put('/admin/api/map/nations/:id', balance, async (req) => {
    const key = p('id')(req);
    const raw = (req.body ?? {}) as { mergeInto?: unknown };
    if (typeof raw.mergeInto === 'string') {
      const body = parseBody(
        SaveBodySchema.omit({ data: true }).extend({ mergeInto: z.string().min(1).max(64) }),
        req.body,
      );
      const cur = store.current();
      const from = cur.nationsById.get(key);
      const into = cur.nationsById.get(body.mergeInto);
      if (!from || !into || from.id === into.id) {
        throw new HttpError(400, 'invalid_merge', 'Nations de fusion invalides');
      }
      const moved = (cur.map?.provinces ?? []).filter((pr) => pr.nationId === key);
      let last: Awaited<ReturnType<typeof write>> | null = null;
      for (const pr of moved) {
        const next: ProvinceDef = { ...pr, nationId: into.id, isCapital: false };
        last = await write(req, 'province', pr.id, next, {
          message: body.message || `Fusion de ${from.name} dans ${into.name}`,
          scope: 'new_games',
          action: 'data.nation.merge',
        });
      }
      const runningGames = await propagate('province', body.scope, body.playerMessage);
      return { merged: moved.length, revision: last?.revision ?? null, runningGames };
    }
    const body = parseBody(SaveBodySchema, req.body);
    const data = validate('nation', key, body.data) as NationDef;
    NationDefSchema.parse(data);
    return write(req, 'nation', key, data, {
      message: body.message || `Modification de la nation ${key}`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.nation.update',
    });
  });
  app.get('/admin/api/map/nations/:id/history', balance, async (req) =>
    history('nation', p('id')(req)),
  );
  app.post('/admin/api/map/nations/:id/revert', balance, async (req) => {
    const key = p('id')(req);
    const body = parseBody(RevertBodySchema, req.body);
    const rev = await store.revision(body.revisionId);
    if (!rev || rev.kind !== 'nation' || rev.key !== key) {
      throw new HttpError(404, 'not_found', 'Révision introuvable');
    }
    assertSameMap(rev);
    return write(req, 'nation', key, rev.data, {
      message: body.message || `Retour à la révision n° ${rev.id}`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.nation.revert',
    });
  });

  // Retour à la valeur du dépôt (data/map/nations.json) : la modification du back-office est annulée.
  app.post('/admin/api/map/nations/:id/reset', balance, async (req) => {
    const key = p('id')(req);
    if (!store.repo.nationsById.has(key) && !currentValue('nation', key)) {
      throw new HttpError(404, 'not_found', 'Nation introuvable');
    }
    const body = parseBody(SaveBodySchema.omit({ data: true }), req.body);
    return write(req, 'nation', key, null, {
      message: body.message || 'Retour à la valeur du dépôt',
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'data.nation.reset',
    });
  });

  // Avertissements du chargement des données (fichiers ignorés, doublons…).
  app.get('/admin/api/data/status', balance, async () => ({
    rev: store.currentRev,
    warnings: ctx.data.warnings,
    catalogErrors: ctx.data.catalogErrors,
    research: store.current().research.length,
    orbats: Object.fromEntries(
      Object.entries(store.current().orbats).map(([k, v]) => [k, v.length]),
    ),
    scenarios: store.current().scenarios.length,
    photos: Object.keys(ctx.data.photos).length,
  }));
}
