/**
 * Build des pages publiques prérendues (pnpm --filter @redline/site build) → apps/site/dist :
 *   pages/<langue>/…/index.html  pages HTML complètes (jetons {{origin}} et {{legal.*}} remplacés à l'envoi)
 *   site/…                       polices, carte, images (noms à empreinte, cache d'un an)
 *   spa-head.<langue>.html       balises SEO injectées dans index.html du jeu (route /)
 *   sitemap.xml, robots.txt      avec hreflang
 *   manifest.json                table des routes lue par apps/server (src/http/site.ts)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildAssets } from './assets.js';
import { FAMILY_IDS, LEGAL_DOCS, loadContent, type ContentSet } from './content.js';
import { loadGameData, type GameData } from './data.js';
import { DIST_DIR } from './paths.js';
import { Renderer } from './render.js';
import { Routes, exists, pathIn } from './routes.js';
import { robots, sitemap } from './seo.js';

export interface SiteManifest {
  version: 1;
  builtAt: string;
  defaultLang: string;
  languages: { code: string; hreflang: string; dir: 'ltr' | 'rtl' }[];
  /** Chemin public (avec / final) → fichier relatif à dist. */
  pages: Record<string, string>;
  /** Page 404 par langue. */
  notFound: Record<string, string>;
  /** Fragment <head> du jeu par langue. */
  spaHead: Record<string, string>;
}

export interface BuildResult {
  manifest: SiteManifest;
  files: number;
  warnings: string[];
}

export function buildSite(
  o: { outDir?: string; set?: ContentSet; data?: GameData; now?: Date } = {},
): BuildResult {
  const outDir = o.outDir ?? DIST_DIR;
  const set = o.set ?? loadContent();
  const data = o.data ?? loadGameData();
  const now = o.now ?? new Date();
  const routes = new Routes(set);
  const warnings: string[] = [];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const assets = buildAssets(
    outDir,
    set.langs.map((l) => l.lang.code),
  );

  const manifest: SiteManifest = {
    version: 1,
    builtAt: now.toISOString(),
    defaultLang: set.defaultLang,
    languages: set.langs.map((l) => ({
      code: l.lang.code,
      hreflang: l.lang.hreflang,
      dir: l.lang.dir,
    })),
    pages: {},
    notFound: {},
    spaHead: {},
  };
  let files = 0;
  const write = (rel: string, body: string) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    files++;
  };
  const page = (path: string, html: string) => {
    // Slug en double dans une langue : deux pages se recouvriraient.
    if (manifest.pages[path]) throw new Error(`Adresse en double : ${path}`);
    const rel = `pages${path}index.html`;
    write(rel, html);
    manifest.pages[path] = rel;
  };

  for (const lc of set.langs) {
    if (lc.missing.length) {
      warnings.push(
        `${lc.lang.code} : ${lc.missing.length} texte(s) repris d'une autre langue (${lc.missing.slice(0, 5).join(', ')}${lc.missing.length > 5 ? '…' : ''})`,
      );
    }
    const r = new Renderer({ set, lc, routes, data, assets, year: now.getUTCFullYear() });
    page(pathIn(lc, 'home'), r.home());
    page(pathIn(lc, 'howto'), r.howto());
    page(pathIn(lc, 'features'), r.features());
    page(pathIn(lc, 'nations'), r.nations());
    page(pathIn(lc, 'arsenal'), r.arsenal());
    for (const f of FAMILY_IDS) page(pathIn(lc, `family:${f}`), r.family(f));
    page(pathIn(lc, 'faq'), r.faq());
    for (const d of LEGAL_DOCS) {
      if (exists(lc, `legal:${d}`)) page(pathIn(lc, `legal:${d}`), r.legal(d));
      else
        warnings.push(
          `${lc.lang.code} : document légal « ${d} » absent (lien vers une autre langue)`,
        );
    }
    const nf = `pages/${lc.lang.code}/404.html`;
    write(nf, r.notFound());
    manifest.notFound[lc.lang.code] = nf;
    const head = `spa-head.${lc.lang.code}.html`;
    write(head, r.spaHead());
    manifest.spaHead[lc.lang.code] = head;
  }

  write('sitemap.xml', sitemap(routes, now.toISOString().slice(0, 10)));
  write('robots.txt', robots());
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files, warnings };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const t0 = performance.now();
  const r = buildSite();
  for (const w of r.warnings) console.warn(`avertissement : ${w}`);
  console.log(
    `site : ${Object.keys(r.manifest.pages).length} pages (${r.manifest.languages
      .map((l) => l.code)
      .join(', ')}), ${r.files} fichiers en ${Math.round(performance.now() - t0)} ms → ${DIST_DIR}`,
  );
}
