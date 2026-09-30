import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEPARTMENTS,
  type Department,
  type IntelOpKind,
  type IntelReport,
  type IntelSource,
  type NationId,
  type Order,
} from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Gauge,
  Icon,
  Money,
  ProgressBar,
  Select,
  Tabs,
  Window,
  formatMoney,
  formatPct,
  type IconName,
} from '@redline/ui';
import { Ago, Cotation, NationTag, isLowCotation } from '../components/Common.js';
import { MiniMap } from '../components/MiniMap.js';
import { fmtDuration } from '../i18n/index.js';
import { nationName, provinceName } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

/** Opérations proposées par département et par source (affichage ; le moteur décide). */
export const OPS_BY_DEPT: Record<Department, Record<IntelSource, IntelOpKind[]>> = {
  interior: { humint: ['counterintel_sweep', 'turn_agent', 'plant_fake_report'], sigint: [] },
  exterior: {
    humint: ['infiltrate_spy', 'recruit_source', 'steal_research', 'sabotage_factory', 'fund_rebels', 'exfiltrate', 'leak_plans'],
    sigint: ['cyber_production', 'disinformation'],
  },
  military: {
    humint: ['deploy_decoys'],
    sigint: ['listen_area', 'intercept_army', 'jam_area', 'cyber_radar', 'cyber_orders', 'fake_radio_traffic'],
  },
};

const DEPT_ICON: Record<Department, IconName> = { interior: 'shield', exterior: 'globe', military: 'target' };

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res) toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };
}

