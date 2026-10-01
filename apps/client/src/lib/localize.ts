/**
 * Noms et textes de données dans la langue de l'interface : appliqués une fois, au chargement des
 * données statiques (nations, provinces, fond de carte, catalogue, recherche, fiches nations).
 * En français, rien n'est modifié (données sources).
 */
import type { FeatureCollection } from 'geojson';
import type {
  NationDef,
  NationInfo,
  ProvinceDef,
  ResearchNode,
  ScenarioSummary,
  WeaponSystem,
} from '@redline/shared';
import type { BasemapData } from '../api/types.js';
import {
  dataText,
  isFrench,
  loadNationTexts,
  localCityName,
  localNationName,
  localPlaceName,
  localProvinceName,
  nationText,
} from '../i18n/index.js';

export function localizeNations(list: NationDef[]): NationDef[] {
  if (isFrench) return list;
  return list.map((n) => ({ ...n, name: localNationName(n.id, n.name) }));
}

export function localizeProvinces(list: ProvinceDef[]): ProvinceDef[] {
  if (isFrench) return list;
  return list.map((p) => ({
    ...p,
    name: localProvinceName(p.id, p.name),
    ...(p.cityName ? { cityName: localCityName(p.id, p.cityName) } : {}),
  }));
}

function mapNames(
  fc: FeatureCollection | null,
  fn: (props: Record<string, unknown>) => string | null,
): FeatureCollection | null {
  if (!fc || isFrench) return fc;
  return {
    ...fc,
    features: fc.features.map((f) => {
      const name = fn((f.properties ?? {}) as Record<string, unknown>);
      return name === null ? f : { ...f, properties: { ...f.properties, name } };
    }),
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Fond de carte : villes et mers (Natural Earth), étiquettes de pays (nom de la nation). */
export function localizeBasemap(b: BasemapData): BasemapData {
  if (isFrench) return b;
  return {
    ...b,
    seas: mapNames(b.seas, (p) => (p.name ? localPlaceName(str(p.name)) : null)),
    cities: mapNames(b.cities, (p) => (p.name ? localPlaceName(str(p.name)) : null)),
    countries: mapNames(b.countries, (p) =>
      p.id && p.name ? localNationName(str(p.id), str(p.name)) : null,
    ),
  };
}

/** Géométrie des provinces : propriété `name` éventuelle (infobulles). */
export function localizeProvincesGeo(fc: FeatureCollection | null): FeatureCollection | null {
  return mapNames(fc, (p) =>
    p.id && typeof p.name === 'string' ? localProvinceName(str(p.id), p.name) : null,
  );
}

/** Catalogue : noms des systèmes génériques, lignes de fiche technique, noms d'unités. */
export function localizeCatalog(list: WeaponSystem[]): WeaponSystem[] {
  if (isFrench) return list;
  return list.map((s) => ({
    ...s,
    name: s.generic ? dataText(s.name) : s.name,
    ...(s.unitLabel ? { unitLabel: dataText(s.unitLabel) } : {}),
    sheet: s.sheet
      ? { ...s.sheet, engine: dataText(s.sheet.engine), speedLabel: dataText(s.sheet.speedLabel) }
      : s.sheet,
  }));
}

export function localizeResearch(list: ResearchNode[]): ResearchNode[] {
  if (isFrench) return list;
  return list.map((n) => ({
    ...n,
    name: dataText(n.name),
    ...(n.description ? { description: dataText(n.description) } : {}),
  }));
}

export function localizeScenarios(list: ScenarioSummary[]): ScenarioSummary[] {
  if (isFrench) return list;
  return list.map((s) => ({ ...s, name: dataText(s.name), description: dataText(s.description) }));
}

/** Fiches des nations (écran de sélection) : textes chargés à la demande. */
export async function localizeNationInfo(list: NationInfo[]): Promise<NationInfo[]> {
  if (isFrench) return list;
  await loadNationTexts();
  return list.map((n) => ({
    ...n,
    name: localNationName(n.id, n.name),
    description: nationText(n.description),
    doctrineText: nationText(n.doctrineText),
  }));
}
