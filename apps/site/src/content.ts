/**
 * Contenus éditoriaux des pages publiques, externalisés par langue :
 *   content/languages.json          langues prévues (code, hreflang, locale Open Graph, sens d'écriture)
 *   content/<langue>/site.json      textes des pages (schéma ci-dessous)
 *   content/<langue>/legal/<doc>.md documents légaux (en-tête --- title / description / version / updatedAt ---)
 *
 * Une langue n'est construite que si son site.json existe. Les clés absentes reprennent l'anglais (puis le
 * français) : une traduction partielle ne casse jamais le build, elle est signalée. Les documents légaux
 * absents dans une langue renvoient vers la version anglaise (puis française).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONTENT_DIR } from './paths.js';

export const LEGAL_DOCS = ['mentions', 'privacy', 'cookies', 'cgu', 'cgv', 'withdrawal'] as const;
export type LegalDocId = (typeof LEGAL_DOCS)[number];

export const FAMILIES = {
  air: ['fighter', 'bomber', 'air_support'],
  rotary: ['helicopter', 'drone'],
  land: ['tank', 'ifv', 'infantry', 'artillery', 'logistics'],
  airdef: ['air_defense', 'radar'],
  naval: ['surface_ship', 'submarine'],
  strategic: ['strike_missile', 'nuclear', 'space'],
} as const;
export type FamilyId = keyof typeof FAMILIES;
export const FAMILY_IDS = Object.keys(FAMILIES) as FamilyId[];
export const CATEGORIES = FAMILY_IDS.flatMap((f) => [...FAMILIES[f]]);
export type Category = (typeof CATEGORIES)[number];

const Str = z.string().min(1);
const Seo = { title: Str, description: Str };
const Block = z.object({ title: Str, text: Str, link: Str.optional() });
const Section = z.object({
  title: Str,
  paragraphs: z.array(Str),
  list: z.array(Str).optional(),
});

const slugRecord = <K extends string>(keys: readonly K[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, Str])) as Record<K, typeof Str>);

export const SiteContentSchema = z.object({
  slugs: z.object({
    howto: Str,
    features: Str,
    nations: Str,
    arsenal: Str,
    faq: Str,
    legal: slugRecord(LEGAL_DOCS),
    families: slugRecord(FAMILY_IDS),
  }),
  ui: z.object({
    skip: Str,
    nav: z.object({
      home: Str,
      howto: Str,
      features: Str,
      nations: Str,
      arsenal: Str,
      faq: Str,
      menu: Str,
      language: Str,
      main: Str,
    }),
    play: Str,
    playShort: Str,
    multiplayer: Str,
    login: Str,
    breadcrumb: Str,
    updated: Str,
    version: Str,
    toc: Str,
    back: Str,
    referenceLang: Str,
    footer: z.object({
      tagline: Str,
      game: Str,
      legal: Str,
      languages: Str,
      publisher: Str,
      credits: Str,
    }),
    legalNames: slugRecord(LEGAL_DOCS),
  }),
  home: z.object({
    ...Seo,
    kicker: Str,
    h1: Str,
    lead: Str,
    ctaNote: Str,
    figures: z.object({
      nations: Str,
      provinces: Str,
      systems: Str,
      players: Str,
      scenarios: Str,
    }),
    blocksTitle: Str,
    blocks: z.array(Block).min(3),
    shot: z.object({ alt: Str, caption: Str }),
    stepsTitle: Str,
    steps: z.array(z.object({ title: Str, text: Str })).min(1),
    faqTitle: Str,
    moreFaq: Str,
  }),
  howto: z.object({
    ...Seo,
    h1: Str,
    lead: Str,
    sections: z.array(Section).min(1),
    scenariosTitle: Str,
    scenarios: z.record(z.string(), z.object({ name: Str, text: Str })),
    tipsTitle: Str,
    tips: z.array(Str),
  }),
  features: z.object({
    ...Seo,
    h1: Str,
    lead: Str,
    items: z.array(z.object({ title: Str, text: Str, points: z.array(Str) })).min(1),
  }),
  nations: z.object({
    ...Seo,
    h1: Str,
    lead: Str,
    tableCaption: Str,
    cols: z.object({ rank: Str, nation: Str, budget: Str, personnel: Str, provinces: Str }),
    note: Str,
  }),
  arsenal: z.object({
    ...Seo,
    h1: Str,
    lead: Str,
    familiesTitle: Str,
    count: Str,
    families: z.object(
      Object.fromEntries(
        FAMILY_IDS.map((f) => [
          f,
          z.object({ name: Str, title: Str, description: Str, lead: Str }),
        ]),
      ) as Record<
        FamilyId,
        z.ZodObject<{
          name: typeof Str;
          title: typeof Str;
          description: typeof Str;
          lead: typeof Str;
        }>
      >,
    ),
    categories: slugRecord(CATEGORIES),
    labels: z.object({
      origin: Str,
      since: Str,
      price: Str,
      speed: Str,
      range: Str,
      generation: Str,
      fielded: Str,
      variants: Str,
      photo: Str,
      generic: Str,
      kmh: Str,
      km: Str,
    }),
    note: Str,
  }),
  faq: z.object({
    ...Seo,
    h1: Str,
    lead: Str,
    items: z.array(z.object({ q: Str, a: Str })).min(1),
  }),
  notFound: z.object({ title: Str, h1: Str, text: Str }),
  /** Noms des matériels génériques du catalogue (le catalogue est rédigé en français). */
  catalogNames: z.record(z.string(), z.string()),
});
export type SiteContent = z.infer<typeof SiteContentSchema>;

