import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Kbd } from './Kbd.js';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'success' | 'subtle';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` : action principale (cyan). `danger` : irréversible. `ghost` : sans cadre. */
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Icône à gauche du libellé (ex. `<Icon name="plus" />`). */
  icon?: ReactNode;
  /** Élément à droite du libellé (compteur, chevron). */
  trailing?: ReactNode;
  /** Raccourci clavier affiché à droite (ex. « Entrée »). */
  kbd?: string;
  block?: boolean;
  /** Bouton de bascule enfoncé (aria-pressed). */
  pressed?: boolean;
}

/** Bouton texte. Hauteur ≥ 44 px sur écran tactile (variable `--rl-touch`). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    icon,
    trailing,
    kbd,
    block,
    pressed,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const cls = [
    'rl-btn',
    `rl-btn--${variant}`,
    `rl-btn--${size}`,
    block ? 'rl-btn--block' : '',
    pressed ? 'rl-btn--pressed' : '',
    !children ? 'rl-btn--icon-only' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      {icon ? <span className="rl-btn__icon">{icon}</span> : null}
      {children ? <span className="rl-btn__label">{children}</span> : null}
      {trailing ? <span className="rl-btn__trail">{trailing}</span> : null}
      {kbd ? <Kbd className="rl-btn__kbd">{kbd}</Kbd> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Libellé accessible (et infobulle). Obligatoire. */
  label: string;
  icon: ReactNode;
  /** Pastille de compteur (non lus…). */
  badge?: number | string;
  /** Ton de la pastille (cyan par défaut, rouge si critique). */
  badgeTone?: 'cyan' | 'red' | 'amber';
  active?: boolean;
  /** Affiche le libellé sous l'icône (barre de navigation mobile). */
  showLabel?: boolean;
  /** Libellé visible abrégé (avec `showLabel`) ; `label` reste le nom accessible. */
  shortLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Raccourci affiché dans l'infobulle native. */
  shortcut?: string;
}

/** Bouton icône carré (≥ 44 px en tactile), libellé accessible obligatoire. */
export function IconButton({
  label,
  icon,
  badge,
  badgeTone = 'cyan',
  active,
  showLabel,
  shortLabel,
  size = 'md',
  shortcut,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const cls = [
    'rl-iconbtn',
    `rl-iconbtn--${size}`,
    active ? 'rl-iconbtn--active' : '',
    showLabel ? 'rl-iconbtn--labelled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const hasBadge = badge !== undefined && badge !== 0 && badge !== '';
  return (
    <button
      type={type}
      className={cls}
      aria-label={hasBadge ? `${label} (${badge})` : label}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${label} · ${shortcut}` : label}
      {...rest}
    >
      <span className="rl-iconbtn__icon">{icon}</span>
      {showLabel ? (
        <span className="rl-iconbtn__label" aria-hidden>
          {shortLabel ?? label}
        </span>
      ) : null}
      {hasBadge ? (
        <span className={`rl-iconbtn__badge rl-iconbtn__badge--${badgeTone}`} aria-hidden>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
