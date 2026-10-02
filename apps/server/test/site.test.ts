import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import { api, dbAvailable, login, makeDataDir, register, resetDb, startApp } from './helpers.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

/** Mini-build des pages publiques (même format que apps/site/dist). */
function siteDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-site-'));
  const w = (rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const page = (title: string) =>
    `<!doctype html><html lang="fr"><head><title>${title}</title>` +
    `<link rel="canonical" href="{{origin}}/fr/"></head><body>` +
    `<p id="pub">{{legal.publisherName}} — {{legal.siren}} — {{legal.contactEmail}}</p></body></html>`;
  w('pages/fr/index.html', page('Accueil'));
  w('pages/fr/faq/index.html', page('FAQ'));
  w('pages/en/index.html', page('Home'));
  w('pages/fr/404.html', '<!doctype html><title>Introuvable</title>404 fr');
  w('pages/en/404.html', '<!doctype html><title>Not found</title>404 en');
  w('spa-head.fr.html', '<link rel="canonical" href="{{origin}}/">');
  w('sitemap.xml', '<urlset><url><loc>{{origin}}/fr/</loc></url></urlset>');
  w('robots.txt', 'User-agent: *\nSitemap: {{origin}}/sitemap.xml\n');
  w('site/fonts/jbm.abc123.woff2', 'police');
  w(
    'manifest.json',
    JSON.stringify({
      version: 1,
      builtAt: '2026-10-01T00:00:00Z',
      defaultLang: 'fr',
      languages: [
        { code: 'fr', hreflang: 'fr', dir: 'ltr' },
        { code: 'en', hreflang: 'en', dir: 'ltr' },
      ],
      pages: {
        '/fr/': 'pages/fr/index.html',
        '/fr/faq/': 'pages/fr/faq/index.html',
        '/en/': 'pages/en/index.html',
      },
      notFound: { fr: 'pages/fr/404.html', en: 'pages/en/404.html' },
      spaHead: { fr: 'spa-head.fr.html' },
    }),
  );
  return dir;
}

describe.skipIf(!hasDb)('pages publiques prérendues, sitemap, robots, réglages légaux', () => {
  let built: BuiltApp;
  let admin: string;
  const dataDir = makeDataDir({ dists: true });
  writeFileSync(
    join(dataDir, 'client-dist/index.html'),
    '<!doctype html><html><head><title>Red Line</title><!--rl:head--></head><body></body></html>',
  );

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir,
      env: { ...ADMIN, SITE_DIST: siteDist(), PUBLIC_URL: 'https://redline.example' },
    });
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    built.app.inject({ method: 'GET', url, headers });

  it('sert les pages avec les jetons remplacés (PUBLIC_URL, éditeur) et la CSP stricte', async () => {
    const res = await get('/fr/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(res.body).toContain('<link rel="canonical" href="https://redline.example/fr/">');
    expect(res.body).toContain('Amine Djouamai — 921 737 607 — contact@redline.example');
    expect(res.body).not.toContain('{{');
    expect(String(res.headers['cache-control'])).toContain('max-age=300');
  });

  it('compresse (Brotli), gère ETag / 304, redirige vers la forme à « / » final, 404 par langue', async () => {
    const br = await get('/fr/faq/', { 'accept-encoding': 'gzip, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.rawPayload).toString()).toContain('<title>FAQ</title>');
    const etag = String(br.headers.etag);
    expect((await get('/fr/faq/', { 'if-none-match': etag })).statusCode).toBe(304);

    const r1 = await get('/fr');
    expect([r1.statusCode, r1.headers.location]).toEqual([301, '/fr/']);
    const r2 = await get('/fr/faq?x=1');
    expect([r2.statusCode, r2.headers.location]).toEqual([301, '/fr/faq/?x=1']);
    const nf = await get('/en/nope/');
    expect(nf.statusCode).toBe(404);
    expect(nf.body).toContain('404 en');
    // Les routes du jeu restent à l'application monopage.
    expect((await get('/lobby/abc')).body).toContain('<title>Red Line</title>');
  });

  it('sitemap.xml, robots.txt et ressources à empreinte', async () => {
    const sm = await get('/sitemap.xml');
    expect(sm.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(sm.body).toContain('<loc>https://redline.example/fr/</loc>');
    const rb = await get('/robots.txt');
    expect(rb.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(rb.body).toContain('Sitemap: https://redline.example/sitemap.xml');
    const font = await get('/site/fonts/jbm.abc123.woff2');
    expect(font.statusCode).toBe(200);
    expect(String(font.headers['cache-control'])).toContain('immutable');
    // Aucune remontée hors de dist/site (au pire : page du jeu, jamais le manifeste).
    expect((await get('/site/%2e%2e/manifest.json')).body).not.toContain('"pages"');
    expect((await get('/site/absent.css')).statusCode).toBe(404);
  });

  it('index.html du jeu reçoit l’en-tête SEO (canonique absolue)', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://redline.example/">');
    expect(res.body).not.toContain('<!--rl:head-->');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('chiffres publics de l’accueil', async () => {
    const s = (await get('/api/public/stats')).json();
    expect(s).toMatchObject({
      nations: 3,
      gamesRunning: expect.any(Number),
      playersOnline: expect.any(Number),
    });
  });

  it('Réglages › Légal : lecture modérateur, écriture super-admin journalisée, pages mises à jour', async () => {
    const anon = api(built.app, null);
    expect((await anon('GET', '/admin/api/settings/legal')).statusCode).toBe(401);
    const player = await register(built.app, 'joueur-legal@redline.test');
    expect(
      (await api(built.app, player.cookie)('GET', '/admin/api/settings/legal')).statusCode,
    ).toBe(403);

    const req = api(built.app, admin);
    const view = (await req('GET', '/admin/api/settings/legal')).json();
    expect(view.settings.siret).toBe('921 737 607 00017');
    expect(view.effective.contactEmail).toBe('contact@redline.example');

    const bad = await req('PUT', '/admin/api/settings/legal', {
      ...view.settings,
      contactEmail: 'pas-un-email',
    });
    expect(bad.statusCode).toBe(400);

    const next = {
      ...view.settings,
      contactEmail: 'legal@redline.example',
      mediatorName: 'Médiateur Exemple',
    };
    const ok = await req('PUT', '/admin/api/settings/legal', next);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().effective.contactEmail).toBe('legal@redline.example');
    expect((await get('/fr/')).body).toContain('legal@redline.example');

    const audit = (await req('GET', '/admin/api/audit')).json().entries;
    expect(audit.map((e: { action: string }) => e.action)).toContain('settings.legal');
  });
});
