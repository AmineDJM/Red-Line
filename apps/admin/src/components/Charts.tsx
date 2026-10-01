/**
 * Courbes des métriques : un seul axe par graphique, traits de 2 px, grille discrète,
 * réticule et infobulle au survol, légende dès deux séries. Palette validée (scripts dataviz)
 * contre le fond sombre #0a0e13 : #2a95c0 puis #c08010.
 */
import { useId, useState } from 'react';

export const SERIES = ['#2a95c0', '#c08010'] as const;

export interface Series {
  label: string;
  values: number[];
}

const W = 380;
const H = 140;
const PAD = { l: 46, r: 8, t: 10, b: 18 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function LineChart(p: {
  series: Series[];
  /** Horodatage de chaque point (même longueur que les séries). */
  times: number[];
  format: (v: number) => string;
  title: string;
  min?: number;
  /** Libellé d'un horodatage (défaut : heure:minute:seconde). */
  timeLabel?: (t: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId();
  const n = p.times.length;
  const all = p.series.flatMap((s) => s.values);
  const max = niceMax(Math.max(0, ...all) * 1.1);
  const lo = p.min ?? 0;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (max - lo || 1)) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => lo + f * (max - lo));
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const hi = hover ?? n - 1;
  const at = (t: number) =>
    p.timeLabel?.(t) ??
    new Date(t).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  return (
    <div style={{ position: 'relative' }}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={p.title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          if (n < 2) return;
          const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={SERIES[0]} stopOpacity="0.22" />
            <stop offset="1" stopColor={SERIES[0]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-l" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="ax" x={PAD.l - 6} y={y(t) + 3} textAnchor="end">
              {p.format(t)}
            </text>
          </g>
        ))}
        {n > 1 && p.series[0] && (
          <path
            d={`${path(p.series[0].values)}L${x(n - 1)},${y(lo)}L${x(0)},${y(lo)}Z`}
            fill={`url(#${gid})`}
          />
        )}
        {n > 1 &&
          p.series.map((s, k) => (
            <path
              key={s.label}
              d={path(s.values)}
              fill="none"
              stroke={SERIES[k % SERIES.length]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {n > 0 && hover !== null && (
          <line
            x1={x(hi)}
            x2={x(hi)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="#7d8b99"
            strokeDasharray="2 3"
          />
        )}
        {n > 0 &&
          p.series.map((s, k) => (
            <circle
              key={s.label}
              cx={x(hi)}
              cy={y(s.values[hi] ?? 0)}
              r={4}
              fill={SERIES[k % SERIES.length]}
              stroke="#0a0e13"
              strokeWidth={2}
            />
          ))}
        {n > 0 && (
          <text className="ax" x={W - PAD.r} y={H - 4} textAnchor="end">
            {at(p.times[n - 1]!)}
          </text>
        )}
        {n > 0 && (
          <text className="ax" x={PAD.l} y={H - 4}>
            {at(p.times[0]!)}
          </text>
        )}
      </svg>
      {hover !== null && n > 0 && (
        <div className="chart-tip" style={{ left: `${(x(hi) / W) * 100}%` }}>
          <div className="dim">{at(p.times[hi]!)}</div>
          {p.series.map((s, k) => (
            <div key={s.label} className="row" style={{ gap: 6 }}>
              <span className="dot" style={{ background: SERIES[k % SERIES.length] }} />
              <span className="muted">{s.label}</span>
              <b style={{ marginLeft: 'auto' }}>{p.format(s.values[hi] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
      {p.series.length > 1 && (
        <div className="legend" style={{ marginTop: 4 }}>
          {p.series.map((s, k) => (
            <span key={s.label}>
              <i style={{ background: SERIES[k % SERIES.length], height: 2 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
