import type { ReactNode } from 'react';

export interface StatLineProps {
  label: ReactNode;
  value: ReactNode;
  /** Couleur de la valeur : orange (défaut), claire, rouge (critique). */
  tone?: 'accent' | 'plain' | 'critical' | 'muted';
  mono?: boolean;
}

/** Ligne « caractéristique : valeur », valeur en orange et chasse fixe. */
export function StatLine({ label, value, tone = 'accent', mono = true }: StatLineProps) {
  return (
    <div className="rl-stat">
      <span className="rl-stat__label">{label}</span>
      <span className="rl-stat__sep" aria-hidden>
        :
      </span>
      <span
        className={['rl-stat__value', `rl-stat__value--${tone}`, mono ? 'rl-mono' : ''].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

/** Jauge horizontale fine (points de vie, progression). */
export function Meter({
  value,
  tone = 'accent',
  label,
}: {
  value: number;
  tone?: 'accent' | 'violet' | 'critical' | 'ok';
  label?: string;
}) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`rl-meter rl-meter--${tone}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={label}
    >
      <span style={{ width: `${v * 100}%` }} />
    </div>
  );
}

/** Pastille orange devant une ligne (étiquettes multi-éléments, listes). */
export function Bullet({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div className="rl-bullet">
      <span
        className="rl-bullet__dot"
        style={color ? { background: color } : undefined}
        aria-hidden
      />
      <span>{children}</span>
    </div>
  );
}

/** Petit panneau cartouche bleu marine semi-opaque. */
export function Panel({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  return (
    <section className={className ? `rl-panel ${className}` : 'rl-panel'}>
      {title ? <h3 className="rl-panel__title">{title}</h3> : null}
      {children}
    </section>
  );
}
