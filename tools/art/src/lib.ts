// Outils communs du pipeline photo : accès poli aux API Wikimedia, lecture des licences, chemins.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(TOOL_DIR, '../..');
export const CACHE_DIR = resolve(TOOL_DIR, '.cache');
export const CATALOG_IDS = resolve(REPO, 'data/catalog-ids.json');
export const SOURCES = resolve(TOOL_DIR, 'sources.json');
export const OVERRIDES = resolve(TOOL_DIR, 'overrides.json');
export const SELECTION = resolve(TOOL_DIR, 'selection.json');
export const MANIFEST = resolve(REPO, 'data/art/photos.json');
export const CREDITS = resolve(REPO, 'data/art/CREDITS.md');
export const PHOTO_DIR = resolve(REPO, 'apps/client/public/art/photos');
/** Décisions de détourage (verrou commité, produit par `cutout`, lu par `build`). */
export const CUTOUTS = resolve(TOOL_DIR, 'cutouts.json');
/** Découpes (PNG avec transparence) mises en cache, une par photo source. */
export const CUTOUT_DIR = resolve(CACHE_DIR, 'cutout');

/** Identification exigée par Wikimedia. Jamais d'adresse e-mail. */
export const USER_AGENT = 'RedLine-art/1.0 (https://github.com/AmineDJM/Red-Line)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';

/**
 * Intervalle minimal entre deux requêtes (une toutes les 2 s au plus) : les environnements partagés sont vite
 * limités par Wikimedia (429), la patience coûte moins cher que les reprises.
 */
const MIN_INTERVAL_MS = 2000;
let last = 0;

async function pace(): Promise<void> {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

export async function politeFetch(url: string, attempt = 0): Promise<Response> {
  await pace();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
      // Une connexion bloquée ne doit pas figer tout le pipeline.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    if (attempt >= 5) throw e;
    await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
    return politeFetch(url, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const retry = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, retry * 1000));
    return politeFetch(url, attempt + 1);
  }
  return res;
}

async function api(base: string, params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const res = await politeFetch(`${base}?${q}`);
  if (!res.ok) throw new Error(`${base} ${res.status} ${await res.text()}`);
  return res.json();
}

export const wikiApi = (p: Record<string, string>) => api(WIKI_API, p);
export const commonsApi = (p: Record<string, string>) => api(COMMONS_API, p);

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  doctrine: string;
  origin: string;
}

export async function catalog(): Promise<CatalogEntry[]> {
  return (await readJson<{ systems: CatalogEntry[] }>(CATALOG_IDS)).systems;
}

/** Source d'un système : article Wikipedia anglais et/ou requête Commons, avec note éventuelle. */
export interface SourceSpec {
  wiki?: string;
  search?: string;
  /** Photo représentative (système générique) : noté dans le manifeste. */
  generic?: boolean;
  /** Raison documentée pour laquelle aucune photo n'est retenue. */
  none?: string;
  note?: string;
  /**
   * Détourage (étape `cutout`) : `false` garde la photo d'origine (détourage refusé au contrôle visuel :
   * navire sur l'eau, radar dans son décor, groupe, lancement…), `true` impose le détourage même si un
   * contrôle automatique échoue. Absent : détourage tenté, retenu si les contrôles automatiques passent.
   */
  cutout?: boolean;
  /** Raison du choix de détourage (contrôle visuel), reprise dans cutouts.json. */
  cutoutWhy?: string;
  /** Zone de la découpe à garder, [x0, y0, x1, y1] en fractions (écarte un second véhicule, un décor). */
  cutoutBox?: [number, number, number, number];
  /** Zones de la découpe à retirer (mêmes coordonnées), pour un reste de décor qu'aucune boîte n'écarte. */
  cutoutErase?: [number, number, number, number][];
  /** Déclaration d'attribution imposée par la licence (GODL-India), reprise telle quelle dans CREDITS.md. */
  attribution?: string;
}

/** Décision de détourage d'un système (cutouts.json). */
export interface CutoutDecision {
  /** Titre du fichier Commons détouré : la décision ne vaut que pour cette photo. */
  title: string;
  use: boolean;
  reason: string;
  /** Part de l'image occupée par le sujet (0..1), pour mémoire. */
  coverage?: number;
  /** Zone gardée (copie de sources.json `cutoutBox`). */
  box?: [number, number, number, number];
  /** Zones retirées (copie de sources.json `cutoutErase`). */
  erase?: [number, number, number, number][];
}