function ReportCard({ r, now, open, onToggle }: { r: IntelReport; now: number; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const focusOn = useUi((s) => s.focusOn);
  const select = useUi((s) => s.select);
  const inspect = useUi((s) => s.inspect);
  const selectProvince = useUi((s) => s.selectProvince);
  const view = useGame((s) => s.view);
  const send = useSend();
  const allies = view?.diplomacy?.alliances.find((a) => a.id === view.diplomacy?.myAllianceId)?.members.filter((m) => m !== view.me) ?? [];
  const low = isLowCotation(r.reliability, r.credibility);
  const flash = r.kind === 'flash';
  const doAction = (a: IntelReport['actions'][number]) => {
    switch (a.kind) {
      case 'plan_strike':
      case 'send_recon':
        focusOn(a.at, 6.5);
        if (a.kind === 'send_recon')
          void send({ kind: 'intelOp', op: 'listen_area', target: { at: a.at, radiusKm: 80 } }, t('intel.reconSent'));
        break;
      case 'share':
        if (allies[0]) void send({ kind: 'shareReport', reportId: a.reportId, to: allies[0] }, t('intel.shared', { nation: nationName(allies[0]) }));
        break;
      case 'open_unit':
        if (view?.units[a.unitId]?.owner === view?.me) select([a.unitId]);
        else inspect(a.unitId);
        break;
      case 'open_province':
        if (!a.provinceId) break;
        selectProvince(a.provinceId);
        {
          const p = useWorld.getState().provinces[a.provinceId];
          if (p) focusOn(p.cityPoint, 6);
        }
        break;
    }
  };
  return (
    <article className={['report', flash ? 'report--flash' : '', open ? 'report--open' : '', low ? 'report--low' : ''].join(' ')}>
      <button type="button" className="report__head" onClick={onToggle} aria-expanded={open}>
        <Cotation r={r.reliability} c={r.credibility} />
        <span className="report__titles">
          <span className="report__meta">
            {flash ? <Badge tone="red" variant="solid">{t('intel.flash')}</Badge> : <span className="report__kind">{t(`intel.kinds.${r.kind}`)}</span>}
            {r.sharedBy ? <Badge tone="green" variant="outline">{t('intel.sharedBy', { nation: nationName(r.sharedBy) })}</Badge> : null}
            <Ago from={r.time} now={now} />
          </span>
          <span className="report__title">{r.title}</span>
        </span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} className="report__chev" />
      </button>
      {open ? (
        <div className="report__body">
          {low ? (
            <p className="report__warn">
              <Icon name="warning" size={13} /> {t('intel.lowCotation')}
            </p>
          ) : null}
          <div className={r.at ? 'report__grid' : undefined}>
            <pre className="report__text">{r.body}</pre>
            {r.at ? (
              <MiniMap
                center={r.at}
                spanKm={Math.max(120, r.radiusKm * 3)}
                markers={[{ at: r.at, radiusKm: r.radiusKm, color: flash ? '#ff4d5e' : '#ffb020', shape: 'cross', size: 4 }]}
                height={120}
                label={t('intel.minimap')}
              />
            ) : null}
          </div>
          {r.subject?.nationId ? (
            <div className="report__subject">
              <span>{t('intel.subject')}</span> <NationTag id={r.subject.nationId} />
              {r.subject.provinceId ? <span className="muted">· {provinceName(r.subject.provinceId)}</span> : null}
            </div>
          ) : null}
          {r.actions.length ? (
            <div className="report__actions">
              {r.actions.map((a, i) => (
                <Button key={i} size="sm" variant={a.kind === 'plan_strike' ? 'danger' : 'subtle'} icon={<Icon name={ACTION_ICON[a.kind]} size={12} />} onClick={() => doAction(a)}>
                  {t(`intel.actions.${a.kind}`)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const ACTION_ICON: Record<IntelReport['actions'][number]['kind'], IconName> = {
  plan_strike: 'target',
  send_recon: 'satellite',
  share: 'send',
  open_unit: 'eye',
  open_province: 'mapPin',
};

function LaunchDialog({ dept, source, onClose }: { dept: Department; source: IntelSource; onClose: () => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const balance = useWorld((s) => s.balance);
  const nations = useWorld((s) => s.nations);
  const send = useSend();
  const ops = OPS_BY_DEPT[dept][source];
  const [op, setOp] = useState<IntelOpKind>(ops[0] ?? 'infiltrate_spy');
  const enemies = useMemo(
    () =>
      Object.values(nations)
        .filter((n) => n.id !== me)
        .sort((a, b) => {
          const ra = view?.nations[a.id]?.relation === 'war' ? 0 : 1;
          const rb = view?.nations[b.id]?.relation === 'war' ? 0 : 1;
          return ra - rb || a.name.localeCompare(b.name, 'fr');
        }),
    [nations, me, view?.nations],
  );
  const [target, setTarget] = useState<NationId>(op === 'counterintel_sweep' ? (me ?? '') : (enemies[0]?.id ?? ''));
  const cost = balance?.intel?.ops[op];
  const selfTarget = op === 'counterintel_sweep' || op === 'plant_fake_report';
  return (
    <Dialog
      open
      title={t('intel.launch')}
      path={[t('sections.path.intel'), t(`intel.depts.${dept}`), 'nouvelle-op']}
      onClose={onClose}
      closeLabel={t('app.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="play" size={12} />}
            onClick={() => {
              void send(
                { kind: 'intelOp', op, target: { nationId: selfTarget ? me ?? undefined : target } },
                t('intel.opLaunched', { op: t(`intel.ops.${op}`) }),
              );
              onClose();
            }}
            data-testid="intel-launch-confirm"
          >
            {t('intel.launchShort')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('intel.operation')}>
          <Select value={op} onChange={(v) => setOp(v as IntelOpKind)} options={ops.map((o) => ({ value: o, label: t(`intel.ops.${o}`) }))} />
        </Field>
        <p className="hint">{t(`intel.opsHelp.${op}`)}</p>
        {!selfTarget ? (
          <Field label={t('intel.target')}>
            <Select value={target} onChange={setTarget} options={enemies.map((n) => ({ value: n.id, label: `${view?.nations[n.id]?.relation === 'war' ? '⚔ ' : ''}${n.name}` }))} />
          </Field>
        ) : null}
        <dl className="opcost">
          <div>
            <dt>{t('intel.cost')}</dt>
            <dd className="rl-money">{cost ? formatMoney(cost.money) : '—'}</dd>
          </div>
          <div>
            <dt>{t('intel.duration')}</dt>
            <dd>{cost ? `${cost.durationH} h` : '—'}</dd>
          </div>
          <div>
            <dt>{t('intel.success')}</dt>
            <dd>{cost ? formatPct(cost.baseSuccess) : '—'}</dd>
          </div>
          <div>
            <dt>{t('intel.exposure')}</dt>
            <dd className="rl-tone-red">{cost ? formatPct(cost.exposure) : '—'}</dd>
          </div>
        </dl>
      </div>
    </Dialog>
  );
}

function DeptColumn({ dept, source, now, openId, setOpenId }: { dept: Department; source: IntelSource; now: number; openId: string | null; setOpenId: (id: string | null) => void }) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const send = useSend();
  const [launch, setLaunch] = useState(false);
  if (!intel) return null;
  const d = intel.departments.find((x) => x.id === dept);
  const reports = intel.reports.filter((r) => r.dept === dept && r.source === source);
  const ops = intel.operations.filter((o) => o.dept === dept);
  const canLaunch = OPS_BY_DEPT[dept][source].length > 0;
  const step = 250_000;
  return (
    <section className={`dept dept--${dept}`} aria-label={t(`intel.depts.${dept}`)}>
      <header className="dept__head">
        <span className="dept__icon">
          <Icon name={DEPT_ICON[dept]} size={15} />
        </span>
        <span className="dept__titles">
          <h3>{t(`intel.depts.${dept}`)}</h3>
          <span>{t(`intel.deptsShort.${dept}`)}</span>
        </span>
        {d ? <Badge tone="cyan" variant="outline">{t('intel.level', { level: d.level })}</Badge> : null}
      </header>
      {d ? (
        <div className="dept__stats">
          <div className="dept__budget">
            <span className="dept__label">{t('intel.budget')}</span>
            <span className="dept__budget-ctl">
              <button type="button" onClick={() => void send({ kind: 'intelBudget', dept, budgetPerDay: Math.max(0, d.budgetPerDay - step) }, t('intel.budgetSet'))} aria-label={t('intel.budgetDown')}>
                <Icon name="minus" size={11} />
              </button>
              <Money value={d.budgetPerDay} suffix={t('game.topbar.perDay')} />
              <button type="button" onClick={() => void send({ kind: 'intelBudget', dept, budgetPerDay: d.budgetPerDay + step }, t('intel.budgetSet'))} aria-label={t('intel.budgetUp')}>
                <Icon name="plus" size={11} />
              </button>
            </span>
          </div>
          <div className="dept__cap">
            <span className="dept__label">{t('intel.capacity')}</span>
            <Gauge value={d.running / Math.max(1, d.capacity)} cells={d.capacity} tone={d.running >= d.capacity ? 'amber' : 'cyan'} valueText={`${d.running}/${d.capacity}`} />
          </div>
        </div>
      ) : null}
      <div className="dept__reports">
        {reports.length ? (
          reports.map((r) => (
            <ReportCard key={r.id} r={r} now={now} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
          ))
        ) : (
          <EmptyState compact icon={source === 'humint' ? 'spy' : 'radio'} title={t('intel.noReports')} />
        )}
      </div>
      <div className="dept__ops">
        <div className="dept__ops-head">
          <span className="dept__label">
            {t('intel.operations')} <b>{ops.length}</b>
          </span>
          {canLaunch ? (
            <Button size="sm" variant="subtle" icon={<Icon name="plus" size={12} />} onClick={() => setLaunch(true)} data-testid={`intel-launch-${dept}`}>
              {t('intel.launchShort')}
            </Button>
          ) : null}
        </div>
        {ops.map((o) => {
          const f = (now - o.startedAt) / Math.max(1, o.completesAt - o.startedAt);
          return (
            <div key={o.id} className={`op op--${o.status}`}>
              <div className="op__row">
                <span className="op__name">{t(`intel.ops.${o.kind}`)}</span>
                {o.status === 'running' ? (
                  <span className="op__est" title={t('intel.estimate')}>
                    {formatPct(o.estimate)}
                  </span>
                ) : (
                  <Badge tone={o.status === 'success' ? 'green' : o.status === 'compromised' ? 'red' : 'amber'}>{t(`intel.opStatus.${o.status}`)}</Badge>
                )}
                {o.status === 'running' ? (
                  <button type="button" className="op__cancel" onClick={() => void send({ kind: 'cancelIntelOp', opId: o.id }, t('intel.opCancelled'))} aria-label={t('app.cancel')}>
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
              <div className="op__target">
                {o.target.nationId ? <NationTag id={o.target.nationId} size={9} /> : null}
                {o.target.provinceId ? <span>{provinceName(o.target.provinceId)}</span> : null}
                {o.target.at && !o.target.provinceId ? <span>{t('intel.zone', { km: o.target.radiusKm ?? 0 })}</span> : null}
              </div>
              {o.status === 'running' ? (
                <ProgressBar value={f} size="xs" trailing={fmtDuration(Math.max(0, o.completesAt - now))} label={t('intel.progress')} />
              ) : null}
            </div>
          );
        })}
      </div>
      {launch ? <LaunchDialog dept={dept} source={source} onClose={() => setLaunch(false)} /> : null}
    </section>
  );
}

function Agents() {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const send = useSend();
  const now = useGameTime(5000);
  if (!intel) return null;
  return (
    <div className="agents">
      <div className="agents__col">
        <span className="dept__label">{t('intel.agents')}</span>
        <ul>
          {intel.agents.map((a) => (
            <li key={a.id} className={`agent agent--${a.status}`}>
              <span className="agent__code">{a.codename}</span>
              <NationTag id={a.nationId} size={9} />
              <Badge tone={a.status === 'active' ? 'green' : a.status === 'double' ? 'violet' : a.status === 'burned' || a.status === 'captured' ? 'red' : 'neutral'}>
                {t(`intel.agentStatus.${a.status}`)}
              </Badge>
              <Ago from={a.since} now={now} />
            </li>
          ))}
        </ul>
      </div>
      <div className="agents__col">
        <span className="dept__label">{t('intel.caught')}</span>
        <ul>
          {intel.caughtAgents.map((c) => (
            <li key={c.id} className="agent">
              <span className="agent__code">{t('intel.caughtAgent')}</span>
              <NationTag id={c.nationId} size={9} />
              {c.turned ? (
                <Badge tone="violet">{t('intel.turned')}</Badge>
              ) : (
                <Button size="sm" variant="subtle" onClick={() => void send({ kind: 'turnAgent', agentId: c.id }, t('intel.turnedOk'))}>
                  {t('intel.turn')}
                </Button>
              )}
              <Ago from={c.caughtAt} now={now} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Console de renseignement : HUMINT / SIGINT, trois départements, rapports cotés, opérations. */
export function IntelWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const now = useGameTime(5000);
  const [source, setSource] = useState<IntelSource>('sigint');
  const [dept, setDept] = useState<Department>('military');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const r = win.params.reportId ? intel?.reports.find((x) => x.id === win.params.reportId) : null;
    if (r) {
      setSource(r.source);
      setDept(r.dept);
      setOpenId(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.seq]);
  const count = (s: IntelSource) => intel?.reports.filter((r) => r.source === s).length ?? 0;
  const flash = (s: IntelSource) => !!intel?.reports.some((r) => r.source === s && r.kind === 'flash');
  const totalBudget = intel?.departments.reduce((s, d) => s + d.budgetPerDay, 0) ?? 0;
  return (
    <Window
      {...frame}
      path={[t('sections.path.intel'), source.toUpperCase()]}
      flush
      tabs={
        <div className="intel-tabs">
          <Tabs
            label={t('intel.sources')}
            value={source}
            onChange={setSource}
            tabs={[
              { id: 'humint', label: t('intel.humint'), count: count('humint'), dot: flash('humint'), icon: <Icon name="spy" size={13} /> },
              { id: 'sigint', label: t('intel.sigint'), count: count('sigint'), dot: flash('sigint'), icon: <Icon name="radio" size={13} /> },
            ]}
          />
          {mobile ? (
            <Tabs
              label={t('intel.departments')}
              value={dept}
              onChange={setDept}
              variant="pill"
              fill
              tabs={DEPARTMENTS.map((d) => ({ id: d, label: t(`intel.deptsShort.${d}`) }))}
            />
          ) : null}
        </div>
      }
      headerExtra={
        !mobile ? (
          <span className="win-meta">
            <span>{t('intel.totalBudget')}</span> <Money value={totalBudget} suffix={t('game.topbar.perDay')} />
          </span>
        ) : null
      }
    >
      {!intel ? (
        <EmptyState icon="intel" title={t('intel.unavailable')} text={t('intel.unavailableHint')} />
      ) : (
        <div className="intel">
          <div className="intel__cols">
            {(mobile ? [dept] : DEPARTMENTS).map((d) => (
              <DeptColumn key={d} dept={d} source={source} now={now} openId={openId} setOpenId={setOpenId} />
            ))}
          </div>
          {source === 'humint' ? <Agents /> : null}
        </div>
      )}
    </Window>
  );
}
