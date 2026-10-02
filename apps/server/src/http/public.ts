import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

  // Données effectives (dépôt + modifications du back-office), mises en cache par révision et par
  // version de carte. `?map=<version>` : carte d'une partie créée avant un changement d'identifiants de
  // province (data/map/archive/<version>), sinon la carte courante.
  const mapVersionOf = async (req: FastifyRequest): Promise<number> => {
    const raw = (req.query as { map?: string }).map;
    if (raw === undefined || raw === '') return ctx.store.mapVersion;
    const v = Number(raw);
    if (!Number.isInteger(v) || !ctx.store.hasMap(v))
      throw new HttpError(404, 'unknown_map', 'Version de carte inconnue');
    await ctx.store.ensureMap(v);
    return v;
  };
  const requireMap = async (req: FastifyRequest) => {
    const version = await mapVersionOf(req);
    const cur = ctx.store.current();
    if (!cur.map) throw unavailable('data_unavailable', data.mapError ?? 'Carte indisponible');
    const eff = version === cur.mapVersion ? cur : ctx.store.effective(cur.rev, version);
    return { map: eff.map!, key: `${eff.rev}:${version}`, version };
  };
  const cached = (build: (map: NonNullable<typeof data.map>, version: number) => unknown) => {
    const cache = new Map<string, StaticAsset>();
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const { map, key, version } = await requireMap(req);
      let a = cache.get(key);
      if (!a) {
        if (cache.size >= 4) cache.clear();
        a = asset(Buffer.from(JSON.stringify(build(map, version))));
        cache.set(key, a);
      }
      return sendAsset(req, reply, a, 'application/json; charset=utf-8');
    };
  };

  app.get(
    '/api/map/nations',
    cached((map, version) => ({ nations: map.nations, mapVersion: version })),
  );
  app.get(
    '/api/map/provinces',
    cached((map) => ({ provinces: map.provinces })),
  );

  app.get('/api/map/provinces.geojson', async (req, reply) => {
    const version = await mapVersionOf(req);
    const geo =
      version === ctx.store.mapVersion
        ? data.provincesGeojson
        : (ctx.store.archived(version)?.provincesGeojson ?? null);
    if (!geo) {
      throw unavailable(
        'data_unavailable',
        'Géométrie des provinces indisponible (data/map/provinces.geojson)',
      );
    }
    return sendAsset(req, reply, geo, 'application/geo+json; charset=utf-8');
  });

  // Réseau de routes des unités terrestres (couche « routes », aperçu des trajets, accrochage).
  const routes = cached((map) => {
    if (!map.routes)
      throw unavailable('data_unavailable', 'Réseau de routes indisponible (data/map/routes.json)');
    return map.routes;
  });
  app.get('/api/map/routes', routes);

  // Noms localisés des provinces et de leurs villes d'une carte archivée (la carte courante est
  // embarquée dans le client) : { provinces: {id: nom}, cities: {id: ville} }.
  const namesCache = new Map<string, StaticAsset>();
  app.get('/api/map/names/:lang', async (req, reply) => {
    const version = await mapVersionOf(req);
    const lang = (req.params as { lang: string }).lang;
    if (!/^[a-z]{2}$/.test(lang)) throw new HttpError(404, 'not_found', 'Langue inconnue');
    const dir =
      version === ctx.store.mapVersion
        ? join(data.dataDir, 'map', 'names')
        : ctx.store.archived(version)!.namesDir;
    const k = `${version}:${lang}`;
    let a = namesCache.get(k);
    if (!a) {
      const file = join(dir, `${lang}.json`);
      const all = existsSync(file)
        ? (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>)
        : {};
      a = asset(
        Buffer.from(JSON.stringify({ provinces: all.provinces ?? {}, cities: all.cities ?? {} })),
      );
      namesCache.set(k, a);
    }
    return sendAsset(req, reply, a, 'application/json; charset=utf-8');
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

  // Suppression définitive d'une partie solo par son créateur (libère aussi le quota).
  app.delete('/api/games/:id', async (req, reply) => {
    const { user } = await requireUser(req, reply);
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) throw new HttpError(404, 'not_found', 'Partie introuvable');
    const r = await host.deleteSoloGame(id.data, user.id);
    if (r === 'not_found') throw new HttpError(404, 'not_found', 'Partie introuvable');
    if (r === 'not_allowed') {
      throw new HttpError(403, 'not_allowed', 'Seules vos parties solo peuvent être supprimées');
    }
    if (r === 'busy') {
      throw new HttpError(409, 'game_busy', 'Partie en cours sur un autre serveur : réessayez');
    }
    return { ok: true };
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
