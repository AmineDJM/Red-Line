import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AnnouncementBodySchema,
  COST_PERIODS,
  CostEntryBodySchema,
  CostSettingsSchema,
  RuntimeSettingsSchema,
  type Role,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import { adminAudit, costEntries } from '../db/schema.js';
import { HttpError, checkRole, type AuthState } from '../auth/auth.js';
import { parseBody } from '../http/util.js';

/**
 * Économie du service (coûts, recettes, alertes), paramètres de coût, dépenses saisies, annonces
 * globales et paramètres d'exploitation. Tout est réservé au superadmin, sauf la lecture des annonces
 * (publique) et la lecture des paramètres d'exploitation (modérateur).
 */
export async function adminEconomyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;
  const guard =
    (role: Role) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      (req as FastifyRequest & { admin?: AuthState }).admin = checkRole(
        await ctx.auth.authenticate(req, reply),
        role,
      );
    };
  const adminOf = (req: FastifyRequest) => (req as FastifyRequest & { admin: AuthState }).admin;
  const superadmin = { preHandler: guard('superadmin') };
  const moderator = { preHandler: guard('moderator') };
  const audit = (
    req: FastifyRequest,
    action: string,
    target: string,
    before: unknown,
    after: unknown,
  ) =>
    db.insert(adminAudit).values({
      adminId: adminOf(req).user.id,
      action,
      target,
      before: before as object | null,
      after: after as object | null,
    });
  const PeriodQuery = z.object({
    period: z.enum(COST_PERIODS).default('month'),
    full: z.enum(['0', '1']).optional(),
  });

  // ─────────── Coûts ───────────

  app.get('/admin/api/costs/dashboard', superadmin, async (req) => {
    const q = parseBody(PeriodQuery, req.query);
    return ctx.costs.dashboard(q.period);
  });

  /** Rapport d'attribution ; `full=1` : toutes les parties et tous les utilisateurs (export CSV). */
  app.get('/admin/api/costs/report', superadmin, async (req) => {
    const q = parseBody(PeriodQuery, req.query);
    const { report } = await ctx.costs.report(q.period);
    if (q.full === '1') return { report };
    const { users: _u, games: _g, ...light } = report;
    return { report: light };
  });

  app.get('/admin/api/costs/users/:id', superadmin, async (req) => {
    const id = String((req.params as { id: string }).id);
    const q = parseBody(PeriodQuery, req.query);
    const { report } = await ctx.costs.report(q.period);
    return { period: q.period, cost: report.users?.find((u) => u.id === id) ?? null };
  });

  app.get('/admin/api/costs/games/:id', superadmin, async (req) => {
    const id = String((req.params as { id: string }).id);
    const q = parseBody(PeriodQuery, req.query);
    const { report } = await ctx.costs.report(q.period);
    return { period: q.period, cost: report.games?.find((g) => g.id === id) ?? null };
  });

  app.get('/admin/api/costs/settings', superadmin, async () => ({
    settings: ctx.costs.settings(),
  }));

  app.put('/admin/api/costs/settings', superadmin, async (req) => {
    const body = parseBody(CostSettingsSchema, req.body);
    const before = ctx.costs.settings();
    let settings;
    try {
      settings = await ctx.costs.saveSettings(body);
    } catch (err) {
      throw new HttpError(
        400,
        'invalid_settings',
        err instanceof Error ? err.message : String(err),
      );
    }
    await audit(req, 'costs.settings', 'costs:settings', before, settings);
    return { settings };
  });

  app.get('/admin/api/costs/entries', superadmin, async () => ({
    entries: await ctx.costs.entries(),
  }));

  app.post('/admin/api/costs/entries', superadmin, async (req, reply) => {
    const body = parseBody(CostEntryBodySchema, req.body);
    const [row] = await db
      .insert(costEntries)
      .values({ ...body, source: 'manual', createdBy: adminOf(req).user.id })
      .returning();
    ctx.costs.invalidate();
    await audit(req, 'costs.entry.create', `cost:${row!.id}`, null, body);
    reply.code(201);
    return { entry: { ...row!, createdAt: row!.createdAt.toISOString() } };
  });

  app.delete('/admin/api/costs/entries/:id', superadmin, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new HttpError(404, 'not_found', 'Dépense introuvable');
    const [row] = await db.delete(costEntries).where(eq(costEntries.id, id)).returning();
    if (!row) throw new HttpError(404, 'not_found', 'Dépense introuvable');
    ctx.costs.invalidate();
    await audit(req, 'costs.entry.delete', `cost:${id}`, row, null);
    return { ok: true };
  });

  // ─────────── Annonces globales ───────────

  /** Annonces en cours (public : bannière du client, page d'accueil). */
  app.get('/api/announcements', async () => ({ announcements: await ctx.announcements.current() }));

  app.get('/admin/api/announcements', superadmin, async () => ({
    announcements: await ctx.announcements.list(),
  }));

  app.post('/admin/api/announcements', superadmin, async (req, reply) => {
    const body = parseBody(AnnouncementBodySchema, req.body);
    if (Date.parse(body.endsAt) <= Date.parse(body.startsAt ?? new Date().toISOString())) {
      throw new HttpError(400, 'invalid_dates', 'La fin doit être postérieure au début');
    }
    const r = await ctx.announcements.create(body, adminOf(req).user.id);
    await audit(req, 'announcement.create', `announcement:${r.announcement.id}`, null, body);
    reply.code(201);
    return r;
  });

  app.put('/admin/api/announcements/:id', superadmin, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parseBody(
      z.object({
        active: z.boolean().optional(),
        endsAt: z.string().datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    const a = Number.isInteger(id) ? await ctx.announcements.update(id, body) : null;
    if (!a) throw new HttpError(404, 'not_found', 'Annonce introuvable');
    await audit(req, 'announcement.update', `announcement:${id}`, null, body);
    return { announcement: a };
  });

  app.delete('/admin/api/announcements/:id', superadmin, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || !(await ctx.announcements.remove(id))) {
      throw new HttpError(404, 'not_found', 'Annonce introuvable');
    }
    await audit(req, 'announcement.delete', `announcement:${id}`, null, null);
    return { ok: true };
  });

  // ─────────── Paramètres d'exploitation ───────────

  app.get('/admin/api/server/settings', moderator, async () => ({
    settings: ctx.runtimeSettings.current(),
    /** Valeurs liées à l'équilibrage (écran Règles) et au déploiement (variables d'environnement). */
    info: {
      speeds: ctx.host.allowedSpeeds(),
      dormancyRadiusKm: ctx.store.current().balance?.time.dormancyRadiusKm ?? null,
      snapshotIntervalS: ctx.config.snapshotIntervalS,
      createRateLimitPerMin: ctx.options.createRateLimitPerMin,
      instanceId: ctx.config.instanceId,
      nodeEnv: ctx.config.nodeEnv,
      paymentsAvailable: !!ctx.payments,
    },
  }));

  app.put('/admin/api/server/settings', superadmin, async (req) => {
    const body = parseBody(RuntimeSettingsSchema, req.body);
    const before = ctx.runtimeSettings.current();
    const settings = await ctx.runtimeSettings.save(body);
    await audit(req, 'server.settings', 'server:settings', before, settings);
    return { settings };
  });
}
