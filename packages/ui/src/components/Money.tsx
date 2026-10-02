import { formatCountdown, formatLocale, formatMoney, type MoneyOptions } from '../format.js';

export interface MoneyProps extends MoneyOptions {
  /** Montant en dollars US. */
  value: number;
  /** Colore selon le signe (vert si positif, rouge si négatif). */
  colored?: boolean;
  /** Suffixe discret (`/ j`). */
  suffix?: string;
  className?: string;
}

/** Montant en dollars au format compact (`$1,2 Md`), valeur en ambre, titre = montant exact. */
export function Money({ value, colored, suffix, className, ...opts }: MoneyProps) {
  const tone = colored ? (value > 0 ? ' rl-money--pos' : value < 0 ? ' rl-money--neg' : '') : '';
  return (
    <span
      className={`rl-money${tone}${className ? ` ${className}` : ''}`}
      title={`${new Intl.NumberFormat(opts.locale ?? formatLocale()).format(Math.round(value))} $`}
    >
      {formatMoney(value, opts)}
      {suffix ? <span className="rl-money__suffix">{suffix}</span> : null}
    </span>
  );
}

export interface CountdownProps {
  /** Durée restante en millisecondes (le parent la recalcule à chaque rafraîchissement). */
  ms: number;
  /** Durée totale : affiche une barre de progression sous le compteur. */
  total?: number;
  /** Préfixe (`T−`). */
  prefix?: string;
  /** Unité des jours (`j`). */
  dayUnit?: string;
  /** Texte quand le décompte est terminé. */
  doneText?: string;
  urgentBelowMs?: number;
  className?: string;
}

/** Compte à rebours en chasse fixe (`T−3:12:04`), ambre, rouge sous le seuil d'urgence. */
export function Countdown({
  ms,
  total,
  prefix = '',
  dayUnit,
  doneText,
  urgentBelowMs,
  className,
}: CountdownProps) {
  const done = ms <= 0;
  const urgent = !done && urgentBelowMs !== undefined && ms < urgentBelowMs;
  return (
    <span
      className={[
        'rl-countdown',
        urgent ? 'rl-countdown--urgent' : '',
        done ? 'rl-countdown--done' : '',
        className ?? '',
      ].join(' ')}
    >
      <span className="rl-countdown__text">
        {done && doneText ? doneText : `${prefix}${formatCountdown(ms, dayUnit)}`}
      </span>
      {total ? (
        <span className="rl-countdown__bar" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(1, 1 - ms / total)) * 100}%` }} />
        </span>
      ) : null}
    </span>
  );
}
