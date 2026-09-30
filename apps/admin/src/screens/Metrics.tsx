import { useState } from 'react';
import type { Metrics } from '@redline/shared';
import { useSession } from '../context';
import { ErrorBox, Frame, Spinner } from '../components/ui';
import { T, fmt, num } from '../i18n';
import { useInterval, useLoad } from '../lib/hooks';

const REFRESH_S = 5;
const KEEP = 60;

type Key = keyof Metrics;
interface TileDef {
  key: Key;
  label: string;
  unit?: string;
  format?: (v: number) => string;
  /** Seuils [élevé, critique] : un état n'est jamais signalé par la seule couleur (icône + texte). */
  thresholds?: [number, number];
  spark?: boolean;
}

export function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} j ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

const TILES: TileDef[] = [
  { key: 'cpuPct', label: T.metrics.cpu, unit: '%', thresholds: [70, 90], spark: true },
  {
    key: 'eventLoopLagMs',
    label: T.metrics.lag,
    unit: 'ms',
    thresholds: [50, 200],
    spark: true,
    format: (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }),
  },
  { key: 'rssMb', label: T.metrics.rss, unit: 'Mo', thresholds: [1400, 1800], spark: true },
  { key: 'heapMb', label: T.metrics.heap, unit: 'Mo', spark: true },
  { key: 'eventsProcessedPerMin', label: T.metrics.events, spark: true },
  { key: 'games', label: T.metrics.games },
  { key: 'connectedPlayers', label: T.metrics.players },
  { key: 'uptimeS', label: T.metrics.uptime, format: formatUptime },
];

export function MetricsScreen() {
  const { api } = useSession();
  const [history, setHistory] = useState<Metrics[]>([]);
  const { data, error, loading, reload } = useLoad(
    () =>
      api.metrics().then((m) => {
        setHistory((h) => [...h, m].slice(-KEEP));
        return m;
      }),
    [api],
    T.roles.moderator,
  );
  useInterval(() => void reload(true), REFRESH_S * 1000);

  return (
    <Frame title={T.metrics.title}>
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {data && (
        <div className="metric-tiles">
          {TILES.map((t) => {
            const v = data[t.key];
            const level = t.thresholds
              ? v >= t.thresholds[1]
                ? 'crit'
                : v >= t.thresholds[0]
                  ? 'warn'
                  : 'ok'
              : null;
            return (
              <div key={t.key} className="tile metric">
                <span className="tile-label">{t.label}</span>
                <span className="tile-value">
                  {t.format ? t.format(v) : num(v)}
                  {t.unit && <span className="tile-unit"> {t.unit}</span>}
                </span>
                {level && (
                  <span className={`tile-status status-${level}`}>
                    {level === 'ok' ? '●' : level === 'warn' ? '▲' : '■'} {T.metrics[level]}
                  </span>
                )}
                {t.spark && history.length > 1 && (
                  <Sparkline values={history.map((h) => h[t.key])} label={t.label} unit={t.unit} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {history.length > 1 && (
        <p className="muted small">{fmt(T.metrics.history, { n: history.length })}</p>
      )}
    </Frame>
  );
}

/** Courbe d'une seule série (pas de légende : le titre de la tuile la nomme). Survol : valeur au point. */
function Sparkline({ values, label, unit }: { values: number[]; label: string; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 160;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const hv = hover != null ? values[hover] : undefined;
  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} : ${values.map((v) => num(v)).join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)));
        }}
      >
        <path d={d} className="spark-line" />
        {hover != null && hv != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={h} className="spark-cross" />
            <circle cx={x(hover)} cy={y(hv)} r={3} className="spark-dot" />
          </>
        )}
      </svg>
      {hover != null && hv != null && (
        <span className="spark-tip mono">
          {num(hv)}
          {unit ? ` ${unit}` : ''}
        </span>
      )}
    </div>
  );
}
