import type { ReactNode } from 'react';

export interface TitleBannerProps {
  title: string;
  subtitle?: ReactNode;
  /** Zone à droite (horloge, boutons). */
  right?: ReactNode;
  /** Alerte majeure affichée sous le titre (rouge si critique). */
  alert?: { text: string; critical?: boolean; onClick?: () => void } | null;
  compact?: boolean;
}

/** Bandeau titre : fond orange en dégradé vers le transparent, titre en capitales espacées. */
export function TitleBanner({ title, subtitle, right, alert, compact }: TitleBannerProps) {
  return (
    <header className={compact ? 'rl-banner rl-banner--compact' : 'rl-banner'}>
      <div className="rl-banner__text">
        <h1 className="rl-banner__title">{title}</h1>
        {subtitle ? <div className="rl-banner__subtitle">{subtitle}</div> : null}
        {alert ? (
          <button
            type="button"
            className={alert.critical ? 'rl-banner__alert rl-banner__alert--critical' : 'rl-banner__alert'}
            onClick={alert.onClick}
          >
            <span className="rl-dot" aria-hidden />
            {alert.text}
          </button>
        ) : null}
      </div>
      {right ? <div className="rl-banner__right">{right}</div> : null}
    </header>
  );
}
