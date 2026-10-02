/**
 * Langues de l'interface et textes localisables produits par le moteur.
 *
 * Le français est la langue source (textes du moteur, fichiers `fr*.json` du client). Les autres
 * langues sont générées par `tools/i18n` et commitées ; le client se replie sur l'anglais puis sur
 * le français quand une clé manque.
 *
 * Textes du moteur : en plus du texte français (toujours présent, rétrocompatible), une dépêche, une
 * notification ou un rapport peut porter un `LocText` (clé + paramètres structurés) que le client
 * traduit dans la langue du joueur. Les paramètres désignent des objets du jeu (nation, province,
 * système d'armes) par identifiant : le client affiche leur nom localisé.
 */
import { z } from 'zod';

/** Langues prises en charge (ordre du sélecteur). `fr` est la langue source. */
export const LOCALES = [
  'fr',
  'en',
  'ar',
  'es',
  'tr',
  'de',
  'pt',
  'ru',
  'it',
  'zh',
  'ja',
  'ko',
  'hi',
  'id',
  'pl',
] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

export const SOURCE_LOCALE: Locale = 'fr';
/** Chaîne de repli : langue demandée → anglais → français. */
export const FALLBACK_LOCALES: readonly Locale[] = ['en', 'fr'];

/** Langues écrites de droite à gauche. */
export const RTL_LOCALES: readonly Locale[] = ['ar'];

/** Étiquette BCP 47 utilisée pour Intl (nombres, dates, pluriels) et l'attribut `lang`. */
export const LOCALE_TAGS: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  ar: 'ar',
  es: 'es-ES',
  tr: 'tr-TR',
  de: 'de-DE',
  pt: 'pt-BR',
  ru: 'ru-RU',
  it: 'it-IT',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  hi: 'hi-IN',
  id: 'id-ID',
  pl: 'pl-PL',
};

/** Nom de chaque langue dans sa propre langue (sélecteur). */
export const LOCALE_NAMES: Record<Locale, string> = {
  fr: 'Français',
  en: 'English',
  ar: 'العربية',
  es: 'Español',
  tr: 'Türkçe',
  de: 'Deutsch',
  pt: 'Português (Brasil)',
  ru: 'Русский',
  it: 'Italiano',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  pl: 'Polski',
};

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x);
}

/**
 * Langue la plus proche d'une étiquette quelconque (« en-GB » → en, « pt-PT » → pt, « zh-Hant » → zh,
 * « nb » → null). Insensible à la casse ; accepte `_` comme séparateur.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().replace('_', '-').split('-')[0] ?? '';
  return isLocale(base) ? base : null;
}

/** Première langue prise en charge d'une liste de préférences (navigateur, Accept-Language). */
export function pickLocale(prefs: readonly (string | null | undefined)[]): Locale | null {
  for (const p of prefs) {
    const m = matchLocale(p);
    if (m) return m;
  }
  return null;
}

/** Préférences d'un en-tête Accept-Language, triées par poids décroissant. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)/.exec(p)?.[1]).find(Boolean);
      return { tag: (tag ?? '').trim(), q: q ? Number(q) : 1, i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

// ——— Textes localisables du moteur ———

/**
 * Paramètre d'un texte localisable :
 *  - chaîne ou nombre : valeur littérale (nom d'alliance, durée…) ;
 *  - `{ nation }`, `{ province }`, `{ system }` : nom localisé de l'objet ;
 *  - `{ key, params }` : sous-texte traduit (libellé de résolution, type de frappe…) ;
 *  - `{ list }` : énumération (« Maroc, Algérie et Tunisie ») au format de la langue.
 */
export type LocParam =
  | string
  | number
  | { nation: string }
  | { province: string }
  | { system: string }
  | { key: string; params?: Record<string, LocParam> }
  | { list: LocParam[] };

/** Texte localisable : clé du dictionnaire du client (`engine.*`, `news.*`) et paramètres. */
export interface LocText {
  key: string;
  params?: Record<string, LocParam>;
}

/** Construit un `LocText` (paramètres vides omis : instantanés plus compacts). */
export function loc(key: string, params?: Record<string, LocParam>): LocText {
  return params && Object.keys(params).length ? { key, params } : { key };
}

export const LocParamSchema: z.ZodType<LocParam> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.object({ nation: z.string() }),
    z.object({ province: z.string() }),
    z.object({ system: z.string() }),
    z.object({ key: z.string(), params: z.record(LocParamSchema).optional() }),
    z.object({ list: z.array(LocParamSchema) }),
  ]),
);
export const LocTextSchema = z.object({
  key: z.string(),
  params: z.record(LocParamSchema).optional(),
});

/**
 * Clé courte et stable d'un texte source (FNV-1a 32 bits, 8 caractères hexadécimaux) : sert à
 * retrouver la traduction d'un texte de données (fiche technique, description de nation…) sans
 * dépendre de l'identifiant de l'objet qui le porte.
 */
export function textKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