/** Surcharge manuelle : titre de fichier Commons, ou objet avec cadrage. */
export type Override =
  | string
  | {
      file: string;
      focus?: Focus;
      zoom?: number;
      /** Crédit corrigé à la main quand les métadonnées Commons sont inexploitables (URL, texte trop long). */
      credit?: string;
      /** Vidéo : instant (secondes) de l'image extraite par Commons. */
      seek?: number;
      /**
       * Licences admises pour cette seule photo, validées au cas par cas par Amine (ex. « GODL-India » pour
       * l'Agni-V) : voir CASE_BY_CASE. Jamais utilisé par la sélection automatique.
       */
      validated?: string[];
    };
/**
 * Cadrage : 'centre' (défaut), 'attention' (sujet détecté), un bord, un point normalisé [x, y], ou 'fit'
 * (image entière sur fond flou, pour les photos très allongées).
 */
export type Focus =
  'centre' | 'attention' | 'fit' | 'top' | 'bottom' | 'left' | 'right' | [number, number];

export interface FileInfo {
  title: string; // « File:… »
  width: number;
  height: number;
  mime: string;
  thumbUrl: string;
  thumbWidth: number;
  thumbHeight: number;
  descriptionUrl: string;
  credit: string;
  license: string;
  licenseCode: string;
  restrictions: string;
  objectName: string;
}

export interface Selection extends FileInfo {
  systemId: string;
  generic: boolean;
  focus: Focus;
  /** Grossissement du recadrage (≥ 1) : 1,25 ne garde que 80 % de la largeur 16:10 maximale. */
  zoom?: number;
  via: 'override' | 'pageimage' | 'page' | 'search';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#039': "'",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Licences gouvernementales admises seulement au cas par cas, pour une photo précise (surcharge manuelle avec
 * `validated`), après validation explicite d'Amine. Clé = libellé affiché, valeur = reconnaissance.
 */
export const CASE_BY_CASE: Record<string, RegExp> = {
  // Government Open Data License – India (Gazette of India, 2017) : attribution exigée, pas d'approbation
  // implicite, ne couvre ni les logos et emblèmes du fournisseur ni les insignes militaires.
  'GODL-India': /^godl(-india)?\b|government open data licen[cs]e\W+india/i,
};

/**
 * Licences acceptées : domaine public, CC0, CC BY, CC BY-SA (usage commercial permis).
 * Tout le reste est refusé (NC, ND, usage loyal, GFDL seule, licences gouvernementales, inconnue).
 *
 * `extended` (surcharges manuelles seulement) admet en plus deux licences publiques d'attribution que leurs
 * auteurs déclarent compatibles CC BY : la Licence Ouverte 2.0 (Etalab, État français, dont le ministère des
 * Armées) et l'Open Government Licence v3 (Royaume-Uni). Utilisées uniquement faute de photo CC/PD.
 * `validated` (surcharge manuelle validée au cas par cas) admet en plus les licences citées de CASE_BY_CASE.
 */
export function acceptLicense(
  code: string,
  short: string,
  extended = false,
  validated: readonly string[] = [],
): string | null {
  const c = code.toLowerCase().trim();
  const s = short.trim();
  if (/\bnc\b|-nc|\bnd\b|-nd|non-?commercial|no ?deriv|fair ?use/i.test(`${c} ${s}`)) return null;
  if (c === 'pd' || /^public domain$/i.test(s) || /^pd\b/i.test(s)) return 'Domaine public';
  if (c === 'cc0' || /^cc0/i.test(s)) return 'CC0 1.0';
  const m = /^cc-by(-sa)?-(\d(?:\.\d)?)/.exec(c);
  if (m) return `CC BY${m[1] ? '-SA' : ''} ${m[2]!.includes('.') ? m[2] : `${m[2]}.0`}`;
  const ms = /^CC BY(-SA)? (\d(?:\.\d)?)/i.exec(s);
  if (ms) return `CC BY${ms[1] ? '-SA' : ''} ${ms[2]}`;
  if (extended && /^(licence ouverte|open licence|etalab)/i.test(s)) return 'Licence Ouverte';
  if (extended && (/^ogl/i.test(c) || /^(OGL|Open Government Licence)/i.test(s))) return 'OGL v3';
  for (const name of validated)
    if (CASE_BY_CASE[name]?.test(s) || CASE_BY_CASE[name]?.test(c)) return name;
  return null;
}

