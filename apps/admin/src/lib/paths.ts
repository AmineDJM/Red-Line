/** Accès et mise à jour immuable par chemin dans un objet JSON. */
export type Path = readonly (string | number)[];
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function getIn(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

export function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  const src = obj as unknown;
  const base = (
    src && typeof src === 'object' ? (Array.isArray(src) ? [...src] : { ...src }) : {}
  ) as Record<string | number, unknown>;
  const next = setIn(base[head], rest, value);
  if (next === undefined) delete base[head];
  else base[head] = next;
  return base as T;
}

export const pathKey = (path: Path): string => path.join('.');

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
