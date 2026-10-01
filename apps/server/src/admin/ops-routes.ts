import { and, desc, eq, gte, ilike, isNotNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RESOURCES, ROLES, WorldEventBodySchema, type Role } from '@redline/shared';
import type { AppContext } from '../context.js';
import {
  adminAudit,
  chatMessages,
  gamePlayers,
  games,
  purchases,
  shopPacks,
  shopPromotions,
  shopResourceOffers,
  userFingerprints,
  users,
  walletLedger,
} from '../db/schema.js';
import { HttpError, checkRole, toPublicUser, type AuthState } from '../auth/auth.js';
import { parseBody } from '../http/util.js';
import { gameIdParam } from '../http/access.js';
import { toChatMessage } from '../chat/chat.js';
import { offerResources, packView, refundPurchase } from '../shop/shop.js';

const PackBodySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(80),
  amount: z.number().int().positive(),
  bonus: z.number().int().min(0).default(0),
  priceCents: z.number().int().positive(),
  currency: z.enum(['eur', 'usd']).default('eur'),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});

/** Offre de ressources en jeu (monnaie premium → dollars du jeu et/ou ressources). */
const ResourceOfferBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9._-]+$/),
    name: z.string().min(1).max(80),
    money: z.number().min(0).max(1e13).default(0),
    resources: z.record(z.enum(RESOURCES), z.number().min(0).max(1e7)).default({}),
    price: z.number().int().positive().max(1_000_000),
    active: z.boolean().default(true),
    sort: z.number().int().default(0),
  })
  .refine((b) => b.money > 0 || Object.values(b.resources).some((v) => (v ?? 0) > 0), {
    message: 'Offre vide : dollars ou ressources requis',
  });

const PromoBodySchema = z.object({
  packId: z.string().max(64).nullable().default(null),
  label: z.string().min(1).max(80),
  percentOff: z.number().int().min(1).max(90),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  active: z.boolean().default(true),
});

const UserPatchSchema = z.object({
  role: z.enum(ROLES).optional(),
  banned: z.boolean().optional(),
  banReason: z.string().max(500).optional(),
  chatMutedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  displayName: z.string().min(2).max(40).optional(),
  /** Mode illimité (ressources, monnaie premium, quotas) : superadmin seulement (route superadmin). */
  unlimited: z.boolean().optional(),
});

