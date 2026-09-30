import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Icon } from '../icons.js';
import { Kbd } from './Kbd.js';

/** Champ de formulaire : libellé au-dessus, aide ou erreur dessous. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  // Association automatique étiquette ↔ champ (accessibilité, lecteurs d'écran, tests) : l'enfant
  // unique reçoit un identifiant s'il n'en a pas.
  const auto = useId();
  let id = htmlFor;
  let content = children;
  if (!id && isValidElement<{ id?: string }>(children)) {
    id = children.props.id ?? auto;
    if (!children.props.id) content = cloneElement(children, { id });
  }
  return (
    <div className={['rl-field', className ?? ''].join(' ')}>
      <label className="rl-field__label" htmlFor={id}>
        {label}
      </label>
      {content}
      {error ? (
        <div className="rl-field__error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="rl-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

/** Champ texte stylé (préfixe « > » optionnel façon invite). */
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { prompt?: boolean }
>(function Input({ className, prompt, ...rest }, ref) {
  if (!prompt)
    return <input ref={ref} className={['rl-input', className ?? ''].join(' ')} {...rest} />;
  return (
    <span className="rl-input-wrap rl-input-wrap--prompt">
      <span className="rl-input-wrap__prompt" aria-hidden>
        &gt;
      </span>
      <input ref={ref} className={['rl-input', className ?? ''].join(' ')} {...rest} />
    </span>
  );
});

export interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  value: string;
  onChange: (v: string) => void;
  /** Libellé accessible (obligatoire si pas de <label>). */
  label: string;
  /** Raccourci affiché à droite (ex. « / »). */
  shortcut?: string;
  clearLabel?: string;
}

/** Recherche : icône loupe, bouton d'effacement, raccourci. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, label, shortcut, clearLabel = 'Effacer', className, ...rest },
  ref,
) {
  return (
    <span className={['rl-search', className ?? ''].join(' ')}>
      <Icon name="search" size={15} className="rl-search__icon" />
      <input
        ref={ref}
        type="search"
        className="rl-input rl-search__input"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="rl-search__clear"
          onClick={() => onChange('')}
          aria-label={clearLabel}
        >
          <Icon name="close" size={13} />
        </button>
      ) : shortcut ? (
        <Kbd className="rl-search__kbd">{shortcut}</Kbd>
      ) : null}
    </span>
  );
});

export interface SelectProps<T extends string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'value'
> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  /** Libellé accessible si pas de <label>. */
  label?: string;
}

/** Liste déroulante native (accessible), stylée terminal. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={['rl-select', className ?? ''].join(' ')}>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={14} className="rl-select__chev" />
    </span>
  );
}

/** Interrupteur (role switch). */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={disabled ? 'rl-toggle rl-toggle--disabled' : 'rl-toggle'}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={checked ? 'rl-toggle__sw rl-toggle__sw--on' : 'rl-toggle__sw'}
        onClick={() => onChange(!checked)}
      >
        <span className="rl-toggle__knob" />
      </button>
      <label htmlFor={id} className="rl-toggle__text">
        <span className="rl-toggle__label">{label}</span>
        {description ? <span className="rl-toggle__desc">{description}</span> : null}
      </label>
    </div>
  );
}

/** Curseur (input range) avec valeur affichée. */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format = (v) => String(v),
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (v: number) => ReactNode;
  disabled?: boolean;
}) {
  const pct = ((value - min) / Math.max(1e-9, max - min)) * 100;
  return (
    <div className="rl-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--rl-slider-pct' as string]: `${pct}%` }}
      />
      <output className="rl-slider__value">{format(value)}</output>
    </div>
  );
}

/** Case à cocher stylée. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? 'rl-check rl-check--disabled' : 'rl-check'}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="rl-check__box" aria-hidden>
        {checked ? <Icon name="check" size={12} strokeWidth={2.4} /> : null}
      </span>
      <span className="rl-check__label">{label}</span>
    </label>
  );
}
