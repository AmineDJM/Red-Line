/** Validation d'une fiche avec WeaponSystemSchema et messages lisibles en français. */
import { WeaponSystemSchema, type WeaponSystem } from '@redline/shared';
import { T, fmt } from '../i18n';
import { usd } from './format';

export interface Issue {
  code: string;
  path: (string | number)[];
  message: string;
  [k: string]: unknown;
}

export interface ReadableIssue {
  path: string;
  label: string;
  message: string;
}

export function fieldLabel(path: string): string {
  if (T.fields[path]) return T.fields[path];
  const [head, sub] = path.split('.');
  if (head === 'damage' && sub) {
    return `${T.fields.damage} : ${T.targetClasses[sub as keyof typeof T.targetClasses] ?? sub}`;
  }
  if (head === 'roles' || head === 'requires') return T.fields[head] ?? path;
  return path || T.validation.root;
}

const TYPE_MSG: Record<string, string> = {
  number: T.validation.number,
  string: T.validation.string,
  boolean: T.validation.boolean,
  array: T.validation.array,
  object: T.validation.object,
};

export function issueMessage(i: Issue): string {
  const v = T.validation;
  switch (i.code) {
    case 'invalid_type':
      if (i.received === 'undefined') return v.required;
      if (i.expected === 'integer') return v.int;
      return TYPE_MSG[String(i.expected)] ?? i.message;
    case 'too_small':
      if (i.type === 'string') {
        return i.exact
          ? fmt(v.length, { n: Number(i.minimum) })
          : fmt(v.minLength, { n: Number(i.minimum) });
      }
      if (i.type === 'number') {
        return (
          fmt(v.min, { n: Number(i.minimum).toLocaleString('fr-FR') }) +
          (i.inclusive === false ? ' (strictement)' : '')
        );
      }
      return i.message;
    case 'too_big':
      if (i.type === 'string' && i.exact) return fmt(v.length, { n: Number(i.maximum) });
      if (i.type === 'number') return fmt(v.max, { n: Number(i.maximum).toLocaleString('fr-FR') });
      return i.message;
    case 'invalid_enum_value':
      return fmt(v.enum, { options: (i.options as unknown[] | undefined)?.join(', ') ?? '' });
    case 'unrecognized_keys':
      return fmt(v.unknownKeys, { keys: (i.keys as string[] | undefined)?.join(', ') ?? '' });
    default:
      return i.message;
  }
}

export function readableIssues(issues: readonly Issue[]): ReadableIssue[] {
  return issues.map((i) => {
    const path = i.path.join('.');
    return { path, label: fieldLabel(path), message: issueMessage(i) };
  });
}

export type ValidationResult =
  | { ok: true; value: WeaponSystem; issues: []; warnings: string[] }
  | { ok: false; value: null; issues: ReadableIssue[]; warnings: string[] };

/** Contrôles de cohérence non bloquants (le schéma reste la seule règle dure). */
export function coherenceWarnings(s: Partial<WeaponSystem>): string[] {
  const e = T.editor;
  const w: string[] = [];
  if (s.movement === 'air' && (s.operationalRadiusKm == null || s.operationalRadiusKm === 0))
    w.push(e.warnAirRadius);
  if (s.movement && s.movement !== 'air' && s.operationalRadiusKm != null)
    w.push(e.warnGroundRadius);
  if (s.weaponRangeKm && s.weaponRangeKm.min > s.weaponRangeKm.max) w.push(e.warnRange);
  if (typeof s.id === 'string' && s.doctrine && !s.id.startsWith(`${s.doctrine}.`)) {
    w.push(fmt(e.warnPrefix, { doctrine: s.doctrine }));
  }
  if (s.canCapture && s.movement !== 'land') w.push(e.warnCapture);
  if (typeof s.stealth === 'number' && s.stealth > 0.3 && s.generation !== 5) w.push(e.warnStealth);
  if (typeof s.unitPriceUsd === 'number' && typeof s.cost?.money === 'number') {
    const expected = s.unitPriceUsd * (typeof s.unitSize === 'number' ? s.unitSize : 1);
    if (Math.abs(s.cost.money - expected) > Math.max(1, expected * 0.01))
      w.push(fmt(e.warnCost, { cost: usd(s.cost.money), expected: usd(expected) }));
  }
  return w;
}

/** Validation générique d'une donnée par un schéma zod, avec libellés lisibles. */
export function validateWith<T>(
  schema: {
    safeParse: (
      d: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: unknown[] } };
  },
  data: unknown,
  labelFor: (path: string) => string = fieldLabel,
):
  | { ok: true; value: T; issues: ReadableIssue[] }
  | { ok: false; value: null; issues: ReadableIssue[] } {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data, issues: [] };
  const issues = (r.error.issues as Issue[]).map((i) => {
    const path = i.path.join('.');
    return { path, label: labelFor(path), message: issueMessage(i) };
  });
  return { ok: false, value: null, issues };
}

/** Regroupe les erreurs par chemin (pour les champs de formulaire). */
export function issueMap(issues: readonly ReadableIssue[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const i of issues) m.set(i.path, [...(m.get(i.path) ?? []), i.message]);
  return m;
}

export function validateSystem(data: unknown): ValidationResult {
  const r = WeaponSystemSchema.safeParse(data);
  const warnings = coherenceWarnings((data ?? {}) as Partial<WeaponSystem>);
  if (r.success) return { ok: true, value: r.data, issues: [], warnings };
  return {
    ok: false,
    value: null,
    issues: readableIssues(r.error.issues as unknown as Issue[]),
    warnings,
  };
}
