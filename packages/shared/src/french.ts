/**
 * Grammaire française des noms de pays : article défini, contractions (« du », « au », « des »,
 * « aux ») et élision (« d'Israël », « l'Algérie »). Fonctions pures, sans dépendance, utilisées par
 * le moteur (rapports, dépêches) et par les clients (gabarits i18n).
 *
 * L'article de chaque nation est une donnée (`NationDef.article` dans `data/map/nations.json`) :
 * « le » Maroc, « la » France, « l' » Algérie, « les » États-Unis, « » (aucun) pour Cuba, Israël…
 */
import { z } from 'zod';

export const FR_ARTICLES = ['le', 'la', "l'", 'les', ''] as const;
export const FrArticleSchema = z.enum(FR_ARTICLES);
export type FrArticle = z.infer<typeof FrArticleSchema>;

/** Commence par une voyelle ou un h muet (les noms à h aspiré portent leur article : la Hongrie). */
function vowelStart(name: string): boolean {
  return /^[aeiouhàâäéèêëîïôöùûüœæ]/i.test(name.trim());
}

/** Article par défaut quand la donnée manque : aucun article (« Maroc »), forme neutre la plus sûre. */
function art(article: FrArticle | string | null | undefined): FrArticle {
  return article && (FR_ARTICLES as readonly string[]).includes(article)
    ? (article as FrArticle)
    : '';
}

/** Nom précédé de son article : le Maroc, la France, l'Algérie, les États-Unis, Cuba. */
export function frLe(name: string, article?: FrArticle | string | null): string {
  const a = art(article);
  if (a === '') return name;
  if (a === "l'") return `l'${name}`;
  return `${a} ${name}`;
}

/** Complément introduit par « de » : du Maroc, de la France, de l'Algérie, des États-Unis, d'Israël. */
export function frDe(name: string, article?: FrArticle | string | null): string {
  switch (art(article)) {
    case 'le':
      return `du ${name}`;
    case 'les':
      return `des ${name}`;
    case 'la':
      return `de la ${name}`;
    case "l'":
      return `de l'${name}`;
    default:
      return vowelStart(name) ? `d'${name}` : `de ${name}`;
  }
}

/** Complément introduit par « à » : au Maroc, à la France, à l'Algérie, aux États-Unis, à Cuba. */
export function frA(name: string, article?: FrArticle | string | null): string {
  switch (art(article)) {
    case 'le':
      return `au ${name}`;
    case 'les':
      return `aux ${name}`;
    case 'la':
      return `à la ${name}`;
    case "l'":
      return `à l'${name}`;
    default:
      return `à ${name}`;
  }
}

/** Nom pluriel (« les États-Unis ») : le verbe s'accorde au pluriel (« les États-Unis attaquent »). */
export function frPlural(article?: FrArticle | string | null): boolean {
  return art(article) === 'les';
}

/** Choisit la forme du verbe (ou du possessif) selon le nombre : frAgree('les', 'a', 'ont') → « ont ». */
export function frAgree(
  article: FrArticle | string | null | undefined,
  sg: string,
  pl: string,
): string {
  return frPlural(article) ? pl : sg;
}

/** Première lettre en capitale (début de phrase) : « le Maroc » → « Le Maroc ». */
export function frCap(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Toutes les formes d'un nom de pays, prêtes pour l'interpolation (gabarits i18n). */
// Alias de type (et non interface) : assignable à Record<string, unknown> pour i18next.
export type FrNationForms = {
  /** Nom nu : « Maroc ». */
  nation: string;
  /** « le Maroc » (milieu de phrase). */
  nationLe: string;
  /** « Le Maroc » (début de phrase). */
  NationLe: string;
  /** « du Maroc ». */
  deNation: string;
  /** « au Maroc ». */
  aNation: string;
};

export function frForms(name: string, article?: FrArticle | string | null): FrNationForms {
  const le = frLe(name, article);
  return {
    nation: name,
    nationLe: le,
    NationLe: frCap(le),
    deNation: frDe(name, article),
    aNation: frA(name, article),
  };
}