export function parseImageInfo(
  page: any,
  extended = false,
  validated: readonly string[] = [],
): FileInfo | null {
  const ii = page?.imageinfo?.[0];
  if (!ii || page.missing) return null;
  const md = ii.extmetadata ?? {};
  const val = (k: string): string => (md[k]?.value != null ? String(md[k].value) : '');
  const license = acceptLicense(val('License'), val('LicenseShortName'), extended, validated);
  if (!license) return null;
  let credit = stripHtml(val('Artist')) || stripHtml(val('Credit'));
  if (!credit || /^unknown/i.test(credit)) credit = stripHtml(val('Credit'));
  // À défaut d'auteur déclaré, on crédite le compte qui a versé l'œuvre sur Commons.
  if (!credit || /^unknown/i.test(credit))
    credit = ii.user ? `${ii.user} (Wikimedia Commons)` : 'Auteur inconnu';
  if (credit.length > 160) credit = credit.slice(0, 157).trimEnd() + '…';
  return {
    title: page.title,
    width: ii.width,
    height: ii.height,
    mime: ii.mime,
    thumbUrl: ii.thumburl ?? ii.url,
    thumbWidth: ii.thumbwidth ?? ii.width,
    thumbHeight: ii.thumbheight ?? ii.height,
    descriptionUrl: ii.descriptionurl,
    credit,
    license,
    licenseCode: val('License'),
    restrictions: val('Restrictions'),
    objectName: stripHtml(val('ObjectName')),
  };
}

/** Clé de cache d'une photo source (URL de miniature Commons). */
export function sourceKey(sel: Pick<Selection, 'thumbUrl'>): string {
  return createHash('sha1').update(sel.thumbUrl).digest('hex').slice(0, 16);
}

/** Photo source téléchargée (cache .cache/dl), telle que renvoyée par Commons. */
export async function downloadSource(sel: Selection): Promise<Buffer> {
  const path = resolve(CACHE_DIR, 'dl', `${sourceKey(sel)}.img`);
  try {
    return await readFile(path);
  } catch {
    const res = await politeFetch(sel.thumbUrl);
    if (!res.ok) throw new Error(`${sel.systemId} : ${res.status} ${sel.thumbUrl}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buf);
    return buf;
  }
}

/** Largeur de miniature demandée : assez pour un recadrage 16:10 en 1280×800 sans agrandissement. */
export const FETCH_WIDTH = 1920;

/**
 * Métadonnées Commons (licence, auteur, miniature) pour une liste de titres « File:… ». `seek` (secondes) :
 * pour une vidéo, la miniature renvoyée par Commons est l'image extraite à cet instant.
 */
export async function fileInfos(
  titles: string[],
  width = FETCH_WIDTH,
  extended = false,
  seek?: number,
  validated: readonly string[] = [],
): Promise<Map<string, FileInfo | null>> {
  const out = new Map<string, FileInfo | null>();
  for (const batch of chunks([...new Set(titles)], 40)) {
    const data = await commonsApi({
      action: 'query',
      titles: batch.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|user|extmetadata',
      iiurlwidth: String(width),
      ...(seek != null ? { iiurlparam: `${width}px-seek=${seek}` } : {}),
      iiextmetadatafilter:
        'License|LicenseShortName|Artist|Credit|Restrictions|ObjectName|UsageTerms',
    });
    const norm = new Map<string, string>();
    for (const n of data.query?.normalized ?? []) norm.set(n.to, n.from);
    for (const page of data.query?.pages ?? []) {
      const info = parseImageInfo(page, extended, validated);
      out.set(page.title, info);
      const from = norm.get(page.title);
      if (from) out.set(from, info);
    }
  }
  // Image plus étroite que la largeur demandée : l'API renvoie l'original (upload.wikimedia.org, très
  // limité en débit depuis les environnements partagés). On redemande une miniature à la plus grande largeur
  // standard inférieure (1280 ou 960 px), servie par le cache de miniatures : URL toujours renvoyée par l'API,
  // jamais construite à la main.
  if (seek == null && width === FETCH_WIDTH) {
    for (const [title, info] of [...out]) {
      if (!info || info.thumbUrl.includes('/thumb/') || info.width <= 960) continue;
      const step = info.width > 1280 ? 1280 : 960;
      const data = await commonsApi({
        action: 'query',
        titles: info.title,
        prop: 'imageinfo',
        iiprop: 'url|size|mime|user|extmetadata',
        iiurlwidth: String(step),
        iiextmetadatafilter:
          'License|LicenseShortName|Artist|Credit|Restrictions|ObjectName|UsageTerms',
      });
      const scaled = parseImageInfo(data.query?.pages?.[0], extended, validated);
      if (scaled?.thumbUrl.includes('/thumb/')) out.set(title, { ...info, ...scaled });
    }
  }
  return out;
}

export function fileTitle(name: string): string {
  const t = name.replace(/_/g, ' ').trim();
  return /^(File|Image):/i.test(t) ? t.replace(/^Image:/i, 'File:') : `File:${t}`;
}

/** Noms de fichiers qui trahissent un schéma, un logo, une carte, une maquette… */
export const BAD_NAME =
  /\b(diagram|schem|drawing|logo|insignia|emblem|badge|patch|seal|flag|map|chart|graph|3-?view|3view|silhouette|line ?art|profile|mock-?up|model|render|artist|concept|illustration|cockpit|interior|stamp|coin|poster|cutaway|infographic|patent|sketch|toy|miniature|scale)\b/i;
