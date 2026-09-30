import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GameStats } from '@redline/engine';
import type { GameStatsView, NationId, TimelapseView } from '@redline/shared';
import type { AppContext } from '../context.js';
import { gamePlayers, games, timelapseFrames, users } from '../db/schema.js';
import { HttpError } from '../auth/auth.js';
import { DAY_MS, metaOf } from '../host/game-host.js';
import { asset, type StaticAsset } from '../data/loader.js';
import { gameAccess, gameIdParam, requireUser } from './access.js';
import { sendAsset } from './public.js';

/** Routes de partie des phases 5-6 : spectateur, statistiques, timelapse, rapports de bataille, photos. */
export async function gameExtraRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, host } = ctx;

  app.get('/api/games/:id/spectate', async (req, reply) => {
    const auth = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const { row, canSpectate } = await gameAccess(ctx, id, auth);
    if (!canSpectate) throw new HttpError(403, 'forbidden', 'Partie non ouverte aux spectateurs');
    if (!ctx.engine?.publicView) {
      throw new HttpError(503, 'spectate_unavailable', 'Mode spectateur indisponible');
    }
    return { game: { ...(host.games.get(id)?.meta ?? metaOf(row)), spectator: true } };
  });

  app.get('/api/games/:id/stats', async (req, reply): Promise<GameStatsView> => {
    const auth = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const { row, canSpectate } = await gameAccess(ctx, id, auth);
    if (!canSpectate) throw new HttpError(404, 'not_found', 'Partie introuvable');
    // Les pertes et effectifs de chaque nation sont des secrets tant que la partie dure.
    if (row.status !== 'ended') throw new HttpError(409, 'not_ended', 'Partie en cours');
    await host.settle(id);
    const [fresh] = await db.select().from(games).where(eq(games.id, id));
    const stats = (fresh?.finalStats ?? null) as GameStats | null;
    const players = await db
      .select({ nationId: gamePlayers.nationId, name: users.displayName })
      .from(gamePlayers)
      .leftJoin(users, eq(users.id, gamePlayers.userId))
      .where(eq(gamePlayers.gameId, id));
    const playerOf = new Map(players.map((p) => [p.nationId, p.name]));
    const nations = stats
      ? Object.entries(stats.nations).map(([nationId, s]) => ({
          nationId: nationId as NationId,
          player: playerOf.get(nationId) ?? null,
          ...s,
        }))
      : players.map((p) => ({
          nationId: p.nationId,
          player: p.name,
          provincesStart: 0,
          provincesEnd: 0,
          conquered: 0,
          kills: 0,
          losses: 0,
          spentUsd: 0,
          bestUnits: [],
        }));
    // Humains d'abord, puis par provinces finales.
    nations.sort(
      (a, b) =>
        Number(!!b.player) - Number(!!a.player) ||
        b.provincesEnd - a.provincesEnd ||
        (a.nationId < b.nationId ? -1 : 1),
    );
    return {
      winner: (fresh?.winner as NationId | null) ?? null,
      durationDays: Math.floor((fresh?.gameTimeMs ?? 0) / DAY_MS),
      nations,
    };
  });

  app.get('/api/games/:id/timelapse', async (req, reply): Promise<TimelapseView> => {
    const auth = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const { canSpectate } = await gameAccess(ctx, id, auth);
    if (!canSpectate) throw new HttpError(404, 'not_found', 'Partie introuvable');
    await host.settle(id);
    const rows = await db
      .select()
      .from(timelapseFrames)
      .where(eq(timelapseFrames.gameId, id))
      .orderBy(asc(timelapseFrames.day));
    let cur: Record<string, NationId> = {};
    const frames = rows.map((r) => {
      cur = { ...cur, ...r.delta };
      return { day: r.day, owners: cur };
    });
    return { frames };
  });

  app.get('/api/games/:id/battle-reports/:rid', async (req, reply) => {
    const auth = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const rid = String((req.params as { rid: string }).rid).slice(0, 64);
    const { member } = await gameAccess(ctx, id, auth);
    if (!member) throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (!ctx.engine?.battleReportFor) {
      throw new HttpError(404, 'not_available', 'Rapports détaillés non disponibles');
    }
    const g = await host.ensureLoaded(id);
    if (!g) throw new HttpError(409, 'game_unavailable', 'Partie momentanément indisponible');
    const report = ctx.engine.battleReportFor(g.state, member.nationId, rid);
    if (!report) throw new HttpError(404, 'not_found', 'Rapport introuvable');
    return { report };
  });

  // Photos réelles des matériels (manifeste data/art/photos.json).
  let photosAsset: StaticAsset | null = null;
  app.get('/api/art/photos', async (req, reply) => {
    photosAsset ??= asset(Buffer.from(JSON.stringify({ photos: ctx.data.photos })));
    return sendAsset(req, reply, photosAsset, 'application/json; charset=utf-8');
  });
}
