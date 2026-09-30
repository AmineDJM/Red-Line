import { fr } from './fr';

/** Textes actifs (français uniquement pour l'instant). */
export const T = fr;

/** Remplace les `{clé}` d'un texte par les valeurs fournies. */
export function fmt(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const nf = new Intl.NumberFormat('fr-FR');
export const num = (n: number | null | undefined): string => (n == null ? '—' : nf.format(n));

const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
export const date = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : df.format(d);
};
