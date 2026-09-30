import type { ReactNode } from 'react';

export interface PanelProps {
  /** Titre en majuscules espacées (facultatif). */
  title?: ReactNode;
  /** Sous-titre ou compteur à droite du titre. */
  meta?: ReactNode;
  /** Actions à droite de l'en-tête. */
  actions?: ReactNode;
  children?: ReactNode;
  /** `plain` : sans cadre (section dans une fenêtre). `boxed` : cadre 1 px (défaut). */
  variant?: 'boxed' | 'plain' | 'glass';
  /** Corps sans marge (tableaux). */
  flush?: boolean;
  className?: string;
  /** Ton d'accent (filet gauche coloré). */
  accent?: 'cyan' | 'green' | 'amber' | 'red' | 'violet' | 'blue';
  id?: string;
}

/** Bloc de contenu avec en-tête terminal (`── TITRE ─────── meta`). */
export function Panel({
  title,
  meta,
  actions,
  children,
  variant = 'boxed',
  flush,
  className,
  accent,
  id,
}: PanelProps) {
  return (
    <section
      id={id}
      className={[
        'rl-panel',
        `rl-panel--${variant}`,
        accent ? `rl-panel--accent-${accent}` : '',
        className ?? '',
      ].join(' ')}
    >
      {title || actions ? (
        <header className="rl-panel__head">
          {title ? <h3 className="rl-panel__title">{title}</h3> : null}
          {meta ? <span className="rl-panel__meta">{meta}</span> : null}
          <span className="rl-panel__rule" aria-hidden />
          {actions ? <div className="rl-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className={flush ? 'rl-panel__body rl-panel__body--flush' : 'rl-panel__body'}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Titre de section seul (majuscules espacées + filet). */
export function SectionTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="rl-section-title">
      <span>{children}</span>
      {meta ? <span className="rl-section-title__meta">{meta}</span> : null}
      <span className="rl-section-title__rule" aria-hidden />
    </div>
  );
}

export interface KeyValueProps {
  items: {
    label: ReactNode;
    value: ReactNode;
    tone?: 'amber' | 'green' | 'red' | 'cyan' | 'dim';
  }[];
  /** Nombre de colonnes (1 ou 2). */
  columns?: 1 | 2;
  className?: string;
}

/** Liste « libellé ........ valeur » alignée en chasse fixe. */
export function KeyValue({ items, columns = 1, className }: KeyValueProps) {
  return (
    <dl className={['rl-kv', `rl-kv--c${columns}`, className ?? ''].join(' ')}>
      {items.map((it, i) => (
        <div className="rl-kv__row" key={i}>
          <dt>{it.label}</dt>
          <dd className={it.tone ? `rl-tone-${it.tone}` : undefined}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Ligne secondaire (variation, unité). */
  sub?: ReactNode;
  tone?: 'amber' | 'green' | 'red' | 'cyan' | 'violet' | 'default';
  icon?: ReactNode;
}

/** Indicateur clé (budget, stabilité) : libellé discret, grande valeur, ligne secondaire. */
export function Stat({ label, value, sub, tone = 'default', icon }: StatProps) {
  return (
    <div className={`rl-stat rl-stat--${tone}`}>
      <div className="rl-stat__label">
        {icon ? <span className="rl-stat__icon">{icon}</span> : null}
        {label}
      </div>
      <div className="rl-stat__value">{value}</div>
      {sub ? <div className="rl-stat__sub">{sub}</div> : null}
    </div>
  );
}
