// Noms localisés des nations, provinces, villes et mers depuis Natural Earth (champs NAME_xx),
// pour chaque langue de l'interface — à lancer après build.ts et cities.mjs :
//   node tools/map/scripts/names.mjs
// Produit data/map/names/<langue>.json :
//   { nations: {id: nom}, provinces: {id: nom}, cities: {idProvince: ville}, places: {k<textKey>: nom} }
// `places` couvre les étiquettes du fond de carte (villes, mers), indexées par l'empreinte du nom
// français (`textKey` de @redline/shared). Seuls les noms différents du français sont écrits ; un
// nom absent de Natural Earth garde le nom français (repli côté client).
import fs from 'node:fs';

const R = new URL('../../../', import.meta.url).pathname;
// Cache Natural Earth (rempli par build.ts) ; NE_CACHE permet d'en désigner un autre.
const CACHE = process.env.NE_CACHE ?? R + 'tools/map/.cache/';
const LANGS = ['en', 'ar', 'es', 'tr', 'de', 'pt', 'ru', 'it', 'zh', 'ja', 'ko', 'hi', 'id', 'pl'];

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ne = (name) => read(`${CACHE}${name}.geojson`).features.map((f) => f.properties);

/** Même empreinte que textKey() de packages/shared/src/i18n.ts (FNV-1a 32 bits). */
function textKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clean = (s) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ');
/** Champ de langue Natural Earth (majuscules pour admin-0 et villes, minuscules sinon). */
const pick = (p, lang) => clean(p[`NAME_${lang.toUpperCase()}`] ?? p[`name_${lang}`]);

const nations = read(R + 'data/map/nations.json');
const provinces = read(R + 'data/map/provinces.json');
const basemapCities = read(R + 'data/basemap/cities.geojson').features;
const seas = read(R + 'data/basemap/seas.geojson').features;

// ——— Nations : admin-0 (pays) puis unités cartographiques (Gaza…) ———
const byA3 = new Map();
for (const p of [...ne('ne_10m_admin_0_countries'), ...ne('ne_10m_admin_0_map_units')])
  for (const k of ['ISO_A3', 'ADM0_A3', 'GU_A3', 'BRK_A3'])
    if (p[k] && p[k] !== '-99' && !byA3.has(p[k])) byA3.set(p[k], p);
const ISO_ALIAS = { XKX: 'KOS' };

// ——— Villes : lieux peuplés, recherche par nom français puis distance ———
const places = ne('ne_10m_populated_places');
const placesByFr = new Map();
for (const p of places) {
  for (const n of new Set([clean(p.NAME_FR), clean(p.NAME)].filter(Boolean))) {
    if (!placesByFr.has(n)) placesByFr.set(n, []);
    placesByFr.get(n).push(p);
  }
}
function nearestPlace(name, lng, lat) {
  const list = placesByFr.get(name);
  if (!list) return null;
  let best = null;
  let bd = Infinity;
  for (const p of list) {
    const d = Math.hypot(p.LONGITUDE - lng, p.LATITUDE - lat);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return bd < 1.5 ? best : null;
}

// ——— Provinces : admin-1 du même pays, nom français identique (suffixe numéroté conservé) ———
const adm1 = ne('ne_10m_admin_1_states_provinces');
const adm1ByName = new Map();
for (const p of adm1) {
  for (const n of new Set([clean(p.name_fr), clean(p.name)].filter(Boolean))) {
    const k = `${p.adm0_a3}|${cap(n.replace(/^(de la |de l['’]|du |des |de |d['’])/u, ''))}`;
    if (!adm1ByName.has(k)) adm1ByName.set(k, p);
  }
}
const nationIso = new Map(nations.map((n) => [n.id, ISO_ALIAS[n.iso] ?? n.iso]));

const seaByFr = new Map();
for (const p of ne('ne_10m_geography_marine_polys')) {
  const fr = cap(clean(p.name_fr || p.name));
  if (fr && !seaByFr.has(fr)) seaByFr.set(fr, p);
}

fs.mkdirSync(R + 'data/map/names', { recursive: true });
for (const lang of LANGS) {
  const out = { nations: {}, provinces: {}, cities: {}, places: {} };
  const latin = !['ar', 'ru', 'zh', 'ja', 'ko', 'hi'].includes(lang);
  const put = (obj, k, fr, v) => {
    if (v && v !== fr) obj[k] = latin ? cap(v) : v;
  };
  for (const n of nations) {
    const p = byA3.get(ISO_ALIAS[n.iso] ?? n.iso);
    if (p) put(out.nations, n.id, n.name, pick(p, lang));
  }
  for (const pr of provinces) {
    const iso = nationIso.get(pr.nationId);
    const m = /^(.*?)( \d+| \(ville\))?$/u.exec(pr.name);
    const base = m?.[1] ?? pr.name;
    const p = adm1ByName.get(`${iso}|${base}`);
    if (p) {
      const v = pick(p, lang);
      const suffix = m?.[2] && /\d/.test(m[2]) ? m[2] : '';
      if (v) put(out.provinces, pr.id, pr.name, v + suffix);
    }
    if (pr.cityName && pr.cityPoint) {
      const c = nearestPlace(pr.cityName, pr.cityPoint[0], pr.cityPoint[1]);
      if (c) put(out.cities, pr.id, pr.cityName, pick(c, lang));
    }
  }
  for (const f of basemapCities) {
    const name = f.properties.name;
    const [lng, lat] = f.geometry.coordinates;
    const c = nearestPlace(name, lng, lat);
    if (c) put(out.places, `k${textKey(name)}`, name, pick(c, lang));
  }
  for (const f of seas) {
    const name = f.properties.name;
    const p = seaByFr.get(name);
    if (p) put(out.places, `k${textKey(name)}`, name, pick(p, lang));
  }
  fs.writeFileSync(R + `data/map/names/${lang}.json`, JSON.stringify(out));
  const c = (o) => Object.keys(o).length;
  console.log(
    `${lang} : ${c(out.nations)} nations, ${c(out.provinces)}/${provinces.length} provinces, ${c(out.cities)} villes, ${c(out.places)} lieux`,
  );
}
