import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateLobbyBodySchema,
  hasRole,
  type LobbyGame,
  type NationId,
  type NationInfo,
  type ScenarioFile,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import { gamePlayers, games, users } from '../db/schema.js';
import { HttpError } from '../auth/auth.js';
import { parseBody, unavailable } from '../http/util.js';
import { gameIdParam, requireUser } from '../http/access.js';
import { metaOf } from '../host/game-host.js';

const JoinBodySchema = z.object({ nationId: z.string().min(1).max(64) });

export function nationPlayable(
  ctx: AppContext,
  scenario: ScenarioFile,
  nationId: string,
): boolean {
  if (!ctx.store.current().nationsById.has(nationId)) return false;
  return (
    (scenario.playableNations === 'all' || scenario.playableNations.includes(nationId)) &&
    (!scenario.nationIds || scenario.nationIds.includes(nationId))
  );
}

/** Principaux systèmes : les plus coûteux au total (prix × quantité), sinon les plus nombreux. */
function highlights(
  inventory: { systemId: string; count: number }[],
  costOf: (id: string) => number,
): { systemId: string; count: number }[] {
  return inventory
    .filter((i) => i.count > 0)
    .map((i) => ({ ...i, w: costOf(i.systemId) * i.count || i.count * 1e-9 }))
    .sort((a, b) => b.w - a.w || b.count - a.count || (a.systemId < b.systemId ? -1 : 1))
    .slice(0, 8)
    .map(({ systemId, count }) => ({ systemId, count }));
}

