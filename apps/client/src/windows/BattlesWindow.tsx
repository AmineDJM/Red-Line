import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BattleReport, BattleReportSummary, BattleSide } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Spinner,
  WeaponPhoto,
  Window,
  formatInt,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { BattleReplay } from '../components/BattleReplay.js';
import { Ago, NationTag } from '../components/Common.js';
import { fmtClock, fmtDuration } from '../i18n/index.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

function outcomeFor(b: BattleReportSummary, me: string | null): { tone: 'green' | 'red' | 'amber' | 'cyan'; key: string } {
  if (b.outcome === 'ongoing') return { tone: 'cyan', key: 'ongoing' };
  if (b.outcome === 'draw') return { tone: 'amber', key: 'draw' };
  const winners = b.outcome === 'attacker' ? b.attacker.nations : b.defender.nations;
  return winners.includes(me ?? '') ? { tone: 'green', key: 'victory' } : { tone: 'red', key: 'defeat' };
}

const lossCount = (s: BattleSide) => s.losses.reduce((n, x) => n + x.count, 0);
const engagedCount = (s: BattleSide) => s.engaged.reduce((n, x) => n + x.count, 0);

function SideTable({ side, label, tone }: { side: BattleSide; label: string; tone: 'red' | 'cyan' }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  return (
    <Panel
      title={label}
      accent={tone}
      meta={
        <span className="row">
          {side.nations.map((n) => (
            <NationTag key={n} id={n} size={10} />
          ))}
        </span>
      }
      flush
    >
      <table className="rl-table rl-table--dense">
        <thead>
          <tr>
            <th>{t('battles.system')}</th>
            <th style={{ textAlign: 'right' }}>{t('battles.engaged')}</th>
            <th style={{ textAlign: 'right' }}>{t('battles.lost')}</th>
          </tr>
        </thead>
        <tbody>
          {side.engaged.map((e) => {
            const s = catalog[e.systemId];
            const lost = side.losses.find((l) => l.systemId === e.systemId)?.count ?? 0;
            return (
              <tr key={e.systemId}>
                <td>
                  <span className="qrow">
                    {s ? <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" /> : null}
                    <b>{s?.name ?? e.systemId}</b>
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>{formatInt(e.count)}</td>
                <td style={{ textAlign: 'right' }} className={lost ? 'rl-tone-red' : 'muted'}>
                  {lost ? `−${lost}` : '0'}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>{t('battles.total')}</td>
            <td style={{ textAlign: 'right' }}>{formatInt(engagedCount(side))}</td>
            <td style={{ textAlign: 'right' }} className="rl-tone-red">
              −{formatInt(lossCount(side))}
            </td>
          </tr>
        </tfoot>
      </table>
    </Panel>
  );
}

function Detail({ summary }: { summary: BattleReportSummary }) {
  const { t } = useTranslation();
  const meta = useGame((s) => s.meta);
  const me = useGame((s) => s.me);
  const focusOn = useUi((s) => s.focusOn);
  const [report, setReport] = useState<BattleReport | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setReport(null);
    setError(false);
    void getApi()
      .then((api) => api.battleReport(meta?.id ?? 'demo', summary.id))
      .then(setReport)
      .catch(() => setError(true));
  }, [summary.id, meta?.id]);
  const o = outcomeFor(summary, me);
  return (
    <div className="battle">
      <header className="battle__head">
        <div>
          <Badge tone={o.tone} variant="solid">
            {t(`battles.outcome.${o.key}`)}
          </Badge>
          <h3>{summary.title}</h3>
          <span className="muted small">
            {fmtClock(summary.startedAt).day} {fmtClock(summary.startedAt).time}
            {summary.endedAt ? ` · ${t('battles.lasted', { value: fmtDuration(summary.endedAt - summary.startedAt) })}` : ''}
          </span>
        </div>
        <Button size="sm" variant="subtle" icon={<Icon name="mapPin" size={12} />} onClick={() => focusOn(summary.at, 7)}>
          {t('news.locate')}
        </Button>
      </header>
      {report ? <BattleReplay report={report} /> : error ? <p className="hint">{t('battles.noDetail')}</p> : <Spinner label={t('app.loading')} />}
      <div className="battle__sides">
        <SideTable side={summary.attacker} label={t('battles.attacker')} tone="red" />
        <SideTable side={summary.defender} label={t('battles.defender')} tone="cyan" />
      </div>
      {report ? (
        <div className="cols2">
          <Panel title={t('battles.countermeasures')}>
            <ul className="plainlist">
              {report.countermeasures.map((c, i) => (
                <li key={i} className="cm">
                  <b className="rl-tone-amber">×{c.count}</b> {c.text}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title={t('battles.timeline')}>
            <ol className="btimeline">
              {report.timeline.map((e, i) => (
                <li key={i}>
                  <span>{fmtClock(e.t).time}</span>
                  <p>{e.text}</p>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

/** Rapports de bataille : pertes, contre-mesures, chronologie, replay animé. */
export function BattlesWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const reports = useGame((s) => s.view?.battleReports ?? []);
  const me = useGame((s) => s.me);
  const now = useGameTime(10_000);
  const [sel, setSel] = useState<string | null>(win.params.reportId ?? null);
  useEffect(() => {
    if (win.params.reportId) setSel(win.params.reportId);
  }, [win.seq, win.params.reportId]);
  const list = [...reports].sort((a, b) => b.startedAt - a.startedAt);
  const cur = list.find((r) => r.id === sel) ?? (mobile ? null : list[0]);
  return (
    <Window {...frame} path={[t('sections.path.battles'), cur ? cur.id : '']} flush>
      {!list.length ? (
        <EmptyState icon="battle" title={t('battles.empty')} />
      ) : (
        <div className={mobile ? 'battles battles--mobile' : 'battles'}>
          {!mobile || !cur ? (
            <ul className="battles__list">
              {list.map((b) => {
                const o = outcomeFor(b, me);
                return (
                  <li key={b.id}>
                    <button type="button" className={cur?.id === b.id ? 'bitem bitem--sel' : 'bitem'} onClick={() => setSel(b.id)}>
                      <span className="bitem__top">
                        <Badge tone={o.tone} dot pulse={b.outcome === 'ongoing'}>
                          {t(`battles.outcome.${o.key}`)}
                        </Badge>
                        <Ago from={b.startedAt} now={now} />
                      </span>
                      <span className="bitem__title">{b.title}</span>
                      <span className="bitem__loss">
                        <span className="rl-tone-red">−{lossCount(b.attacker)}</span> / <span className="rl-tone-red">−{lossCount(b.defender)}</span>
                        <span className="muted"> {t('battles.losses')}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {cur ? (
            <div className="battles__detail">
              {mobile ? (
                <Button variant="ghost" size="sm" icon={<Icon name="chevronLeft" size={13} />} onClick={() => setSel(null)}>
                  {t('battles.back')}
                </Button>
              ) : null}
              <Detail summary={cur} />
            </div>
          ) : null}
        </div>
      )}
    </Window>
  );
}
