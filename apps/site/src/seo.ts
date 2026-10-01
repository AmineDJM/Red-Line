/**
 * Données structurées (JSON-LD), sitemap.xml (avec hreflang) et robots.txt.
 * Toutes les URL absolues commencent par le jeton {{origin}}, remplacé par le serveur (PUBLIC_URL).
 */
import type { ContentSet, LangContent } from './content.js';
import { esc } from './markdown.js';
import type { PageKey, Routes } from './routes.js';
import { PAGE_KEYS, exists, pathIn } from './routes.js';

export const ORIGIN = '{{origin}}';

/** JSON sûr dans un <script> : « < » échappé (pas de fermeture de balise possible). */
export function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function organization() {
  return {
    '@type': 'Organization',
    '@id': `${ORIGIN}/#organization`,
    name: 'Red Line',
    url: `${ORIGIN}/`,
    logo: { '@type': 'ImageObject', url: `${ORIGIN}/icon-512.png`, width: 512, height: 512 },
  };
}

export function website(set: ContentSet) {
  // Pas de SearchAction : le site n'a pas de moteur de recherche interne (balisage trompeur sinon).
  return {
    '@type': 'WebSite',
    '@id': `${ORIGIN}/#website`,
    name: 'Red Line',
    url: `${ORIGIN}/`,
    inLanguage: set.langs.map((l) => l.lang.hreflang),
    publisher: { '@id': `${ORIGIN}/#organization` },
  };
}

export function videoGame(
  set: ContentSet,
  lc: LangContent,
  o: { description: string; image?: string; screenshot?: string; maxPlayers: number },
) {
  return {
    '@type': 'VideoGame',
    '@id': `${ORIGIN}/#game`,
    name: 'Red Line',
    url: `${ORIGIN}/`,
    description: o.description,
    ...(o.image ? { image: `${ORIGIN}${o.image}` } : {}),
    ...(o.screenshot ? { screenshot: `${ORIGIN}${o.screenshot}` } : {}),
    genre: ['Strategy', 'Real-time strategy', 'Grand strategy', 'Wargame'],
    gamePlatform: ['Web browser', 'PC', 'Mac', 'Android', 'iOS'],
    applicationCategory: 'Game',
    operatingSystem: 'Windows, macOS, Linux, ChromeOS, Android, iOS',
    playMode: ['SinglePlayer', 'MultiPlayer'],
    numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: o.maxPlayers },
    inLanguage: set.langs.map((l) => l.lang.hreflang),
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'EUR',
      availability: 'https://schema.org/InStock',
      url: `${ORIGIN}/`,
    },
    publisher: { '@id': `${ORIGIN}/#organization` },
    mainEntityOfPage: `${ORIGIN}${pathIn(lc, 'home')}`,
  };
}

export function breadcrumb(items: { name: string; path: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: `${ORIGIN}${it.path}`,
    })),
  };
}

export function faqPage(items: { q: string; a: string }[], path: string, lang: string) {
  return {
    '@type': 'FAQPage',
    url: `${ORIGIN}${path}`,
    inLanguage: lang,
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  };
}

export function graph(...nodes: unknown[]): string {
  return jsonLd({ '@context': 'https://schema.org', '@graph': nodes });
}

/** sitemap.xml : une entrée par page et par langue, avec toutes ses versions (xhtml:link). */
export function sitemap(routes: Routes, lastmod: string): string {
  const set = routes.set;
  const urls: string[] = [];
  const entry = (loc: string, alts: { hreflang: string; path: string }[], prio: string) =>
    `<url><loc>${ORIGIN}${esc(loc)}</loc><lastmod>${lastmod}</lastmod><priority>${prio}</priority>` +
    alts
      .map(
        (a) =>
          `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${ORIGIN}${esc(a.path)}"/>`,
      )
      .join('') +
    '</url>';
  urls.push(entry('/', [], '1.0'));
  for (const key of PAGE_KEYS) {
    const alts = routes.alternates(key);
    const prio = priority(key);
    for (const lc of set.langs) {
      if (!exists(lc, key)) continue;
      urls.push(entry(pathIn(lc, key), alts.length > 1 ? alts : [], prio));
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls.join('\n') +
    '\n</urlset>\n'
  );
}

function priority(key: PageKey): string {
  if (key === 'home') return '0.9';
  if (key.startsWith('legal:')) return '0.2';
  if (key.startsWith('family:')) return '0.6';
  return '0.8';
}

/** robots.txt : tout est indexable sauf l'API, le back-office et les écrans privés du jeu. */
export function robots(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /ws',
    'Disallow: /game/',
    'Disallow: /spectate/',
    'Disallow: /lobby/',
    'Disallow: /games',
    'Disallow: /new',
    'Disallow: /shop',
    // Documents légaux dans l'application : doublons des pages publiques /<langue>/….
    'Disallow: /legal/',
    'Disallow: /*?*mock=',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}
