import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'cyan' | 'green' | 'amber' | 'red' | 'violet' | 'blue';

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** `soft` (fond teinté, défaut), `outline` (filet seul), `solid` (fond plein). */
  variant?: 'soft' | 'outline' | 'solid';
  /** Point de couleur devant le texte (statut). */
  dot?: boolean;
  /** Point clignotant (événement en cours). */
  pulse?: boolean;
  title?: string;
  className?: string;
}

/** Étiquette courte en majuscules (statut, génération, cotation). */
export function Badge({
  children,
  tone = 'neutral',
  variant = 'soft',
  dot,
  pulse,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      className={['rl-badge', `rl-badge--${tone}`, `rl-badge--${variant}`, className ?? ''].join(
        ' ',
      )}
      title={title}
    >
      {dot || pulse ? (
        <span
          className={pulse ? 'rl-badge__dot rl-badge__dot--pulse' : 'rl-badge__dot'}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

/** Point de statut seul (liste, tableau). */
export function StatusDot({
  tone = 'neutral',
  pulse,
  label,
}: {
  tone?: Tone;
  pulse?: boolean;
  label?: string;
}) {
  return (
    <span
      className={`rl-dot rl-dot--${tone}${pulse ? ' rl-dot--pulse' : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
