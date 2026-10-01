import { useTranslation } from 'react-i18next';
import { INTERIOR_FOCUS, type InteriorFocus, type Order, type ThreatGrade } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Gauge,
  Icon,
  Money,
  Panel,
  ProgressBar,
  Segmented,
  Stat,
  Table,
  formatPct,
} from '@redline/ui';
import { provinceName } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import '../styles/w-domestic.css';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };
}

const GRADE_TONE: Record<ThreatGrade, 'green' | 'amber' | 'red' | 'violet'> = {
  low: 'green',
  moderate: 'amber',
  high: 'red',
  critical: 'violet',
};

function gradeOf(v: number): ThreatGrade {
  return v >= 75 ? 'critical' : v >= 50 ? 'high' : v >= 25 ? 'moderate' : 'low';
}

/** Onglet Intérieur de la console de renseignement : sécurité intérieure. */
export function IntelInterior({ onOpenReport }: { onOpenReport: (id: string) => void }) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const focusOn = useUi((s) => s.focusOn);
  const defs = useWorld((s) => s.provinces);
  const now = useGameTime(5000);
  const send = useSend();
  const it = intel?.interior;
  if (!intel || !it)
    return (
      <EmptyState
        icon="shield"
        title={t('interior.unavailable')}
        text={t('intel.unavailableHint')}
      />
    );
  const dept = intel.departments.find((d) => d.id === 'interior');
  const budget = dept?.budgetPerDay ?? 0;
  const setBudget = (v: number) =>
    void send(
      { kind: 'intelBudget', dept: 'interior', budgetPerDay: Math.max(0, Math.round(v)) },
      t('interior.budgetSet'),
    );
  const reports = intel.reports.filter((r) => r.dept === 'interior').slice(0, 8);
  const full = it.protected.length >= it.maxProtected;
  const grade = gradeOf(it.threatLevel);
  const m = it.metrics;
  return (
    <div className="interior" data-testid="intel-interior">
      <div className="kpis">
        <Stat
          label={t('interior.kpi.threat')}
          value={`${it.threatLevel}/100`}
          tone={grade === 'low' ? 'green' : grade === 'moderate' ? 'amber' : 'red'}
          sub={t(`interior.grades.${grade}`)}
        />
        <Stat
          label={t('interior.kpi.quality')}
          value={formatPct(m.quality)}
          tone="cyan"
          sub={t('interior.kpi.level', { level: dept?.level ?? 1 })}
        />
        <Stat
          label={t('interior.kpi.foiled')}
          value={it.stats.foiled}
          tone="green"
          sub={t('interior.kpi.alerts', { count: it.stats.alerts })}
        />
        <Stat
          label={t('interior.kpi.caught')}
          value={it.stats.caught}
          tone="violet"
          sub={t('interior.kpi.doubles', { count: it.stats.doubles })}
        />
      </div>
      <div className="cols2">
        <Panel title={t('interior.focusTitle')} accent="cyan">
          <Segmented<InteriorFocus>
            label={t('interior.focusTitle')}
            value={it.focus}
            onChange={(focus) =>
              void send(
                { kind: 'interiorFocus', focus },
                t('interior.focusSet', { name: t(`interior.focus.${focus}.name`) }),
              )
            }
            options={INTERIOR_FOCUS.map((f) => ({
              value: f,
              label: t(`interior.focus.${f}.name`),
              title: t(`interior.focus.${f}.desc`),
            }))}
          />
          <p className="hint interior__focus-desc">{t(`interior.focus.${it.focus}.desc`)}</p>
          <div className="interior__budget">
            <span className="dept__label">{t('interior.budget')}</span>
            <Money value={budget} suffix={t('game.topbar.perDay')} />
            <span className="interior__budget-btns">
              <Button size="sm" variant="subtle" onClick={() => setBudget(budget / 2)}>
                ÷2
              </Button>
              <Button size="sm" variant="subtle" onClick={() => setBudget(budget * 2 || 1e6)}>
                ×2
              </Button>
            </span>
          </div>
        </Panel>
        <Panel title={t('interior.metricsTitle')} meta={t('interior.metricsMeta')}>
          <ul className="imetrics">
            {(
              [
                ['agentDetect', m.agentDetectPerDay, 0.2],
                ['opDetect', m.opDetect, 1],
                ['protection', m.protection, 1],
                ['unrestReduction', m.unrestReduction, 1],
              ] as const
            ).map(([k, v, scale]) => (
              <li key={k}>
                <span className="imetrics__label">{t(`interior.metrics.${k}`)}</span>
                <ProgressBar
                  value={v / scale}
                  tone="cyan"
                  size="sm"
                  label={t(`interior.metrics.${k}`)}
                  trailing={formatPct(v)}
                />
                <span className="imetrics__hint">{t(`interior.metrics.${k}Hint`)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel
        title={t('interior.threatsTitle')}
        meta={t('interior.protectedCount', { n: it.protected.length, max: it.maxProtected })}
        flush
      >
        <Table
          label={t('interior.threatsTitle')}
          rows={it.threats}
          rowKey={(x) => x.provinceId}
          dense
          empty={<EmptyState compact icon="check" title={t('interior.noThreat')} />}
          rowClass={(x) => (x.grade === 'critical' ? 'is-critical' : undefined)}
          columns={[
            {
              key: 'p',
              header: t('economy.cols.province'),
              render: (x) => (
                <span className="drisk__prov">
                  <b>{provinceName(x.provinceId)}</b>
                  {x.protected ? (
                    <Badge tone="cyan">
                      <Icon name="shield" size={10} /> {t('interior.protectedShort')}
                    </Badge>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'l',
              header: t('interior.cols.threat'),
              render: (x) => (
                <span className="ithreat">
                  <Gauge
                    value={x.level / 100}
                    cells={10}
                    tone={GRADE_TONE[x.grade]}
                    label={t('interior.cols.threat')}
                    valueText={`${x.level}`}
                  />
                  <Badge tone={GRADE_TONE[x.grade]}>{t(`interior.grades.${x.grade}`)}</Badge>
                </span>
              ),
            },
            {
              key: 'f',
              header: t('interior.cols.factors'),
              render: (x) => <span className="muted small">{x.factors.join(' · ')}</span>,
            },
            {
              key: 'a',
              header: '',
              align: 'right',
              render: (x) => {
                const at = defs[x.provinceId]?.cityPoint;
                return (
                  <span className="ithreat__acts">
                    <Button
                      size="sm"
                      variant={x.protected ? 'ghost' : 'subtle'}
                      disabled={!x.protected && full}
                      icon={<Icon name="shield" size={12} />}
                      onClick={() =>
                        void send(
                          { kind: 'protectSite', provinceId: x.provinceId, on: !x.protected },
                          t(x.protected ? 'interior.unprotected' : 'interior.protectedOk', {
                            name: provinceName(x.provinceId),
                          }),
                        )
                      }
                      data-testid={`protect-${x.provinceId}`}
                    >
                      {x.protected ? t('interior.unprotect') : t('interior.protect')}
                    </Button>
                    {at ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon name="mapPin" size={12} />}
                        onClick={() => focusOn(at, 6)}
                        aria-label={t('economy.show')}
                      />
                    ) : null}
                  </span>
                );
              },
            },
          ]}
        />
      </Panel>
      <Panel title={t('interior.reportsTitle')} meta={String(reports.length)} flush>
        {reports.length === 0 ? (
          <EmptyState compact icon="document" title={t('interior.noReports')} />
        ) : (
          <ul className="ireports">
            {reports.map((r) => (
              <li key={r.id}>
                <button type="button" className="ireport" onClick={() => onOpenReport(r.id)}>
                  <span className={`ireport__grade ireport__grade--${r.reliability}`}>
                    {r.reliability}
                    {r.credibility}
                  </span>
                  <span className="ireport__title">{r.title}</span>
                  <span className="ireport__time">
                    {t('domestic.ago', {
                      value: `${Math.max(0, Math.round((now - r.time) / 3_600_000))} h`,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
