/**
 * Langues de l'interface.
 *
 * Source : le français (`fr.json`, `fr.map.json`, `fr.features.json`), embarqué dans le paquet
 * principal. Les autres langues sont générées par `tools/i18n` dans `locales/<langue>.json` et
 * chargées à la demande (un morceau par langue), avec repli sur l'anglais puis le français.
 * Les noms de lieux (Natural Earth, `data/map/names`), les textes de données (`data/`, recherche,
 * fiches) et les descriptions des nations sont aussi chargés à la demande.
 *
 * Choix de la langue (premier trouvé) : préfixe de route `/<langue>/`, paramètre `?lang=`, choix
 * mémorisé (localStorage `rl.lang`, synchronisé avec le compte), langue du navigateur, anglais.
 * Changer de langue recharge la page (formats, carte et noms sont figés au démarrage).
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DAY,
  HOUR,
  LOCALE_TAGS,
  MINUTE,
  RTL_LOCALES,
  isLocale,
  matchLocale,
  pickLocale,
  textKey,
  type GameTime,
  type Locale,
} from '@redline/shared';
import { setFormatDefaults } from '@redline/ui';
import frCore from './fr.json';
// Textes séparés par domaine (évite les conflits entre équipes) : fusion profonde au démarrage.
import frMap from './fr.map.json';
import frFeatures from './fr.features.json';
import frLocale from './fr.locale.json';
import frAudio from './fr.audio.json';
import frCommand from './fr.command.json';

type Tree = { [k: string]: string | Tree };
function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = typeof v === 'object' && typeof cur === 'object' ? merge(cur, v) : v;
  }
  return out;
}
const fr = [frMap, frFeatures, frAudio, frLocale, frCommand].reduce<Tree>(
  (a, b) => merge(a, b as Tree),
  frCore as Tree,
);

// Morceaux chargés à la demande (un fichier par langue).
const coreFiles = import.meta.glob<Tree>('./locales/*.json', { import: 'default' });
const dataFiles = import.meta.glob<Tree>('./data/*.json', { import: 'default' });
const nationFiles = import.meta.glob<Tree>('./nations/*.json', { import: 'default' });
const nameFiles = import.meta.glob<PlaceNames>('../../../../data/map/names/*.json', {
  import: 'default',
});
const fontFiles = import.meta.glob('../styles/fonts/*.css');

const loaderFor = <T>(files: Record<string, () => Promise<T>>, l: Locale) =>
  Object.entries(files).find(([p]) => p.endsWith(`/${l}.json`) || p.endsWith(`/${l}.css`))?.[1];

export const STORAGE_KEY = 'rl.lang';

export interface Detection {
  lang: Locale;
  /** Origine du choix : explicite (route, paramètre, mémorisé) ou déduite (navigateur, défaut). */
  source: 'path' | 'query' | 'storage' | 'browser' | 'default';
}

/** Préfixe de langue en tête de chemin (`/en/game/42` → en), ou null. */
export function localeFromPath(pathname: string): Locale | null {
  const m = /^\/([a-z]{2})(?=\/|$)/.exec(pathname);
  return m && isLocale(m[1]) ? m[1] : null;
}

/** Chemin sans préfixe de langue (`/en/game/42` → `/game/42`, `/en` → `/`). */
export function stripLocalePrefix(pathname: string): string {
  return localeFromPath(pathname) ? pathname.slice(3) || '/' : pathname;
}

/** Détection pure (testable) de la langue de l'interface. */
export function detectLocale(input: {
  pathname: string;
  search: string;
  stored: string | null;
  languages: readonly string[];
}): Detection {
  const fromPath = localeFromPath(input.pathname);
  if (fromPath) return { lang: fromPath, source: 'path' };
  const q = matchLocale(new URLSearchParams(input.search).get('lang'));
  if (q) return { lang: q, source: 'query' };
  if (isLocale(input.stored)) return { lang: input.stored, source: 'storage' };
  const nav = pickLocale(input.languages);
  if (nav) return { lang: nav, source: 'browser' };
  return { lang: 'en', source: 'default' };
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserDetection(): Detection {
  if (typeof window === 'undefined') return { lang: 'fr', source: 'default' };
  return detectLocale({
    pathname: window.location.pathname,
    search: window.location.search,
    stored: readStored(),
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
  });
}

const detection = browserDetection();
/** Langue de l'interface (figée pour la durée de la page). */
export const lang: Locale = detection.lang;
export const langSource = detection.source;
export const isRtl = RTL_LOCALES.includes(lang);
export const isFrench = lang === 'fr';
/** Étiquette Intl (chiffres latins en arabe : lisibilité des valeurs tactiques). */
export const LOCALE = lang === 'ar' ? 'ar-u-nu-latn' : LOCALE_TAGS[lang];
/** Écritures sans glyphes de carte précalculés (étiquettes rendues par le navigateur). */
export const NON_LATIN_SCRIPT = ['ar', 'ru', 'zh', 'ja', 'ko', 'hi'].includes(lang);

/** Choix mémorisé sur cet appareil (null si la langue vient du navigateur). */
export function storedLocale(): Locale | null {
  const s = readStored();
  return isLocale(s) ? s : null;
}

/**
 * Change de langue : mémorise le choix et recharge la page sans préfixe ni paramètre de langue.
 * `reload: false` (tests) se contente de mémoriser.
 */
export function chooseLanguage(l: Locale, opts: { reload?: boolean } = {}): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // stockage indisponible : le choix vaut pour cette page seulement
  }
  if (opts.reload === false || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('lang');
  url.pathname = stripLocalePrefix(url.pathname);
  window.location.assign(url.toString());
}

