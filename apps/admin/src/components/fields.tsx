/** Champs de formulaire liés à un brouillon JSON par chemin, avec affichage des erreurs du schéma. */
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { T } from '../i18n';
import { fieldLabel } from '../lib/validation';
import { getIn, pathKey, type Path } from '../lib/paths';

interface FormCtx {
  draft: unknown;
  set: (path: Path, value: unknown) => void;
  errors: ReadonlyMap<string, string[]>;
  changed: ReadonlySet<string>;
  readOnly?: ReadonlySet<string>;
}
const Ctx = createContext<FormCtx | null>(null);
export const FormProvider = (p: FormCtx & { children: ReactNode }) => {
  const { children, ...value } = p;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
function useForm() {
  const c = useContext(Ctx);
  if (!c) throw new Error('FormProvider manquant');
  return c;
}

/** Erreurs attachées à ce chemin ou à ses descendants directs. */
function useFieldState(path: Path) {
  const f = useForm();
  const key = pathKey(path);
  const errs: string[] = [];
  for (const [k, msgs] of f.errors) if (k === key || k.startsWith(`${key}.`)) errs.push(...msgs);
  const changed = [...f.changed].some((c) => c === key || c.startsWith(`${key}.`));
  return { f, key, errs, changed, value: getIn(f.draft, path), ro: f.readOnly?.has(key) ?? false };
}

function Wrap(props: {
  id: string;
  label: string;
  errs: string[];
  changed: boolean;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
  inline?: boolean;
}) {
  return (
    <div
      className={`field ${props.errs.length ? 'field-error' : ''} ${props.changed ? 'field-changed' : ''} ${props.wide ? 'field-wide' : ''} ${props.inline ? 'field-inline' : ''}`}
    >
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.hint && !props.errs.length && <small className="field-hint">{props.hint}</small>}
      {props.errs.map((e, i) => (
        <small key={i} className="field-msg">
          {e}
        </small>
      ))}
    </div>
  );
}

export function TextField(props: {
  path: Path;
  label?: string;
  /** Vide → null. */
  nullable?: boolean;
  /** Vide → champ absent. */
  optional?: boolean;
  wide?: boolean;
  placeholder?: string;
  mono?: boolean;
}) {
  const { f, key, errs, changed, value, ro } = useFieldState(props.path);
  const id = useId();
  return (
    <Wrap
      id={id}
      label={props.label ?? fieldLabel(key)}
      errs={errs}
      changed={changed}
      wide={props.wide}
    >
      <input
        id={id}
        className={props.mono ? 'mono' : undefined}
        value={typeof value === 'string' ? value : value == null ? '' : String(value)}
        placeholder={props.placeholder ?? (props.nullable ? T.editor.nullable : undefined)}
        readOnly={ro}
        onChange={(e) => {
          const v = e.target.value;
          f.set(
            props.path,
            v === '' && props.nullable ? null : v === '' && props.optional ? undefined : v,
          );
        }}
      />
    </Wrap>
  );
}

/**
 * Champ numérique. Texte local pour autoriser les saisies intermédiaires (« 0, », « - »).
 * Vide → null si `nullable`, sinon undefined (le schéma signale « champ obligatoire »).
 */
export function NumberField(props: {
  path: Path;
  label?: string;
  nullable?: boolean;
  optional?: boolean;
  step?: number;
  min?: number;
  max?: number;
  compact?: boolean;
}) {
  const { f, key, errs, changed, value } = useFieldState(props.path);
  const id = useId();
  const toText = (v: unknown) =>
    typeof v === 'number' ? String(v).replace('.', ',') : v == null ? '' : String(v);
  const [text, setText] = useState(toText(value));
  useEffect(() => {
    const parsed = Number(text.replace(',', '.').replace(/\s/g, ''));
    if (!(text !== '' && parsed === value)) setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Wrap
      id={id}
      label={props.label ?? fieldLabel(key)}
      errs={errs}
      changed={changed}
      inline={props.compact}
    >
      <input
        id={id}
        inputMode="decimal"
        className="mono num"
        value={text}
        placeholder={props.nullable ? T.editor.nullable : undefined}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const clean = t.replace(',', '.').replace(/\s/g, '');
          if (clean === '') f.set(props.path, props.nullable ? null : undefined);
          else if (/^-?\d*\.?\d*$/.test(clean) && clean !== '-' && clean !== '.')
            f.set(props.path, Number(clean));
          else f.set(props.path, t);
        }}
      />
    </Wrap>
  );
}

export function SelectField(props: {
  path: Path;
  label?: string;
  options: readonly (readonly [string, string])[];
  asNumber?: boolean;
}) {
  const { f, key, errs, changed, value } = useFieldState(props.path);
  const id = useId();
  const v = value == null ? '' : String(value);
  const known = props.options.some(([k]) => k === v);
  return (
    <Wrap id={id} label={props.label ?? fieldLabel(key)} errs={errs} changed={changed}>
      <select
        id={id}
        value={v}
        onChange={(e) =>
          f.set(props.path, props.asNumber ? Number(e.target.value) : e.target.value)
        }
      >
        {!known && <option value={v}>{v || '—'}</option>}
        {props.options.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    </Wrap>
  );
}

export function CheckField(props: { path: Path; label?: string }) {
  const { f, key, errs, changed, value } = useFieldState(props.path);
  const id = useId();
  return (
    <div
      className={`field field-check ${errs.length ? 'field-error' : ''} ${changed ? 'field-changed' : ''}`}
    >
      <label htmlFor={id} className="check">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => f.set(props.path, e.target.checked)}
        />
        <span className="check-box" aria-hidden />
        {props.label ?? fieldLabel(key)}
      </label>
      {errs.map((e, i) => (
        <small key={i} className="field-msg">
          {e}
        </small>
      ))}
    </div>
  );
}

/** Liste de chaînes saisie comme « a, b, c ». */
export function ListField(props: { path: Path; label?: string; wide?: boolean }) {
  const { f, key, errs, changed, value } = useFieldState(props.path);
  const id = useId();
  const join = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  const [text, setText] = useState(join(value));
  useEffect(() => {
    const cur = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (JSON.stringify(cur) !== JSON.stringify(value)) setText(join(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Wrap
      id={id}
      label={props.label ?? fieldLabel(key)}
      errs={errs}
      changed={changed}
      hint={T.editor.listHint}
      wide={props.wide}
    >
      <input
        id={id}
        className="mono"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          f.set(
            props.path,
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
      />
    </Wrap>
  );
}
