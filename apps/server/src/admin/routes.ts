import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ImportBodySchema,
  SaveSystemBodySchema,
  WeaponSystemSchema,
  type AdminSystem,
  type CatalogChange,
  type ChangeScope,
  type Metrics,
  type Role,
  type WeaponSystem,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import { adminAudit, catalogChanges, users, weaponSystems } from '../db/schema.js';
import { HttpError, checkRole, type AuthState } from '../auth/auth.js';
import { createRelease, listSystems, sameJson } from '../data/catalog-store.js';
import { parseBody } from '../http/util.js';

type Row = typeof weaponSystems.$inferSelect;

const toAdmin = (r: Row): AdminSystem => ({
  system: r.data,
  revision: r.revision,
  updatedAt: r.updatedAt.toISOString(),
});

const DEFAULT_NOTICE = "Le catalogue d'armes a été mis à jour par l'administration.";

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(fiche)'} : ${i.message}`)
    .join(' ; ');
}

function validateSystem(data: unknown): WeaponSystem {
  const r = WeaponSystemSchema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'invalid_system', zodMessage(r.error));
  return r.data;
}

export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, auth, host, worlds } = ctx;

  const guard =
    (role: Role) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      (req as FastifyRequest & { admin?: AuthState }).admin = checkRole(
        await auth.authenticate(req, reply),
        role,
      );
    };
  const adminOf = (req: FastifyRequest) => (req as FastifyRequest & { admin: AuthState }).admin;
  const balance = { preHandler: guard('balance') };
  const moderator = { preHandler: guard('moderator') };

  /** Propage une nouvelle release selon la portée choisie. */
  async function applyScope(releaseId: number, scope: ChangeScope, playerMessage?: string) {
    await worlds.setCurrentRelease(releaseId).catch((err) => {
      ctx.log.error({ err }, 'reconstruction du monde des nouvelles parties en échec');
    });
    let runningGames = 0;
    if (scope === 'running_games' && !worlds.unavailableReason()) {
      runningGames = await host.applyReleaseToRunning(releaseId, playerMessage || DEFAULT_NOTICE);
    }
    return runningGames;
  }

  interface WriteSpec {
    system: WeaponSystem;
    expect: 'new' | 'existing' | 'any';
  }

  /** Écrit des fiches dans une transaction : révision, release, historique, audit. */
  async function writeSystems(
    admin: AuthState,
    specs: WriteSpec[],
    meta: { message: string; scope: ChangeScope; playerMessage?: string; action: string },
  ): Promise<{ rows: Row[]; created: number; updated: number; releaseId: number | null }> {
    const out = await db.transaction(async (tx) => {
      const rows: Row[] = [];
      let created = 0;
      let updated = 0;
      const changes: {
        id: string;
        before: WeaponSystem | null;
        after: WeaponSystem;
        revision: number;
      }[] = [];
      for (const { system, expect } of specs) {
        const [cur] = await tx
          .select()
          .from(weaponSystems)
          .where(eq(weaponSystems.id, system.id))
          .for('update');
        if (expect === 'new' && cur) {
          throw new HttpError(409, 'already_exists', `La fiche ${system.id} existe déjà`);
        }
        if (expect === 'existing' && !cur) {
          throw new HttpError(404, 'not_found', `Fiche ${system.id} introuvable`);
        }
        if (cur && sameJson(cur.data, system)) {
          rows.push(cur);
          continue;
        }
        const revision = (cur?.revision ?? 0) + 1;
        const [row] = await tx
          .insert(weaponSystems)
          .values({
            id: system.id,
            data: system,
            enabled: system.enabled,
            revision,
            source: 'admin',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: weaponSystems.id,
            set: {
              data: system,
              enabled: system.enabled,
              revision,
              source: 'admin',
              updatedAt: new Date(),
            },
          })
          .returning();
        rows.push(row!);
        if (cur) updated++;
        else created++;
        changes.push({ id: system.id, before: cur?.data ?? null, after: system, revision });
      }
      if (changes.length === 0) return { rows, created, updated, releaseId: null };
      const releaseId = await createRelease(tx, admin.user.id, meta.message);
      for (const c of changes) {
        await tx.insert(catalogChanges).values({
          releaseId,
          systemId: c.id,
          revision: c.revision,
          before: c.before,
          after: c.after,
          message: meta.message,
          scope: meta.scope,
          playerMessage: meta.playerMessage ?? null,
          authorId: admin.user.id,
        });
        await tx.insert(adminAudit).values({
          adminId: admin.user.id,
          action: meta.action,
          target: `system:${c.id}`,
          before: c.before,
          after: c.after,
        });
      }
      return { rows, created, updated, releaseId };
    });
    if (out.releaseId !== null) await applyScope(out.releaseId, meta.scope, meta.playerMessage);
    return out;
  }

  async function getRow(id: string): Promise<Row> {
    const [row] = await db.select().from(weaponSystems).where(eq(weaponSystems.id, id));
    if (!row) throw new HttpError(404, 'not_found', `Fiche ${id} introuvable`);
    return row;
  }

  const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;

  // ─────────── Catalogue ───────────

  app.get('/admin/api/systems', balance, async () => ({
    systems: (await listSystems(db)).map(toAdmin),
  }));

  app.get('/admin/api/systems/:id', balance, async (req) => ({
    system: toAdmin(await getRow(idParam(req))),
  }));

  app.post('/admin/api/systems', balance, async (req, reply) => {
    const body = parseBody(SaveSystemBodySchema, req.body);
    const system = validateSystem(body.data);
    const { rows } = await writeSystems(adminOf(req), [{ system, expect: 'new' }], {
      message: body.message || `Création de ${system.id}`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'system.create',
    });
    reply.code(201);
    return { system: toAdmin(rows[0]!) };
  });

  app.put('/admin/api/systems/:id', balance, async (req) => {
    const body = parseBody(SaveSystemBodySchema, req.body);
    const system = validateSystem(body.data);
    if (system.id !== idParam(req)) {
      throw new HttpError(
        400,
        'id_mismatch',
        "L'identifiant de la fiche ne peut pas changer (utilisez la duplication)",
      );
    }
    const { rows } = await writeSystems(adminOf(req), [{ system, expect: 'existing' }], {
      message: body.message || `Modification de ${system.id}`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'system.update',
    });
    return { system: toAdmin(rows[0]!) };
  });

  app.post('/admin/api/systems/:id/duplicate', balance, async (req, reply) => {
    const { newId } = parseBody(z.object({ newId: z.string().min(1).max(64) }), req.body);
    const src = await getRow(idParam(req));
    const system = validateSystem({ ...src.data, id: newId, name: `${src.data.name} (copie)` });
    const { rows } = await writeSystems(adminOf(req), [{ system, expect: 'new' }], {
      message: `Duplication de ${src.id} en ${newId}`,
      scope: 'new_games',
      action: 'system.duplicate',
    });
    reply.code(201);
    return { system: toAdmin(rows[0]!) };
  });

  app.get('/admin/api/systems/:id/history', balance, async (req) => {
    const rows = await db
      .select({ c: catalogChanges, author: users.displayName })
      .from(catalogChanges)
      .leftJoin(users, eq(users.id, catalogChanges.authorId))
      .where(eq(catalogChanges.systemId, idParam(req)))
      .orderBy(desc(catalogChanges.id))
      .limit(500);
    const changes: CatalogChange[] = rows.map(({ c, author }) => ({
      id: c.id,
      systemId: c.systemId,
      revision: c.revision,
      before: c.before,
      after: c.after,
      message: c.message,
      scope: c.scope,
      author: author ?? 'système',
      createdAt: c.createdAt.toISOString(),
    }));
    return { changes };
  });

  app.post('/admin/api/systems/:id/revert', balance, async (req) => {
    const body = parseBody(
      z.object({
        changeId: z.number().int(),
        message: z.string().max(500).optional(),
        scope: z.enum(['new_games', 'running_games']).default('new_games'),
        playerMessage: z.string().max(500).optional(),
      }),
      req.body,
    );
    const id = idParam(req);
    const [change] = await db
      .select()
      .from(catalogChanges)
      .where(eq(catalogChanges.id, body.changeId));
    if (!change || change.systemId !== id) {
      throw new HttpError(404, 'not_found', 'Modification introuvable pour cette fiche');
    }
    if (!change.before) {
      throw new HttpError(
        400,
        'revert_creation',
        'Cette modification est une création : désactivez la fiche plutôt que de la supprimer',
      );
    }
    const system = validateSystem(change.before);
    const { rows } = await writeSystems(adminOf(req), [{ system, expect: 'existing' }], {
      message: body.message || `Retour arrière (modification n° ${change.id})`,
      scope: body.scope,
      playerMessage: body.playerMessage,
      action: 'system.revert',
    });
    return { system: toAdmin(rows[0]!) };
  });

  app.get('/admin/api/catalog/export', balance, async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="redline-catalog.json"');
    return { systems: (await listSystems(db)).map((r) => r.data) };
  });

  app.post('/admin/api/catalog/import', balance, async (req, reply) => {
    const body = parseBody(
      ImportBodySchema.extend({
        scope: z.enum(['new_games', 'running_games']).default('new_games'),
        playerMessage: z.string().max(500).optional(),
      }),
      req.body,
    );
    // Tout ou rien : la moindre fiche invalide fait rejeter l'import complet.
    const errors: { index: number; id: string | null; message: string }[] = [];
    const systems: WeaponSystem[] = [];
    const seen = new Set<string>();
    body.systems.forEach((raw, index) => {
      const r = WeaponSystemSchema.safeParse(raw);
      const rawId = (raw as { id?: unknown } | null)?.id;
      const id = typeof rawId === 'string' ? rawId : null;
      if (!r.success) errors.push({ index, id, message: zodMessage(r.error) });
      else if (seen.has(r.data.id)) errors.push({ index, id, message: 'identifiant en double' });
      else {
        seen.add(r.data.id);
        systems.push(r.data);
      }
    });
    if (errors.length > 0 || systems.length === 0) {
      if (systems.length === 0 && errors.length === 0) {
        errors.push({ index: -1, id: null, message: 'aucune fiche à importer' });
      }
      reply.code(400);
      return { created: 0, updated: 0, errors };
    }
    const r = await writeSystems(
      adminOf(req),
      systems.map((system) => ({ system, expect: 'any' as const })),
      {
        message: body.message,
        scope: body.scope,
        playerMessage: body.playerMessage,
        action: 'catalog.import',
      },
    );
    return { created: r.created, updated: r.updated, errors: [] };
  });

  // ─────────── Parties en direct ───────────

  app.get('/admin/api/games', moderator, async () => ({ games: await host.adminGames() }));

  const pauseRoute = (paused: boolean) => async (req: FastifyRequest) => {
    const id = z.string().uuid().safeParse(idParam(req));
    if (!id.success) throw new HttpError(404, 'not_found', 'Partie introuvable');
    const ok = await host.adminSetPaused(id.data, paused);
    if (!ok) {
      throw new HttpError(
        409,
        'game_unavailable',
        'Partie introuvable, terminée ou hébergée ailleurs',
      );
    }
    await db.insert(adminAudit).values({
      adminId: adminOf(req).user.id,
      action: paused ? 'game.pause' : 'game.resume',
      target: `game:${id.data}`,
    });
    return { ok: true };
  };
  app.post('/admin/api/games/:id/pause', moderator, pauseRoute(true));
  app.post('/admin/api/games/:id/resume', moderator, pauseRoute(false));

  // ─────────── Métriques ───────────

  app.get('/admin/api/metrics', moderator, async (): Promise<Metrics> => ({
    ...ctx.metrics.snapshot(),
    games: host.games.size,
    connectedPlayers: host.connectedPlayers(),
    eventsProcessedPerMin: ctx.metrics.eventsPerMinute(),
  }));
}
