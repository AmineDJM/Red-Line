import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Role } from '@redline/shared';
import type { AppContext } from '../context.js';
import {
  adminAudit,
  chatMessages,
  chatReads,
  gamePlayers,
  gameResults,
  games,
  legalAcceptances,
  purchases,
  pushSubscriptions,
  rankings,
  sessions,
  userCosmetics,
  userFingerprints,
  users,
  walletLedger,
} from '../db/schema.js';
import { HttpError, checkRole, hashPassword, type AuthState } from '../auth/auth.js';
import { parseBody } from '../http/util.js';
import { gameIdParam } from '../http/access.js';
import { moveWallet } from '../shop/wallet.js';

/**
 * Gestion complète des comptes et des parties (back-office, superadmin) : fiche détaillée, suspension
 * temporaire, sessions, mot de passe provisoire, crédit/débit du portefeuille, export et suppression RGPD,
 * fin et suppression de partie, archives. Toute action est journalisée (admin_audit) ; les actions
 * destructives exigent une confirmation explicite dans le corps de la requête.
 */
export async function adminManageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
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
  const superadmin = { preHandler: guard('superadmin') };
  const moderator = { preHandler: guard('moderator') };
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

  const userIdParam = (req: FastifyRequest) => {
    const r = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!r.success) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    return r.data;
  };
  const userOr404 = async (id: string) => {
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
    return u;
  };
  const notSelf = (req: FastifyRequest, id: string) => {
    if (id === adminOf(req).user.id) {
      throw new HttpError(400, 'self_lockout', 'Action impossible sur votre propre compte');
    }
  };

  // ─────────── Fiche utilisateur ───────────

  /** Compléments de la fiche : sessions, parties détaillées, résultats, solde, coût du mois. */
  app.get('/admin/api/users/:id/overview', superadmin, async (req) => {
    const id = userIdParam(req);
    const u = await userOr404(id);
    const [sess, played, results, wallet, cost] = await Promise.all([
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, id), sql`${sessions.expiresAt} > now()`))
        .orderBy(desc(sessions.createdAt))
        .limit(50),
      db
        .select({
          gameId: games.id,
          name: games.name,
          mode: games.mode,
          status: games.status,
          nationId: gamePlayers.nationId,
          createdAt: games.createdAt,
          endedAt: games.endedAt,
          lastActiveAt: gamePlayers.lastActiveAt,
          isAi: gamePlayers.isAiReplacement,
          createdBy: games.createdBy,
          stateBytes: games.stateBytes,
        })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .where(eq(gamePlayers.userId, id))
        .orderBy(desc(games.createdAt))
        .limit(200),
      db
        .select({
          wins: sql<number>`count(*) FILTER (WHERE ${gameResults.won})::int`,
          games: sql<number>`count(*)::int`,
          points: sql<number>`coalesce(sum(${gameResults.points}), 0)::int`,
        })
        .from(gameResults)
        .where(eq(gameResults.userId, id)),
      db
        .select({
          bought: sql<number>`coalesce(sum(${walletLedger.delta}) FILTER (WHERE ${walletLedger.reason} = 'purchase'), 0)::int`,
          spent: sql<number>`coalesce(-sum(${walletLedger.delta}) FILTER (WHERE ${walletLedger.reason} IN ('accelerate','cosmetic')), 0)::int`,
          admin: sql<number>`coalesce(sum(${walletLedger.delta}) FILTER (WHERE ${walletLedger.reason} = 'admin'), 0)::int`,
        })
        .from(walletLedger)
        .where(eq(walletLedger.userId, id)),
      ctx.costs
        .report('month')
        .then((r) => r.report.users?.find((x) => x.id === id) ?? null)
        .catch(() => null),
    ]);
    return {
      sessions: sess.map((s, i) => ({
        n: i + 1,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        userAgent: s.userAgent,
      })),
      games: played.map((g) => ({
        ...g,
        createdAt: g.createdAt.toISOString(),
        endedAt: g.endedAt?.toISOString() ?? null,
        lastActiveAt: g.lastActiveAt?.toISOString() ?? null,
        owner: g.createdBy === id,
        loaded: host.games.has(g.gameId),
      })),
      results: results[0] ?? { wins: 0, games: 0, points: 0 },
      wallet: { balance: u.premiumBalance, ...(wallet[0] ?? { bought: 0, spent: 0, admin: 0 }) },
      costMonth: cost,
      kind:
        u.role !== 'player' || u.unlimited
          ? 'staff'
          : u.isGuest
            ? 'guest'
            : (
                  await db
                    .select({ n: sql<number>`count(*)::int` })
                    .from(purchases)
                    .where(and(eq(purchases.userId, id), eq(purchases.status, 'paid')))
                )[0]!.n > 0
              ? 'paying'
              : 'free',
    };
  });

  // ─────────── Sanctions et sécurité du compte ───────────

  app.post('/admin/api/users/:id/suspend', superadmin, async (req) => {
    const id = userIdParam(req);
    notSelf(req, id);
    const body = parseBody(
      z.object({
        hours: z
          .number()
          .positive()
          .max(24 * 365 * 5),
        reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    const before = await userOr404(id);
    const until = new Date(Date.now() + body.hours * 3_600_000);
    await db
      .update(users)
      .set({ bannedAt: new Date(), bannedUntil: until, banReason: body.reason ?? null })
      .where(eq(users.id, id));
    await ctx.auth.revokeAll(id);
    host.kickUser(id, 'Compte suspendu');
    await audit(
      req,
      'user.suspend',
      `user:${id}`,
      { bannedAt: before.bannedAt, bannedUntil: before.bannedUntil },
      { bannedUntil: until.toISOString(), reason: body.reason ?? null },
    );
    return { ok: true, bannedUntil: until.toISOString() };
  });

  app.post('/admin/api/users/:id/sessions/revoke', superadmin, async (req) => {
    const id = userIdParam(req);
    notSelf(req, id);
    await userOr404(id);
    const n = await db
      .delete(sessions)
      .where(eq(sessions.userId, id))
      .returning({ id: sessions.id });
    host.kickUser(id, 'Session fermée par l’administration');
    await audit(req, 'user.sessions_revoke', `user:${id}`, null, { sessions: n.length });
    return { ok: true, revoked: n.length };
  });

  /** Mot de passe provisoire (affiché une seule fois, jamais journalisé) ; sessions fermées. */
  app.post('/admin/api/users/:id/password-reset', superadmin, async (req) => {
    const id = userIdParam(req);
    notSelf(req, id);
    const u = await userOr404(id);
    if (!u.email || u.isGuest || u.deletedAt) {
      throw new HttpError(409, 'no_password', 'Compte sans adresse e-mail (invité ou supprimé)');
    }
    const password = randomBytes(9).toString('base64url');
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, id));
    await ctx.auth.revokeAll(id);
    host.kickUser(id, 'Mot de passe réinitialisé');
    await audit(req, 'user.password_reset', `user:${id}`);
    return { ok: true, password };
  });

  /** Crédit (ou débit) de monnaie premium : geste commercial, correction. */
  app.post('/admin/api/users/:id/wallet', superadmin, async (req) => {
    const id = userIdParam(req);
    const body = parseBody(
      z.object({
        delta: z
          .number()
          .int()
          .min(-1_000_000)
          .max(1_000_000)
          .refine((v) => v !== 0, 'montant nul'),
        note: z.string().min(1).max(200),
      }),
      req.body,
    );
    await userOr404(id);
    const balance = await db.transaction((tx) =>
      moveWallet(tx, { userId: id, delta: body.delta, reason: 'admin', ref: body.note }),
    );
    await audit(req, 'user.wallet', `user:${id}`, null, { ...body, balance });
    return { ok: true, balance };
  });

  // ─────────── RGPD : export et suppression ───────────

  async function exportUser(id: string) {
    const u = await userOr404(id);
    const { passwordHash: _p, ...account } = u;
    const [sess, fps, played, results, buys, wallet, cos, chat, legal, push, ranks] =
      await Promise.all([
        db.select().from(sessions).where(eq(sessions.userId, id)),
        db.select().from(userFingerprints).where(eq(userFingerprints.userId, id)),
        db
          .select({
            game: games.name,
            gameId: games.id,
            nationId: gamePlayers.nationId,
            joinedAt: gamePlayers.joinedAt,
          })
          .from(gamePlayers)
          .innerJoin(games, eq(games.id, gamePlayers.gameId))
          .where(eq(gamePlayers.userId, id)),
        db.select().from(gameResults).where(eq(gameResults.userId, id)),
        db.select().from(purchases).where(eq(purchases.userId, id)),
        db.select().from(walletLedger).where(eq(walletLedger.userId, id)),
        db.select().from(userCosmetics).where(eq(userCosmetics.userId, id)),
        db
          .select({
            gameId: chatMessages.gameId,
            channel: chatMessages.channel,
            text: chatMessages.text,
            createdAt: chatMessages.createdAt,
          })
          .from(chatMessages)
          .where(eq(chatMessages.userId, id)),
        db.select().from(legalAcceptances).where(eq(legalAcceptances.userId, id)),
        db
          .select({ endpoint: pushSubscriptions.endpoint, createdAt: pushSubscriptions.createdAt })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.userId, id)),
        db.select().from(rankings).where(eq(rankings.userId, id)),
      ]);
    return {
      exportedAt: new Date().toISOString(),
      service: 'Red Line',
      account,
      sessions: sess.map(({ id: _s, ...s }) => s),
      fingerprints: fps,
      games: played,
      results,
      purchases: buys,
      wallet,
      cosmetics: cos,
      chat,
      legalAcceptances: legal,
      pushSubscriptions: push.map((p) => ({ ...p, endpoint: new URL(p.endpoint).host })),
      rankings: ranks,
    };
  }

  app.get('/admin/api/users/:id/export', superadmin, async (req, reply) => {
    const id = userIdParam(req);
    const data = await exportUser(id);
    await audit(req, 'user.export', `user:${id}`);
    reply.header(
      'Content-Disposition',
      `attachment; filename="redline-user-${id.slice(0, 8)}.json"`,
    );
    return data;
  });

  /**
   * Suppression RGPD : données personnelles effacées (e-mail, mot de passe, nom, empreintes, sessions,
   * abonnements push, messages anonymisés, parties solo supprimées). Les achats et le journal du
   * portefeuille sont conservés anonymisés (obligation comptable, 10 ans), avec les acceptations des CGV.
   */
  app.delete('/admin/api/users/:id', superadmin, async (req) => {
    const id = userIdParam(req);
    notSelf(req, id);
    const body = parseBody(z.object({ confirm: z.string().max(80) }), req.body);
    const u = await userOr404(id);
    if (u.deletedAt) throw new HttpError(409, 'already_deleted', 'Compte déjà supprimé');
    if (u.role === 'superadmin') {
      throw new HttpError(409, 'superadmin', 'Retirez d’abord le rôle superadmin de ce compte');
    }
    if (body.confirm !== u.displayName) {
      throw new HttpError(
        400,
        'confirm_mismatch',
        'Confirmation incorrecte (nom du compte attendu)',
      );
    }
    const solo = await db
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.createdBy, id), eq(games.mode, 'solo')));
    let deletedGames = 0;
    for (const g of solo) if ((await host.adminDelete(g.id)) === 'ok') deletedGames++;
    host.kickUser(id, 'Compte supprimé');
    const now = new Date();
    const anon = `Compte supprimé ${id.slice(0, 6)}`;
    await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.userId, id));
      await tx.delete(userFingerprints).where(eq(userFingerprints.userId, id));
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, id));
      await tx.delete(chatReads).where(eq(chatReads.userId, id));
      await tx.delete(userCosmetics).where(eq(userCosmetics.userId, id));
      await tx.delete(rankings).where(eq(rankings.userId, id));
      await tx
        .update(chatMessages)
        .set({ text: '[message supprimé]', authorName: anon, hidden: true })
        .where(eq(chatMessages.userId, id));
      await tx
        .update(users)
        .set({
          email: null,
          passwordHash: null,
          displayName: anon,
          role: 'player',
          unlimited: false,
          activityHours: null,
          chatMutedUntil: null,
          bannedAt: now,
          bannedUntil: null,
          banReason: 'Compte supprimé (RGPD)',
          deletedAt: now,
        })
        .where(eq(users.id, id));
    });
    // Le journal ne garde aucune donnée personnelle du compte supprimé.
    await audit(req, 'user.delete', `user:${id}`, null, {
      deletedGames,
      deletedAt: now.toISOString(),
    });
    return { ok: true, deletedGames };
  });

  // ─────────── Parties ───────────

  /** Parties terminées (archives) : recherche, taille stockée, suppression possible. */
  app.get('/admin/api/games/archive', moderator, async (req) => {
    const q = parseBody(
      z.object({
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      }),
      req.query,
    );
    const pattern = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const rows = await db
      .select({
        id: games.id,
        name: games.name,
        mode: games.mode,
        scenarioId: games.scenarioId,
        pauseReason: games.pauseReason,
        winner: games.winner,
        createdAt: games.createdAt,
        endedAt: games.endedAt,
        stateBytes: games.stateBytes,
        unranked: games.unranked,
        humans: sql<number>`(SELECT count(*)::int FROM game_players p WHERE p.game_id = ${games.id} AND p.user_id IS NOT NULL)`,
      })
      .from(games)
      .where(
        and(
          eq(games.status, 'ended'),
          pattern
            ? sql`(${ilike(games.name, pattern)} OR ${games.id}::text LIKE ${pattern})`
            : undefined,
        ),
      )
      .orderBy(desc(sql`coalesce(${games.endedAt}, ${games.createdAt})`))
      .limit(q.limit);
    return {
      games: rows.map((r) => ({
        ...r,
        endReason:
          r.pauseReason === 'abandoned'
            ? 'abandoned'
            : r.pauseReason === 'admin'
              ? 'admin'
              : 'victory',
        createdAt: r.createdAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/admin/api/games/:id/end', superadmin, async (req) => {
    const id = gameIdParam(req);
    const body = parseBody(z.object({ message: z.string().max(500).optional() }), req.body);
    const notice = body.message?.trim() || "La partie a été terminée par l'administration.";
    const r = await host.adminEnd(id, notice);
    if (r === 'not_found') throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (r === 'ended') throw new HttpError(409, 'already_ended', 'Partie déjà terminée');
    if (r === 'busy') {
      throw new HttpError(
        409,
        'game_unavailable',
        'Partie simulée par une autre instance, réessayez',
      );
    }
    await audit(req, 'game.end', `game:${id}`, null, { message: notice });
    return { ok: true };
  });

  app.delete('/admin/api/games/:id', superadmin, async (req) => {
    const id = gameIdParam(req);
    const body = parseBody(z.object({ confirm: z.string().max(200) }), req.body);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    if (!row) throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (body.confirm !== row.name && body.confirm !== id.slice(0, 8)) {
      throw new HttpError(
        400,
        'confirm_mismatch',
        'Confirmation incorrecte (nom de la partie attendu)',
      );
    }
    const r = await host.adminDelete(id);
    if (r === 'busy') {
      throw new HttpError(
        409,
        'game_unavailable',
        'Partie simulée par une autre instance, réessayez',
      );
    }
    if (r === 'not_found') throw new HttpError(404, 'not_found', 'Partie introuvable');
    await audit(req, 'game.delete', `game:${id}`, {
      name: row.name,
      mode: row.mode,
      status: row.status,
      createdBy: row.createdBy,
    });
    ctx.costs.invalidate();
    return { ok: true };
  });
}
