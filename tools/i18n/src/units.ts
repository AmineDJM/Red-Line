/**
 * Unités de traduction : clés à plat (`a.b.c`), regroupement des pluriels i18next (`x_one`,
 * `x_other`…), empreinte de la source et contrôles (variables, balisage, longueur).
 * Fonctions pures, partagées par l'outil de traduction et par les tests de complétude.
 */
import { createHash } from 'node:crypto';
import { LOCALE_TAGS, type Locale } from '@redline/shared';

export type Tree = { [k: string]: string | Tree };

export const PLURAL_CATS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCat = (typeof PLURAL_CATS)[number];
const PLURAL_RE = /^(.*)_(zero|one|two|few|many|other)$/;

/** Arbre → clés à plat, dans l'ordre du fichier. */
export function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

/** Clés à plat → arbre (ordre d'insertion conservé). */
export function unflatten(flat: Record<string, string>): Tree {
  const root: Tree = {};
  for (const [key, v] of Object.entries(flat)) {
    const parts = key.split('.');
    let cur: Tree = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      const next = cur[p];
      if (typeof next !== 'object') cur[p] = {};
      cur = cur[p] as Tree;
    }
    cur[parts[parts.length - 1]!] = v;
  }
  return root;
}

/** Fusion profonde (b l'emporte). */
export function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = typeof v === 'object' && typeof cur === 'object' ? merge(cur, v) : v;
  }
  return out;
}

/** Unité de traduction : texte simple ou groupe de formes plurielles. */
export type Unit =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'plural'; forms: Partial<Record<PluralCat, string>> };

/** Regroupe les clés plurielles (`base_one` + `base_other`…) en une seule unité. */
export function toUnits(flat: Record<string, string>): Unit[] {
  const units: Unit[] = [];
  const plural = new Map<string, Unit & { kind: 'plural' }>();
  for (const [key, text] of Object.entries(flat)) {
    const m = PLURAL_RE.exec(key);
    if (m && flat[`${m[1]}_other`] !== undefined) {
      const base = m[1]!;
      let u = plural.get(base);
      if (!u) {
        u = { id: base, kind: 'plural', forms: {} };
        plural.set(base, u);
        units.push(u);
      }
      u.forms[m[2] as PluralCat] = text;
    } else units.push({ id: key, kind: 'text', text });
  }
  return units;
}

/** Catégories plurielles d'une langue (règles CLDR de Intl). */
export function pluralCats(lang: Locale): PluralCat[] {
  const cats = new Intl.PluralRules(LOCALE_TAGS[lang]).resolvedOptions()
    .pluralCategories as PluralCat[];
  return PLURAL_CATS.filter((c) => cats.includes(c));
}

/** Clés à plat produites par une unité traduite. */
export function unitKeys(u: Unit, lang: Locale): string[] {
  return u.kind === 'text' ? [u.id] : pluralCats(lang).map((c) => `${u.id}_${c}`);
}

/** Empreinte stable de la source d'une unité (détection des clés modifiées). */
export function unitHash(u: Unit): string {
  const src =
    u.kind === 'text'
      ? u.text
      : PLURAL_CATS.filter((c) => u.forms[c] !== undefined)
          .map((c) => `${c}=${u.forms[c]}`)
          .join('\u0001');
  return createHash('sha1').update(src).digest('hex').slice(0, 12);
}

// ——— Contrôles ———

/** Variables i18next `{{nom}}` / `{{nom, format}}` (noms seuls). */
export function vars(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)) out.add(m[1]!);
  return out;
}

/** Balises (`<b>`, `</1>`), imbrications `$t(...)` : doivent être conservées telles quelles. */
function markup(s: string): string[] {
  return [...s.matchAll(/<\/?[a-zA-Z0-9]+\s*\/?>|\$t\([^)]*\)/g)].map((m) => m[0]).sort();
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

const NON_LATIN: readonly Locale[] = ['ar', 'ru', 'zh', 'ja', 'ko', 'hi'];

/** Longueur maximale tolérée pour une traduction (l'interface est dense). */
export function maxLength(src: string): number {
  return Math.ceil(src.length * 2.2) + 24;
}

/**
 * Contrôle une traduction de texte simple. Renvoie la liste des problèmes (vide = valide).
 */
export function checkText(src: string, out: unknown, lang: Locale): string[] {
  if (typeof out !== 'string') return ['valeur absente ou non textuelle'];
  const errs: string[] = [];
  if (src.trim() && !out.trim()) errs.push('traduction vide');
  const vs = vars(src);
  const vo = vars(out);
  if (!sameSet(vs, vo))
    errs.push(
      `variables différentes : attendu {{${[...vs].join('}}, {{')}}}, reçu {{${[...vo].join('}}, {{')}}}`,
    );
  if (markup(src).join('|') !== markup(out).join('|')) errs.push('balisage modifié');
  if (src.includes('Red Line') && !out.includes('Red Line')) errs.push('« Red Line » traduit');
  if (out.length > maxLength(src)) errs.push(`trop long (${out.length} > ${maxLength(src)})`);
  // Texte long rendu tel quel dans une langue à écriture non latine : non traduit.
  if (NON_LATIN.includes(lang) && src.length > 24 && /\s/.test(src) && out === src)
    errs.push('non traduit');
  return errs;
}

/** Contrôle une traduction plurielle (objet catégorie → texte). */
export function checkPlural(
  forms: Partial<Record<PluralCat, string>>,
  out: unknown,
  lang: Locale,
): string[] {
  if (!out || typeof out !== 'object') return ['objet de formes plurielles attendu'];
  const o = out as Record<string, unknown>;
  const errs: string[] = [];
  const srcVars = new Set<string>();
  let longest = '';
  for (const v of Object.values(forms)) {
    for (const x of vars(v!)) srcVars.add(x);
    if (v!.length > longest.length) longest = v!;
  }
  const seen = new Set<string>();
  for (const c of pluralCats(lang)) {
    const v = o[c];
    if (typeof v !== 'string' || (!v.trim() && longest.trim())) {
      errs.push(`forme « ${c} » manquante`);
      continue;
    }
    for (const x of vars(v)) {
      if (!srcVars.has(x)) errs.push(`variable inconnue {{${x}}} (forme ${c})`);
      seen.add(x);
    }
    if (v.length > maxLength(longest)) errs.push(`forme ${c} trop longue`);
  }
  for (const x of srcVars)
    if (x !== 'count' && !seen.has(x)) errs.push(`variable {{${x}}} perdue`);
  const other = o.other;
  if (srcVars.has('count') && typeof other === 'string' && !vars(other).has('count'))
    errs.push('{{count}} absent de la forme « other »');
  return errs;
}

/** Contrôle d'une unité déjà écrite dans un fichier de langue (clés à plat). */
export function checkUnit(u: Unit, flat: Record<string, string>, lang: Locale): string[] {
  if (u.kind === 'text') {
    if (flat[u.id] === undefined) return ['clé manquante'];
    return checkText(u.text, flat[u.id], lang);
  }
  const out: Record<string, string> = {};
  for (const c of pluralCats(lang)) {
    const v = flat[`${u.id}_${c}`];
    if (v !== undefined) out[c] = v;
  }
  return checkPlural(u.forms, out, lang);
}
