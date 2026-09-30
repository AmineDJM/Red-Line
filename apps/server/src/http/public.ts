import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateGameBodySchema, type MyGame } from '@redline/shared';
import type { AppContext } from '../context.js';
import { gamePlayers, games, weaponSystems } from '../db/schema.js';
import { HttpError, checkRole } from '../auth/auth.js';
import { asset, scenarioSummary, type StaticAsset } from '../data/loader.js';
import { metaOf } from '../host/game-host.js';
import { parseBody, unavailable } from './util.js';
import { assertCreationQuota } from './access.js';

/** Réponse JSON pré-calculée, avec ETag, compression gzip et cache. */
export function sendAsset(req: FastifyRequest, reply: FastifyReply, a: StaticAsset, type: string) {
  reply.header('ETag', a.etag);
  reply.header('Cache-Control', 'public, max-age=300, must-revalidate');
  reply.header('Vary', 'Accept-Encoding');
  reply.type(type);
  if (req.headers['if-none-match'] === a.etag) return reply.code(304).send();
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    reply.header('Content-Encoding', 'gzip');
    return reply.send(a.gzip);
  }
  return reply.send(a.body);
}

/** Choix du fichier d'imagerie : satellite.pmtiles (zoom 8) sinon satellite-lowzoom.pmtiles (zoom 5). */
export function tilesInfo(ctx: AppContext): { satellite: string; maxzoom: number } | null {
  const dirs = [ctx.config.tilesDir, ctx.config.tilesFallbackDir];
  for (const [file, maxzoom] of [
    ['satellite.pmtiles', 8],
    ['satellite-lowzoom.pmtiles', 5],
  ] as const) {
    if (dirs.some((d) => existsSync(join(d, file))))
      return { satellite: `/tiles/${file}`, maxzoom };
  }
  return null;
}

/** Création de partie : coûteuse (monde complet, ~200 IA), limitée par IP. */
export const createLimit = (ctx: AppContext) => ({
  rateLimit: { max: ctx.options.createRateLimitPerMin, timeWindow: '1 minute' },
});

export async function publicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, data, auth, host, worlds } = ctx;

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) =>
    checkRole(await auth.authenticate(req, reply), 'player');

  // Catalogue actif (depuis la base : la source de vérité après chargement du dépôt).
  app.get('/api/catalog', async () => {
    const rows = await db
      .select({ data: weaponSystems.data })
      .from(weaponSystems)
      .where(eq(weaponSystems.enabled, true))
      .orderBy(weaponSystems.id);
    return { systems: rows.map((r) => r.data) };
  });

  // Arbre technologique et équilibrage effectifs (lecture publique : aucun secret de partie).
  app.get('/api/research', async () => ({ nodes: ctx.store.current().research }));
  app.get('/api/balance', async () => ({ balance: ctx.store.current().balance }));

  // Données effectives (dépôt + modifications du back-office), mises en cache par révision.
  const requireMap = () => {
    const cur = ctx.store.current();
    if (!cur.map) throw unavailable('data_unavailable', data.mapError ?? 'Carte indisponible');
    return { map: cur.map, rev: cur.rev };
  };

  let nationsAsset: { rev: number; a: StaticAsset } | null = null;
  let provincesAsset: { rev: number; a: StaticAsset } | null = null;

  app.get('/api/map/nations', async (req, reply) => {
    const { map, rev } = requireMap();
    if (nationsAsset?.rev !== rev) {
      nationsAsset = { rev, a: asset(Buffer.from(JSON.stringify({ nations: map.nations }))) };
    }
    return sendAsset(req, reply, nationsAsset.a, 'application/json; charset=utf-8');
  });

  app.get('/api/map/provinces', async (req, reply) => {
    const { map, rev } = requireMap();
    if (provincesAsset?.rev !== rev) {
      provincesAsset = {
        rev,
        a: asset(Buffer.from(JSON.stringify({ provinces: map.provinces }))),
      };
    }
    return sendAsset(req, reply, provincesAsset.a, 'application/json; charset=utf-8');
  });

  app.get('/api/map/provinces.geojson', async (req, reply) => {
    if (!data.provincesGeojson) {
      throw unavailable(
        'data_unavailable',
        'Géométrie des provinces indisponible (data/map/provinces.geojson)',
      );
    }
    return sendAsset(req, reply, data.provincesGeojson, 'application/geo+json; charset=utf-8');
  });

  app.get('/api/map/tiles', async () => {
    const info = tilesInfo(ctx);
    if (!info) throw unavailable('tiles_unavailable', 'Aucune imagerie satellite disponible');
    return info;
  });

  app.get('/api/scenarios', async () => ({
    scenarios: ctx.store.current().scenarios.map(scenarioSummary),
  }));

  app.post('/api/games', { config: createLimit(ctx) }, async (req, reply) => {
    const auth = await requireUser(req, reply);
    const { user } = auth;
    const body = parseBody(CreateGameBodySchema, req.body);
    await assertCreationQuota(ctx, auth, 'solo');
    const r = worlds.unavailableReason();
    if (r) throw unavailable(r.code, r.message);
    const cur = ctx.store.current();
    const scenario = cur.scenarios.find((s) => s.id === body.scenarioId);
    if (!scenario) throw new HttpError(404, 'unknown_scenario', 'Scénario inconnu');
    if (!cur.nationsById.has(body.nationId)) {
      throw new HttpError(400, 'unknown_nation', 'Nation inconnue');
    }
    const playable =
      (scenario.playableNations === 'all' || scenario.playableNations.includes(body.nationId)) &&
      (!scenario.nationIds || scenario.nationIds.includes(body.nationId));
    if (!playable)
      throw new HttpError(400, 'nation_not_playable', 'Nation non jouable dans ce scénario');
    const speeds = host.allowedSpeeds();
    if (!speeds.includes(body.speed)) {
      throw new HttpError(400, 'invalid_speed', `Vitesses autorisées : ${speeds.join(', ')}`);
    }
    const { meta } = await host.createSoloGame(user.id, body, scenario);
    reply.code(201);
    return { game: meta };
  });

  app.get('/api/games', async (req, reply) => {
    const { user } = await requireUser(req, reply);
    const rows = await db
      .select({ g: games, nationId: gamePlayers.nationId })
      .from(gamePlayers)
      .innerJoin(games, eq(games.id, gamePlayers.gameId))
      .where(eq(gamePlayers.userId, user.id))
      .orderBy(desc(games.createdAt))
      .limit(200);
    const list: MyGame[] = rows.map((r) => ({
      game: host.games.get(r.g.id)?.meta ?? metaOf(r.g),
      nationId: r.nationId,
      createdAt: r.g.createdAt.toISOString(),
    }));
    return { games: list };
  });

  app.get('/api/games/:id', async (req, reply) => {
    const { user } = await requireUser(req, reply);
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Partie introuvable');
    const [r] = await db
      .select({ g: games, nationId: gamePlayers.nationId })
      .from(gamePlayers)
      .innerJoin(games, eq(games.id, gamePlayers.gameId))
      .where(and(eq(gamePlayers.gameId, id.data), eq(gamePlayers.userId, user.id)))
      .limit(1);
    if (!r) throw new HttpError(404, 'not_found', 'Partie introuvable');
    return { game: host.games.get(r.g.id)?.meta ?? metaOf(r.g), me: r.nationId };
  });
}
