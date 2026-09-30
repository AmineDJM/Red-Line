/** Formats d'affichage (français) : dollars abrégés, nombres, dates, durées. */

const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf3 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Nombre abrégé : 1,2 Md · 450 M · 85 k · 950. */
export function compact(v: number | null | undefined): string {
  if (!ok(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}${nf1.format(a / 1e9)} Md`;
  if (a >= 1e6) return `${s}${nf1.format(a / 1e6)} M`;
  if (a >= 1e4) return `${s}${nf1.format(a / 1e3)} k`;
  return `${s}${nf3.format(a)}`;
}

/** Dollars abrégés (exigence d'Amine) : $1,2 Md · $450 M · $85 k. */
export function usd(v: number | null | undefined): string {
  if (!ok(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${nf1.format(a / 1e9)} Md`;
  if (a >= 1e6) return `${s}$${nf1.format(a / 1e6)} M`;
  if (a >= 1e3) return `${s}$${nf1.format(a / 1e3)} k`;
  return `${s}$${nf0.format(a)}`;
}

/** Nombre lisible (espaces fines, virgule décimale). */
export function num(v: number | null | undefined, digits = 3): string {
  if (!ok(v)) return '—';
  return digits === 3
    ? nf3.format(v)
    : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

/** Fraction 0..1 → « 54 % ». */
export function pct(v: number | null | undefined, digits = 0): string {
  if (!ok(v)) return '—';
  return `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: digits })} %`;
}

/** Prix en centimes → « 4,99 € ». */
export function price(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const dfl = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' });
export const date = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : df.format(d);
};
export const dateLong = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dfl.format(d);
};

/** « il y a 3 min », « dans 2 h ». */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const s = Math.round((now - t) / 1000);
  const a = Math.abs(s);
  const unit =
    a < 60
      ? `${a} s`
      : a < 3600
        ? `${Math.round(a / 60)} min`
        : a < 86400
          ? `${Math.round(a / 3600)} h`
          : `${Math.round(a / 86400)} j`;
  return s >= 0 ? `il y a ${unit}` : `dans ${unit}`;
}

/** Durée en heures de jeu → « 36 h » ou « 3 j 4 h ». */
export function hours(h: number | null | undefined): string {
  if (!ok(h)) return '—';
  if (h < 48) return `${nf1.format(h)} h`;
  const d = Math.floor(h / 24);
  const r = Math.round(h - d * 24);
  return r ? `${d} j ${r} h` : `${d} j`;
}

/** Octets → « 1,4 Mo ». */
export function bytes(b: number | null | undefined): string {
  if (!ok(b)) return '—';
  if (b >= 1 << 30) return `${nf1.format(b / (1 << 30))} Go`;
  if (b >= 1 << 20) return `${nf1.format(b / (1 << 20))} Mo`;
  if (b >= 1 << 10) return `${nf1.format(b / (1 << 10))} ko`;
  return `${nf0.format(b)} o`;
}

/** Durée en secondes → « 3 j 4 h » / « 2 h 10 min ». */
export function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} j ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** camelCase → « Camel case » (libellé de repli). */
export function humanize(key: string): string {
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
