/** Dollars précis (les coûts unitaires sont souvent inférieurs au centime) : « 0,042 $ », « 12,50 $ ». */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a === 0 ? 2 : a < 0.01 ? 4 : a < 1 ? 3 : a < 1000 ? 2 : 0;
  return `${v < 0 ? '−' : ''}${a.toLocaleString('fr-FR', {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  })} $`;
}
