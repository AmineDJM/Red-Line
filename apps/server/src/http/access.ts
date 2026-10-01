import { and, eq, ne, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasRole } from '@redline/shared';
import type { AppContext } from '../context.js';
import { gamePlayers, games } from '../db/schema.js';
import { HttpError, checkRole, type AuthState } from '../auth/auth.js';

export type GameRow = typeof games.$inferSelect;
export type PlayerRow = typeof gamePlayers.$inferSelect;

export async function requireUser(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthState> {
  return checkRole(await ctx.auth.authenticate(req, reply), 'player');
}

/** Identifiant de partie du chemin (:id), 404 s'il n'est pas un UUID. */
export function gameIdParam(req: FastifyRequest, name = 'id'): string {
  const r = z
    .string()
    .uuid()
    .safeParse((req.params as Record<string, string>)[name]);
  if (!r.success) throw new HttpError(404, 'not_found', 'Partie introuvable');
  return r.data;
}

export interface GameAccess {
  row: GameRow;
  member: PlayerRow | null;
  /** Lecture publique autorisée (spectateur) : partie multijoueur publique lancée, ou modérateur. */
  canSpectate: boolean;
}

export async function gameAccess(
  ctx: AppContext,
  gameId: string,
  auth: AuthState,
): Promise<GameAccess> {
  const [row] = await ctx.db.select().from(games).where(eq(games.id, gameId));
  if (!row) throw new HttpError(404, 'not_found', 'Partie introuvable');
  const [member] = await ctx.db
    .select()
    .from(gamePlayers)
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, auth.user.id)))
    .limit(1);
  const started = row.status !== 'lobby';
  const canSpectate =
    started &&
    (hasRole(auth.user.role, 'moderator') || !!member || (row.mode === 'multi' && !row.isPrivate));
  return { row, member: member ?? null, canSpectate };
}

/** Quota de parties non terminées créées par un joueur (protection de la mémoire et du processeur). */
export async function assertCreationQuota(
  ctx: AppContext,
  auth: AuthState,
  mode: 'solo' | 'multi',
): Promise<void> {
  // Modérateurs et comptes en mode illimité : aucun quota.
  if (hasRole(auth.user.role, 'moderator') || auth.user.unlimited) return;
  const max =
    mode === 'solo' ? ctx.options.maxActiveSoloPerUser : ctx.options.maxActiveMultiPerUser;
  const [r] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(games)
    .where(and(eq(games.createdBy, auth.user.id), eq(games.mode, mode), ne(games.status, 'ended')));
  if ((r?.n ?? 0) >= max) {
    throw new HttpError(
      429,
      'too_many_games',
      mode === 'solo'
        ? `Vous avez déjà ${max} parties solo en cours : reprenez-en une avant d'en créer une nouvelle.`
        : `Vous avez déjà créé ${max} parties multijoueur en cours.`,
    );
  }
}
