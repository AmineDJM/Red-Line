/**
 * Domaines traduits : fichiers sources français → un fichier par langue cible. L'état incrémental
 * (empreinte de la source de chaque clé traduite) vit dans `tools/i18n/state/<domaine>/<langue>.json`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, type Locale } from '@redline/shared';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = join(TOOL_DIR, '..', '..');
export const CLIENT_I18N = join(REPO, 'apps/client/src/i18n');
export const SERVER_I18N = join(REPO, 'apps/server/src/i18n');

export const TARGETS: Locale[] = LOCALES.filter((l) => l !== 'fr');

/** Nom anglais de la langue (consigne du modèle). */
export const LANG_LABEL: Record<Locale, string> = {
  fr: 'French',
  en: 'English (US)',
  ar: 'Modern Standard Arabic',
  es: 'Spanish (Spain, neutral international)',
  tr: 'Turkish',
  de: 'German',
  pt: 'Brazilian Portuguese',
  ru: 'Russian',
  it: 'Italian',
  zh: 'Simplified Chinese (Mainland China)',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi (Devanagari)',
  id: 'Indonesian',
  pl: 'Polish',
};

export interface Domain {
  id: string;
  /** Fichiers sources (fusionnés dans l'ordre). */
  sources: string[];
  /** Fichier produit pour une langue. */
  out: (lang: Locale) => string;
  /** Modèle (le moins cher qui reste bon pour ce type de texte). */
  model: string;
  /** Contexte donné au modèle pour ce domaine. */
  context: string;
  /** Taille cible d'un lot (caractères de source). */
  batchChars: number;
}

export const DOMAINS: Domain[] = [
  {
    id: 'client',
    sources: [
      join(CLIENT_I18N, 'fr.json'),
      join(CLIENT_I18N, 'fr.map.json'),
      join(CLIENT_I18N, 'fr.features.json'),
      join(CLIENT_I18N, 'fr.locale.json'),
      join(CLIENT_I18N, 'fr.engine.json'),
      join(CLIENT_I18N, 'fr.news.json'),
    ],
    out: (l) => join(CLIENT_I18N, 'locales', `${l}.json`),
    model: 'gemini-3.5-flash-lite',
    context:
      'User-interface strings of the game client (menus, windows, tooltips, map labels, alerts, ' +
      'news-wire dispatch templates under "news.*", engine notifications under "engine.*"). ' +
      'The JSON key path tells you where the text appears: keys containing "short" or ending in ' +
      '"Short" are tiny labels; keys containing "path" are lowercase terminal path segments.',
    batchChars: 7000,
  },
  {
    id: 'data',
    sources: [join(CLIENT_I18N, 'fr.data.json')],
    out: (l) => join(CLIENT_I18N, 'data', `${l}.json`),
    model: 'gemini-3.5-flash-lite',
    context:
      'Game data: research-tree node names and descriptions, technical sheet lines of real weapon ' +
      'systems (engines, speeds: keep designations, numbers and units), unit nouns, scenario names.',
    batchChars: 7000,
  },
  {
    id: 'nations',
    sources: [join(CLIENT_I18N, 'fr.nations.json')],
    out: (l) => join(CLIENT_I18N, 'nations', `${l}.json`),
    // Longs textes descriptifs : modèle le moins cher (qualité suffisante pour de la prose simple).
    model: 'gemini-3.5-flash-lite',
    context:
      'Short factual descriptions of real countries armed forces and their military doctrine, ' +
      'shown on the nation selection screen. Keep facts, numbers and proper names exact.',
    batchChars: 9000,
  },
  {
    id: 'server',
    sources: [join(SERVER_I18N, 'fr.json')],
    out: (l) => join(SERVER_I18N, 'locales', `${l}.json`),
    model: 'gemini-3.5-flash-lite',
    context: 'Short push notifications sent by the game server to absent players.',
    batchChars: 7000,
  },
];

export const stateFile = (domain: string, lang: Locale) =>
  join(TOOL_DIR, 'state', domain, `${lang}.json`);