// Initialisation synchrone en français : `t` fonctionne avant `initI18n` (tests, écrans précoces).
void i18next.use(initReactI18next).init({
  lng: 'fr',
  fallbackLng: 'fr',
  resources: { fr: { translation: fr } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export const i18n = i18next;
export const t = i18next.t.bind(i18next);

/**
 * Formes plurielles manquantes (ex. `_many` des règles CLDR récentes en français, espagnol…) :
 * recopiées depuis `_other` pour que i18next ne retombe jamais sur une autre langue.
 */
export function fillPlurals(tree: Tree, l: Locale): Tree {
  const cats = new Intl.PluralRules(LOCALE_TAGS[l]).resolvedOptions().pluralCategories;
  const walk = (node: Tree) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'object') walk(v);
      else if (k.endsWith('_other')) {
        const base = k.slice(0, -6);
        for (const c of cats) if (node[`${base}_${c}`] === undefined) node[`${base}_${c}`] = v;
      }
    }
  };
  walk(tree);
  return tree;
}

export interface PlaceNames {
  nations?: Record<string, string>;
  provinces?: Record<string, string>;
  cities?: Record<string, string>;
  places?: Record<string, string>;
}
let names: PlaceNames = {};
const dataTexts = new Map<string, string>();
const nationTexts = new Map<string, string>();

function indexTexts(tree: Tree | undefined, into: Map<string, string>) {
  const walk = (n: Tree) => {
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === 'object') walk(v);
      else if (k.startsWith('k')) into.set(k.slice(1), v);
    }
  };
  if (tree) walk(tree);
}

let ready: Promise<void> | null = null;

/** Charge la langue détectée (textes, noms, polices) puis règle le document. Idempotent. */
export function initI18n(): Promise<void> {
  ready ??= (async () => {
    fillPlurals(fr, 'fr');
    applyDocument();
    if (lang === 'fr') {
      setFormats();
      return;
    }
    const load = async <T>(files: Record<string, () => Promise<T>>, l: Locale) => {
      const f = loaderFor(files, l);
      return f ? f().catch(() => undefined) : undefined;
    };
    const [core, en, data, enData, placeNames] = await Promise.all([
      load(coreFiles, lang),
      lang === 'en' ? undefined : load(coreFiles, 'en'),
      load(dataFiles, lang),
      lang === 'en' ? undefined : load(dataFiles, 'en'),
      load(nameFiles, lang),
      load(fontFiles, lang),
    ]);
    if (en) i18next.addResourceBundle('en', 'translation', fillPlurals(en, 'en'), true, true);
    if (core) i18next.addResourceBundle(lang, 'translation', fillPlurals(core, lang), true, true);
    // Données (recherche, fiches techniques…) : langue choisie, sinon anglais, sinon français.
    indexTexts(enData, dataTexts);
    indexTexts(data, dataTexts);
    names = placeNames ?? {};
    await i18next.changeLanguage(lang);
    i18next.options.fallbackLng = lang === 'en' ? ['fr'] : ['en', 'fr'];
    setFormats();
  })();
  return ready;
}

function applyDocument() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = LOCALE_TAGS[lang];
  root.dir = isRtl ? 'rtl' : 'ltr';
  root.classList.toggle('rtl', isRtl);
}

function setFormats() {
  setFormatDefaults({
    locale: LOCALE,
    dayUnit: t('time.dayUnit'),
    units: { k: t('format.k'), M: t('format.M'), Md: t('format.B') },
  });
}

/** Descriptions des nations (écran de sélection) : chargées à la première demande. */
let nationLoad: Promise<void> | null = null;
export function loadNationTexts(): Promise<void> {
  if (isFrench) return Promise.resolve();
  nationLoad ??= (async () => {
    const get = (l: Locale) => loaderFor(nationFiles, l)?.().catch(() => undefined);
    const [mine, en] = await Promise.all([get(lang), lang === 'en' ? undefined : get('en')]);
    indexTexts(en, nationTexts); // repli anglais, puis français
    indexTexts(mine, nationTexts);
  })();
  return nationLoad;
}

