/**
 * Gabarit HTML et contenu de chaque page publique. Pages statiques sans JavaScript ; jetons {{origin}} et
 * {{legal.*}} remplacés par le serveur à l'envoi (URL publique, mentions légales réglées au back-office).
 */
import {
  FAMILIES,
  FAMILY_IDS,
  LEGAL_DOCS,
  fill,
  type ContentSet,
  type FamilyId,
  type LangContent,
  type LegalDocId,
} from './content.js';
import type { Assets } from './assets.js';
import type { ArsenalEntry, GameData } from './data.js';
import { heroMap } from './heromap.js';
import { esc, inline, markdown, slugify } from './markdown.js';
import { exists, pathIn, type PageKey, type Routes } from './routes.js';
import { ORIGIN, breadcrumb, faqPage, graph, organization, videoGame, website } from './seo.js';

export interface RenderCtx {
  set: ContentSet;
  lc: LangContent;
  routes: Routes;
  data: GameData;
  assets: Assets;
  year: number;
}

interface PageSpec {
  key: PageKey | null;
  title: string;
  description: string;
  body: string;
  crumbs?: { name: string; path: string }[];
  jsonld?: unknown[];
  noindex?: boolean;
  ogType?: 'website' | 'article';
}

/** Capitales animées sur la carte d'accueil et trajectoires (sans traverser l'antiméridien). */
const PINGS = [
  'usa',
  'rus',
  'chn',
  'fra',
  'gbr',
  'ind',
  'bra',
  'irn',
  'jpn',
  'ukr',
  'tur',
  'egy',
  'aus',
  'zaf',
  'kor',
  'isr',
  'pak',
  'nga',
];
const ARCS: [string, string][] = [
  ['usa', 'rus'],
  ['chn', 'jpn'],
  ['fra', 'egy'],
  ['irn', 'isr'],
  ['ind', 'chn'],
  ['gbr', 'ukr'],
];

export class Renderer {
  private readonly nf: Intl.NumberFormat;
  private readonly usd: Intl.NumberFormat;
  private readonly date: Intl.DateTimeFormat;
  private readonly regions: Intl.DisplayNames | null;
  readonly vars: Record<string, string>;

  constructor(private readonly c: RenderCtx) {
    const intl = c.lc.lang.intl;
    this.nf = new Intl.NumberFormat(intl, { maximumFractionDigits: 0 });
    this.usd = new Intl.NumberFormat(intl, {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    });
    this.date = new Intl.DateTimeFormat(intl, { dateStyle: 'long', timeZone: 'UTC' });
    try {
      this.regions = new Intl.DisplayNames([intl], { type: 'region' });
    } catch {
      this.regions = null;
    }
    const d = c.data;
    this.vars = {
      nations: this.int(d.nations.length),
      provinces: this.int(d.provinces),
      systems: this.int(d.systems),
      players: this.int(d.maxPlayers),
      scenarios: this.int(d.scenarios.length),
    };
  }

