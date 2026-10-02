/**
 * Formats d'affichage communs (français par défaut). Aucune dépendance à i18next : le jeu règle la
 * langue une fois au démarrage (`setFormatDefaults`), le back-office garde le français.
 */

export interface MoneyUnits {
  k: string;
  M: string;
  Md: string;
}

const FR_UNITS: MoneyUnits = { k: 'k', M: 'M', Md: 'Md' };
const NBSP = ' ';

/** Réglages par défaut (langue de l'interface) : étiquette Intl, unités monétaires, unité de jour. */
const defaults = { locale: 'fr-FR', units: FR_UNITS, dayUnit: 'j' };

/** Change la langue des formats (appelé une fois au démarrage du jeu). */
export function setFormatDefaults(d: { locale?: string; units?: MoneyUnits; dayUnit?: string }) {
  if (d.locale) defaults.locale = d.locale;
  if (d.units) defaults.units = d.units;
  if (d.dayUnit) defaults.dayUnit = d.dayUnit;
}

/** Étiquette Intl en vigueur pour les formats. */
export function formatLocale(): string {
  return defaults.locale;
}
const cache = new Map<string, Intl.NumberFormat>();

function nf(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    cache.set(key, f);
  }
  return f;
}

/** Espaces fines insécables → espaces insécables simples (rendu identique dans toutes les polices). */
function tidy(s: string): string {
  return s.replace(/ /g, NBSP);
}

export interface MoneyOptions {
  locale?: string;
  units?: MoneyUnits;
  /** Affiche « + » devant les montants positifs (revenus, variations). */
  signed?: boolean;
  /** Chiffres après la virgule pour les montants < 100 dans l'unité (défaut 1). */
  digits?: number;
}

/**
 * Montant en dollars US, format compact français : `$1,2 Md`, `$450 M`, `$85 k`, `$620`.
 * Négatif : `−$3,4 M`. Au-delà de 100 dans l'unité, pas de décimale (`$125 M`).
 */
export function formatMoney(usd: number, opts: MoneyOptions = {}): string {
  const { locale = defaults.locale, units = defaults.units, signed = false, digits = 1 } = opts;
  if (!Number.isFinite(usd)) return '—';
  const abs = Math.abs(usd);
  // Seuils décalés d'un demi-arrondi : jamais « $1 000 k », toujours « $1 M ».
  const [div, unit] =
    abs >= 999.5e6
      ? [1e9, units.Md]
      : abs >= 999.5e3
        ? [1e6, units.M]
        : abs >= 999.5
          ? [1e3, units.k]
          : [1, ''];
  const value = abs / div;
  const d = unit && value < 99.95 ? digits : 0;
  const body = `$${tidy(nf(locale, d).format(value))}${unit ? NBSP + unit : ''}`;
  const sign = usd < 0 ? '\u2212' : signed && usd > 0 ? '+' : '';
  return sign + body;
}

/** Nombre entier groupé à la française (`12 480`). */
export function formatInt(n: number, locale = defaults.locale): string {
  return tidy(nf(locale, 0).format(Math.round(n)));
}

/** Nombre avec au plus `digits` décimales. */
export function formatNumber(n: number, digits = 1, locale = defaults.locale): string {
  return tidy(nf(locale, digits).format(n));
}

/** Nombre compact (`12,4 k`, `3,1 M`) pour les quantités (pas pour l'argent). */
export function formatCompact(n: number, locale = defaults.locale): string {
  const abs = Math.abs(n);
  if (abs < 10_000) return formatInt(n, locale);
  if (abs < 1e6)
    return `${formatNumber(n / 1e3, abs < 1e5 ? 1 : 0, locale)}${NBSP}${defaults.units.k}`;
  if (abs < 1e9)
    return `${formatNumber(n / 1e6, abs < 1e8 ? 1 : 0, locale)}${NBSP}${defaults.units.M}`;
  return `${formatNumber(n / 1e9, 1, locale)}${NBSP}${defaults.units.Md}`;
}

/** Pourcentage depuis une fraction 0..1 (`54 %`). */
export function formatPct(fraction: number, digits = 0, locale = defaults.locale): string {
  return `${formatNumber(fraction * 100, digits, locale)}${NBSP}%`;
}

/**
 * Compte à rebours compact : `45 s`, `12:04` (min:s), `3:12:04` (h:min:s), `2 j 04:10` (j h:min).
 * `ms` est une durée (négative → 0).
 */
export function formatCountdown(ms: number, dayUnit = defaults.dayUnit): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  if (d > 0) return `${d}${NBSP}${dayUnit} ${p(h)}:${p(m)}`;
  if (h > 0) return `${h}:${p(m)}:${p(sec)}`;
  if (m > 0) return `${m}:${p(sec)}`;
  return `${sec}${NBSP}s`;
}

/** Durée lisible en heures de jeu : `45 min`, `6 h`, `3 j 4 h`. */
export function formatHours(h: number, dayUnit = defaults.dayUnit): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}${NBSP}min`;
  if (h < 48) return `${formatNumber(h, h < 10 ? 1 : 0)}${NBSP}h`;
  const d = Math.floor(h / 24);
  const rest = Math.round(h - d * 24);
  return rest ? `${d}${NBSP}${dayUnit} ${rest}${NBSP}h` : `${d}${NBSP}${dayUnit}`;
}
