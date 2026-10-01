/**
 * Adresses des pages publiques : /<langue>/<slug>/ (slugs traduits dans content/<langue>/site.json).
 * Une page légale absente dans une langue renvoie vers la langue de repli (anglais, puis français).
 */
import {
  FAMILY_IDS,
  LEGAL_DOCS,
  type ContentSet,
  type FamilyId,
  type LangContent,
  type LegalDocId,
} from './content.js';

export type PageKey =
  | 'home'
  | 'howto'
  | 'features'
  | 'nations'
  | 'arsenal'
  | 'faq'
  | `family:${FamilyId}`
  | `legal:${LegalDocId}`;

export const PAGE_KEYS: PageKey[] = [
  'home',
  'howto',
  'features',
  'nations',
  'arsenal',
  ...FAMILY_IDS.map((f) => `family:${f}` as const),
  'faq',
  ...LEGAL_DOCS.map((d) => `legal:${d}` as const),
];

export function exists(lc: LangContent, key: PageKey): boolean {
  if (key.startsWith('legal:')) return !!lc.legal[key.slice(6) as LegalDocId];
  return true;
}

/** Chemin d'une page dans une langue donnée (sans vérifier son existence). */
export function pathIn(lc: LangContent, key: PageKey): string {
  const s = lc.site.slugs;
  const base = `/${lc.lang.code}/`;
  if (key === 'home') return base;
  if (key.startsWith('family:')) {
    return `${base}${s.arsenal}/${s.families[key.slice(7) as FamilyId]}/`;
  }
  if (key.startsWith('legal:')) return `${base}${s.legal[key.slice(6) as LegalDocId]}/`;
  return `${base}${s[key as 'howto' | 'features' | 'nations' | 'arsenal' | 'faq']}/`;
}

export class Routes {
  constructor(readonly set: ContentSet) {}

  byCode(code: string): LangContent | undefined {
    return this.set.langs.find((l) => l.lang.code === code);
  }

  /** Langue qui sert réellement la page demandée dans `lc` (elle-même ou un repli). */
  serving(lc: LangContent, key: PageKey): LangContent | null {
    if (exists(lc, key)) return lc;
    for (const code of [this.set.xDefault, this.set.defaultLang]) {
      const l = this.byCode(code);
      if (l && exists(l, key)) return l;
    }
    return this.set.langs.find((l) => exists(l, key)) ?? null;
  }

  /** Lien vers une page depuis une langue (repli éventuel). */
  href(lc: LangContent, key: PageKey): string {
    const l = this.serving(lc, key);
    return l ? pathIn(l, key) : pathIn(lc, 'home');
  }

  /** Versions linguistiques d'une page (hreflang), x-default compris. */
  alternates(key: PageKey): { hreflang: string; path: string; code: string }[] {
    const out = this.set.langs
      .filter((l) => exists(l, key))
      .map((l) => ({ hreflang: l.lang.hreflang, path: pathIn(l, key), code: l.lang.code }));
    const def = [this.set.xDefault, this.set.defaultLang]
      .map((c) => out.find((o) => o.code === c))
      .find(Boolean);
    if (def && out.length > 1) out.push({ hreflang: 'x-default', path: def.path, code: def.code });
    return out;
  }

  /** Résolution des liens « page:… » écrits dans les contenus. */
  resolver(lc: LangContent) {
    return (href: string): string | null => {
      if (!href.startsWith('page:')) return /^(https?:|mailto:|\/|#)/.test(href) ? href : null;
      const key = href.slice(5) as PageKey;
      return PAGE_KEYS.includes(key) ? this.href(lc, key) : null;
    };
  }
}
