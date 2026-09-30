import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef<T extends string = string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
  /** Info-bulle (ex. « bientôt »). */
  hint?: string;
  badge?: ReactNode;
}

export interface TabsProps<T extends string = string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Défilement horizontal (mobile). */
  scroll?: boolean;
}

/** Onglets accessibles (flèches gauche/droite). */
export function Tabs<T extends string>({ tabs, value, onChange, label, scroll = true }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    for (let k = 1; k <= tabs.length; k++) {
      const j = (i + dir * k + tabs.length) % tabs.length;
      const t = tabs[j];
      if (t && !t.disabled) {
        onChange(t.id);
        refs.current[j]?.focus();
        return;
      }
    }
  };
  return (
    <div className={scroll ? 'rl-tabs rl-tabs--scroll' : 'rl-tabs'} role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-disabled={t.disabled || undefined}
          tabIndex={t.id === value ? 0 : -1}
          title={t.hint}
          className={['rl-tab', t.id === value ? 'rl-tab--active' : '', t.disabled ? 'rl-tab--disabled' : ''].join(' ')}
          onClick={() => !t.disabled && onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.badge !== undefined ? <span className="rl-tab__badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
