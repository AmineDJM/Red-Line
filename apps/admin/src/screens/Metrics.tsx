/** Métriques du serveur : tuiles d'état et courbes échantillonnées toutes les 5 s. */
import { useState } from 'react';
import type { Metrics } from '@redline/shared';
import { useSession } from '../context';
import type { MetricsExtra } from '../api/types';
import { LineChart, SERIES } from '../components/Charts';
import { Badge, Button, ErrorBox, Icon, PageHead, Spinner, Stat, Win } from '../components/term';
import { T, fmt } from '../i18n';
import { bytes, num, uptime } from '../lib/format';
import { useInterval, useLoad } from '../lib/hooks';

const REFRESH_S = 5;
const KEEP = 120;
type M = Metrics & MetricsExtra & { at: number };

/** Kept for compatibility with earlier imports. */
export const formatUptime = uptime;

function level(v: number, [warn, crit]: [number, number]) {
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
}
const TONE = { ok: 'var(--t-green)', warn: 'var(--t-amber)', crit: 'var(--t-red)' } as const;

export function MetricsScreen() {
  const { api } = useSession();
  const [hist, setHist] = useState<M[]>([]);
  const [live, setLive] = useState(true);
  const { data, error, loading, reload } = useLoad(
    () =>
      api.metrics().then((m) => {
        const row = { ...m, at: Date.now() };
        setHist((h) => [...h, row].slice(-KEEP));
        return row;
      }),
    [api],
    T.roles.moderator,
  );
  useInterval(() => live && void reload(true), REFRESH_S * 1000);
  const times = hist.map((h) => h.at);
  const col = (k: keyof M) => hist.map((h) => Number(h[k] ?? 0));
  const badge = (v: number, th: [number, number]) => {
    const l = level(v, th);
    return (
      <Badge tone={l}>
        {l === 'ok'
          ? `✓ ${T.metrics.ok}`
          : l === 'warn'
            ? `! ${T.metrics.warn}`
            : `✕ ${T.metrics.crit}`}
      </Badge>
    );
  };

  return (
    <>
      <PageHead
        title={T.metrics.title}
        sub={fmt(T.metrics.sub, { n: REFRESH_S, k: hist.length })}
        actions={
          <Button onClick={() => setLive((v) => !v)}>
            <Icon name={live ? 'pause' : 'play'} size={14} />{' '}
            {live ? T.metrics.live : T.metrics.paused}
          </Button>
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <div className="stats">
            <Stat
              k={T.metrics.cpu}
              v={num(data.cpuPct)}
              unit="%"
              tone={TONE[level(data.cpuPct, [70, 90])]}
              d={badge(data.cpuPct, [70, 90])}
            />
            <Stat
              k={T.metrics.lag}
              v={num(data.eventLoopLagMs, 1)}
              unit="ms"
              tone={TONE[level(data.eventLoopLagMs, [50, 200])]}
              d={badge(data.eventLoopLagMs, [50, 200])}
            />
            <Stat
              k={T.metrics.rss}
              v={num(data.rssMb)}
              unit="Mo"
              tone={TONE[level(data.rssMb, [1400, 1800])]}
              d={`${T.metrics.heap} ${num(data.heapMb)} Mo`}
            />
            <Stat
              k={T.metrics.games}
              v={data.games}
              d={`${T.metrics.players} : ${data.connectedPlayers}${data.spectators !== undefined ? ` · ${T.metrics.spectators} : ${data.spectators}` : ''}`}
            />
            <Stat k={T.metrics.events} v={num(data.eventsProcessedPerMin)} />
            <Stat k={T.metrics.uptime} v={uptime(data.uptimeS)} />
            {data.stateBytes !== undefined && (
              <Stat k={T.metrics.state} v={bytes(data.stateBytes)} />
            )}
            {data.chatMessagesPerMin !== undefined && (
              <Stat
                k={T.metrics.chat}
                v={num(data.chatMessagesPerMin)}
                d={`${T.metrics.push} : ${num(data.pushSentPerMin ?? 0)}`}
              />
            )}
          </div>
          <div className="charts">
            <ChartCard title={T.metrics.cpu} value={`${num(data.cpuPct)} %`}>
              <LineChart
                title={T.metrics.cpu}
                times={times}
                series={[{ label: T.metrics.cpu, values: col('cpuPct') }]}
                format={(v) => `${num(v, 0)} %`}
              />
            </ChartCard>
            <ChartCard title={T.metrics.lag} value={`${num(data.eventLoopLagMs, 1)} ms`}>
              <LineChart
                title={T.metrics.lag}
                times={times}
                series={[{ label: T.metrics.lag, values: col('eventLoopLagMs') }]}
                format={(v) => `${num(v, 1)} ms`}
              />
            </ChartCard>
            <ChartCard title="Mémoire" value={`${num(data.rssMb)} Mo`}>
              <LineChart
                title="Mémoire"
                times={times}
                series={[
                  { label: T.metrics.rss, values: col('rssMb') },
                  { label: T.metrics.heap, values: col('heapMb') },
                ]}
                format={(v) => `${num(v, 0)} Mo`}
              />
            </ChartCard>
            <ChartCard title={T.metrics.events} value={num(data.eventsProcessedPerMin)}>
              <LineChart
                title={T.metrics.events}
                times={times}
                series={[{ label: T.metrics.events, values: col('eventsProcessedPerMin') }]}
                format={(v) => num(v, 0)}
              />
            </ChartCard>
            {data.wsBytesOutPerMin !== undefined && (
              <ChartCard title={T.metrics.wsBytes} value={bytes(data.wsBytesOutPerMin)}>
                <LineChart
                  title={T.metrics.wsBytes}
                  times={times}
                  series={[{ label: T.metrics.wsBytes, values: col('wsBytesOutPerMin') }]}
                  format={(v) => bytes(v)}
                />
              </ChartCard>
            )}
            {data.wsMessagesOutPerMin !== undefined && (
              <ChartCard title={T.metrics.wsMsgs} value={num(data.wsMessagesOutPerMin)}>
                <LineChart
                  title={T.metrics.wsMsgs}
                  times={times}
                  series={[{ label: T.metrics.wsMsgs, values: col('wsMessagesOutPerMin') }]}
                  format={(v) => num(v, 0)}
                />
              </ChartCard>
            )}
          </div>
          {data.gamesByStatus && (
            <Win title={T.metrics.byStatus} glyph="▤">
              {Object.entries(data.gamesByStatus).map(([k, v]) => {
                const total = Math.max(1, ...Object.values(data.gamesByStatus!));
                return (
                  <div key={k} className="hbar">
                    <span className="muted">
                      {T.games.statuses[k as keyof typeof T.games.statuses] ?? k}
                    </span>
                    <span className="t">
                      <span style={{ width: `${(v / total) * 100}%`, background: SERIES[0] }} />
                    </span>
                    <span className="r">{v}</span>
                  </div>
                );
              })}
            </Win>
          )}
        </>
      )}
    </>
  );
}

function ChartCard({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <div className="head">
        <span className="k">{title}</span>
        <span className="v">{value}</span>
      </div>
      {children}
    </div>
  );
}