export async function lobbyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, host, store } = ctx;

  const scenarioOf = (id: string) => store.current().scenarios.find((s) => s.id === id);

  /** Lignes LobbyGame pour une liste de parties. */
  async function lobbyViews(rows: (typeof games.$inferSelect)[]): Promise<LobbyGame[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const players = await db
      .select({ p: gamePlayers, name: users.displayName })
      .from(gamePlayers)
      .leftJoin(users, eq(users.id, gamePlayers.userId))
      .where(inArray(gamePlayers.gameId, ids));
    const creatorIds = rows.map((r) => r.createdBy).filter((x): x is string => !!x);
    const creators = creatorIds.length
      ? await db
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
    return rows.map((r) => {
      const mine = players.filter((x) => x.p.gameId === r.id && x.p.userId);
      const takenBy: Record<NationId, string> = {};
      for (const x of mine) takenBy[x.p.nationId] = x.name ?? '?';
      return {
        game: host.games.get(r.id)?.meta ?? metaOf(r, mine.length),
        scenarioName: scenarioOf(r.scenarioId)?.name ?? r.scenarioId,
        takenNations: mine.map((x) => x.p.nationId),
        takenBy,
        creator: creators.find((c) => c.id === r.createdBy)?.name ?? '?',
        speed: r.speed,
      };
    });
  }

  app.get('/api/lobby', async (req, reply) => {
    const auth = await ctx.auth.authenticate(req, reply);
    const mineIds = auth
      ? (
          await db
            .select({ id: gamePlayers.gameId })
            .from(gamePlayers)
            .where(eq(gamePlayers.userId, auth.user.id))
        ).map((r) => r.id)
      : [];
    // Salons ouverts + parties multijoueurs publiques en cours (arrivée en cours de partie).
    const rows = await db
      .select()
      .from(games)
      .where(
        and(
          eq(games.mode, 'multi'),
          inArray(games.status, ['lobby', 'running', 'paused']),
          or(
            eq(games.isPrivate, false),
            mineIds.length ? inArray(games.id, mineIds) : sql`false`,
          ),
        ),
      )
      .orderBy(desc(games.createdAt))
      .limit(200);
    return { games: await lobbyViews(rows) };
  });

  app.get('/api/lobby/:id', async (req, reply) => {
    await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const [row] = await db.select().from(games).where(and(eq(games.id, id), eq(games.mode, 'multi')));
    if (!row) throw new HttpError(404, 'not_found', 'Partie introuvable');
    return { game: (await lobbyViews([row]))[0] };
  });

  app.post('/api/lobby', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const body = parseBody(CreateLobbyBodySchema, req.body);
    const r = ctx.worlds.unavailableReason();
    if (r) throw unavailable(r.code, r.message);
    const scenario = scenarioOf(body.scenarioId);
    if (!scenario) throw new HttpError(404, 'unknown_scenario', 'Scénario inconnu');
    if (!nationPlayable(ctx, scenario, body.nationId)) {
      throw new HttpError(400, 'nation_not_playable', 'Nation non jouable dans ce scénario');
    }
    const speeds = host.allowedSpeeds();
    if (!speeds.includes(body.speed)) {
      throw new HttpError(400, 'invalid_speed', `Vitesses autorisées : ${speeds.join(', ')}`);
    }
    if (body.shopPolicy.mode === 'limited' && body.shopPolicy.capPerPlayer === undefined) {
      throw new HttpError(400, 'invalid_body', 'shopPolicy.capPerPlayer requis en mode limité');
    }
    const balance = store.current().balance!;
    const row = await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(games)
        .values({
          name: body.name,
          scenarioId: scenario.id,
          status: 'lobby',
          mode: 'multi',
          speed: body.speed,
          speeds: [body.speed],
          seed: 0,
          balance,
          setup: { aiLevel: body.aiLevel, scenarioId: scenario.id },
          createdBy: user.id,
          maxPlayers: body.maxPlayers,
          shopPolicy: body.shopPolicy,
          victory: body.victory ?? null,
          inactiveAiAfterH: body.inactiveAiAfterH,
          isPrivate: body.private,
        })
        .returning();
      await tx
        .insert(gamePlayers)
        .values({ gameId: g!.id, slot: 0, userId: user.id, nationId: body.nationId });
      return g!;
    });
    reply.code(201);
    if (body.maxPlayers === 1) {
      return { game: await host.startLobbyGame(row.id, scenario) };
    }
    return { game: metaOf(row, 1) };
  });

  app.post('/api/lobby/:id/join', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const { nationId } = parseBody(JoinBodySchema, req.body);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    if (!row || row.mode !== 'multi') throw new HttpError(404, 'not_found', 'Partie introuvable');
    const scenario = scenarioOf(row.scenarioId);
    if (!scenario) throw new HttpError(409, 'unknown_scenario', 'Scénario indisponible');
    if (!nationPlayable(ctx, scenario, nationId)) {
      throw new HttpError(400, 'nation_not_playable', 'Nation non jouable dans ce scénario');
    }
    if (row.status === 'ended') throw new HttpError(409, 'game_over', 'La partie est terminée');
    if (row.status !== 'lobby') {
      // Arrivée en cours de partie : la nation, tenue jusque-là par une IA, passe au joueur.
      return { game: await host.joinRunning(id, user.id, nationId) };
    }
    const count = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(games).where(eq(games.id, id)).for('update');
      if (!locked || locked.status !== 'lobby') {
        throw new HttpError(409, 'already_started', 'Partie déjà lancée, réessayez');
      }
      const players = await tx.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
      if (players.some((p) => p.userId === user.id)) {
        throw new HttpError(409, 'already_joined', 'Vous êtes déjà inscrit');
      }
      if (players.some((p) => p.nationId === nationId)) {
        throw new HttpError(409, 'nation_taken', 'Nation déjà prise');
      }
      if (players.length >= locked.maxPlayers) throw new HttpError(409, 'game_full', 'Partie complète');
      const slot = Math.max(-1, ...players.map((p) => p.slot)) + 1;
      await tx.insert(gamePlayers).values({ gameId: id, slot, userId: user.id, nationId });
      return players.length + 1;
    });
    // Démarrage automatique quand la partie est pleine.
    if (count >= row.maxPlayers) {
      try {
        return { game: await host.startLobbyGame(id, scenario) };
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'already_started')) throw err;
      }
    }
    const [fresh] = await db.select().from(games).where(eq(games.id, id));
    return { game: host.games.get(id)?.meta ?? metaOf(fresh!, count) };
  });

  app.post('/api/lobby/:id/leave', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    if (!row || row.mode !== 'multi') throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (row.status !== 'lobby') {
      await host.leaveRunning(id, user.id);
      return { ok: true };
    }
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(games).where(eq(games.id, id)).for('update');
      if (!locked || locked.status !== 'lobby') {
        throw new HttpError(409, 'already_started', 'Partie déjà lancée, réessayez');
      }
      const del = await tx
        .delete(gamePlayers)
        .where(and(eq(gamePlayers.gameId, id), eq(gamePlayers.userId, user.id)))
        .returning();
      if (!del.length) throw new HttpError(404, 'not_found', 'Vous n’êtes pas inscrit');
      const rest = await tx
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, id))
        .orderBy(asc(gamePlayers.slot));
      if (rest.length === 0) await tx.delete(games).where(eq(games.id, id));
      else if (locked.createdBy === user.id) {
        await tx.update(games).set({ createdBy: rest[0]!.userId }).where(eq(games.id, id));
      }
    });
    return { ok: true };
  });

  app.post('/api/lobby/:id/start', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const id = gameIdParam(req);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    if (!row || row.mode !== 'multi') throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (row.createdBy !== user.id && !hasRole(user.role, 'moderator')) {
      throw new HttpError(403, 'forbidden', 'Seul le créateur peut lancer la partie');
    }
    const scenario = scenarioOf(row.scenarioId);
    if (!scenario) throw new HttpError(409, 'unknown_scenario', 'Scénario indisponible');
    return { game: await host.startLobbyGame(id, scenario) };
  });

  // ─────────── Fiches nations (écran de sélection) ───────────

  const infoCache = new Map<string, NationInfo[]>();
  app.get('/api/nations/info', async (req) => {
    const q = req.query as { set?: string; scenario?: string };
    const cur = store.current();
    if (!cur.map) throw unavailable('data_unavailable', 'Carte indisponible');
    const set =
      (typeof q.set === 'string' && q.set) ||
      (typeof q.scenario === 'string' && cur.scenarios.find((s) => s.id === q.scenario)?.orbatSet) ||
      '2025';
    const key = `${cur.rev}|${set}`;
    let nations = infoCache.get(key);
    if (!nations) {
      const orbats = new Map((cur.orbats[set] ?? []).map((o) => [o.nationId, o]));
      const costs = new Map(ctx.data.repoCatalog.map((s) => [s.id, s.cost.money]));
      const provinceCount = new Map<string, number>();
      for (const p of cur.map.provinces) {
        provinceCount.set(p.nationId, (provinceCount.get(p.nationId) ?? 0) + 1);
      }
      nations = cur.map.nations.map((n) => {
        const o = orbats.get(n.id);
        return {
          id: n.id,
          name: n.name,
          description: o?.description ?? '',
          doctrine: o?.doctrine ?? 'other',
          doctrineText: o?.doctrineText ?? '',
          defenseBudgetUsd: o?.defenseBudgetUsd ?? 0,
          activePersonnel: o?.activePersonnel ?? null,
          provinceCount: provinceCount.get(n.id) ?? 0,
          highlights: o ? highlights(o.inventory, (id) => costs.get(id) ?? 0) : [],
        };
      });
      infoCache.clear();
      infoCache.set(key, nations);
    }
    return { nations };
  });
}
