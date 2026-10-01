import { useTranslation } from 'react-i18next';
import type {
  DomesticPolicy,
  DomesticPolicyEffects,
  DomesticPolicyView,
  Order,
} from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Gauge,
  Icon,
  KeyValue,
  Panel,
  Stat,
  Table,
  Toggle,
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

const POLICY_ICON: Record<DomesticPolicy, Parameters<typeof Icon>[0]['name']> = {
  propaganda: 'radio',
  conscription: 'users',
  war_economy: 'factory',
  austerity: 'wallet',
  stimulus: 'money',
  martial_law: 'shield',
};

/** Variation en pourcentage d'un multiplicateur (« +25 % », « −5 % »). */
function pct(x: number): string {
  const v = Math.round((x - 1) * 100);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} %`;
}
function signed(x: number, digits = 1): string {
  const v = Math.round(x * 10 ** digits) / 10 ** digits;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('fr-FR')}`;
}

type Chip = { key: string; text: string; good: boolean };

/** Effets lisibles d'une politique (seulement ceux qui changent quelque chose). */
function effectChips(e: DomesticPolicyEffects, t: (k: string) => string): Chip[] {
  const out: Chip[] = [];
  const mul = (k: 'income' | 'production' | 'infantry' | 'research', lower = false) => {
    if (e[k] !== 1)
      out.push({
        key: k,
        text: `${t(`domestic.fx.${k}`)} ${pct(e[k])}`,
        good: lower ? e[k] < 1 : e[k] > 1,
      });
  };
  mul('income');
  mul('production');
  mul('infantry');
  mul('research');
  if (e.upkeep !== 1)
    out.push({
      key: 'upkeep',
      text: `${t('domestic.fx.upkeep')} ${pct(e.upkeep)}`,
      good: e.upkeep < 1,
    });
  if (e.stabilityPerDay)
    out.push({
      key: 'stab',
      text: `${t('domestic.fx.stability')} ${signed(e.stabilityPerDay)}${t('domestic.fx.perDay')}`,
      good: e.stabilityPerDay > 0,
    });
  if (e.morale)
    out.push({
      key: 'morale',
      text: `${t('domestic.fx.morale')} ${signed(e.morale, 0)}`,
      good: e.morale > 0,
    });
  if (e.warSupport)
    out.push({
      key: 'ws',
      text: `${t('domestic.fx.warSupport')} ${signed(e.warSupport, 0)}`,
      good: e.warSupport > 0,
    });
  if (e.unrest !== 1)
    out.push({
      key: 'unrest',
      text: `${t('domestic.fx.unrest')} ${pct(e.unrest)}`,
      good: e.unrest < 1,
    });
  if (e.strikes !== 1)
    out.push({
      key: 'strikes',
      text: `${t('domestic.fx.strikes')} ${pct(e.strikes)}`,
      good: e.strikes < 1,
    });
  return out;
}

