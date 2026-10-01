/** Export CSV (séparateur « ; », BOM UTF-8 : ouverture directe dans Excel en français). */

export type CsvValue = string | number | boolean | null | undefined;

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  const s =
    typeof v === 'number'
      ? Number.isFinite(v)
        ? String(Math.round(v * 1e6) / 1e6).replace('.', ',')
        : ''
      : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: [string, (r: T) => CsvValue][]): string {
  const head = columns.map(([h]) => cell(h)).join(';');
  const body = rows.map((r) => columns.map(([, f]) => cell(f(r))).join(';'));
  return [head, ...body].join('\r\n');
}

export function downloadCsv<T>(
  filename: string,
  rows: T[],
  columns: [string, (r: T) => CsvValue][],
): void {
  const blob = new Blob(['﻿', toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
