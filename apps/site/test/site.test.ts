import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { minifyCss } from '../src/assets.js';
import { buildSite } from '../src/build.js';
import { deepMerge, loadContent } from '../src/content.js';
import { inline, markdown } from '../src/markdown.js';
import { greatCircle } from '../src/heromap.js';
import { dotsPath } from '../src/world.js';

describe('markdown', () => {
  it('échappe tout HTML et ne garde que les liens sûrs', () => {
    expect(inline('<script>alert(1)</script> **gras**')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; <strong>gras</strong>',
    );
    expect(inline('[x](javascript:alert)')).toBe('x');
    expect(inline('[CNIL](https://www.cnil.fr)')).toContain('rel="noopener"');
    expect(
      inline('[CGV](page:legal:cgv)', (h) => (h === 'page:legal:cgv' ? '/fr/cgv/' : null)),
    ).toBe('<a href="/fr/cgv/">CGV</a>');
  });

  it('titres avec ancres, listes, tableaux, citations ; commentaires retirés ; jetons intacts', () => {
    const r = markdown(
      '<!-- note interne -->\n## Éditeur\n\n- SIREN : {{legal.siren}}\n\n1. un\n2. deux\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> attention',
    );
    expect(r.html).not.toContain('note interne');
    expect(r.html).toContain('<h2 id="editeur">Éditeur</h2>');
    expect(r.html).toContain('<li>SIREN : {{legal.siren}}</li>');
    expect(r.html).toContain('<ol><li>un</li><li>deux</li></ol>');
    expect(r.html).toContain('<th scope="col">A</th>');
    expect(r.html).toContain('<blockquote><p>attention</p></blockquote>');
    expect(r.toc).toEqual([{ id: 'editeur', text: 'Éditeur' }]);
  });
});

describe('outils', () => {
  it('minification CSS sans toucher aux chaînes', () => {
    expect(minifyCss("a > b {\n  content: '> ';\n  margin: 0 ;\n}\n/* c */")).toBe(
      "a>b{content:'> ';margin:0}",
    );
    expect(minifyCss('@media (min-width: 640px) { .a { width: calc(1px + 2px); } }')).toBe(
      '@media (min-width:640px){.a{width:calc(1px + 2px)}}',
    );
  });

  it('fusion avec repli et relevé des clés manquantes', () => {
    const missing: string[] = [];
    expect(
      deepMerge({ a: 'en', b: { c: 'en', d: 'en' } }, { b: { c: 'fr' } }, '', missing),
    ).toEqual({ a: 'en', b: { c: 'fr', d: 'en' } });
    expect(missing.sort()).toEqual(['a', 'b.d']);
  });

  it('grand cercle et matrice de points', () => {
    const gc = greatCircle([0, 0], [90, 0], 2);
    expect(gc[1]![0]).toBeCloseTo(45);
    expect(dotsPath([[false, true, true, false, true]])).toBe('M1 0h1M4 0h0');
  });
});

