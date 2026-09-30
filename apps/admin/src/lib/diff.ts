/** Différences champ par champ entre deux fiches (chemins aplatis, ex. « damage.armor »). */
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Aplatit un objet en feuilles ; les tableaux sont des feuilles (comparés en entier). */
export function flatten(
  v: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0 && prefix) out[prefix] = {};
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = v;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffObjects(before: unknown, after: unknown): FieldChange[] {
  const a = flatten(before ?? {});
  const b = flatten(after ?? {});
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const order = [...Object.keys(b), ...Object.keys(a)];
  keys.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return keys.filter((k) => !same(a[k], b[k])).map((k) => ({ path: k, before: a[k], after: b[k] }));
}

export function formatValue(v: unknown): string {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (typeof v === 'number') return v.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'string') return v === '' ? '« »' : v;
  return JSON.stringify(v);
}
