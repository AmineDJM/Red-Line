/** Champs de formulaire liés à un brouillon JSON par chemin, avec erreurs du schéma et marque « modifié ». */
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { T } from '../i18n';
import { fieldLabel } from '../lib/validation';
import { getIn, pathKey, type Path } from '../lib/paths';

export interface FormCtx {
  draft: unknown;
  set: (path: Path, value: unknown) => void;
  errors: ReadonlyMap<string, string[]>;
  changed: ReadonlySet<string>;
  readOnly?: ReadonlySet<string>;
  /** Libellé par défaut d'un chemin (sinon libellés de la fiche d'arme). */
  labelFor?: (key: string) => string;
  /** Champ actif (aide contextuelle). */
  onFocusPath?: (key: string) => void;
}
const Ctx = createContext<FormCtx | null>(null);
export const FormProvider = (p: FormCtx & { children: ReactNode }) => {
  const { children, ...value } = p;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
export function useForm() {
  const c = useContext(Ctx);
  if (!c) throw new Error('FormProvider manquant');
  return c;
}

/** Erreurs et état « modifié » d'un chemin (et de ses descendants). */
export function useFieldState(path: Path) {
  const f = useForm();
  const key = pathKey(path);
  const errs: string[] = [];
  for (const [k, msgs] of f.errors) if (k === key || k.startsWith(`${key}.`)) errs.push(...msgs);
  let changed = false;
  for (const c of f.changed)
    if (c === key || c.startsWith(`${key}.`) || key.startsWith(`${c}.`)) {
      changed = true;
      break;
    }
  return {
    f,
    key,
    errs,
    changed,
    value: getIn(f.draft, path),
    ro: f.readOnly?.has(key) ?? false,
    label: f.labelFor?.(key) ?? fieldLabel(key),
  };
}

export function Wrap(props: {
  id: string;
  label: ReactNode;
  errs: string[];
  changed: boolean;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  inline?: boolean;
  pathKey?: string;
  className?: string;
}) {
  const f = useContext(Ctx);
  return (
    <div
      className={`field ${props.errs.length ? 'field-error' : ''} ${props.changed ? 'field-changed' : ''} ${props.wide ? 'field-wide' : ''} ${props.inline ? 'field-inline' : ''} ${props.className ?? ''}`}
      onFocusCapture={
        props.pathKey && f?.onFocusPath ? () => f.onFocusPath!(props.pathKey!) : undefined
      }
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
  hint?: ReactNode;
  multiline?: boolean;
  rows?: number;
}) {
  const { f, key, errs, changed, value, ro, label } = useFieldState(props.path);
  const id = useId();
  const v = typeof value === 'string' ? value : value == null ? '' : String(value);
  const onChange = (s: string) =>
    f.set(
      props.path,
      s === '' && props.nullable ? null : s === '' && props.optional ? undefined : s,
    );
  return (
    <Wrap
      id={id}
      label={props.label ?? label}
      errs={errs}
      changed={changed}
      wide={props.wide || props.multiline}
      hint={props.hint}
      pathKey={key}
    >
      {props.multiline ? (
        <textarea
          id={id}
          rows={props.rows ?? 3}
          value={v}
          readOnly={ro}
          placeholder={props.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          value={v}
          placeholder={props.placeholder ?? (props.nullable ? T.editor.nullable : undefined)}
          readOnly={ro}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Wrap>
  );
}

const toText = (v: unknown) =>
  typeof v === 'number' ? String(v).replace('.', ',') : v == null ? '' : String(v);

/**
 * Champ numérique. Texte local pour autoriser les saisies intermédiaires (« 0, », « - »).
 * Vide → null si `nullable`, sinon undefined (le schéma signale « champ obligatoire »).
 */
export function NumberField(props: {
  path: Path;
  label?: string;
  nullable?: boolean;
  optional?: boolean;
  compact?: boolean;
  hint?: ReactNode;
  /** Valeur formatée affichée dans le champ (ex. « $1,2 Md »). */
  affix?: (v: number) => string;
}) {
  const { f, key, errs, changed, value, label } = useFieldState(props.path);
  const id = useId();
  const [text, setText] = useState(toText(value));
  useEffect(() => {
    const parsed = Number(text.replace(',', '.').replace(/\s/g, ''));
    if (!(text !== '' && parsed === value)) setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const input = (
    <input
      id={id}
      inputMode="decimal"
      className="num"
      value={text}
      placeholder={props.nullable ? T.editor.nullable : undefined}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const clean = t.replace(',', '.').replace(/\s/g, '');
        if (clean === '') f.set(props.path, props.nullable ? null : undefined);
        else if (/^-?\d*\.?\d*(e-?\d+)?$/i.test(clean) && clean !== '-' && clean !== '.')
          f.set(props.path, Number(clean));
        else f.set(props.path, t);
      }}
    />
  );
  const aff = props.affix && typeof value === 'number' ? props.affix(value) : null;
  return (
    <Wrap
      id={id}
      label={props.label ?? label}
      errs={errs}
      changed={changed}
      inline={props.compact}
      hint={props.hint}
      pathKey={key}
    >
      {aff ? (
        <div className="input-affix">
          {input}
          <span className="affix">{aff}</span>
        </div>
      ) : (
        input
      )}
    </Wrap>
  );
}

export function SelectField(props: {
  path: Path;
  label?: string;
  options: readonly (readonly [string, string])[];
  asNumber?: boolean;
  /** Option vide (champ absent). */
  optional?: boolean;
  hint?: ReactNode;
}) {
  const { f, key, errs, changed, value, label } = useFieldState(props.path);
  const id = useId();
  const v = value == null ? '' : String(value);
  const known = props.options.some(([k]) => k === v);
  return (
    <Wrap
      id={id}
      label={props.label ?? label}
      errs={errs}
      changed={changed}
      hint={props.hint}
      pathKey={key}
    >
      <select
        id={id}
        value={v}
        onChange={(e) =>
          f.set(
            props.path,
            e.target.value === '' && props.optional
              ? undefined
              : props.asNumber
                ? Number(e.target.value)
                : e.target.value,
          )
        }
      >
        {props.optional && <option value="">—</option>}
        {!known && !(props.optional && v === '') && <option value={v}>{v || '—'}</option>}
        {props.options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </Wrap>
  );
}

export function CheckField(props: { path: Path; label?: string; hint?: ReactNode }) {
  const { f, key, errs, changed, value, label } = useFieldState(props.path);
  const id = useId();
  return (
    <div
      className={`field ${errs.length ? 'field-error' : ''} ${changed ? 'field-changed' : ''}`}
      onFocusCapture={f.onFocusPath ? () => f.onFocusPath!(key) : undefined}
    >
      <label htmlFor={id} className="switch" style={{ minHeight: 30 }}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => f.set(props.path, e.target.checked)}
        />
        <span className="track" aria-hidden />
        <span>{props.label ?? label}</span>
        {changed && <span className="c-amber tiny">●</span>}
      </label>
      {props.hint && !errs.length && <small className="field-hint">{props.hint}</small>}
      {errs.map((e, i) => (
        <small key={i} className="field-msg">
          {e}
        </small>
      ))}
    </div>
  );
}

/** Liste de chaînes saisie comme « a, b, c ». */
export function ListField(props: { path: Path; label?: string; wide?: boolean; hint?: ReactNode }) {
  const { f, key, errs, changed, value, label } = useFieldState(props.path);
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
      label={props.label ?? label}
      errs={errs}
      changed={changed}
      hint={props.hint ?? T.editor.listHint}
      wide={props.wide}
      pathKey={key}
    >
      <input
        id={id}
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

/** Liste de nombres « 20 ; 45 ; 70 » (le point-virgule évite l'ambiguïté avec la virgule décimale). */
export function NumListField(props: {
  path: Path;
  label?: string;
  hint?: ReactNode;
  wide?: boolean;
}) {
  const { f, key, errs, changed, value, label } = useFieldState(props.path);
  const id = useId();
  const join = (v: unknown) => (Array.isArray(v) ? v.map(toText).join(' ; ') : '');
  const [text, setText] = useState(join(value));
  useEffect(() => {
    if (join(value) !== normalize(text)) setText(join(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Wrap
      id={id}
      label={props.label ?? label}
      errs={errs}
      changed={changed}
      hint={props.hint}
      wide={props.wide}
      pathKey={key}
    >
      <input
        id={id}
        className="num"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parts = e.target.value
            .split(/[;\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const n = Number(s.replace(',', '.'));
              return Number.isFinite(n) ? n : s;
            });
          f.set(props.path, parts);
        }}
      />
    </Wrap>
  );
}
const normalize = (t: string) =>
  t
    .split(/[;\s]+/)
    .filter(Boolean)
    .join(' ; ');
