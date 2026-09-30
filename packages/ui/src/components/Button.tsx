import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  icon?: ReactNode;
  block?: boolean;
  active?: boolean;
}

/** Bouton (hauteur tactile ≥ 44 px). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  active,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={active === undefined ? undefined : active}
      className={[
        'rl-btn',
        `rl-btn--${variant}`,
        size === 'lg' ? 'rl-btn--lg' : '',
        block ? 'rl-btn--block' : '',
        active ? 'rl-btn--active' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? <span className="rl-btn__icon">{icon}</span> : null}
      {children !== undefined && children !== null ? <span className="rl-btn__label">{children}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  badge?: number | string | null;
  active?: boolean;
  critical?: boolean;
  showLabel?: boolean;
}

/** Bouton carré à icône, libellé accessible, pastille de compteur optionnelle. */
export function IconButton({
  label,
  icon,
  badge,
  active,
  critical,
  showLabel,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={[
        'rl-iconbtn',
        active ? 'rl-iconbtn--active' : '',
        showLabel ? 'rl-iconbtn--labelled' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="rl-iconbtn__icon">{icon}</span>
      {showLabel ? <span className="rl-iconbtn__label">{label}</span> : null}
      {badge !== undefined && badge !== null && badge !== 0 ? (
        <span className={critical ? 'rl-badge rl-badge--critical' : 'rl-badge'}>{badge}</span>
      ) : null}
    </button>
  );
}
