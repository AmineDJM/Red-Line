/**
 * Pages publiques prérendues (apps/site/dist, produit par « pnpm --filter @redline/site build ») :
 *   /<langue>/…        pages HTML (accueil, guide, fonctionnalités, nations, arsenal, FAQ, légal)
 *   /site/…            polices, images, carte (noms à empreinte : cache d'un an, immuable)
 *   /sitemap.xml       avec hreflang ; /robots.txt
 *   /api/public/stats  chiffres de l'accueil du jeu (parties en cours, joueurs en ligne)
 * et l'en-tête SEO de index.html du jeu (commentaire <!--rl:head-->).
 *
 * Les fichiers contiennent des jetons {{origin}} (PUBLIC_URL) et {{legal.*}} (réglages du back-office) :
 * remplacés à l'envoi, résultat compressé (Brotli, gzip) et gardé en mémoire par origine et révision des
 * réglages. Aucun script : la CSP stricte (script-src 'self') s'applique telle quelle.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicStats } from '@redline/shared';
import type { AppContext } from '../context.js';
import { games, weaponSystems } from '../db/schema.js';
import { fillTokens, type LegalSettingsService } from '../legal/settings.js';
import { publicOrigin } from './origin.js';

interface Manifest {
  version: number;
  defaultLang: string;
  languages: { code: string; hreflang: string; dir: string }[];
  pages: Record<string, string>;
  notFound: Record<string, string>;
  spaHead: Record<string, string>;
}

interface Rendered {
  body: Buffer;
  br: Buffer;
  gz: Buffer;
  etag: string;
}

const HEAD_MARK = '<!--rl:head-->';
const MAX_CACHE = 600;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class SitePages {
  readonly manifest: Manifest | null;
  private readonly templates = new Map<string, string>();
  private readonly cache = new Map<string, Rendered>();

  constructor(
    readonly dir: string,
    private readonly legal: LegalSettingsService,
    log: FastifyBaseLogger,
  ) {
    const p = join(dir, 'manifest.json');
    let m: Manifest | null = null;
    if (existsSync(p)) {
      try {
        m = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
      } catch (err) {
        log.warn({ err }, 'manifeste du site illisible : pages publiques désactivées');
      }
    } else log.warn(`pages publiques non construites (${p}) : lancez « pnpm build »`);
    this.manifest = m;
  }

  get languages(): string[] {
    return this.manifest?.languages.map((l) => l.code) ?? [];
  }

  private template(rel: string): string | null {
    let t = this.templates.get(rel);
    if (t === undefined) {
      const p = join(this.dir, rel);
      if (!existsSync(p)) return null;
      t = readFileSync(p, 'utf8');
      this.templates.set(rel, t);
    }
    return t;
  }

  tokens(origin: string): Record<string, string> {
    return { origin, ...this.legal.tokens(origin) };
  }

  /** Texte final (jetons remplacés, valeurs échappées pour HTML/XML). */
  fill(text: string, origin: string): string {
    return fillTokens(text, this.tokens(origin), escapeHtml);
  }

  private rendered(key: string, make: () => string): Rendered {
    const k = `${key}|${this.legal.rev}`;
    let r = this.cache.get(k);
    if (!r) {
      const body = Buffer.from(make());
      r = {
        body,
        br: brotliCompressSync(body, {
          params: {
            [zc.BROTLI_PARAM_QUALITY]: 9,
            [zc.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        }),
        gz: gzipSync(body, { level: 9 }),
        etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
      };
      if (this.cache.size >= MAX_CACHE) this.cache.clear();
      this.cache.set(k, r);
    }
    return r;
  }

  send(
    req: FastifyRequest,
    reply: FastifyReply,
    r: Rendered,
    o: { type: string; cache: string; status?: number },
  ) {
    reply.code(o.status ?? 200);
    reply.type(o.type);
    reply.header('Cache-Control', o.cache);
    reply.header('Vary', 'Accept-Encoding');
    reply.header('ETag', r.etag);
    if ((o.status ?? 200) === 200 && req.headers['if-none-match'] === r.etag) {
      return reply.code(304).send();
    }
    const ae = String(req.headers['accept-encoding'] ?? '');
    if (/\bbr\b/.test(ae)) {
      reply.header('Content-Encoding', 'br');
      return reply.send(r.br);
    }
    if (/\bgzip\b/.test(ae)) {
      reply.header('Content-Encoding', 'gzip');
      return reply.send(r.gz);
    }
    return reply.send(r.body);
  }

  /** Fichier du site avec jetons (page, sitemap, robots) ; null s'il n'existe pas. */
  file(rel: string, origin: string): Rendered | null {
    const t = this.template(rel);
    if (t === null) return null;
    return this.rendered(`${rel}|${origin}`, () => this.fill(t, origin));
  }

  /** index.html du jeu avec l'en-tête SEO de la langue par défaut. */
  spaIndex(indexPath: string, origin: string): Rendered | null {
    let mtime = 0;
    try {
      mtime = statSync(indexPath).mtimeMs;
    } catch {
      return null;
    }
    return this.rendered(`spa|${indexPath}|${mtime}|${origin}`, () => {
      const html = readFileSync(indexPath, 'utf8');
      const rel = this.manifest?.spaHead[this.manifest.defaultLang];
      const head = rel ? (this.template(rel) ?? '') : '';
      return html.replace(HEAD_MARK, this.fill(head, origin));
    });
  }

  /** Chemin d'une page du manifeste, avec redirection éventuelle vers la forme à « / » final. */
  resolve(path: string): { file: string } | { redirect: string } | null {
    const pages = this.manifest?.pages ?? {};
    if (pages[path]) return { file: pages[path] };
    if (!path.endsWith('/') && pages[`${path}/`]) return { redirect: `${path}/` };
    return null;
  }
}

const HTML = 'text/html; charset=utf-8';
const PAGE_CACHE = 'public, max-age=300, must-revalidate';

export async function siteRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  site: SitePages,
): Promise<void> {
  const origin = (req: FastifyRequest) => publicOrigin(ctx.config, req);

  app.get('/robots.txt', (req, reply) => {
    const r = site.file('robots.txt', origin(req));
    if (!r) return reply.code(404).type('text/plain').send('Not found\n');
    return site.send(req, reply, r, {
      type: 'text/plain; charset=utf-8',
      cache: 'public, max-age=3600',
    });
  });

  app.get('/sitemap.xml', (req, reply) => {
    const r = site.file('sitemap.xml', origin(req));
    if (!r) return reply.code(404).type('text/plain').send('Not found\n');
    return site.send(req, reply, r, {
      type: 'application/xml; charset=utf-8',
      cache: 'public, max-age=3600',
    });
  });

  // Ressources à empreinte : polices, carte, images.
  app.get('/site/*', (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    if (!/^[\w./-]+$/.test(rel) || rel.split('/').some((p) => p.startsWith('.') || !p)) {
      return reply.code(404).send({ error: 'not_found', message: 'Fichier introuvable' });
    }
    if (!existsSync(join(site.dir, 'site', rel))) {
      return reply.code(404).send({ error: 'not_found', message: 'Fichier introuvable' });
    }
    return reply.sendFile(rel, join(site.dir, 'site'), {
      cacheControl: true,
      maxAge: '365d',
      immutable: true,
      dotfiles: 'deny',
    });
  });

  const notFound = (req: FastifyRequest, reply: FastifyReply, lang: string) => {
    const rel = site.manifest?.notFound[lang] ?? site.manifest?.notFound[site.manifest.defaultLang];
    const r = rel ? site.file(rel, origin(req)) : null;
    if (!r) return reply.code(404).type(HTML).send('<!doctype html><title>404</title>');
    return site.send(req, reply, r, { type: HTML, cache: 'no-cache', status: 404 });
  };

  const page = (req: FastifyRequest, reply: FastifyReply, lang: string) => {
    let path: string;
    try {
      path = decodeURIComponent(req.url.split('?')[0] ?? '/');
    } catch {
      return notFound(req, reply, lang);
    }
    const hit = site.resolve(path);
    if (!hit) return notFound(req, reply, lang);
    if ('redirect' in hit) {
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return reply.redirect(`${hit.redirect}${q}`, 301);
    }
    const r = site.file(hit.file, origin(req));
    if (!r) return notFound(req, reply, lang);
    return site.send(req, reply, r, { type: HTML, cache: PAGE_CACHE });
  };

  for (const lang of site.languages) {
    app.get(`/${lang}`, (req, reply) => reply.redirect(`/${lang}/`, 301));
    app.get(`/${lang}/`, (req, reply) => page(req, reply, lang));
    app.get(`/${lang}/*`, (req, reply) => page(req, reply, lang));
  }

  // Chiffres publics de l'accueil (mis en cache 30 s : aucune donnée personnelle).
  let stats: { at: number; v: PublicStats } | null = null;
  app.get('/api/public/stats', async (_req, reply) => {
    if (!stats || Date.now() - stats.at > 30_000) {
      const cur = ctx.store.current();
      let running = ctx.host.games.size;
      let systems = 0;
      try {
        const [g] = await ctx.db
          .select({ n: count() })
          .from(games)
          .where(eq(games.status, 'running'));
        const [w] = await ctx.db
          .select({ n: count() })
          .from(weaponSystems)
          .where(eq(weaponSystems.enabled, true));
        running = Number(g?.n ?? running);
        systems = Number(w?.n ?? 0);
      } catch {
        /* base indisponible : valeurs locales */
      }
      stats = {
        at: Date.now(),
        v: {
          nations: cur.map?.nations.length ?? 0,
          provinces: cur.map?.provinces.length ?? 0,
          systems,
          gamesRunning: running,
          playersOnline: ctx.host.connectedPlayers(),
        },
      };
    }
    reply.header('Cache-Control', 'public, max-age=30');
    return stats.v;
  });
}
