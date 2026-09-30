import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Compteur affiché après le libellé. */
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
  /** Pastille d'attention (nouveau contenu). */
  dot?: boolean;
}

export interface TabsProps<T extends string> {
  /** Libellé accessible de la liste d'onglets. */
  label: string;
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  /** `line` (souligné, défaut) ou `pill` (segments). */
  variant?: 'line' | 'pill';
  /** Onglets étirés sur toute la largeur. */
  fill?: boolean;
  className?: string;
}

/** Onglets accessibles (role tablist, flèches gauche/droite, Début/Fin). */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  variant = 'line',
  fill,
  className,
}: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const tab = enabled[next]!;
    onChange(tab.id);
    refs.current[tabs.indexOf(tab)]?.focus();
  };
  return (
    <div
      className={[
        'rl-tabs',
        `rl-tabs--${variant}`,
        fill ? 'rl-tabs--fill' : '',
        className ?? '',
      ].join(' ')}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
    >
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          disabled={t.disabled}
          className={t.id === value ? 'rl-tab rl-tab--on' : 'rl-tab'}
          onClick={() => onChange(t.id)}
        >
          {t.icon ? <span className="rl-tab__icon">{t.icon}</span> : null}
          <span className="rl-tab__label">{t.label}</span>
          {t.count !== undefined ? <span className="rl-tab__count">{t.count}</span> : null}
          {t.dot ? <span className="rl-tab__dot" aria-hidden /> : null}
        </button>
      ))}
    </div>
  );
}

export interface SegmentedProps<T extends string | number> {
  label: string;
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/** Choix exclusif compact (vitesse, difficulté) : role radiogroup. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedProps<T>) {
  return (
    <div
      className={['rl-seg', `rl-seg--${size}`, className ?? ''].join(' ')}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'rl-seg__btn rl-seg__btn--on' : 'rl-seg__btn'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