export const LanguageSchema = z.object({
  code: z.string().regex(/^[a-z]{2,3}$/),
  name: Str,
  hreflang: Str,
  locale: Str,
  intl: Str,
  dir: z.enum(['ltr', 'rtl']),
});
export type Language = z.infer<typeof LanguageSchema>;

const LanguagesFileSchema = z.object({
  default: Str,
  xDefault: Str,
  languages: z.array(LanguageSchema).min(1),
});

export interface LegalDocContent {
  id: LegalDocId;
  title: string;
  description: string;
  version: number;
  updatedAt: string;
  markdown: string;
}

export interface LangContent {
  lang: Language;
  site: SiteContent;
  legal: Partial<Record<LegalDocId, LegalDocContent>>;
  /** Clés absentes du fichier de la langue (reprises de la langue de repli). */
  missing: string[];
}

export interface ContentSet {
  defaultLang: string;
  xDefault: string;
  /** Toutes les langues prévues (construites ou non). */
  planned: Language[];
  /** Langues construites, dans l'ordre de languages.json. */
  langs: LangContent[];
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Fusion profonde : `over` l'emporte, les tableaux sont remplacés en bloc. Relève les chemins absents. */
export function deepMerge(
  base: Json,
  over: Json | undefined,
  path = '',
  missing: string[] = [],
): Json {
  if (over === undefined) {
    if (path) missing.push(path);
    return base;
  }
  if (
    base &&
    over &&
    typeof base === 'object' &&
    typeof over === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(over)
  ) {
    const out: { [k: string]: Json } = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
      const b = base[k];
      const o = over[k];
      out[k] = b === undefined ? o! : deepMerge(b, o, path ? `${path}.${k}` : k, missing);
    }
    return out;
  }
  return over;
}

/** En-tête --- clé: valeur --- d'un document Markdown. */
export function parseFrontMatter(raw: string): { head: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  const head: Record<string, string> = {};
  if (!m) return { head, body: raw };
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { head, body: m[2]! };
}

export function loadLegalDoc(path: string, id: LegalDocId): LegalDocContent {
  const { head, body } = parseFrontMatter(readFileSync(path, 'utf8'));
  const version = Number(head.version ?? 1);
  return {
    id,
    title: head.title ?? id,
    description: head.description ?? head.title ?? id,
    version: Number.isInteger(version) && version > 0 ? version : 1,
    updatedAt: head.updatedAt ?? '',
    markdown: body.trim(),
  };
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

export function loadContent(dir = CONTENT_DIR): ContentSet {
  const file = LanguagesFileSchema.parse(readJson(join(dir, 'languages.json')));
  const raw = new Map<string, Json>();
  for (const l of file.languages) {
    const p = join(dir, l.code, 'site.json');
    if (existsSync(p)) raw.set(l.code, readJson(p));
  }
  const fallbackChain = (code: string) =>
    [code, file.xDefault, file.default].filter((c, i, a) => a.indexOf(c) === i && raw.has(c));
  const langs: LangContent[] = [];
  for (const lang of file.languages) {
    if (!raw.has(lang.code)) continue;
    const chain = fallbackChain(lang.code);
    // Base = dernière langue de repli, puis chaque langue plus spécifique par-dessus.
    let merged: Json = raw.get(chain[chain.length - 1]!)!;
    const missing: string[] = [];
    for (const c of chain.slice(0, -1).reverse()) {
      merged = deepMerge(merged, raw.get(c), '', c === lang.code ? missing : []);
    }
    // Noms de matériels : propres à chaque langue, jamais repris d'une autre (le catalogue est en français).
    const own = raw.get(lang.code) as { catalogNames?: Json } | null;
    merged = { ...(merged as { [k: string]: Json }), catalogNames: own?.catalogNames ?? {} };
    const relevant = missing.filter((m) => !m.startsWith('catalogNames.'));
    missing.length = 0;
    missing.push(...relevant);
    const parsed = SiteContentSchema.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((i) => `  - ${i.path.join('.')} : ${i.message}`)
        .join('\n');
      throw new Error(`content/${lang.code}/site.json invalide :\n${issues}`);
    }
    const legal: LangContent['legal'] = {};
    for (const id of LEGAL_DOCS) {
      const p = join(dir, lang.code, 'legal', `${id}.md`);
      if (existsSync(p)) legal[id] = loadLegalDoc(p, id);
    }
    langs.push({ lang, site: parsed.data, legal, missing });
  }
  if (!langs.length)
    throw new Error('Aucune langue construite (content/<langue>/site.json absent)');
  return { defaultLang: file.default, xDefault: file.xDefault, planned: file.languages, langs };
}

/** Remplace {cle} par sa valeur (les clés inconnues sont laissées telles quelles). */
export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