describe('build des pages publiques', () => {
  const out = mkdtempSync(join(tmpdir(), 'redline-site-test-'));
  const r = buildSite({ outDir: out, now: new Date('2026-10-01T12:00:00Z') });
  const pages = Object.entries(r.manifest.pages).map(([path, rel]) => ({
    path,
    html: readFileSync(join(out, rel), 'utf8'),
  }));
  const meta = (html: string, re: RegExp) => re.exec(html)?.[1] ?? null;

  it('construit le français et l’anglais complets', () => {
    expect(r.manifest.languages.map((l) => l.code)).toEqual(['fr', 'en']);
    expect(pages.length).toBe(36);
    expect(r.warnings).toEqual([]);
  });

  it('titres et descriptions uniques, canonique, hreflang réciproques, aucun script exécutable', () => {
    const titles = new Set<string>();
    const descs = new Set<string>();
    for (const p of pages) {
      const title = meta(p.html, /<title>([^<]+)<\/title>/);
      const desc = meta(p.html, /<meta name="description" content="([^"]+)"/);
      expect(title, p.path).toBeTruthy();
      expect(desc!.length, p.path).toBeGreaterThan(50);
      expect(titles.has(title!), `titre en double : ${title}`).toBe(false);
      expect(descs.has(desc!), `description en double : ${p.path}`).toBe(false);
      titles.add(title!);
      descs.add(desc!);
      expect(p.html).toContain(`<link rel="canonical" href="{{origin}}${p.path}">`);
      expect(p.html).toContain('hreflang="x-default"');
      expect(p.html).not.toMatch(/<script(?![^>]*application\/ld\+json)/);
      expect(p.html).toContain('<meta property="og:image" content="{{origin}}/site/og/');
      expect(p.html.match(/<h1[ >]/g)?.length, p.path).toBe(1);
      // Chaque version linguistique pointe vers les autres, qui pointent vers elle.
      for (const m of p.html.matchAll(/hreflang="([a-z-]+)" href="\{\{origin\}\}([^"]+)"/g)) {
        const other = pages.find((x) => x.path === m[2]);
        expect(other, `${p.path} → ${m[2]}`).toBeTruthy();
        expect(other!.html).toContain(`href="{{origin}}${p.path}"`);
      }
    }
  });

  it('JSON-LD valide : VideoGame + Organization + WebSite (accueil), FAQPage, fil d’Ariane', () => {
    const ld = (html: string) =>
      [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(
        (m) => JSON.parse(m[1]!) as { '@graph': { '@type': string }[] },
      );
    const types = (path: string) =>
      ld(pages.find((p) => p.path === path)!.html).flatMap((g) =>
        g['@graph'].map((n) => n['@type']),
      );
    expect(types('/fr/')).toEqual(['Organization', 'WebSite', 'VideoGame']);
    expect(types('/en/faq/')).toEqual(['FAQPage', 'BreadcrumbList']);
    expect(types('/fr/arsenal/aviation/')).toEqual(['BreadcrumbList']);
  });

  it('pages légales datées, versionnées, avec les jetons de l’éditeur', () => {
    const mentions = pages.find((p) => p.path === '/fr/mentions-legales/')!.html;
    expect(mentions).toContain('Dernière mise à jour : 1 octobre 2026');
    expect(mentions).toContain('{{legal.siren}}');
    expect(mentions).toContain('{{legal.contactEmail}}');
    const cgvEn = pages.find((p) => p.path === '/en/terms-of-sale/')!.html;
    expect(cgvEn).toContain('Last updated: October 1, 2026');
    expect(cgvEn).toContain('only the French version');
    expect(cgvEn).not.toContain('Note pour Amine');
  });

  it('arsenal : chaque matériel du catalogue figure sur une page de famille', () => {
    const fam = pages.filter((p) => /^\/fr\/arsenal\/.+/.test(p.path)).map((p) => p.html);
    expect(fam.length).toBe(6);
    const items = fam.reduce((n, h) => n + (h.match(/<li class="item">/g)?.length ?? 0), 0);
    expect(items).toBeGreaterThan(350);
    expect(fam.join('')).toContain('Rafale');
  });

  it('sitemap (avec hreflang) et robots', () => {
    const sm = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    expect(sm.match(/<url>/g)?.length).toBe(pages.length + 1);
    expect(sm).toContain('<loc>{{origin}}/</loc>');
    expect(sm).toContain('hreflang="en" href="{{origin}}/en/how-to-play/"');
    const robots = readFileSync(join(out, 'robots.txt'), 'utf8');
    expect(robots).toContain('Sitemap: {{origin}}/sitemap.xml');
    expect(robots).toContain('Disallow: /api/');
  });

  it('en-tête SEO du jeu et liens du client cohérents avec les slugs', () => {
    expect(readFileSync(join(out, 'spa-head.fr.html'), 'utf8')).toContain('"@type":"VideoGame"');
    const set = loadContent();
    for (const lc of set.langs) {
      expect(lc.site.slugs.legal.cgu).toBeTruthy();
      expect(r.manifest.pages[`/${lc.lang.code}/${lc.site.slugs.howto}/`]).toBeTruthy();
    }
  });
});
