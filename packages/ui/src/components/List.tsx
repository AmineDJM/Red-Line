import type { ReactNode } from 'react';

export interface ListItemProps {
  /** Élément à gauche (drapeau, pictogramme, point de statut). */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Élément à droite (valeur, badge, heure). */
  trailing?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  /** Ton du filet gauche (alerte critique…). */
  tone?: 'cyan' | 'green' | 'amber' | 'red' | 'violet' | 'blue';
  disabled?: boolean;
  unread?: boolean;
  className?: string;
}

/** Ligne de liste : bouton plein-largeur si `onClick`, sinon élément statique. */
export function ListItem({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  active,
  tone,
  disabled,
  unread,
  className,
}: ListItemProps) {
  const cls = [
    'rl-li',
    onClick ? 'rl-li--click' : '',
    active ? 'rl-li--active' : '',
    tone ? `rl-li--${tone}` : '',
    unread ? 'rl-li--unread' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const inner = (
    <>
      {leading ? <span className="rl-li__lead">{leading}</span> : null}
      <span className="rl-li__main">
        <span className="rl-li__title">{title}</span>
        {subtitle ? <span className="rl-li__sub">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="rl-li__trail">{trailing}</span> : null}
    </>
  );
  return (
    <li className="rl-list__row">
      {onClick ? (
        <button
          type="button"
          className={cls}
          onClick={onClick}
          disabled={disabled}
          aria-current={active ? 'true' : undefined}
        >
          {inner}
        </button>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

/** Conteneur de `ListItem` (ul sans puces, séparateurs fins). */
export function List({
  children,
  label,
  className,
  divided = true,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  divided?: boolean;
}) {
  return (
    <ul
      className={['rl-list', divided ? 'rl-list--divided' : '', className ?? ''].join(' ')}
      aria-label={label}
    >
      {children}
    </ul>
  );
}