/** Texte de données traduit (recherche, fiche technique, unité…), sinon le texte français. */
export function dataText<T extends string | null | undefined>(frText: T): T {
  if (isFrench || !frText) return frText;
  return (dataTexts.get(textKey(frText)) ?? frText) as T;
}

/** Description de nation traduite (après `loadNationTexts`), sinon le texte français. */
export function nationText(frText: string): string {
  if (isFrench || !frText) return frText;
  return nationTexts.get(textKey(frText)) ?? frText;
}

/** Nom localisé d'une nation (Natural Earth), sinon le nom français. */
export function localNationName(id: string, frName: string): string {
  return names.nations?.[id] ?? frName;
}
export function localProvinceName(id: string, frName: string): string {
  return names.provinces?.[id] ?? frName;
}
export function localCityName(provinceId: string, frName: string): string {
  return names.cities?.[provinceId] ?? frName;
}
/** Étiquette du fond de carte (ville, mer) par son nom français. */
export function localPlaceName(frName: string): string {
  if (isFrench || !frName) return frName;
  return names.places?.[`k${textKey(frName)}`] ?? frName;
}

const nf0 = () => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const nf1 = () => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
let cachedNf: [Intl.NumberFormat, Intl.NumberFormat, Intl.NumberFormat] | null = null;
function nfs() {
  cachedNf ??= [
    nf0(),
    nf1(),
    new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }),
  ];
  return cachedNf;
}

/** Espaces fines insécables → espaces normales (glyphes absents de certaines polices de carte). */
export function plainSpaces(s: string): string {
  return s.replace(/[  ]/g, ' ');
}

export function fmtInt(n: number): string {
  return nfs()[0].format(Math.round(n));
}

export function fmtCompact(n: number): string {
  return Math.abs(n) < 100_000 ? fmtInt(n) : nfs()[2].format(n);
}

/** « 1 000 km » (arrondi lisible). */
export function fmtKm(km: number): string {
  const v =
    km >= 100 ? Math.round(km / 10) * 10 : km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
  return plainSpaces(t('units.km', { value: nfs()[1].format(v) }));
}

/** Plage de distances : « 3–380 km » (une décimale sous 10 km). */
export function fmtKmRange(min: number, max: number): string {
  const f = (v: number) => nfs()[v >= 10 ? 0 : 1].format(v >= 10 ? Math.round(v) : v);
  return plainSpaces(t('units.kmRange', { min: f(min), max: f(max) }));
}

/** Durée de jeu : « 45 min », « 3 h 20 », « 2 j 4 h ». */
export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return t('game.time.minutes', { value: m });
  if (ms < DAY)
    return t('game.time.hours', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
  return t('game.time.days', { d: Math.floor(ms / DAY), h: Math.floor((ms % DAY) / HOUR) });
}

/** Horloge de jeu : { day: « J+3 », time: « 07:41 » }. */
export function fmtClock(time: GameTime): { day: string; time: string } {
  const d = Math.floor(time / DAY);
  const rest = time - d * DAY;
  const h = Math.floor(rest / HOUR);
  const m = Math.floor((rest % HOUR) / MINUTE);
  return {
    day: t('game.clock.day', { day: d }),
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  };
}

/** Date courte du calendrier réel (listes de parties, historique d'achats…). */
export function fmtDate(at: number | string | Date): string {
  return new Date(at).toLocaleDateString(LOCALE);
}

/** Heure courte (messagerie). */
export function fmtTime(at: number | string | Date): string {
  return new Date(at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

/** Comparaison de noms selon la langue (tri alphabétique des listes). */
let collator: Intl.Collator | null = null;
export function compareNames(a: string, b: string): number {
  collator ??= new Intl.Collator(LOCALE);
  return collator.compare(a, b);
}

/** Majuscules selon la langue (« i » → « İ » en turc). */
export function upper(s: string): string {
  return s.toLocaleUpperCase(LOCALE);
}

/** Énumération (« A, B et C ») selon la langue. */
export function fmtList(items: string[]): string {
  try {
    return new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

let regionNames: Intl.DisplayNames | null = null;
/** Nom de pays depuis un code ISO alpha-2 (fiche d'arme). */
export function countryName(iso2: string): string {
  // « XX » : système générique sans pays d'origine (infanterie des fournisseurs secondaires…).
  if (iso2.toUpperCase() === 'XX') return t('weapon.genericOrigin');
  try {
    regionNames ??= new Intl.DisplayNames([LOCALE], { type: 'region' });
    return regionNames.of(iso2.toUpperCase()) ?? iso2;
  } catch {
    return iso2;
  }
}
