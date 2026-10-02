import {
  frA,
  frAgree,
  frCap,
  frDe,
  frLe,
  loc,
  type LocParam,
  type LocText,
  type LngLat,
  type NationId,
  type NewsCategory,
  type NewsItem,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { notify } from '../../state/access.js';
import { cfg, ds, nationArticle, nationName } from './state.js';

/**
 * Fil d'actualité mondial : dépêches sobres en français, générées à partir des événements du jeu.
 * Le choix du gabarit est déterministe (empreinte du numéro de dépêche), sans consommer le PRNG.
 * Noms de pays : `{A}` nu (style « dépêche » : « Maroc / Algérie : … »), `{le:A}` / `{Le:A}` (« le Maroc »,
 * « Le Maroc » en début de phrase), `{de:A}` (« du Maroc ») et `{a:A}` (« au Maroc ») : l'article vient
 * des données (`NationDef.article`). Verbe accordé en nombre par `{s:A:attaque|attaquent}` (« les
 * États-Unis attaquent ») ; jamais d'accord en genre sur le nom du pays (« mise en cause du… »).
 */
interface Template {
  cat: NewsCategory;
  h: string[];
  b: string[];
}

export const TEMPLATES = {
  war: {
    cat: 'war',
    h: [
      '{A} / {B} : les hostilités sont ouvertes',
      'Guerre ouverte : {le:A} contre {le:B}',
      '{Le:A} {s:A:franchit|franchissent} la ligne rouge : état de guerre avec {le:B}',
      'Rupture diplomatique totale : {A} / {B}',
    ],
    b: [
      "Les chancelleries confirment l'état de guerre. Agresseur désigné : {le:A}.",
      'Premiers mouvements de troupes signalés. {Le:B} {s:B:dénonce|dénoncent} une agression {de:A}.',
      "Les appels au calme se multiplient après l'ouverture des hostilités par {le:A}.",
    ],
  },
  war_alliance: {
    cat: 'war',
    h: [
      '{X} : {le:A} {s:A:entre|entrent} en guerre contre {le:B} au nom de la défense mutuelle',
      'Défense mutuelle activée : {le:A} {s:A:rejoint|rejoignent} le conflit face {a:B}',
      "Solidarité d'alliance : {le:A} {s:A:déclare|déclarent} la guerre {a:B}",
    ],
    b: [
      "{Le:A} {s:A:honore|honorent} la charte de l'alliance {X} après l'agression d'un membre.",
      "La clause de défense mutuelle de l'alliance {X} élargit le conflit.",
    ],
  },
  peace: {
    cat: 'peace',
    h: [
      '{A} / {B} : un traité de paix est signé',
      'Fin des hostilités entre {le:A} et {le:B}',
      'Paix conclue : {A} / {B}',
    ],
    b: [
      "Les délégations ont paraphé l'accord. Les troupes disposent d'un délai pour se retirer.",
      'Le traité prévoit le retrait des forces engagées sur le territoire adverse.',
    ],
  },
  peace_annexation: {
    cat: 'peace',
    h: [
      '{A} / {B} : la paix entérine les conquêtes {de:A}',
      'Traité de paix : {le:B} {s:B:cède|cèdent} {X} province(s) {a:A}',
      'Fin de la guerre : les frontières {de:B} redessinées',
    ],
    b: [
      'Les territoires occupés restent sous le contrôle {de:A} : {X} province(s) changent de main.',
      '{Le:B} {s:B:signe|signent} la paix sans récupérer les {X} province(s) perdues.',
    ],
  },
  capitulation: {
    cat: 'peace',
    h: [
      '{Le:B} {s:B:capitule|capitulent} face {a:A}',
      'Capitulation {de:B} : {le:A} {s:A:impose|imposent} la paix',
      'Défaite {de:B} : armistice signé avec {le:A}',
    ],
    b: [
      'Sa capitale tombée, le gouvernement {de:B} accepte les conditions {de:A}. {X} province(s) passent sous son contrôle.',
      'Les forces {de:B} déposent les armes. {Le:A} {s:A:annexe|annexent} {X} province(s).',
    ],
  },
  ceasefire: {
    cat: 'peace',
    h: [
      '{A} / {B} : cessez-le-feu en vigueur',
      'Les armes se taisent : trêve entre {le:A} et {le:B}',
      'Cessez-le-feu conclu : {A} / {B}',
    ],
    b: [
      'La trêve gèle les lignes de front. Toute violation exposerait son auteur à des sanctions.',
      'Les observateurs internationaux saluent un premier pas. Durée prévue : {X} jours.',
    ],
  },
  ceasefire_violated: {
    cat: 'war',
    h: [
      '{Le:A} {s:A:viole|violent} le cessez-le-feu avec {le:B}',
      'Trêve rompue : {le:A} {s:A:reprend|reprennent} les hostilités contre {le:B}',
      'Violation du cessez-le-feu : mise en cause {de:A}',
    ],
    b: [
      'La communauté internationale condamne la rupture de la trêve. Un vote de sanctions est engagé.',
      'Le Conseil de sécurité est saisi automatiquement de la violation commise par {le:A}.',
    ],
  },
  alliance_created: {
    cat: 'alliance',
    h: [
      'Nouvelle alliance : {X}, sous la conduite {de:A}',
      '{Le:A} {s:A:fonde|fondent} l’alliance {X}',
      'Recomposition stratégique : naissance de {X}',
    ],
    b: ['Charte : {Y}.', 'Le nouveau bloc est dirigé par {le:A}. Charte : {Y}.'],
  },
  alliance_joined: {
    cat: 'alliance',
    h: [
      '{Le:A} {s:A:rejoint|rejoignent} l’alliance {X}',
      '{X} s’élargit : adhésion {de:A}',
      'Adhésion : {A} / {X}',
    ],
    b: ["L'alliance compte désormais {Y} membres.", '{Le:A} {s:A:signe|signent} la charte de {X}.'],
  },
  alliance_left: {
    cat: 'alliance',
    h: [
      '{Le:A} {s:A:quitte|quittent} l’alliance {X}',
      'Départ fracassant : {A} / {X}',
      '{X} perd un membre : {le:A}',
    ],
    b: [
      'Le retrait {de:A} fragilise {X}.',
      'Les partenaires {de:A} prennent acte de {s:A:son|leur} départ.',
    ],
  },
  alliance_expelled: {
    cat: 'alliance',
    h: [
      '{X} exclut {le:A}',
      'Exclusion : {le:A} {s:A:n’est plus membre|ne sont plus membres} de {X}',
    ],
    b: ["Les membres de {X} ont voté l'exclusion {de:A}."],
  },
  leader_replaced: {
    cat: 'alliance',
    h: [
      '{X} : {le:A} {s:A:prend|prennent} la tête de l’alliance',
      'Changement de direction à la tête de {X}',
    ],
    b: ["Les membres de {X} ont désigné {le:A} comme nouveau chef de l'alliance."],
  },
  mutual_skipped: {
    cat: 'alliance',
    h: ['{X} renonce à la défense mutuelle face {a:A}', 'Défense mutuelle suspendue : {X} / {A}'],
    b: [
      'Les membres de {X} ont voté la dispense : aucune entrée en guerre automatique contre {le:A}.',
    ],
  },
  council_open: {
    cat: 'council',
    h: [
      'Conseil de sécurité : ouverture de la séance',
      'Le Conseil de sécurité se réunit',
      'Séance du Conseil de sécurité : {X} texte(s) au vote',
    ],
    b: [
      '{X} projet(s) de résolution soumis au vote. Membres : {Y}.',
      'Les délégations disposent de la fenêtre de vote pour se prononcer sur {X} texte(s).',
    ],
  },
  emergency_council: {
    cat: 'council',
    h: ['Réunion d’urgence du Conseil de sécurité', 'Le Conseil de sécurité convoqué en urgence'],
    b: ['{X}', 'La présidence convoque les membres sans délai. {X}'],
  },
  resolution_passed: {
    cat: 'council',
    h: [
      'Conseil de sécurité : {X} adopté(e) contre {le:A}',
      'Résolution adoptée : {X} ({A})',
      'Résolution visant {le:A} : {X}',
    ],
    b: ['Le texte entre en vigueur pour {Y} jour(s).', 'Vote : {Y}.'],
  },
  resolution_zone_passed: {
    cat: 'council',
    h: ['Conseil de sécurité : {X} adopté(e)', 'Résolution adoptée : {X}'],
    b: ['Zone concernée : {Y}.', 'Le dispositif couvre : {Y}.'],
  },
  resolution_rejected: {
    cat: 'council',
    h: ['Conseil de sécurité : {X} rejeté(e)', 'Pas de majorité pour {X}'],
    b: ['Le projet présenté par {le:A} n’a pas recueilli la majorité requise.'],
  },
  resolution_vetoed: {
    cat: 'council',
    h: [
      'Veto au Conseil de sécurité : {X} bloqué(e)',
      '{Le:A} {s:A:oppose son|opposent leur} veto : {X}',
    ],
    b: ['Le veto {de:A} empêche l’adoption du texte.'],
  },
  strike: {
    cat: 'strike',
    h: [
      'Frappes {X} {de:A} signalées près de {P}',
      '{B} : frappes {X} près de {P}',
      '{A} / {B} : nouvelles frappes {X}',
    ],
    b: [
      'Des explosions ont été entendues près de {P}. {Le:B} {s:B:accuse|accusent} {le:A}.',
      'Bilan en cours d’évaluation après des frappes {X} près de {P}.',
    ],
  },
  nuclear: {
    cat: 'nuclear',
    h: [
      'Détonation nucléaire près de {P}',
      'Le tabou nucléaire est brisé : {le:A} {s:A:frappe|frappent} {le:B}',
      'Frappe nucléaire : le monde sous le choc',
    ],
    b: [
      "Une arme nucléaire a été employée par {le:A} près de {P}. L'alerte mondiale est maximale.",
      'Les capitales condamnent unanimement l’emploi de l’arme atomique par {le:A}.',
    ],
  },
  battle: {
    cat: 'war',
    h: [
      'Combats violents près de {P}',
      'Bataille près de {P} : {le:A} {s:A:l’emporte|l’emportent}',
      'Front : {P}',
    ],
    b: ['Belligérants : {X}.', 'Les combats ont opposé {X}. Avantage : {le:A}.'],
  },
  capital: {
    cat: 'capture',
    h: [
      'La capitale {de:B} tombe aux mains {de:A}',
      '{P} : la capitale {de:B} est prise par {le:A}',
      'Coup de tonnerre : {le:A} {s:A:s’empare|s’emparent} de {P}',
    ],
    b: [
      'Le gouvernement {de:B} aurait quitté {P}.',
      'La chute de {P} marque un tournant dans le conflit.',
    ],
  },
  capture: {
    cat: 'capture',
    h: ['{Le:A} {s:A:prend|prennent} le contrôle de {P}', '{P} passe sous le contrôle {de:A}'],
    b: ['{Le:B} {s:B:perd|perdent} la province de {P}.'],
  },
  agent_caught: {
    cat: 'leak',
    h: [
      'Affaire d’espionnage : {le:B} {s:B:accuse|accusent} {le:A}',
      'Un agent {de:A} arrêté par {le:B}',
      'Espionnage : incident diplomatique entre {le:A} et {le:B}',
    ],
    b: [
      '{Le:B} {s:B:dénonce|dénoncent} une opération de renseignement menée par {le:A} sur {s:B:son|leur} sol.',
    ],
  },
  blockade: {
    cat: 'economy',
    h: [
      'Blocus : {le:A} {s:A:verrouille|verrouillent} {P}',
      'Le trafic maritime perturbé : blocus de {P}',
    ],
    b: ['Les échanges commerciaux sont fortement ralentis autour de {P}.'],
  },
  blockade_lifted: {
    cat: 'economy',
    h: ['Levée du blocus de {P}'],
    b: ['Le trafic reprend progressivement autour de {P}.'],
  },
  revolt: {
    cat: 'revolt',
    h: [
      'Troubles à {P} : manifestations contre le pouvoir {de:B}',
      '{B} : émeutes à {P}',
      'Agitation à {P}',
    ],
    b: [
      'Des milliers de manifestants défient les autorités {de:B}.',
      'Les forces de l’ordre {de:B} sont déployées à {P}.',
    ],
  },
  revolt_disputed: {
    cat: 'revolt',
    h: [
      '{X} : révolte à {P} contre {le:B}',
      'Territoire disputé : soulèvement populaire à {P}',
      '{X} : la tension monte à {P}',
    ],
    b: [
      'Dans ce territoire revendiqué par {Y}, la population conteste l’autorité {de:B}.',
      'La région de {X} renoue avec la violence. Détenteur : {le:B}.',
    ],
  },
  uprising: {
    cat: 'revolt',
    h: [
      'Soulèvement armé à {P}',
      '{B} : des groupes armés prennent les armes à {P}',
      'Insurrection à {P}',
    ],
    b: [
      'Des combattants rebelles défient l’armée {de:B}.',
      'Les insurgés contrôleraient plusieurs axes autour de {P}.',
    ],
  },
  rallied: {
    cat: 'revolt',
    h: [
      '{P} : les insurgés se rallient {a:A}',
      'Territoire disputé : {P} passe sous le contrôle {de:A}',
    ],
    b: ['Après la chute des autorités {de:B}, les insurgés ont proclamé leur ralliement {a:A}.'],
  },
  coup: {
    cat: 'coup',
    h: ['Coup d’État : {A}', '{A} : l’armée prend le pouvoir', '{A} : le gouvernement renversé'],
    b: [
      'Une junte annonce la suspension des institutions. La politique étrangère {de:A} change de cap.',
      'Après des semaines d’instabilité, les militaires s’emparent du pouvoir.',
    ],
  },
  refugees: {
    cat: 'refugees',
    h: [
      'Afflux de réfugiés fuyant {le:A}',
      'Crise humanitaire : les civils fuient {le:A}',
      'Exode : {A}',
    ],
    b: [
      'Pays d’accueil sous pression : {X}.',
      'Les pays voisins voient affluer des familles fuyant les combats : {X}.',
    ],
  },
  embargo_import_blocked: {
    cat: 'economy',
    h: ['Embargo : achats d’armement interdits {a:A}'],
    b: ['Les fournisseurs se conforment à la résolution du Conseil.'],
  },
  black_market: {
    cat: 'economy',
    h: [
      'Trafic d’armes : mise en cause {de:A}',
      'Marché noir : une filière vers {le:A} démantelée',
    ],
    b: ['Des livraisons illicites à destination {de:A} ont été repérées.'],
  },
  peacekeepers: {
    cat: 'council',
    h: ['Déploiement de casques bleus : {P}', 'Force de maintien de la paix déployée à {P}'],
    b: ['Les casques bleus prennent position. Les attaquer vaudrait condamnation.'],
  },
  peacekeepers_attacked: {
    cat: 'council',
    h: [
      'Casques bleus attaqués : mise en cause {de:A}',
      '{Le:A} {s:A:ouvre|ouvrent} le feu sur les casques bleus',
    ],
    b: ['Le Conseil de sécurité est saisi. Des sanctions sont mises au vote.'],
  },
  oil_crisis: {
    cat: 'economy',
    h: ['Choc pétrolier : les cours s’envolent', 'Crise pétrolière mondiale'],
    b: ['{X}', 'Les économies dépendantes des hydrocarbures accusent le coup. {X}'],
  },
  market_crash: {
    cat: 'economy',
    h: ['Krach boursier mondial', 'Les marchés s’effondrent'],
    b: ['{X}', 'Les budgets publics sont sous pression. {X}'],
  },
  pandemic: {
    cat: 'event',
    h: [
      'Pandémie : l’alerte sanitaire est déclenchée',
      'Épidémie mondiale : les industries ralentissent',
    ],
    b: ['{X}', 'Les chaînes de production tournent au ralenti. {X}'],
  },
  arms_fair: {
    cat: 'economy',
    h: ['Salon international de l’armement', 'Grand salon de défense : les prix baissent'],
    b: ['{X}', 'Les industriels multiplient les offres promotionnelles. {X}'],
  },
  ultimatum: {
    cat: 'war',
    h: [
      'Ultimatum {de:A} {a:B}',
      '{Le:A} {s:A:adresse|adressent} un ultimatum {a:B}',
      'Tension extrême : {le:A} {s:A:menace|menacent} {le:B}',
    ],
    b: [
      "{Le:A} {s:A:exige|exigent} des concessions sous {X} heures, sous peine d'intervention militaire. Des troupes sont massées à la frontière.",
      'Des concentrations de troupes {de:A} sont signalées près {de:B}. Échéance : {X} heures.',
    ],
  },
  deescalation: {
    cat: 'peace',
    h: ["{Le:A} {s:A:renonce|renoncent} à l'ultimatum adressé {a:B}", 'Désescalade : {A} / {B}'],
    b: [
      'Le rapport de force a changé : les troupes massées à la frontière regagnent leurs casernes.',
      "Les chancelleries saluent le recul {de:A} : la menace n'a pas été mise à exécution.",
    ],
  },
  mercenaries: {
    cat: 'war',
    h: ['Des sociétés militaires privées signalées à {P}'],
    b: ['Des combattants sous contrat auraient été engagés par {le:A}.'],
  },
} satisfies Record<string, Template>;

export type NewsKind = keyof typeof TEMPLATES;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface NewsVars {
  A?: NationId;
  B?: NationId;
  /** Lieu (nom de province). */
  P?: string;
  X?: string;
  Y?: string;
  /**
   * Équivalents structurés de P, X, Y pour la dépêche localisée (`NewsItem.loc`) : province, liste
   * de nations, libellé traduit… À défaut, la chaîne française est transmise telle quelle.
   */
  loc?: { P?: LocParam; X?: LocParam; Y?: LocParam };
}

/** Liste de nations (paramètre localisable). */
export function locNations(ns: readonly NationId[]): LocParam {
  return { list: ns.map((n) => ({ nation: n })) };
}

/** Paramètres de la dépêche localisée (gabarit `news.<type>.h<n>` du client). */
function locParams(v: NewsVars): Record<string, LocParam> {
  const p: Record<string, LocParam> = {};
  if (v.A) p.A = { nation: v.A };
  if (v.B) p.B = { nation: v.B };
  for (const k of ['P', 'X', 'Y'] as const) {
    const val = v.loc?.[k] ?? v[k];
    if (val !== undefined) p[k] = val;
  }
  return p;
}

/** Élision devant une voyelle (« de Ukraine » → « d’Ukraine »), sans toucher au h aspiré. */
export function elide(s: string): string {
  return s.replace(/\b([Dd])e ([AEIOUÉÈÊÂÎÔaeiouéèêâîô])/g, '$1’$2');
}

/** Remplit un gabarit de dépêche (noms de pays accordés, élision). */
export function fill(tpl: string, state: EngineState, v: NewsVars): string {
  return elide(fill0(tpl, state, v));
}

function form(state: EngineState, f: string, n: NationId): string {
  const name = nationName(state, n);
  const art = nationArticle(state, n);
  if (f === 'de') return frDe(name, art);
  if (f === 'a') return frA(name, art);
  const le = frLe(name, art);
  return f === 'Le' ? frCap(le) : le;
}

function fill0(tpl: string, state: EngineState, v: NewsVars): string {
  return tpl
    .replace(/\{(le|Le|de|a):([AB])\}/g, (_m, f: string, k: 'A' | 'B') =>
      v[k] ? form(state, f, v[k]) : '—',
    )
    .replace(/\{s:([AB]):([^|}]*)\|([^}]*)\}/g, (_m, k: 'A' | 'B', sg: string, pl: string) =>
      v[k] ? frAgree(nationArticle(state, v[k]), sg, pl) : sg,
    )
    .replace(/\{A\}/g, v.A ? nationName(state, v.A) : '—')
    .replace(/\{B\}/g, v.B ? nationName(state, v.B) : '—')
    .replace(/\{P\}/g, v.P ?? '—')
    .replace(/\{X\}/g, v.X ?? '')
    .replace(/\{Y\}/g, v.Y ?? '');
}