export async function adminOpsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, host } = ctx;

  const guard =
    (role: Role) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      (req as FastifyRequest & { admin?: AuthState }).admin = checkRole(
        await ctx.auth.authenticate(req, reply),
        role,
      );
    };
  const adminOf = (req: FastifyRequest) => (req as FastifyRequest & { admin: AuthState }).admin;
  const moderator = { preHandler: guard('moderator') };
  const superadmin = { preHandler: guard('superadmin') };

  const audit = (
    req: FastifyRequest,
    action: string,
    target: string,
    before: unknown = null,
    after: unknown = null,
  ) =>
    db.insert(adminAudit).values({
      adminId: adminOf(req).user.id,
      action,
      target,
      before: before as object | null,
      after: after as object | null,
    });

  // ─────────── Événements mondiaux en direct ───────────

  app.post('/admin/api/games/:id/event', moderator, async (req) => {
    const id = gameIdParam(req);
    const body = parseBody(WorldEventBodySchema, req.body);
    const r = await host.system(id, { kind: 'worldEvent', ...body });
    if (!r.ok) {
      throw new HttpError(
        409,
        r.error === 'unsupported' ? 'event_unavailable' : (r.error ?? 'event_refused'),
        r.message ?? 'Événement refusé',
      );
    }
    const g = host.games.get(id);
    if (g && body.message) host.notice(g, body.message, 'warn');
    await audit(req, 'game.world_event', `game:${id}`, null, body);
    return { ok: true };
  });

  // ─────────── Modération de la messagerie ───────────

  app.get('/admin/api/chat', moderator, async (req) => {
    const q = parseBody(
      z.object({
        gameId: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        userId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const conds: SQL[] = [];
    if (q.gameId) conds.push(eq(chatMessages.gameId, q.gameId));
    if (q.userId) conds.push(eq(chatMessages.userId, q.userId));
    if (q.q) conds.push(ilike(chatMessages.text, `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
    const rows = await db
      .select()
      .from(chatMessages)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(chatMessages.id))
      .limit(q.limit);
    // La modération voit le texte des messages masqués.
    return {
      messages: rows.map((r) => ({ ...toChatMessage(r), text: r.text, filtered: r.filtered })),
    };
  });

  app.post('/admin/api/chat/:messageId/hide', moderator, async (req) => {
    const id = z.coerce
      .number()
      .int()
      .positive()
      .safeParse((req.params as { messageId: string }).messageId);
    if (!id.success) throw new HttpError(404, 'not_found', 'Message introuvable');
    const body = parseBody(z.object({ hidden: z.boolean().default(true) }), req.body);
    const msg = await ctx.chat.setHidden(id.data, body.hidden, adminOf(req).user.id);
    if (!msg) throw new HttpError(404, 'not_found', 'Message introuvable');
    await audit(req, body.hidden ? 'chat.hide' : 'chat.unhide', `chat:${id.data}`);
    return { ok: true, message: msg };
  });

  app.post('/admin/api/chat/mute', moderator, async (req) => {
    const body = parseBody(
      z.object({
        userId: z.string().uuid(),
        hours: z
          .number()
          .min(0)
          .max(24 * 365),
      }),
      req.body,
    );
    const until = body.hours > 0 ? new Date(Date.now() + body.hours * 3_600_000) : null;
    const [u] = await db
      .update(users)
      .set({ chatMutedUntil: until })
      .where(eq(users.id, body.userId))
      .returning({ id: users.id });
    if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    await audit(req, 'chat.mute', `user:${body.userId}`, null, { until });
    return { ok: true, mutedUntil: until?.toISOString() ?? null };
  });

  // ─────────── Sécurité : multi-comptes et anomalies ───────────

  app.get('/admin/api/security/suspicious', moderator, async () => {
    const pairs = await ctx.fingerprints.suspicious();
    // Anomalies : cadence d'ordres anormale sur la dernière heure (scripts, bots).
    const bursts = await db.execute(sql`
      SELECT gp.user_id AS "userId", o.game_id AS "gameId", count(*)::int AS orders
      FROM game_orders o
      JOIN game_players gp ON gp.game_id = o.game_id AND gp.slot = o.player_slot
      WHERE o.received_at > now() - interval '1 hour' AND gp.user_id IS NOT NULL
      GROUP BY gp.user_id, o.game_id
      HAVING count(*) > 1500
      ORDER BY orders DESC LIMIT 50`);
    return { pairs, anomalies: [...bursts].map((r) => ({ kind: 'order_rate', ...r })) };
  });

  // ─────────── Utilisateurs ───────────

  const userView = (u: typeof users.$inferSelect) => ({
    ...toPublicUser(u),
    unlimited: u.unlimited,
    premiumBalance: u.premiumBalance,
    createdAt: u.createdAt.toISOString(),
    lastSeenAt: u.lastSeenAt.toISOString(),
    bannedAt: u.bannedAt?.toISOString() ?? null,
    banReason: u.banReason,
    bannedUntil: u.bannedUntil?.toISOString() ?? null,
    deletedAt: u.deletedAt?.toISOString() ?? null,
    chatMutedUntil: u.chatMutedUntil?.toISOString() ?? null,
  });

  app.get('/admin/api/users', superadmin, async (req) => {
    const q = parseBody(
      z.object({
        q: z.string().max(200).optional(),
        /** Filtre : comptes bannis, invités, équipe (rôle ≠ joueur), illimités, payants, supprimés. */
        filter: z.enum(['banned', 'guest', 'staff', 'unlimited', 'paying', 'deleted']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
      }),
      req.query,
    );
    const pattern = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const conds: SQL[] = [];
    if (pattern) {
      const byId = z.string().uuid().safeParse(q.q?.trim());
      conds.push(
        or(
          ilike(users.displayName, pattern),
          ilike(users.email, pattern),
          ...(byId.success ? [eq(users.id, byId.data)] : []),
        )!,
      );
    }
    if (q.filter === 'banned') conds.push(isNotNull(users.bannedAt));
    if (q.filter === 'guest') conds.push(eq(users.isGuest, true));
    if (q.filter === 'staff') conds.push(sql`${users.role} <> 'player'`);
    if (q.filter === 'unlimited') conds.push(eq(users.unlimited, true));
    if (q.filter === 'deleted') conds.push(isNotNull(users.deletedAt));
    if (q.filter === 'paying') {
      conds.push(
        sql`EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = ${users.id} AND p.status = 'paid')`,
      );
    }
    const rows = await db
      .select()
      .from(users)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(users.lastSeenAt))
      .limit(q.limit);
    return { users: rows.map(userView) };
  });

  const userIdParam = (req: FastifyRequest) => {
    const r = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!r.success) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    return r.data;
  };

  app.get('/admin/api/users/:id', superadmin, async (req) => {
    const id = userIdParam(req);
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    const [fps, gp, buys, wallet] = await Promise.all([
      db
        .select()
        .from(userFingerprints)
        .where(eq(userFingerprints.userId, id))
        .orderBy(desc(userFingerprints.lastSeen))
        .limit(50),
      db
        .select({ gameId: gamePlayers.gameId, nationId: gamePlayers.nationId, name: games.name })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .where(eq(gamePlayers.userId, id))
        .limit(100),
      db
        .select()
        .from(purchases)
        .where(eq(purchases.userId, id))
        .orderBy(desc(purchases.createdAt))
        .limit(100),
      db
        .select()
        .from(walletLedger)
        .where(eq(walletLedger.userId, id))
        .orderBy(desc(walletLedger.id))
        .limit(100),
    ]);
    return {
      user: userView(u),
      activityHours: u.activityHours ?? [],
      fingerprints: fps.map((f) => ({
        ipHash: f.ipHash,
        uaHash: f.uaHash,
        userAgent: f.userAgent,
        firstSeen: f.firstSeen.toISOString(),
        lastSeen: f.lastSeen.toISOString(),
        hits: f.hits,
      })),
      games: gp,
      purchases: buys,
      wallet,
    };
  });

  app.put('/admin/api/users/:id', superadmin, async (req) => {
    const id = userIdParam(req);
    const body = parseBody(UserPatchSchema, req.body);
    const admin = adminOf(req);
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    if (id === admin.user.id && (body.banned || (body.role && body.role !== 'superadmin'))) {
      throw new HttpError(400, 'self_lockout', 'Impossible de vous retirer vos propres droits');
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.role) patch.role = body.role;
    if (body.displayName) patch.displayName = body.displayName;
    if (body.unlimited !== undefined) patch.unlimited = body.unlimited;
    if (body.chatMutedUntil !== undefined) {
      patch.chatMutedUntil = body.chatMutedUntil ? new Date(body.chatMutedUntil) : null;
    }
    if (body.banned === true) {
      patch.bannedAt = new Date();
      patch.banReason = body.banReason ?? null;
      patch.bannedUntil = null;
    } else if (body.banned === false) {
      patch.bannedAt = null;
      patch.banReason = null;
      patch.bannedUntil = null;
    }
    const [after] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
    if (body.banned === true) {
      await ctx.auth.revokeAll(id);
      host.kickUser(id, 'Compte suspendu');
    }
    const unlimitedChanged = body.unlimited !== undefined && body.unlimited !== before.unlimited;
    // Parties chargées ici : mode illimité appliqué ou retiré tout de suite (commande journalisée).
    if (unlimitedChanged) host.setUserUnlimited(id, body.unlimited!);
    await audit(
      req,
      unlimitedChanged ? 'user.unlimited' : 'user.update',
      `user:${id}`,
      userView(before),
      userView(after!),
    );
    return { user: userView(after!) };
  });

  // ─────────── Boutique ───────────

  app.get('/admin/api/shop/packs', superadmin, async () => {
    const [packs, promos] = await Promise.all([
      db.select().from(shopPacks).orderBy(shopPacks.sort),
      db.select().from(shopPromotions),
    ]);
    return {
      packs: packs.map((p) => ({
        ...p,
        updatedAt: p.updatedAt.toISOString(),
        view: packView(p, promos),
      })),
    };
  });

  app.post('/admin/api/shop/packs', superadmin, async (req, reply) => {
    const body = parseBody(PackBodySchema, req.body);
    const [row] = await db.insert(shopPacks).values(body).onConflictDoNothing().returning();
    if (!row) throw new HttpError(409, 'already_exists', 'Ce pack existe déjà');
    await audit(req, 'shop.pack.create', `pack:${body.id}`, null, body);
    reply.code(201);
    return { pack: row };
  });

  app.put('/admin/api/shop/packs/:id', superadmin, async (req) => {
    const id = String((req.params as { id: string }).id);
    const body = parseBody(PackBodySchema, { ...(req.body as object), id });
    const [before] = await db.select().from(shopPacks).where(eq(shopPacks.id, id));
    if (!before) throw new HttpError(404, 'not_found', 'Pack introuvable');
    const [row] = await db
      .update(shopPacks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(shopPacks.id, id))
      .returning();
    await audit(req, 'shop.pack.update', `pack:${id}`, before, row);
    return { pack: row };
  });

  app.get('/admin/api/shop/resources', superadmin, async () => ({
    offers: (
      await db
        .select()
        .from(shopResourceOffers)
        .orderBy(shopResourceOffers.sort, shopResourceOffers.id)
    ).map((o) => ({
      ...o,
      resources: offerResources(o),
      updatedAt: o.updatedAt.toISOString(),
    })),
  }));

  app.post('/admin/api/shop/resources', superadmin, async (req, reply) => {
    const body = parseBody(ResourceOfferBodySchema, req.body);
    const [row] = await db
      .insert(shopResourceOffers)
      .values({ ...body, resources: offerResources(body) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, 'already_exists', 'Cette offre existe déjà');
    await audit(req, 'shop.resources.create', `offer:${body.id}`, null, body);
    reply.code(201);
    return { offer: row };
  });

  app.put('/admin/api/shop/resources/:id', superadmin, async (req) => {
    const id = String((req.params as { id: string }).id);
    const body = parseBody(ResourceOfferBodySchema, { ...(req.body as object), id });
    const [before] = await db
      .select()
      .from(shopResourceOffers)
      .where(eq(shopResourceOffers.id, id));
    if (!before) throw new HttpError(404, 'not_found', 'Offre introuvable');
    const [row] = await db
      .update(shopResourceOffers)
      .set({ ...body, resources: offerResources(body), updatedAt: new Date() })
      .where(eq(shopResourceOffers.id, id))
      .returning();
    await audit(req, 'shop.resources.update', `offer:${id}`, before, row);
    return { offer: row };
  });

  app.get('/admin/api/shop/promotions', superadmin, async () => ({
    promotions: await db.select().from(shopPromotions).orderBy(desc(shopPromotions.id)),
  }));

  const promoValues = (b: z.infer<typeof PromoBodySchema>) => {
    const startsAt = new Date(b.startsAt);
    const endsAt = new Date(b.endsAt);
    if (endsAt <= startsAt) throw new HttpError(400, 'invalid_dates', 'Fin avant le début');
    return { ...b, startsAt, endsAt };
  };

  app.post('/admin/api/shop/promotions', superadmin, async (req, reply) => {
    const body = parseBody(PromoBodySchema, req.body);
    const [row] = await db.insert(shopPromotions).values(promoValues(body)).returning();
    await audit(req, 'shop.promo.create', `promo:${row!.id}`, null, body);
    reply.code(201);
    return { promotion: row };
  });

  app.put('/admin/api/shop/promotions/:id', superadmin, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new HttpError(404, 'not_found', 'Promotion introuvable');
    const body = parseBody(PromoBodySchema, req.body);
    const [before] = await db.select().from(shopPromotions).where(eq(shopPromotions.id, id));
    if (!before) throw new HttpError(404, 'not_found', 'Promotion introuvable');
    const [row] = await db
      .update(shopPromotions)
      .set(promoValues(body))
      .where(eq(shopPromotions.id, id))
      .returning();
    await audit(req, 'shop.promo.update', `promo:${id}`, before, row);
    return { promotion: row };
  });

  app.get('/admin/api/purchases', superadmin, async (req) => {
    const q = parseBody(
      z.object({
        status: z.enum(['pending', 'paid', 'refunded', 'failed']).optional(),
        userId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(purchases.status, q.status));
    if (q.userId) conds.push(eq(purchases.userId, q.userId));
    const rows = await db
      .select({ p: purchases, name: users.displayName, email: users.email })
      .from(purchases)
      .leftJoin(users, eq(users.id, purchases.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(purchases.createdAt))
      .limit(q.limit);
    return { purchases: rows.map((r) => ({ ...r.p, userName: r.name, userEmail: r.email })) };
  });

  app.post('/admin/api/purchases/:id/refund', superadmin, async (req) => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Achat introuvable');
    const r = await refundPurchase(ctx, id.data);
    await audit(req, 'shop.refund', `purchase:${id.data}`);
    return { ok: true, balance: r.balance };
  });

  // ─────────── Journal d'administration ───────────

  app.get('/admin/api/audit', superadmin, async (req) => {
    const q = parseBody(
      z.object({
        limit: z.coerce.number().int().min(1).max(5000).default(200),
        /** Préfixe d'action (« user. », « game.end »), administrateur, cible (préfixe), dates. */
        action: z.string().max(80).optional(),
        adminId: z.string().uuid().optional(),
        target: z.string().max(200).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const esc = (v: string) => v.replace(/[%_\\]/g, (c) => `\\${c}`);
    const conds: SQL[] = [];
    if (q.action) conds.push(like(adminAudit.action, `${esc(q.action)}%`));
    if (q.adminId) conds.push(eq(adminAudit.adminId, q.adminId));
    if (q.target) conds.push(like(adminAudit.target, `${esc(q.target)}%`));
    if (q.from) conds.push(gte(adminAudit.createdAt, new Date(q.from)));
    if (q.to) conds.push(lte(adminAudit.createdAt, new Date(q.to)));
    if (q.before) conds.push(sql`${adminAudit.id} < ${q.before}`);
    const rows = await db
      .select({ a: adminAudit, name: users.displayName })
      .from(adminAudit)
      .leftJoin(users, eq(users.id, adminAudit.adminId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(adminAudit.id))
      .limit(q.limit);
    return {
      entries: rows.map((r) => ({
        ...r.a,
        createdAt: r.a.createdAt.toISOString(),
        adminName: r.name,
      })),
    };
  });
}