function fmtWait(ms: number): string {
  const h = Math.ceil(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)} j ${h % 24} h` : `${h} h`;
}

function PolicyCard({ p, now }: { p: DomesticPolicyView; now: number }) {
  const { t } = useTranslation();
  const send = useSend();
  const wait = p.changeableAt - now;
  const locked = wait > 0;
  return (
    <div className={p.active ? 'policy policy--on' : 'policy'} data-testid={`policy-${p.id}`}>
      <div className="policy__head">
        <span className="policy__icon" aria-hidden>
          <Icon name={POLICY_ICON[p.id]} size={15} />
        </span>
        <span className="policy__name">{t(`domestic.policies.${p.id}.name`)}</span>
        {p.active ? (
          <Badge tone="cyan" variant="solid">
            {t('domestic.active')}
          </Badge>
        ) : null}
      </div>
      <p className="policy__desc">{t(`domestic.policies.${p.id}.desc`)}</p>
      <ul className="policy__fx">
        {effectChips(p.effects, t).map((c) => (
          <li key={c.key} className={c.good ? 'fx fx--good' : 'fx fx--bad'}>
            {c.text}
          </li>
        ))}
      </ul>
      {p.effects.excludes.length ? (
        <span className="policy__excl">
          {t('domestic.excludes', {
            list: p.effects.excludes.map((x) => t(`domestic.policies.${x}.name`)).join(', '),
          })}
        </span>
      ) : null}
      <div className="policy__foot">
        <Toggle
          checked={p.active}
          disabled={locked}
          onChange={(on) =>
            void send(
              { kind: 'domesticPolicy', policy: p.id, on },
              t(on ? 'domestic.enabled' : 'domestic.disabled', {
                name: t(`domestic.policies.${p.id}.name`),
              }),
            )
          }
          label={p.active ? t('domestic.inForce') : t('domestic.suspended')}
          description={locked ? t('domestic.locked', { wait: fmtWait(wait) }) : undefined}
        />
      </div>
    </div>
  );
}

function tone(v: number, lowBad = true): 'green' | 'amber' | 'red' {
  const x = lowBad ? v : 100 - v;
  return x >= 60 ? 'green' : x >= 40 ? 'amber' : 'red';
}

/** Onglet Intérieur de la fenêtre Économie : politiques, indicateurs, troubles, événements. */
export function DomesticTab() {
  const { t } = useTranslation();
  const dom = useGame((s) => s.view?.domestic);
  const stab = useGame((s) => s.view?.stability);
  const focusOn = useUi((s) => s.focusOn);
  const defs = useWorld((s) => s.provinces);
  const now = useGameTime(5000);
  if (!dom)
    return (
      <EmptyState
        icon="shield"
        title={t('domestic.unavailable')}
        text={t('domestic.unavailableHint')}
      />
    );
  const active = dom.policies.filter((p) => p.active).length;
  return (
    <div className="vstack domestic">
      <div className="kpis">
        <Stat
          label={t('domestic.kpi.stability')}
          value={`${Math.round(dom.stability)}/100`}
          tone={tone(dom.stability)}
          sub={
            stab
              ? t('domestic.kpi.trend', { value: signed(stab.trend) })
              : t('domestic.kpi.stabilityHint')
          }
        />
        <Stat
          label={t('domestic.kpi.morale')}
          value={`${Math.round(dom.morale)}/100`}
          tone={tone(dom.morale)}
          sub={
            dom.totals.morale
              ? t('domestic.kpi.moraleShift', { value: signed(dom.totals.morale, 0) })
              : t('domestic.kpi.moraleHint')
          }
        />
        <Stat
          label={t('domestic.kpi.warSupport')}
          value={`${Math.round(dom.warSupport)}/100`}
          tone={tone(dom.warSupport)}
          sub={t('domestic.kpi.warSupportTarget', {
            value: Math.round(dom.warSupportTarget),
            factor: dom.wearinessFactor.toLocaleString('fr-FR'),
          })}
        />
        <Stat
          label={t('domestic.kpi.unrest')}
          value={`${dom.unrestRisk}/100`}
          tone={tone(dom.unrestRisk, false)}
          sub={t('domestic.kpi.unrestFactor', { value: pct(dom.unrestFactor) })}
        />
      </div>
      {dom.strikeUntil && dom.strikeUntil > now ? (
        <p className="hint hint--warn" data-testid="strike-banner">
          <Icon name="warning" size={13} />{' '}
          {t('domestic.strike', { wait: fmtWait(dom.strikeUntil - now) })}
        </p>
      ) : null}
      <Panel
        title={t('domestic.policiesTitle')}
        meta={t('domestic.activeCount', { count: active })}
      >
        <div className="policies">
          {dom.policies.map((p) => (
            <PolicyCard key={p.id} p={p} now={now} />
          ))}
        </div>
      </Panel>
      <div className="cols2">
        <Panel title={t('domestic.totalsTitle')}>
          <KeyValue
            columns={2}
            items={[
              {
                label: t('domestic.fx.income'),
                value: pct(dom.totals.income),
                tone: dom.totals.income >= 1 ? 'green' : 'red',
              },
              {
                label: t('domestic.fx.production'),
                value: pct(dom.totals.production),
                tone: dom.totals.production >= 1 ? 'green' : 'red',
              },
              {
                label: t('domestic.fx.research'),
                value: pct(dom.totals.research),
                tone: dom.totals.research >= 1 ? 'green' : 'red',
              },
              {
                label: t('domestic.fx.upkeep'),
                value: pct(dom.totals.upkeep),
                tone: dom.totals.upkeep <= 1 ? 'green' : 'red',
              },
              {
                label: t('domestic.fx.stability'),
                value: `${signed(dom.totals.stabilityPerDay)}${t('domestic.fx.perDay')}`,
                tone: dom.totals.stabilityPerDay >= 0 ? 'green' : 'red',
              },
              {
                label: t('domestic.fx.moraleTarget'),
                value: signed(dom.totals.morale, 0),
                tone: dom.totals.morale >= 0 ? 'green' : 'red',
              },
            ]}
          />
        </Panel>
        <Panel title={t('domestic.eventsTitle')} meta={String(dom.events.length)}>
          {dom.events.length === 0 ? (
            <EmptyState compact icon="check" title={t('domestic.noEvents')} />
          ) : (
            <ul className="devents">
              {dom.events.map((e) => (
                <li key={e.id} className={`devent devent--${e.severity}`}>
                  <span className="devent__time">
                    {t('domestic.ago', { value: fmtWait(Math.max(0, now - e.time)) })}
                  </span>
                  <b className="devent__title">{e.title}</b>
                  <span className="devent__text">{e.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel title={t('domestic.riskTitle')} meta={t('domestic.riskMeta')} flush>
        <Table
          label={t('domestic.riskTitle')}
          rows={dom.provinces}
          rowKey={(p) => p.id}
          dense
          empty={<EmptyState compact icon="check" title={t('domestic.noRisk')} />}
          columns={[
            {
              key: 'p',
              header: t('economy.cols.province'),
              render: (p) => (
                <span className="drisk__prov">
                  <b>{provinceName(p.id)}</b>
                  {p.occupied ? <Badge tone="amber">{t('domestic.occupied')}</Badge> : null}
                  {p.protected ? <Badge tone="cyan">{t('domestic.protected')}</Badge> : null}
                </span>
              ),
            },
            {
              key: 'r',
              header: t('domestic.cols.risk'),
              render: (p) => (
                <Gauge
                  value={p.risk / 100}
                  cells={10}
                  tone={p.risk >= 60 ? 'red' : p.risk >= 30 ? 'amber' : 'green'}
                  label={t('domestic.cols.risk')}
                  valueText={`${p.risk}`}
                />
              ),
            },
            {
              key: 'u',
              header: t('domestic.cols.unrest'),
              align: 'right',
              render: (p) => (
                <span className={p.unrest >= 25 ? 'rl-tone-red' : 'muted'}>{p.unrest}</span>
              ),
            },
            {
              key: 'a',
              header: '',
              align: 'right',
              render: (p) => {
                const at = defs[p.id]?.cityPoint;
                return at ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="mapPin" size={12} />}
                    onClick={() => focusOn(at, 6)}
                  >
                    {t('economy.show')}
                  </Button>
                ) : null;
              },
            },
          ]}
        />
      </Panel>
      <p className="hint">
        <Icon name="info" size={12} /> {t('domestic.help', { pct: formatPct(0.2) })}
      </p>
    </div>
  );
}
