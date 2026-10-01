/**
 * Graphiques de l'économie du service : barres groupées (coûts et recettes par créneau) et barres
 * horizontales de répartition (une seule teinte : la longueur porte la valeur). Même palette que les
 * métriques (validée contre #0a0e13) : #2a95c0 puis #c08010 ; un seul axe ; infobulle au survol.
 */
import { useState } from 'react';
import { SERIES } from './Charts';

const W = 900;
const H = 220;
const PAD = { l: 52, r: 8, t: 10, b: 20 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface BarSeries {
  label: string;
  values: number[];
}

/** Barres groupées (au plus deux séries), extrémités arrondies de 2 px, écart de 2 px entre barres. */
export function GroupedBars(p: {
  series: BarSeries[];
  labels: string[];
  format: (v: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = p.labels.length;
  const k = p.series.length;
  const max = niceMax(Math.max(0, ...p.series.flatMap((s) => s.values)) * 1.08);
  const slot = (W - PAD.l - PAD.r) / Math.max(1, n);
  const gap = 2;
  const bw = Math.max(1, Math.min(18, (slot * 0.72 - gap * (k - 1)) / k));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const base = y(0);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(n / 8));
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
          const i = Math.floor((px - PAD.l) / slot);
          setHover(i >= 0 && i < n ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-l" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="ax" x={PAD.l - 6} y={y(t) + 3} textAnchor="end">
              {p.format(t)}
            </text>
          </g>
        ))}
        {hover !== null && (
          <rect
            x={PAD.l + hover * slot}
            y={PAD.t}
            width={slot}
            height={H - PAD.t - PAD.b}
            fill="rgba(125,139,153,0.08)"
          />
        )}
        {p.labels.map((label, i) => {
          const x0 = PAD.l + i * slot + (slot - (bw * k + gap * (k - 1))) / 2;
          return (
            <g key={label + i}>
              {p.series.map((s, j) => {
                const v = s.values[i] ?? 0;
                const h = Math.max(0, base - y(v));
                if (h <= 0) return null;
                const x = x0 + j * (bw + gap);
                const r = Math.min(2, bw / 2, h);
                return (
                  <path
                    key={s.label}
                    d={`M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + bw - r}Q${x + bw},${base - h} ${x + bw},${base - h + r}V${base}Z`}
                    fill={SERIES[j % SERIES.length]}
                  />
                );
              })}
              {i % every === 0 && (
                <text className="ax" x={PAD.l + i * slot + slot / 2} y={H - 5} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div
          className="chart-tip"
          style={{ left: `${((PAD.l + (hover + 0.5) * slot) / W) * 100}%` }}
        >
          <div className="dim">{p.labels[hover]}</div>
          {p.series.map((s, j) => (
            <div key={s.label} className="row" style={{ gap: 6 }}>
              <span className="dot" style={{ background: SERIES[j % SERIES.length] }} />
              <span className="muted">{s.label}</span>
              <b style={{ marginLeft: 'auto' }}>{p.format(s.values[hover] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
      {k > 1 && (
        <div className="legend" style={{ marginTop: 4 }}>
          {p.series.map((s, j) => (
            <span key={s.label}>
              <i style={{ background: SERIES[j % SERIES.length], height: 8, width: 8 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Barres horizontales d'une même grandeur (répartition), valeur et part en texte. */
export function ShareBars(p: {
  rows: { label: string; value: number; hint?: string }[];
  format: (v: number) => string;
}) {
  const total = p.rows.reduce((a, r) => a + r.value, 0);
  const max = Math.max(0, ...p.rows.map((r) => r.value));
  return (
    <div className="share-bars">
      {p.rows.map((r) => (
        <div key={r.label} className="share-row" title={r.hint}>
          <span className="muted ellipsis">{r.label}</span>
          <span className="t">
            <span
              style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, background: SERIES[0] }}
            />
          </span>
          <span className="r">{p.format(r.value)}</span>
          <span className="p dim">
            {total > 0 ? `${Math.round((r.value / total) * 100)} %` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}