  private get s() {
    return this.c.lc.site;
  }
  private get code() {
    return this.c.lc.lang.code;
  }
  int(n: number): string {
    return this.nf.format(n);
  }
  money(n: number): string {
    return this.usd.format(n);
  }
  /** Texte de contenu : variables {…}, puis Markdown en ligne échappé. */
  t(s: string, extra: Record<string, string | number> = {}): string {
    return inline(fill(s, { ...this.vars, ...extra }), this.c.routes.resolver(this.c.lc));
  }
  /** Texte brut (balises meta, JSON-LD). */
  plain(s: string, extra: Record<string, string | number> = {}): string {
    return fill(s, { ...this.vars, ...extra })
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1');
  }
  href(key: PageKey): string {
    return this.c.routes.href(this.c.lc, key);
  }
  country(iso2: string): string {
    if (iso2 === 'XX') return this.s.arsenal.labels.generic;
    try {
      return this.regions?.of(iso2) ?? iso2;
    } catch {
      return iso2;
    }
  }
  nationName(n: { name: string; iso2: string | null }): string {
    if (this.code === 'fr' || !n.iso2) return n.name;
    const r = this.country(n.iso2.toUpperCase());
    return r && r !== n.iso2.toUpperCase() ? r : n.name;
  }
  formatDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : this.date.format(d);
  }

  // ——————————————————————————— Gabarit ———————————————————————————

  private header(current: PageKey | null): string {
    const s = this.s;
    const nav: [PageKey, string][] = [
      ['howto', s.ui.nav.howto],
      ['features', s.ui.nav.features],
      ['nations', s.ui.nav.nations],
      ['arsenal', s.ui.nav.arsenal],
      ['faq', s.ui.nav.faq],
    ];
    const isCur = (k: PageKey) =>
      current === k || (k === 'arsenal' && !!current?.startsWith('family:'));
    const link = (k: PageKey, label: string) =>
      `<a href="${this.href(k)}"${isCur(k) ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
    const langs = this.c.set.langs
      .map((l) => {
        const target = current && exists(l, current) ? pathIn(l, current) : pathIn(l, 'home');
        const cur = l.lang.code === this.code;
        return (
          `<li><a href="${target}" hreflang="${l.lang.hreflang}" lang="${l.lang.code}"${cur ? ' aria-current="true"' : ''}>` +
          `${esc(l.lang.name)} <small>${l.lang.code}</small></a></li>`
        );
      })
      .join('');
    return (
      `<header class="top"><div class="wrap top__in">` +
      `<a class="brand" href="${pathIn(this.c.lc, 'home')}">RED<span class="l">LINE</span><span class="vh"> — ${esc(s.ui.nav.home)}</span></a>` +
      `<nav class="nav" aria-label="${esc(s.ui.nav.main)}">${nav.map(([k, l]) => link(k, l)).join('')}</nav>` +
      `<div class="top__end">` +
      `<details class="pop menu-pop"><summary>${esc(s.ui.nav.menu)}</summary><ul>` +
      [['home', s.ui.nav.home] as [PageKey, string], ...nav]
        .map(([k, l]) => `<li>${link(k, l)}</li>`)
        .join('') +
      `</ul></details>` +
      (this.c.set.langs.length > 1
        ? `<details class="pop"><summary><span class="vh">${esc(s.ui.nav.language)} : </span>${this.code}</summary><ul>${langs}</ul></details>`
        : '') +
      `<a class="btn btn--primary btn--sm btn--play" href="/">${esc(s.ui.playShort)}</a>` +
      `</div></div></header>`
    );
  }

  private footer(): string {
    const s = this.s;
    const game: [PageKey, string][] = [
      ['howto', s.ui.nav.howto],
      ['features', s.ui.nav.features],
      ['nations', s.ui.nav.nations],
      ['arsenal', s.ui.nav.arsenal],
      ['faq', s.ui.nav.faq],
    ];
    const li = (href: string, label: string, attrs = '') =>
      `<li><a href="${href}"${attrs}>${esc(label)}</a></li>`;
    return (
      `<footer class="foot"><div class="wrap foot__cols">` +
      `<div><a class="brand" href="${pathIn(this.c.lc, 'home')}">RED<span class="l">LINE</span></a>` +
      `<p style="margin-top:10px">${this.t(s.ui.footer.tagline)}</p>` +
      `<p style="margin-top:16px"><a class="btn btn--primary btn--sm" href="/">${esc(s.ui.play)}</a></p></div>` +
      `<div><h2>${esc(s.ui.footer.game)}</h2><ul>${game.map(([k, l]) => li(this.href(k), l)).join('')}</ul></div>` +
      `<div><h2>${esc(s.ui.footer.legal)}</h2><ul>${LEGAL_DOCS.map((d) => li(this.href(`legal:${d}`), s.ui.legalNames[d])).join('')}</ul></div>` +
      (this.c.set.langs.length > 1
        ? `<div><h2>${esc(s.ui.footer.languages)}</h2><ul class="langs">${this.c.set.langs
            .map((l) =>
              li(
                pathIn(l, 'home'),
                l.lang.name,
                ` hreflang="${l.lang.hreflang}" lang="${l.lang.code}"`,
              ),
            )
            .join('')}</ul></div>`
        : '') +
      `</div><div class="wrap foot__base"><p>© ${this.c.year} Red Line · ${this.t(
        s.ui.footer.publisher,
        {
          name: '{{legal.publisherName}} ({{legal.tradeName}})',
        },
      )}</p><p style="margin-top:6px">${this.t(s.ui.footer.credits)}</p></div></footer>`
    );
  }

  private crumbs(items: { name: string; path: string }[]): string {
    const last = items.length - 1;
    return (
      `<nav class="crumbs" aria-label="${esc(this.s.ui.breadcrumb)}"><span class="ps" aria-hidden="true">PS</span>` +
      `<span aria-hidden="true">RED-LINE:\\</span><ol>` +
      items
        .map((it, i) =>
          i === last
            ? `<li><span aria-current="page">${esc(it.name)}</span></li>`
            : `<li><a href="${it.path}">${esc(it.name)}</a></li>`,
        )
        .join('') +
      `</ol><span class="gt" aria-hidden="true">&gt;</span></nav>`
    );
  }

  page(p: PageSpec): string {
    const { lc, routes, assets, set } = this.c;
    const lang = lc.lang;
    const canonical = p.key ? `${ORIGIN}${pathIn(lc, p.key)}` : null;
    const alts = p.key ? routes.alternates(p.key) : [];
    const og = assets.og[lang.code];
    const crumbs = p.crumbs
      ? [{ name: this.s.ui.nav.home, path: pathIn(lc, 'home') }, ...p.crumbs]
      : null;
    const ld = [...(p.jsonld ?? []), ...(crumbs && crumbs.length > 1 ? [breadcrumb(crumbs)] : [])];
    const head = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      `<title>${esc(p.title)}</title>`,
      `<meta name="description" content="${esc(p.description)}">`,
      p.noindex
        ? '<meta name="robots" content="noindex, follow">'
        : '<meta name="robots" content="index, follow, max-image-preview:large">',
      canonical ? `<link rel="canonical" href="${canonical}">` : '',
      ...(alts.length > 1
        ? alts.map(
            (a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${ORIGIN}${a.path}">`,
          )
        : []),
      '<meta name="theme-color" content="#0a0e13">',
      '<meta name="color-scheme" content="dark">',
      '<link rel="icon" href="/icon.svg" type="image/svg+xml">',
      '<link rel="apple-touch-icon" href="/icon-192.png">',
      '<link rel="manifest" href="/manifest.webmanifest">',
      ...assets.preload.map(
        (f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`,
      ),
      `<meta property="og:type" content="${p.ogType ?? 'website'}">`,
      '<meta property="og:site_name" content="Red Line">',
      `<meta property="og:title" content="${esc(p.title)}">`,
      `<meta property="og:description" content="${esc(p.description)}">`,
      canonical ? `<meta property="og:url" content="${canonical}">` : '',
      `<meta property="og:locale" content="${lang.locale}">`,
      ...set.langs
        .filter((l) => l !== lc && p.key && exists(l, p.key))
        .map((l) => `<meta property="og:locale:alternate" content="${l.lang.locale}">`),
      ...(og
        ? [
            `<meta property="og:image" content="${ORIGIN}${og.src}">`,
            `<meta property="og:image:width" content="${og.width}">`,
            `<meta property="og:image:height" content="${og.height}">`,
            `<meta property="og:image:alt" content="${esc(this.s.home.shot.alt)}">`,
          ]
        : []),
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${esc(p.title)}">`,
      `<meta name="twitter:description" content="${esc(p.description)}">`,
      ...(og
        ? [
            `<meta name="twitter:image" content="${ORIGIN}${og.src}">`,
            `<meta name="twitter:image:alt" content="${esc(this.s.home.shot.alt)}">`,
          ]
        : []),
      `<style>${assets.css}</style>`,
      ld.length ? graph(...ld) : '',
    ]
      .filter(Boolean)
      .join('\n');
    return (
      `<!doctype html>\n<html lang="${lang.code}" dir="${lang.dir}">\n<head>\n${head}\n</head>\n<body>\n` +
      `<a class="skip" href="#main">${esc(this.s.ui.skip)}</a>\n` +
      this.header(p.key) +
      `\n<main id="main">\n${crumbs ? `<div class="wrap pagehead-crumbs">${this.crumbs(crumbs)}</div>` : ''}${p.body}\n</main>\n` +
      this.footer() +
      '\n</body>\n</html>\n'
    );
  }

  private pagehead(h1: string, lead?: string, meta?: string): string {
    return (
      `<div class="wrap pagehead"><h1>${this.t(h1)}</h1>` +
      (lead ? `<p class="lead">${this.t(lead)}</p>` : '') +
      (meta ? `<p class="meta">${meta}</p>` : '') +
      '</div>'
    );
  }

  private ctaRow(): string {
    const u = this.s.ui;
    return (
      `<div class="cta">` +
      `<a class="btn btn--primary" href="/"><span class="caret" aria-hidden="true">▶</span>${esc(u.play)}</a>` +
      `<a class="btn" href="/lobby">${esc(u.multiplayer)}</a>` +
      `<a class="btn" href="/?auth=login">${esc(u.login)}</a>` +
      `</div>`
    );
  }

  private figures(): string {
    const f = this.s.home.figures;
    const d = this.c.data;
    const items: [number, string][] = [
      [d.nations.length, f.nations],
      [d.provinces, f.provinces],
      [d.systems, f.systems],
      [d.maxPlayers, f.players],
      [d.scenarios.length, f.scenarios],
    ];
    return `<dl class="figures">${items
      .map(([n, l]) => `<div><dt>${esc(l)}</dt><dd>${this.int(n)}</dd></div>`)
      .join('')}</dl>`;
  }

  private faqList(items: { q: string; a: string }[], open = false): string {
    return `<div class="faq">${items
      .map(
        (it, i) =>
          `<details${open && i === 0 ? ' open' : ''}><summary>${this.t(it.q)}</summary><div class="a"><p>${this.t(it.a)}</p></div></details>`,
      )
      .join('')}</div>`;
  }

  private shot(): string {
    const sh = this.c.assets.shot;
    if (!sh) return '';
    const h = this.s.home.shot;
    return (
      `<figure class="shot"><div class="shot__bar" aria-hidden="true"><i></i><b>PS</b> RED-LINE:\\${esc(this.s.ui.nav.home)}\\carte&gt;</div>` +
      `<img src="${sh.src}" srcset="${sh.srcset}" sizes="(min-width: 1120px) 1088px, 100vw" width="${sh.width}" height="${sh.height}" alt="${esc(h.alt)}" loading="lazy" decoding="async">` +
      `<figcaption>${this.t(h.caption)}</figcaption></figure>`
    );
  }

  // ——————————————————————————— Pages ———————————————————————————

  home(): string {
    const h = this.s.home;
    const d = this.c.data;
    const pt = (id: string) => d.capitals[id];
    const map = heroMap({
      worldUrl: this.c.assets.world,
      pings: PINGS.map(pt).filter((p): p is [number, number] => !!p),
      arcs: ARCS.map(([a, b]) => [pt(a), pt(b)] as const).filter(
        (x): x is [[number, number], [number, number]] => !!x[0] && !!x[1],
      ),
    });
    const blocks = h.blocks
      .map(
        (b, i) =>
          `<article class="card"><span class="idx" aria-hidden="true">[0${i + 1}]</span><h3>${this.t(b.title)}</h3><p>${this.t(b.text)}</p>` +
          (b.link
            ? `<a class="more" href="${this.href(b.link as PageKey)}">${esc(this.linkLabel(b.link as PageKey))} →</a>`
            : '') +
          '</article>',
      )
      .join('');
    const steps = h.steps
      .map((st) => `<li><h3>${this.t(st.title)}</h3><p>${this.t(st.text)}</p></li>`)
      .join('');
    const body =
      `<section class="hero">${map}<div class="wrap hero__in">` +
      `<p class="kicker">${this.t(h.kicker)}</p><h1>${this.t(h.h1)}</h1><p class="lead">${this.t(h.lead)}</p>` +
      this.ctaRow() +
      `<p class="cta__note">${this.t(h.ctaNote)}</p>${this.figures()}</div></section>` +
      `<section class="section"><div class="wrap"><h2>${this.t(h.blocksTitle)}</h2><div class="grid grid--3">${blocks}</div></div></section>` +
      `<section class="section"><div class="wrap"><h2>${this.t(h.stepsTitle)}</h2><ol class="steps">${steps}</ol>` +
      (this.c.assets.shot ? `<div style="margin-top:28px">${this.shot()}</div>` : '') +
      `</div></section>` +
      `<section class="section"><div class="wrap"><h2>${this.t(h.faqTitle)}</h2>${this.faqList(this.s.faq.items.slice(0, 5))}` +
      `<p style="margin-top:16px"><a href="${this.href('faq')}">${esc(h.moreFaq)} →</a></p></div></section>`;
    const description = this.plain(h.description);
    return this.page({
      key: 'home',
      title: this.plain(h.title),
      description,
      body,
      jsonld: [
        organization(),
        website(this.c.set),
        videoGame(this.c.set, this.c.lc, {
          description,
          ...(this.c.assets.og[this.code] ? { image: this.c.assets.og[this.code]!.src } : {}),
          ...(this.c.assets.shot ? { screenshot: this.c.assets.shot.src } : {}),
          maxPlayers: d.maxPlayers,
        }),
      ],
    });
  }

  private linkLabel(k: PageKey): string {
    const n = this.s.ui.nav;
    if (k === 'howto' || k === 'features' || k === 'nations' || k === 'arsenal' || k === 'faq')
      return n[k];
    return n.home;
  }

  howto(): string {
    const h = this.s.howto;
    const sections = h.sections
      .map(
        (sec) =>
          `<h2 id="${slugify(sec.title)}">${this.t(sec.title)}</h2>` +
          sec.paragraphs.map((p) => `<p>${this.t(p)}</p>`).join('') +
          (sec.list ? `<ul>${sec.list.map((l) => `<li>${this.t(l)}</li>`).join('')}</ul>` : ''),
      )
      .join('');
    const scen = this.c.data.scenarios
      .map((sc) => h.scenarios[sc.id])
      .filter((x): x is { name: string; text: string } => !!x)
      .map(
        (x) => `<article class="card"><h3>${this.t(x.name)}</h3><p>${this.t(x.text)}</p></article>`,
      )
      .join('');
    const body =
      this.pagehead(h.h1, h.lead) +
      `<div class="wrap"><div class="prose">${sections}</div></div>` +
      `<section class="section"><div class="wrap"><h2>${this.t(h.scenariosTitle)}</h2><div class="grid grid--3">${scen}</div></div></section>` +
      `<section class="section"><div class="wrap"><h2>${this.t(h.tipsTitle)}</h2><ol class="steps">${h.tips
        .map((tip) => `<li><p>${this.t(tip)}</p></li>`)
        .join('')}</ol>${this.ctaRow()}</div></section>`;
    return this.page({
      key: 'howto',
      title: this.plain(h.title),
      description: this.plain(h.description),
      body,
      crumbs: [{ name: this.s.ui.nav.howto, path: pathIn(this.c.lc, 'howto') }],
      ogType: 'article',
    });
  }

  features(): string {
    const f = this.s.features;
    const items = f.items
      .map(
        (it, i) =>
          `<article class="card"><span class="idx" aria-hidden="true">[0${i + 1}]</span><h2 class="h3">${this.t(it.title)}</h2><p>${this.t(it.text)}</p>` +
          `<ul>${it.points.map((p) => `<li>${this.t(p)}</li>`).join('')}</ul></article>`,
      )
      .join('');
    const body =
      this.pagehead(f.h1, f.lead) +
      `<section class="section"><div class="wrap"><div class="grid">${items}</div>` +
      (this.c.assets.shot ? `<div style="margin-top:28px">${this.shot()}</div>` : '') +
      `${this.ctaRow()}</div></section>`;
    return this.page({
      key: 'features',
      title: this.plain(f.title),
      description: this.plain(f.description),
      body,
      crumbs: [{ name: this.s.ui.nav.features, path: pathIn(this.c.lc, 'features') }],
    });
  }

  nations(): string {
    const n = this.s.nations;
    const list = [...this.c.data.nations].sort(
      (a, b) =>
        (b.budgetUsd ?? -1) - (a.budgetUsd ?? -1) ||
        this.nationName(a).localeCompare(this.nationName(b), this.c.lc.lang.intl),
    );
    const rows = list
      .map((x, i) => {
        const name = this.nationName(x);
        const flag = x.iso2
          ? `<img class="flag" src="/flags/${x.iso2}.svg" width="24" height="18" alt="" loading="lazy" decoding="async">`
          : '<span class="flag" aria-hidden="true"></span>';
        return (
          `<tr id="${x.id}"><td class="num">${i + 1}</td><th scope="row" class="nation">${flag}${esc(name)}</th>` +
          `<td class="num">${x.budgetUsd ? this.money(x.budgetUsd) : '—'}</td>` +
          `<td class="num">${x.personnel ? this.int(x.personnel) : '—'}</td>` +
          `<td class="num">${this.int(x.provinces)}</td></tr>`
        );
      })
      .join('');
    const c = n.cols;
    const body =
      this.pagehead(n.h1, n.lead) +
      `<section class="section" style="padding-top:20px"><div class="wrap"><div class="table"><table>` +
      `<caption>${this.t(n.tableCaption)}</caption><thead><tr><th scope="col" class="num">${esc(c.rank)}</th><th scope="col">${esc(c.nation)}</th>` +
      `<th scope="col" class="num">${esc(c.budget)}</th><th scope="col" class="num">${esc(c.personnel)}</th><th scope="col" class="num">${esc(c.provinces)}</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div><p class="note">${this.t(n.note)}</p>${this.ctaRow()}</div></section>`;
    return this.page({
      key: 'nations',
      title: this.plain(n.title),
      description: this.plain(n.description),
      body,
      crumbs: [{ name: this.s.ui.nav.nations, path: pathIn(this.c.lc, 'nations') }],
    });
  }

  private familyEntries(f: FamilyId): ArsenalEntry[] {
    const cats = FAMILIES[f] as readonly string[];
    return this.c.data.arsenal.filter((e) => cats.includes(e.category));
  }

  arsenal(): string {
    const a = this.s.arsenal;
    const cards = FAMILY_IDS.map((f) => {
      const fam = a.families[f];
      const entries = this.familyEntries(f);
      const sample = [...entries]
        .filter((e) => e.photo && e.origins[0] !== 'XX')
        .sort((x, y) => y.fielded - x.fielded)
        .slice(0, 4)
        .map((e) => esc(this.entryName(e)))
        .join(' · ');
      return (
        `<a class="card family" href="${this.href(`family:${f}`)}"><h2 class="h3">${esc(fam.name)}</h2>` +
        `<p class="count">${esc(fill(a.count, { n: this.int(entries.length) }))}</p>` +
        `<p style="margin-top:8px">${this.t(fam.lead)}</p>` +
        (sample ? `<p class="note">${sample}</p>` : '') +
        `</a>`
      );
    }).join('');
    const body =
      this.pagehead(a.h1, a.lead) +
      `<section class="section" style="padding-top:20px"><div class="wrap"><h2 class="vh">${esc(a.familiesTitle)}</h2>` +
      `<div class="families">${cards}</div><p class="note">${this.t(a.note)}</p>${this.ctaRow()}</div></section>`;
    return this.page({
      key: 'arsenal',
      title: this.plain(a.title),
      description: this.plain(a.description),
      body,
      crumbs: [{ name: this.s.ui.nav.arsenal, path: pathIn(this.c.lc, 'arsenal') }],
    });
  }

  private entryName(e: ArsenalEntry): string {
    return this.s.catalogNames[e.name] ?? e.name;
  }

  private item(e: ArsenalEntry): string {
    const L = this.s.arsenal.labels;
    const name = this.entryName(e);
    const origins = e.origins.map((o) => this.country(o)).join(', ');
    const price =
      e.priceMin && e.priceMin !== e.priceMax
        ? `${this.money(e.priceMin)} – ${this.money(e.priceMax)}`
        : e.priceMax
          ? this.money(e.priceMax)
          : null;
    const facts: [string, string][] = [];
    if (price) facts.push([L.price, price]);
    if (e.speedKmh) facts.push([L.speed, fill(L.kmh, { n: this.int(e.speedKmh) })]);
    if (e.rangeKm) facts.push([L.range, fill(L.km, { n: this.int(e.rangeKm) })]);
    const sub = [
      origins,
      e.since ? fill(L.since, { year: e.since }) : null,
      e.generation && ['fighter', 'bomber'].includes(e.category)
        ? fill(L.generation, { n: e.generation })
        : null,
      e.fielded ? fill(L.fielded, { n: this.int(e.fielded) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const img = e.photo
      ? `<img src="${esc(e.photo.thumb)}" width="112" height="70" alt="${esc(name)}" loading="lazy" decoding="async">`
      : '<span class="ph" aria-hidden="true"></span>';
    const credit = e.photo
      ? `<p class="credit"><a href="${esc(e.photo.sourceUrl)}" rel="nofollow noopener" target="_blank">${esc(
          fill(L.photo, { credit: e.photo.credit, license: e.photo.license }),
        )}</a></p>`
      : '';
    return (
      `<li class="item">${img}<div><h3>${esc(name)}</h3><p class="sub">${esc(sub)}</p>` +
      (facts.length
        ? `<dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
        : '') +
      `</div>${credit}</li>`
    );
  }

  family(f: FamilyId): string {
    const a = this.s.arsenal;
    const fam = a.families[f];
    const coll = new Intl.Collator(this.c.lc.lang.intl);
    const sections = (FAMILIES[f] as readonly string[])
      .map((cat) => {
        const entries = this.c.data.arsenal
          .filter((e) => e.category === cat)
          .sort((x, y) => coll.compare(this.entryName(x), this.entryName(y)));
        if (!entries.length) return '';
        const label = a.categories[cat as keyof typeof a.categories];
        return `<section class="cat" aria-labelledby="c-${cat}"><h2 id="c-${cat}">${esc(label)} <small>${esc(
          fill(a.count, { n: this.int(entries.length) }),
        )}</small></h2><ul class="items">${entries.map((e) => this.item(e)).join('')}</ul></section>`;
      })
      .join('');
    const others = FAMILY_IDS.filter((x) => x !== f)
      .map((x) => `<a href="${this.href(`family:${x}`)}">${esc(a.families[x].name)}</a>`)
      .join(' · ');
    const body =
      this.pagehead(fam.name, fam.lead) +
      `<div class="wrap">${sections}<p class="note">${this.t(a.note)}</p><p class="note">${others}</p>${this.ctaRow()}</div>`;
    return this.page({
      key: `family:${f}`,
      title: this.plain(fam.title),
      description: this.plain(fam.description),
      body,
      crumbs: [
        { name: this.s.ui.nav.arsenal, path: pathIn(this.c.lc, 'arsenal') },
        { name: fam.name, path: pathIn(this.c.lc, `family:${f}`) },
      ],
    });
  }

  faq(): string {
    const f = this.s.faq;
    const path = pathIn(this.c.lc, 'faq');
    const body =
      this.pagehead(f.h1, f.lead) +
      `<section class="section" style="padding-top:20px"><div class="wrap prose">${this.faqList(f.items, true)}${this.ctaRow()}</div></section>`;
    return this.page({
      key: 'faq',
      title: this.plain(f.title),
      description: this.plain(f.description),
      body,
      crumbs: [{ name: this.s.ui.nav.faq, path }],
      jsonld: [
        faqPage(
          f.items.map((it) => ({ q: this.plain(it.q), a: this.plain(it.a) })),
          path,
          this.c.lc.lang.hreflang,
        ),
      ],
    });
  }

  legal(id: LegalDocId): string {
    const doc = this.c.lc.legal[id]!;
    const ui = this.s.ui;
    const md = markdown(doc.markdown, this.c.routes.resolver(this.c.lc));
    const meta =
      esc(fill(ui.updated, { date: this.formatDate(doc.updatedAt) })) +
      ' · ' +
      esc(fill(ui.version, { version: doc.version }));
    const toc =
      md.toc.length > 3
        ? `<nav class="toc" aria-label="${esc(ui.toc)}"><b>${esc(ui.toc)}</b><ol>${md.toc
            .map((h) => `<li><a href="#${h.id}">${inline(h.text)}</a></li>`)
            .join('')}</ol></nav>`
        : '';
    const ref =
      this.code !== this.c.set.defaultLang
        ? `<blockquote><p>${esc(ui.referenceLang)}</p></blockquote>`
        : '';
    const body =
      this.pagehead(doc.title, undefined, meta) +
      `<div class="wrap"><div class="prose">${ref}${toc}${md.html}</div></div>`;
    return this.page({
      key: `legal:${id}`,
      title: `${doc.title} — Red Line`,
      description: doc.description,
      body,
      crumbs: [{ name: doc.title, path: pathIn(this.c.lc, `legal:${id}`) }],
      ogType: 'article',
    });
  }

  notFound(): string {
    const n = this.s.notFound;
    const body =
      `<div class="wrap pagehead"><p class="kicker">404</p><h1>${this.t(n.h1)}</h1><p class="lead">${this.t(n.text)}</p>` +
      `<div class="cta"><a class="btn btn--primary" href="${pathIn(this.c.lc, 'home')}">${esc(this.s.ui.back)}</a>` +
      `<a class="btn" href="/">${esc(this.s.ui.play)}</a></div></div>`;
    return this.page({
      key: null,
      title: this.plain(n.title),
      description: this.plain(n.text),
      body,
      noindex: true,
    });
  }

  /** En-tête SEO injecté dans index.html du jeu (route /) : canonique, partage, JSON-LD. */
  spaHead(): string {
    const { lc, assets, set, data } = this.c;
    const h = this.s.home;
    const og = assets.og[lc.lang.code];
    const description = this.plain(h.description);
    return [
      `<link rel="canonical" href="${ORIGIN}/">`,
      `<meta property="og:url" content="${ORIGIN}/">`,
      `<meta property="og:title" content="${esc(this.plain(h.title))}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:locale" content="${lc.lang.locale}">`,
      ...(og
        ? [
            `<meta property="og:image" content="${ORIGIN}${og.src}">`,
            `<meta property="og:image:width" content="${og.width}">`,
            `<meta property="og:image:height" content="${og.height}">`,
            `<meta property="og:image:alt" content="${esc(h.shot.alt)}">`,
            '<meta name="twitter:card" content="summary_large_image">',
            `<meta name="twitter:image" content="${ORIGIN}${og.src}">`,
          ]
        : []),
      `<meta name="twitter:title" content="${esc(this.plain(h.title))}">`,
      `<meta name="twitter:description" content="${esc(description)}">`,
      graph(
        organization(),
        website(set),
        videoGame(set, lc, {
          description,
          ...(og ? { image: og.src } : {}),
          ...(assets.shot ? { screenshot: assets.shot.src } : {}),
          maxPlayers: data.maxPlayers,
        }),
      ),
    ].join('\n');
  }
}
