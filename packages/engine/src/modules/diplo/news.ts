import type { LngLat, NationId, NewsCategory, NewsItem } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { notify } from '../../state/access.js';
import { cfg, ds, nationName } from './state.js';

/**
 * Fil d'actualité mondial : dépêches sobres en français, générées à partir des événements du jeu.
 * Le choix du gabarit est déterministe (empreinte du numéro de dépêche), sans consommer le PRNG.
 * Style « dépêche » (nations séparées par une barre oblique, deux-points) : pas d'article à accorder.
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
      'Guerre ouverte : {A} contre {B}',
      '{A} franchit la ligne rouge : état de guerre avec {B}',
      'Rupture diplomatique totale : {A} / {B}',
    ],
    b: [
      "Les chancelleries confirment l'état de guerre. Agresseur désigné : {A}.",
      'Premiers mouvements de troupes signalés. {B} dénonce une agression de {A}.',
      "Les appels au calme se multiplient après l'ouverture des hostilités par {A}.",
    ],
  },
  war_alliance: {
    cat: 'war',
    h: [
      '{X} : {A} entre en guerre contre {B} au nom de la défense mutuelle',
      'Défense mutuelle activée : {A} rejoint le conflit face à {B}',
      "Solidarité d'alliance : {A} déclare la guerre à {B}",
    ],
    b: [
      "{A} honore la charte de l'alliance {X} après l'agression d'un membre.",
      "La clause de défense mutuelle de l'alliance {X} élargit le conflit.",
    ],
  },
  peace: {
    cat: 'peace',
    h: [
      '{A} / {B} : un traité de paix est signé',
      'Fin des hostilités entre {A} et {B}',
      'Paix conclue : {A} / {B}',
    ],
    b: [
      "Les délégations ont paraphé l'accord. Les troupes disposent d'un délai pour se retirer.",
      'Le traité prévoit le retrait des forces engagées sur le territoire adverse.',
    ],
  },
  ceasefire: {
    cat: 'peace',
    h: [
      '{A} / {B} : cessez-le-feu en vigueur',
      'Les armes se taisent : trêve entre {A} et {B}',
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
      '{A} viole le cessez-le-feu avec {B}',
      'Trêve rompue : {A} reprend les hostilités contre {B}',
      'Violation du cessez-le-feu : {A} mis en cause',
    ],
    b: [
      'La communauté internationale condamne la rupture de la trêve. Un vote de sanctions est engagé.',
      'Le Conseil de sécurité est saisi automatiquement de la violation commise par {A}.',
    ],
  },
  alliance_created: {
    cat: 'alliance',
    h: [
      'Nouvelle alliance : {X}, sous la conduite de {A}',
      '{A} fonde l’alliance {X}',
      'Recomposition stratégique : naissance de {X}',
    ],
    b: ['Charte : {Y}.', 'Le nouveau bloc est dirigé par {A}. Charte : {Y}.'],
  },
  alliance_joined: {
    cat: 'alliance',
    h: ['{A} rejoint l’alliance {X}', '{X} s’élargit : adhésion de {A}', 'Adhésion : {A} / {X}'],
    b: ["L'alliance compte désormais {Y} membres.", '{A} signe la charte de {X}.'],
  },
  alliance_left: {
    cat: 'alliance',
    h: ['{A} quitte l’alliance {X}', 'Départ fracassant : {A} / {X}', '{X} perd un membre : {A}'],
    b: ['Le retrait de {A} fragilise {X}.', 'Les partenaires de {A} prennent acte de son départ.'],
  },
  alliance_expelled: {
    cat: 'alliance',
    h: ['{X} exclut {A}', 'Exclusion : {A} n’est plus membre de {X}'],
    b: ["Les membres de {X} ont voté l'exclusion de {A}."],
  },
  leader_replaced: {
    cat: 'alliance',
    h: ['{X} : {A} prend la tête de l’alliance', 'Changement de direction à la tête de {X}'],
    b: ["Les membres de {X} ont désigné {A} comme nouveau chef de l'alliance."],
  },
  mutual_skipped: {
    cat: 'alliance',
    h: ['{X} renonce à la défense mutuelle face à {A}', 'Défense mutuelle suspendue : {X} / {A}'],
    b: ["Les membres de {X} ont voté la dispense : aucune entrée en guerre automatique contre {A}."],
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
      'Conseil de sécurité : {X} adopté(e) contre {A}',
      'Résolution adoptée : {X} ({A})',
      '{A} visé par une résolution : {X}',
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
    b: ['Le projet présenté par {A} n’a pas recueilli la majorité requise.'],
  },
  resolution_vetoed: {
    cat: 'council',
    h: ['Veto au Conseil de sécurité : {X} bloqué(e)', '{A} oppose son veto : {X}'],
    b: ['Le veto de {A} empêche l’adoption du texte.'],
  },
  strike: {
    cat: 'strike',
    h: [
      'Frappes {X} de {A} signalées près de {P}',
      '{B} : frappes {X} près de {P}',
      '{A} / {B} : nouvelles frappes {X}',
    ],
    b: [
      'Des explosions ont été entendues près de {P}. {B} accuse {A}.',
      'Bilan en cours d’évaluation après des frappes {X} près de {P}.',
    ],
  },
  nuclear: {
    cat: 'nuclear',
    h: [
      'Détonation nucléaire près de {P}',
      'Le tabou nucléaire est brisé : {A} frappe {B}',
      'Frappe nucléaire : le monde sous le choc',
    ],
    b: [
      "Une arme nucléaire a été employée par {A} près de {P}. L'alerte mondiale est maximale.",
      'Les capitales condamnent unanimement l’emploi de l’arme atomique par {A}.',
    ],
  },
  battle: {
    cat: 'war',
    h: ['Combats violents près de {P}', 'Bataille près de {P} : {A} l’emporte', 'Front : {P}'],
    b: ['Belligérants : {X}.', 'Les combats ont opposé {X}. Avantage : {A}.'],
  },
  capital: {
    cat: 'capture',
    h: [
      'La capitale de {B} tombe aux mains de {A}',
      '{P} : la capitale de {B} est prise par {A}',
      'Coup de tonnerre : {A} s’empare de {P}',
    ],
    b: [
      'Le gouvernement de {B} aurait quitté {P}.',
      'La chute de {P} marque un tournant dans le conflit.',
    ],
  },
  capture: {
    cat: 'capture',
    h: ['{A} prend le contrôle de {P}', '{P} passe sous contrôle de {A}'],
    b: ['{B} perd la province de {P}.'],
  },
  agent_caught: {
    cat: 'leak',
    h: [
      'Affaire d’espionnage : {B} accuse {A}',
      'Un agent de {A} arrêté par {B}',
      'Espionnage : incident diplomatique entre {A} et {B}',
    ],
    b: ['{B} dénonce une opération de renseignement menée par {A} sur son sol.'],
  },
  blockade: {
    cat: 'economy',
    h: ['Blocus : {A} verrouille {P}', 'Le trafic maritime perturbé : blocus de {P}'],
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
      'Troubles à {P} : manifestations contre le pouvoir de {B}',
      '{B} : émeutes à {P}',
      'Agitation à {P}',
    ],
    b: [
      'Des milliers de manifestants défient les autorités de {B}.',
      'Les forces de l’ordre de {B} sont déployées à {P}.',
    ],
  },
  revolt_disputed: {
    cat: 'revolt',
    h: [
      '{X} : révolte à {P} contre {B}',
      'Territoire disputé : soulèvement populaire à {P}',
      '{X} : la tension monte à {P}',
    ],
    b: [
      'Dans ce territoire revendiqué par {Y}, la population conteste l’autorité de {B}.',
      'La région de {X} renoue avec la violence. Détenteur : {B}.',
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
      'Des combattants rebelles défient l’armée de {B}.',
      'Les insurgés contrôleraient plusieurs axes autour de {P}.',
    ],
  },
  coup: {
    cat: 'coup',
    h: ['Coup d’État : {A}', '{A} : l’armée prend le pouvoir', '{A} : le gouvernement renversé'],
    b: [
      'Une junte annonce la suspension des institutions. La politique étrangère de {A} change de cap.',
      'Après des semaines d’instabilité, les militaires s’emparent du pouvoir.',
    ],
  },
  refugees: {
    cat: 'refugees',
    h: ['Afflux de réfugiés fuyant {A}', 'Crise humanitaire : les civils fuient {A}', 'Exode : {A}'],
    b: [
      'Pays d’accueil sous pression : {X}.',
      'Les frontières de {X} voient affluer des familles fuyant les combats.',
    ],
  },
  embargo_import_blocked: {
    cat: 'economy',
    h: ['Embargo : {A} privé d’achats d’armement'],
    b: ['Les fournisseurs se conforment à la résolution du Conseil.'],
  },
  black_market: {
    cat: 'economy',
    h: ['Trafic d’armes : {A} mis en cause', 'Marché noir : une filière vers {A} démantelée'],
    b: ['Des livraisons illicites à destination de {A} ont été repérées.'],
  },
  peacekeepers: {
    cat: 'council',
    h: ['Déploiement de casques bleus : {P}', 'Force de maintien de la paix déployée à {P}'],
    b: ['Les casques bleus prennent position. Les attaquer vaudrait condamnation.'],
  },
  peacekeepers_attacked: {
    cat: 'council',
    h: ['Casques bleus attaqués : {A} mis en cause', '{A} ouvre le feu sur les casques bleus'],
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
    h: ['Pandémie : l’alerte sanitaire est déclenchée', 'Épidémie mondiale : les industries ralentissent'],
    b: ['{X}', 'Les chaînes de production tournent au ralenti. {X}'],
  },
  arms_fair: {
    cat: 'economy',
    h: ['Salon international de l’armement', 'Grand salon de défense : les prix baissent'],
    b: ['{X}', 'Les industriels multiplient les offres promotionnelles. {X}'],
  },
  mercenaries: {
    cat: 'war',
    h: ['Des sociétés militaires privées signalées à {P}'],
    b: ['Des combattants sous contrat auraient été engagés par {A}.'],
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
}

function fill(tpl: string, state: EngineState, v: NewsVars): string {
  return tpl
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
  const headline = fill(t.h[hh % t.h.length]!, state, vars);
  const body = fill(t.b[(hh >>> 8) % t.b.length]!, state, vars).trim();
  return pushNews(state, t.cat, headline, body, at, nations);
}

/** Ajoute une dépêche déjà rédigée (signal `news`, fuite). */
export function pushNews(
  state: EngineState,
  category: NewsCategory,
  headline: string,
  body: string,
  at: LngLat | null,
  nations: NationId[],
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
  };
  d.news.push(item);
  const keep = cfg(state).newsKeep;
  if (d.news.length > keep) d.news.splice(0, d.news.length - keep);
  notify(state, { kind: 'news', time: state.time, newsId: item.id, at: item.at }, null);
  return item;
}
