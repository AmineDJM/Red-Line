import type { ReactNode } from 'react';
import type { Tone } from './Badge.js';

type BarTone = Exclude<Tone, 'neutral'> | 'auto';

function autoTone(v: number): Exclude<Tone, 'neutral'> {
  return v < 0.3 ? 'red' : v < 0.6 ? 'amber' : 'green';
}

export interface ProgressBarProps {
  /** Fraction 0..1. */
  value: number;
  /** `auto` : rouge < 30 %, ambre < 60 %, vert au-delà (états, santé). */
  tone?: BarTone;
  /** Libellé accessible. */
  label?: string;
  /** Texte à droite (pourcentage, temps restant). */
  trailing?: ReactNode;
  size?: 'xs' | 'sm' | 'md';
  /** Animation de progression indéterminée. */
  indeterminate?: boolean;
  className?: string;
}

/** Barre fine et nette (progression de production, recherche, capture). */
export function ProgressBar({
  value,
  tone = 'cyan',
  label,
  trailing,
  size = 'sm',
  indeterminate,
  className,
}: ProgressBarProps) {
  const v = Math.max(0, Math.min(1, value));
  const t = tone === 'auto' ? autoTone(v) : tone;
  return (
    <div className={['rl-progress', `rl-progress--${size}`, className ?? ''].join(' ')}>
      <div
        className={`rl-progress__track rl-progress__track--${t}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(v * 100)}
      >
        <div
          className={
            indeterminate ? 'rl-progress__fill rl-progress__fill--ind' : 'rl-progress__fill'
          }
          style={indeterminate ? undefined : { width: `${v * 100}%` }}
        />
      </div>
      {trailing !== undefined ? <span className="rl-progress__trail">{trailing}</span> : null}
    </div>
  );
}

export interface GaugeProps {
  /** Fraction 0..1. */
  value: number;
  /** Nombre de cellules (défaut 10) : `████░░░░ 54 %`. */
  cells?: number;
  tone?: BarTone;
  label?: string;
  /** Affiche le pourcentage à droite (défaut vrai). */
  showValue?: boolean;
  /** Texte à droite à la place du pourcentage. */
  valueText?: ReactNode;
  className?: string;
}

/** Jauge en blocs façon terminal, rendue en CSS (cellules nettes, pas de caractères). */
export function Gauge({
  value,
  cells = 10,
  tone = 'cyan',
  label,
  showValue = true,
  valueText,
  className,
}: GaugeProps) {
  const v = Math.max(0, Math.min(1, value));
  const t = tone === 'auto' ? autoTone(v) : tone;
  const filled = v * cells;
  return (
    <span
      className={['rl-gauge', `rl-gauge--${t}`, className ?? ''].join(' ')}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <span className="rl-gauge__cells" aria-hidden>
        {Array.from({ length: cells }, (_, i) => {
          const f = Math.max(0, Math.min(1, filled - i));
          return (
            <span key={i} className="rl-gauge__cell">
              {f > 0 ? <span style={{ width: `${f * 100}%` }} /> : null}
            </span>
          );
        })}
      </span>
      {showValue ? (
        <span className="rl-gauge__value">{valueText ?? `${Math.round(v * 100)} %`}</span>
      ) : null}
    </span>
  );
}

/** Mini-courbe (tendance d'un indicateur) en SVG, sans axes. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  tone = 'cyan',
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: Exclude<Tone, 'neutral'>;
  label?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * (width - 2) + 1,
    height - 2 - ((v - min) / span) * (height - 4),
  ]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg
      className={`rl-spark rl-spark--${tone}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={`${d} L${width - 1} ${height} L1 ${height} Z`} className="rl-spark__area" />
      <path d={d} className="rl-spark__line" />
      <circle cx={last[0]} cy={last[1]} r={2} className="rl-spark__dot" />
    </svg>
  );
}
