import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RankingEntry, SeasonView } from '@redline/shared';
import {
  Badge,
  EmptyState,
  Icon,
  Panel,
  Select,
  Spinner,
  Stat,
  Table,
  formatInt,
  formatPct,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { Page } from '../components/Page.js';
import { fmtDate } from '../i18n/index.js';

/** Classements et saisons. */
export function RankingsScreen() {
  const { t } = useTranslation();
  const [seasons, setSeasons] = useState<SeasonView[]>([]);
  const [season, setSeason] = useState<string>('');
  const [data, setData] = useState<{ season: SeasonView; entries: RankingEntry[] } | null>(null);
  const [error, setError] = useState(false);
  const [cosmetics, setCosmetics] = useState<Record<string, string>>({});
  useEffect(() => {
    void getApi()
      .then((api) => api.cosmetics())
      .then((c) => setCosmetics(Object.fromEntries(c.items.map((i) => [i.id, i.name]))))
      .catch(() => undefined);
    void getApi()
      .then((api) => api.seasons())
      .then((s) => {
        setSeasons(s);
        setSeason(s[0]?.id ?? '');
      })
      .catch(() => setError(true));
  }, []);
  useEffect(() => {
    if (!season) return;
    void getApi()
      .then((api) => api.rankings(season))
      .then(setData)
      .catch(() => setError(true));
  }, [season]);
  const s = data?.season;
  const daysLeft = s
    ? Math.max(0, Math.ceil((new Date(s.endsAt).getTime() - Date.now()) / 86_400_000))
    : 0;
  return (
    <Page
      path={[t('rankings.path')]}
      title={t('rankings.title')}
      subtitle={t('rankings.subtitle')}
      actions={
        seasons.length ? (
          <Select
            value={season}
            onChange={setSeason}
            label={t('rankings.season')}
            options={seasons.map((x) => ({ value: x.id, label: x.name }))}
          />
        ) : null
      }
    >
      {error ? (
        <EmptyState icon="warning" title={t('rankings.error')} />
      ) : !data ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="vstack">
          <div className="kpis">
            <Stat
              label={t('rankings.season')}
              value={s?.name ?? '—'}
              sub={s ? `${fmtDate(s.startsAt)} → ${fmtDate(s.endsAt)}` : ''}
            />
            <Stat
              label={t('rankings.remaining')}
              value={t('rankings.days', { count: daysLeft })}
              tone="amber"
            />
            <Stat label={t('rankings.players')} value={formatInt(data.entries.length)} />
          </div>
          {s?.rewards.length ? (
            <Panel title={t('rankings.rewards')}>
              <div className="chips">
                {s.rewards.map((r) => (
                  <span key={r.rank} className="chip">
                    <Icon name="trophy" size={12} /> {t('rankings.top', { rank: r.rank })}{' '}
                    <b>{cosmetics[r.cosmeticId] ?? r.cosmeticId}</b>
                  </span>
                ))}
              </div>
            </Panel>
          ) : null}
          <Table
            label={t('rankings.title')}
            rows={data.entries}
            rowKey={(e) => e.userId}
            columns={[
              {
                key: 'rank',
                header: '#',
                width: '60px',
                render: (e) =>
                  e.rank <= 3 ? (
                    <span className={`medal medal--${e.rank}`}>{e.rank}</span>
                  ) : (
                    <span className="muted">{e.rank}</span>
                  ),
              },
              { key: 'name', header: t('rankings.cols.player'), render: (e) => <b>{e.name}</b> },
              {
                key: 'pts',
                header: t('rankings.cols.points'),
                align: 'right',
                render: (e) => <span className="rl-tone-amber">{formatInt(e.points)}</span>,
              },
              { key: 'w', header: t('rankings.cols.wins'), align: 'right', render: (e) => e.wins },
              {
                key: 'g',
                header: t('rankings.cols.games'),
                align: 'right',
                hideOnMobile: true,
                render: (e) => e.games,
              },
              {
                key: 'rate',
                header: t('rankings.cols.rate'),
                align: 'right',
                hideOnMobile: true,
                render: (e) => (
                  <Badge tone={e.wins / Math.max(1, e.games) > 0.35 ? 'green' : 'neutral'}>
                    {formatPct(e.wins / Math.max(1, e.games))}
                  </Badge>
                ),
              },
            ]}
          />
        </div>
      )}
    </Page>
  );
}
