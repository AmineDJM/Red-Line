import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { publicOrigin } from './origin.js';
import type { SitePages } from './site.js';

/** Chemin relatif sûr (pas de remontée, pas de fichier caché). */
function safeRel(rel: string | undefined): string | null {
  if (!rel) return null;
  const n = normalize(rel).replace(/^[/\\]+/, '');
  if (n.startsWith('..') || n.split(sep).some((p) => p.startsWith('.'))) return null;
  return n;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const API_PREFIXES = ['/api/', '/ws', '/admin/api/', '/tiles/', '/basemap/', '/glyphs/'];

function missingDistPage(what: string, dir: string): string {
  return `Red Line — ${what} non construit.\n\nDossier attendu : ${dir}\nLancez « pnpm build » (ou le serveur Vite en développement).\n`;
}

export async function staticRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  site?: SitePages,
): Promise<void> {
  const { config } = ctx;
  // Décore reply.sendFile (Range, ETag, Last-Modified, If-None-Match gérés par @fastify/send).
  // preCompressed : fichiers .br/.gz produits au build (scripts/precompress.mjs), choisis selon
  // Accept-Encoding ; repli sur le fichier d'origine s'ils n'existent pas (tuiles, photos).
  await app.register(fastifyStatic, { root: config.dataDir, serve: false, preCompressed: true });

  const serveFrom =
    (dirs: () => string[], maxAge: string) => (req: FastifyRequest, reply: FastifyReply) => {
      const rel = safeRel((req.params as Record<string, string>)['*']);
      const dir = rel ? dirs().find((d) => isFile(join(d, rel))) : undefined;
      if (!rel || !dir)
        return reply.code(404).send({ error: 'not_found', message: 'Fichier introuvable' });
      return reply.sendFile(rel, dir, {
        acceptRanges: true,
        cacheControl: true,
        maxAge,
        etag: true,
        lastModified: true,
        dotfiles: 'deny',
      });
    };

  // Tuiles PMTiles : TILES_DIR puis repli DATA_DIR/tiles (disque Render vide au premier déploiement).
  app.get(
    '/tiles/*',
    serveFrom(() => [config.tilesDir, config.tilesFallbackDir], '7d'),
  );
  app.get(
    '/basemap/*',
    serveFrom(() => [join(config.dataDir, 'basemap')], '1d'),
  );
  app.get(
    '/glyphs/*',
    serveFrom(() => [join(config.dataDir, 'glyphs')], '30d'),
  );

  /** Application monopage : fichier s'il existe, sinon index.html. */
  const spa = (
    dist: string,
    rel: string,
    reply: FastifyReply,
    label: string,
    req?: FastifyRequest,
  ) => {
    if (!existsSync(join(dist, 'index.html'))) {
      return reply.type('text/plain; charset=utf-8').send(missingDistPage(label, dist));
    }
    const clean = safeRel(rel);
    if (clean && isFile(join(dist, clean))) {
      const hashed = clean.startsWith('assets/');
      // Photos et drapeaux : noms stables, contenu rarement modifié (revalidation par ETag après 1 j).
      const media = /^(art|flags)\//.test(clean);
      return reply.sendFile(clean, dist, {
        cacheControl: true,
        maxAge: hashed ? '365d' : media ? '1d' : 0,
        immutable: hashed,
        dotfiles: 'deny',
      });
    }
    // Jeu : index.html complété par l'en-tête SEO des pages publiques (canonique, partage, JSON-LD).
    const page =
      req && site && dist === config.clientDist
        ? site.spaIndex(join(dist, 'index.html'), publicOrigin(config, req))
        : null;
    if (req && site && page) {
      return site.send(req, reply, page, { type: 'text/html; charset=utf-8', cache: 'no-cache' });
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html', dist, { cacheControl: false });
  };

  app.get('/admin', (_req, reply) => spa(config.adminDist, '', reply, 'Back-office'));
  app.get('/admin/*', (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    if (rel.startsWith('api/') || rel === 'api') {
      return reply.code(404).send({ error: 'not_found', message: 'Route inconnue' });
    }
    return spa(config.adminDist, rel, reply, 'Back-office');
  });

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '/';
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !API_PREFIXES.some((p) => url.startsWith(p))
    ) {
      let path: string;
      try {
        path = decodeURIComponent(url);
      } catch {
        return reply.code(400).send({ error: 'bad_request', message: 'Adresse invalide' });
      }
      return spa(config.clientDist, path.replace(/^\/+/, ''), reply, 'Client', req);
    }
    return reply.code(404).send({ error: 'not_found', message: 'Route inconnue' });
  });
}
