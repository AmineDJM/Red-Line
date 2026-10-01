/**
 * Textes du serveur dans la langue du compte (notifications push). Le français (`fr.json`) est la
 * source ; les autres langues sont produites par `tools/i18n` dans `locales/<langue>.json` et lues
 * à la demande sur disque (repli : anglais, puis français). Les noms de nations et de provinces
 * localisés viennent de `data/map/names/<langue>.json` (Natural Earth).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLocale, type Locale } from '@redline/shared';
import { REPO_ROOT } from '../paths.js';
import fr from './fr.json' with { type: 'json' };

type Tree = { [k: string]: string | Tree };
const I18N_DIR = join(REPO_ROOT, 'apps/server/src/i18n/locales');
const NAMES_DIR = join(REPO_ROOT, 'data/map/names');

const cache = new Map<string, Tree | null>();
function readTree(file: string): Tree | null {
  if (!cache.has(file)) {
    try {
      cache.set(file, existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Tree) : null);
    } catch {
      cache.set(file, null);
    }
  }
  return cache.get(file) ?? null;
}

function lookup(tree: Tree | null, key: string): string | undefined {
  let cur: string | Tree | undefined = tree ?? undefined;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Langue effective d'un compte (inconnue → français, langue historique du jeu). */
export function accountLocale(l: string | null | undefined): Locale {
  return isLocale(l) ? l : 'fr';
}

/** Texte traduit avec interpolation `{{nom}}` ; repli anglais puis français. */
export function serverT(locale: Locale, key: string, params: Record<string, string> = {}): string {
  const chain: Locale[] = locale === 'fr' ? ['fr'] : locale === 'en' ? ['en', 'fr'] : [locale, 'en', 'fr'];
  let text: string | undefined;
  for (const l of chain) {
    text = l === 'fr' ? lookup(fr as Tree, key) : lookup(readTree(join(I18N_DIR, `${l}.json`)), key);
    if (text !== undefined) break;
  }
  return (text ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => params[k] ?? '');
}

/** Nom localisé d'une nation ou d'une province (sinon le nom français fourni). */
export function placeName(
  locale: Locale,
  kind: 'nations' | 'provinces' | 'cities',
  id: string,
  frName: string,
): string {
  if (locale === 'fr') return frName;
  const names = readTree(join(NAMES_DIR, `${locale}.json`));
  const v = (names?.[kind] as Tree | undefined)?.[id];
  return typeof v === 'string' ? v : frName;
}
