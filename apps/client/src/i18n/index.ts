import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DAY, HOUR, MINUTE, type GameTime } from '@redline/shared';
import fr from './fr.json';

export const LOCALE = 'fr-FR';

void i18next.use(initReactI18next).init({
  lng: 'fr',
  fallbackLng: 'fr',
  resources: { fr: { translation: fr } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export const i18n = i18next;
export const t = i18next.t.bind(i18next);

const nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const nfCompact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

/** Espaces fines insécables → espaces normales (glyphes absents de certaines polices de carte). */
export function plainSpaces(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, ' ');
}

export function fmtInt(n: number): string {
  return nf0.format(Math.round(n));
}

export function fmtCompact(n: number): string {
  return Math.abs(n) < 100_000 ? fmtInt(n) : nfCompact.format(n);
}

/** « 1 000 km » (arrondi lisible). */
export function fmtKm(km: number): string {
  const v =
    km >= 100 ? Math.round(km / 10) * 10 : km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
  return plainSpaces(t('units.km', { value: nf1.format(v) }));
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

let regionNames: Intl.DisplayNames | null = null;
/** Nom de pays depuis un code ISO alpha-2 (fiche d'arme). */
export function countryName(iso2: string): string {
  // « XX » : système générique sans pays d'origine (infanterie des fournisseurs secondaires…).
  if (iso2.toUpperCase() === 'XX') return t('weapon.genericOrigin');
  try {
    regionNames ??= new Intl.DisplayNames(['fr'], { type: 'region' });
    return regionNames.of(iso2.toUpperCase()) ?? iso2;
  } catch {
    return iso2;
  }
}
