/**
 * Liens vers les pages publiques prérendues (apps/site) : /<langue>/<slug>/. Les slugs viennent des
 * contenus du site (seule la clé `slugs` est importée, le reste du fichier n'entre pas dans le bundle).
 * Langue de l'interface sans pages publiques construites : repli sur l'anglais, puis le français.
 * Ajouter ici une langue dès que content/<langue>/site.json existe.
 */
import { slugs as frSlugs } from '../../../site/content/fr/site.json';
import { slugs as enSlugs } from '../../../site/content/en/site.json';
import { slugs as esSlugs } from '../../../site/content/es/site.json';
import { slugs as deSlugs } from '../../../site/content/de/site.json';
import { slugs as ptSlugs } from '../../../site/content/pt/site.json';
import { slugs as trSlugs } from '../../../site/content/tr/site.json';
import { slugs as ruSlugs } from '../../../site/content/ru/site.json';
import { slugs as arSlugs } from '../../../site/content/ar/site.json';

type Slugs = typeof frSlugs;
const SLUGS: Record<string, Slugs> = {
  fr: frSlugs,
  en: enSlugs,
  es: esSlugs,
  de: deSlugs,
  pt: ptSlugs,
  tr: trSlugs,
  ru: ruSlugs,
  ar: arSlugs,
};

export type PublicPage =
  'home' | 'howto' | 'features' | 'nations' | 'arsenal' | 'faq' | keyof Slugs['legal'];

export function publicPageUrl(page: PublicPage, lang = 'fr'): string {
  const code = SLUGS[lang] ? lang : lang.startsWith('fr') ? 'fr' : 'en';
  const s = SLUGS[code]!;
  if (page === 'home') return `/${code}/`;
  if (page in s.legal) return `/${code}/${s.legal[page as keyof Slugs['legal']]}/`;
  return `/${code}/${s[page as 'howto' | 'features' | 'nations' | 'arsenal' | 'faq']}/`;
}
