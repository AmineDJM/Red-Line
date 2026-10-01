/**
 * Textes localisables produits par le moteur (`LocText` : clé + paramètres structurés).
 * En français, le texte du moteur est affiché tel quel (grammaire des noms de pays déjà accordée).
 * Dans les autres langues, la clé est traduite (`engine.*`, `news.*` de locales/<langue>.json) ;
 * si elle manque, repli sur le texte français du moteur.
 */
import type {
  BattleReportSummary,
  IntelReport,
  LocParam,
  LocText,
  NewsItem,
} from '@redline/shared';
import { fmtList, i18n, isFrench, t } from '../i18n/index.js';
import { useWorld } from '../store/world.js';
import { nationName, provinceName, systemName } from './game.js';

function param(p: LocParam): string | number {
  if (typeof p === 'string' || typeof p === 'number') return p;
  if ('nation' in p) return nationName(p.nation);
  if ('province' in p) return useWorld.getState().provinces[p.province]?.name ?? provinceName(p.province);
  if ('system' in p) return systemName(p.system);
  if ('list' in p) return fmtList(p.list.map((x) => String(param(x))));
  return t(p.key, params(p.params));
}

function params(ps: Record<string, LocParam> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(ps ?? {})) out[k] = param(v);
  return out;
}

/** Texte localisé d'un `LocText`, sinon `fallback` (texte français du moteur). */
export function renderLoc(lt: LocText | undefined, fallback: string): string {
  if (isFrench || !lt) return fallback;
  const p = params(lt.params);
  if (!i18n.exists(lt.key, p)) return fallback;
  return t(lt.key, p);
}

export function newsHeadline(n: Pick<NewsItem, 'headline' | 'loc'>): string {
  return renderLoc(n.loc?.headline, n.headline);
}

export function newsBody(n: Pick<NewsItem, 'body' | 'loc'>): string {
  return renderLoc(n.loc?.body, n.body);
}

export function reportTitle(r: Pick<IntelReport, 'title' | 'loc'>): string {
  return renderLoc(r.loc?.title, r.title);
}

/** Titre d'un rapport de bataille : « Bataille de <lieu> », recomposé dans la langue du joueur. */
export function battleTitle(r: Pick<BattleReportSummary, 'title' | 'provinceId'>): string {
  if (isFrench) return r.title;
  if (!r.provinceId) return t('battles.titleSea');
  const p = useWorld.getState().provinces[r.provinceId];
  return t('battles.titleAt', { place: p?.cityName ?? p?.name ?? r.provinceId });
}

/**
 * Message d'un ordre refusé : en français, le message précis du moteur ; dans les autres langues,
 * le libellé traduit du code d'erreur (le message du moteur est en français).
 */
export function orderError(res: { error?: string | null; message?: string | null }): string {
  const generic = t(`game.orders.errors.${res.error ?? 'not_allowed'}`);
  return isFrench ? res.message || generic : generic;
}