/**
 * Anti-répétition : vrai si la clé n'a pas été utilisée depuis `minGapMs` (et la marque).
 */
export function throttled(state: EngineState, key: string, minGapMs: number): boolean {
  const d = ds(state);
  const last = d.throttle[key];
  if (last !== undefined && state.time - last < minGapMs) return true;
  d.throttle[key] = state.time;
  return false;
}

/** Ajoute une dépêche générée à partir d'un gabarit. */
export function news(
  state: EngineState,
  kind: NewsKind,
  vars: NewsVars,
  at: LngLat | null,
  nations: NationId[],
): NewsItem {
  const t: Template = TEMPLATES[kind];
  const d = ds(state);
  const seq = d.newsSeq + 1;
  const hh = hash(`${kind}:${seq}`);
  const hi = hh % t.h.length;
  const bi = (hh >>> 8) % t.b.length;
  const headline = fill(t.h[hi]!, state, vars);
  const body = fill(t.b[bi]!, state, vars).trim();
  const params = locParams(vars);
  return pushNews(state, t.cat, headline, body, at, nations, {
    headline: loc(`news.${kind}.h${hi}`, params),
    body: loc(`news.${kind}.b${bi}`, params),
  });
}

/** Ajoute une dépêche déjà rédigée (signal `news`, fuite). */
export function pushNews(
  state: EngineState,
  category: NewsCategory,
  headline: string,
  body: string,
  at: LngLat | null,
  nations: NationId[],
  locText?: { headline: LocText; body: LocText },
): NewsItem {
  const d = ds(state);
  const item: NewsItem = {
    id: `n${++d.newsSeq}`,
    time: state.time,
    category,
    headline,
    body,
    at: at ? [at[0], at[1]] : null,
    nations: [...new Set(nations)].sort(),
    ...(locText ? { loc: locText } : {}),
  };
  d.news.push(item);
  const keep = cfg(state).newsKeep;
  if (d.news.length > keep) d.news.splice(0, d.news.length - keep);
  notify(state, { kind: 'news', time: state.time, newsId: item.id, at: item.at }, null);
  return item;
}
