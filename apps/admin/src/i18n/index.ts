import { fr } from './fr';
import { num as formatNum, date as formatDate } from '../lib/format';

/** Textes actifs (français uniquement pour l'instant). */
export const T = fr;

/** Remplace les `{clé}` d'un texte par les valeurs fournies. */
export function fmt(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export const num = (n: number | null | undefined): string => formatNum(n);
export const date = (iso: string): string => formatDate(iso);
