/** Lecture d'un fichier d'import JSON et pré-validation locale des fiches. */
import { WeaponSystemSchema } from '@redline/shared';
import { T, fmt } from '../i18n';
import { readableIssues, type Issue } from './validation';

export interface Parsed {
  items: unknown[];
  rows: { id: string; name: string; ok: boolean; errors: string[] }[];
}

/** Accepte un tableau de fiches ou un objet { systems: [...] } (format de data/catalog et de l'export). */
export function parseImport(text: string): Parsed | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      error: fmt(T.importExport.parseError, { msg: e instanceof Error ? e.message : String(e) }),
    };
  }
  const items = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { systems?: unknown }).systems)
      ? (json as { systems: unknown[] }).systems
      : null;
  if (!items) return { error: T.importExport.shapeError };
  const rows = items.map((it) => {
    const r = WeaponSystemSchema.safeParse(it);
    const o = (it ?? {}) as { id?: unknown; name?: unknown };
    return {
      id: typeof o.id === 'string' ? o.id : '?',
      name: typeof o.name === 'string' ? o.name : '',
      ok: r.success,
      errors: r.success
        ? []
        : readableIssues(r.error.issues as unknown as Issue[]).map(
            (i) => `${i.label} : ${i.message}`,
          ),
    };
  });
  return { items, rows };
}
