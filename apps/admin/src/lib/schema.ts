/**
 * Introspection des schémas zod partagés (zod 3) : l'éditeur structuré se construit à partir du contrat,
 * sans liste de champs en dur. Toute nouvelle clé de data/balance apparaît donc automatiquement.
 */
import type { z } from 'zod';

interface Base {
  /** Absent autorisé (optional) ou valeur par défaut fournie. */
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  default?: unknown;
}
export type SNode = Base &
  (
    | { t: 'object'; shape: Record<string, SNode> }
    | { t: 'number'; min?: number; max?: number; minExcl?: boolean; int: boolean }
    | { t: 'boolean' }
    | { t: 'string'; minLength?: number; maxLength?: number; regex?: string }
    | { t: 'enum'; options: string[] }
    | { t: 'literal'; value: unknown }
    | { t: 'array'; of: SNode; length?: number; maxLength?: number }
    | { t: 'tuple'; items: SNode[] }
    | { t: 'record'; value: SNode; keys?: string[] }
    | { t: 'union'; options: SNode[] }
    | { t: 'unknown' }
  );

type AnyDef = { typeName?: string; [k: string]: unknown };
type AnySchema = { _def: AnyDef; shape?: unknown };

export function describe(schema: z.ZodTypeAny): SNode {
  let s = schema as unknown as AnySchema;
  const base: Base = { optional: false, nullable: false, hasDefault: false };
  for (let guard = 0; guard < 20; guard++) {
    const tn = s._def.typeName;
    if (tn === 'ZodOptional') {
      base.optional = true;
      s = s._def.innerType as AnySchema;
    } else if (tn === 'ZodNullable') {
      base.nullable = true;
      s = s._def.innerType as AnySchema;
    } else if (tn === 'ZodDefault') {
      if (!base.hasDefault) {
        base.hasDefault = true;
        base.default = (s._def.defaultValue as () => unknown)();
      }
      s = s._def.innerType as AnySchema;
    } else if (tn === 'ZodEffects') {
      s = s._def.schema as AnySchema;
    } else if (tn === 'ZodBranded' || tn === 'ZodReadonly' || tn === 'ZodCatch') {
      s = (s._def.type ?? s._def.innerType) as AnySchema;
    } else break;
  }
  const d = s._def;
  switch (d.typeName) {
    case 'ZodObject': {
      const shapeRaw = (typeof d.shape === 'function' ? (d.shape as () => unknown)() : s.shape) as
        Record<string, z.ZodTypeAny> | undefined;
      const shape: Record<string, SNode> = {};
      for (const [k, v] of Object.entries(shapeRaw ?? {})) shape[k] = describe(v);
      return { ...base, t: 'object', shape };
    }
    case 'ZodNumber': {
      const n: SNode & { t: 'number' } = { ...base, t: 'number', int: false };
      for (const c of (d.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? []) {
        if (c.kind === 'min') {
          n.min = c.value;
          n.minExcl = c.inclusive === false;
        } else if (c.kind === 'max') n.max = c.value;
        else if (c.kind === 'int') n.int = true;
      }
      return n;
    }
    case 'ZodBoolean':
      return { ...base, t: 'boolean' };
    case 'ZodString': {
      const n: SNode & { t: 'string' } = { ...base, t: 'string' };
      for (const c of (d.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (c.kind === 'min') n.minLength = c.value;
        else if (c.kind === 'max') n.maxLength = c.value;
        else if (c.kind === 'length') n.minLength = n.maxLength = c.value;
        else if (c.kind === 'regex' && c.regex) n.regex = c.regex.source;
      }
      return n;
    }
    case 'ZodEnum':
      return { ...base, t: 'enum', options: [...(d.values as string[])] };
    case 'ZodNativeEnum':
      return { ...base, t: 'enum', options: Object.values(d.values as object).map(String) };
    case 'ZodLiteral':
      return { ...base, t: 'literal', value: d.value };
    case 'ZodArray': {
      const exact = d.exactLength as { value: number } | null;
      const max = d.maxLength as { value: number } | null;
      return {
        ...base,
        t: 'array',
        of: describe(d.type as z.ZodTypeAny),
        ...(exact ? { length: exact.value } : {}),
        ...(max ? { maxLength: max.value } : {}),
      };
    }
    case 'ZodTuple':
      return {
        ...base,
        t: 'tuple',
        items: (d.items as z.ZodTypeAny[]).map((x) => describe(x)),
      };
    case 'ZodRecord': {
      const key = describe(d.keyType as z.ZodTypeAny);
      return {
        ...base,
        t: 'record',
        value: describe(d.valueType as z.ZodTypeAny),
        ...(key.t === 'enum' ? { keys: key.options } : {}),
      };
    }
    case 'ZodUnion':
      return {
        ...base,
        t: 'union',
        options: (d.options as z.ZodTypeAny[]).map((x) => describe(x)),
      };
    default:
      return { ...base, t: 'unknown' };
  }
}

/** Valeur initiale d'un nœud (défaut du schéma, sinon valeur neutre valide). */
export function initialValue(n: SNode): unknown {
  if (n.hasDefault) return structuredClone(n.default);
  switch (n.t) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n.shape)) {
        if (v.optional && !v.hasDefault) continue;
        out[k] = initialValue(v);
      }
      return out;
    }
    case 'number':
      return n.min !== undefined ? (n.minExcl ? n.min + (n.int ? 1 : 0.1) : n.min) : 0;
    case 'boolean':
      return false;
    case 'string':
      return '';
    case 'enum':
      return n.options[0];
    case 'literal':
      return n.value;
    case 'array':
      return n.length ? Array.from({ length: n.length }, () => initialValue(n.of)) : [];
    case 'tuple':
      return n.items.map(initialValue);
    case 'record':
      return {};
    case 'union':
      return n.options[0] ? initialValue(n.options[0]) : null;
    default:
      return null;
  }
}

/** Plage lisible d'un nombre : « 0 à 1 », « ≥ 0 », « > 0 », « entier ». */
export function rangeLabel(n: SNode): string {
  if (n.t !== 'number') return '';
  const parts: string[] = [];
  const f = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
  if (n.min !== undefined && n.max !== undefined) parts.push(`${f(n.min)} à ${f(n.max)}`);
  else if (n.min !== undefined) parts.push(`${n.minExcl ? '>' : '≥'} ${f(n.min)}`);
  else if (n.max !== undefined) parts.push(`≤ ${f(n.max)}`);
  if (n.int) parts.push('entier');
  return parts.join(', ');
}

/** Sous-nœud à un chemin (les index de tableau et clés d'enregistrement descendent dans le type). */
export function nodeAt(root: SNode, path: readonly (string | number)[]): SNode | null {
  let cur: SNode | null = root;
  for (const k of path) {
    if (!cur) return null;
    if (cur.t === 'object') cur = cur.shape[String(k)] ?? null;
    else if (cur.t === 'array') cur = cur.of;
    else if (cur.t === 'record') cur = cur.value;
    else if (cur.t === 'tuple') cur = cur.items[Number(k)] ?? null;
    else return null;
  }
  return cur;
}
