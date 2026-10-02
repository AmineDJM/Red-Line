import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AgentCover,
  type Department,
  type IntelOpKind,
  type IntelOpTarget,
  type IntelReport,
  type NationId,
  type Order,
  type ReconOpKind,
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
  Segmented,
  Select,
  Tabs,
  Window,
  formatMoney,
  formatPct,
  type IconName,
} from '@redline/ui';
import { Ago, Cotation, NationTag, isLowCotation } from '../components/Common.js';
import { MiniMap } from '../components/MiniMap.js';
import { NationRecon, reconNationCost } from '../components/NationRecon.js';
import { compareNames, fmtDuration } from '../i18n/index.js';
import { nationForms, nationName, provinceName } from '../lib/game.js';
import {
  COVER_OPS,
  INTEL_TABS,
  TAB_DEPT,
  TAB_OPS,
  TARGET_KIND,
  WHOLE_NATION_OK,
  tabOfReport,
  type IntelTab,
  type OpsTab,
} from '../lib/intelTabs.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { IntelInterior } from './IntelInterior.js';
import { Dossiers, SigintPanel, ThreatList, ThreatMap } from './IntelDossiers.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError, reportTitle } from '../lib/loc.js';
import '../styles/w-intel.css';

const DEPT_ICON: Record<Department, IconName> = {
  interior: 'shield',
  exterior: 'globe',
  military: 'target',
};

const TAB_ICON: Record<IntelTab, IconName> = {
  sigint: 'radio',
  humint: 'spy',
  military: 'target',
  interior: 'shield',
  dossiers: 'intel',
  reports: 'news',
};

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res) toast(orderError(res), 'error');
  };
}

function ReportCard({
  r,
  now,
  open,
  onToggle,
}: {
  r: IntelReport;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const focusOn = useUi((s) => s.focusOn);
  const select = useUi((s) => s.select);
  const inspect = useUi((s) => s.inspect);
  const selectProvince = useUi((s) => s.selectProvince);
  const view = useGame((s) => s.view);
  const send = useSend();
  const allies =
    view?.diplomacy?.alliances
      .find((a) => a.id === view.diplomacy?.myAllianceId)
      ?.members.filter((m) => m !== view.me) ?? [];
  const low = isLowCotation(r.reliability, r.credibility);
  const flash = r.kind === 'flash';
  const doAction = (a: IntelReport['actions'][number]) => {
    switch (a.kind) {
      case 'plan_strike':
      case 'send_recon':
        focusOn(a.at, 6.5);
        if (a.kind === 'send_recon')
          void send(
            { kind: 'intelOp', op: 'listen_area', target: { at: a.at, radiusKm: 80 } },
            t('intel.reconSent'),
          );
        break;
      case 'share':
        if (allies[0])
          void send(
            { kind: 'shareReport', reportId: a.reportId, to: allies[0] },
            t('intel.shared', nationForms(allies[0])),
          );
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
    <article
      className={[
        'report',
        flash ? 'report--flash' : '',
        open ? 'report--open' : '',
        low ? 'report--low' : '',
      ].join(' ')}
    >
      <button type="button" className="report__head" onClick={onToggle} aria-expanded={open}>
        <Cotation r={r.reliability} c={r.credibility} />
        <span className="report__titles">
          <span className="report__meta">
            {flash ? (
              <Badge tone="red" variant="solid">
                {t('intel.flash')}
              </Badge>
            ) : (
              <span className="report__kind">{t(`intel.kinds.${r.kind}`)}</span>
            )}
            {r.sharedBy ? (
              <Badge tone="green" variant="outline">
                {t('intel.sharedBy', nationForms(r.sharedBy))}
              </Badge>
            ) : null}
            <Ago from={r.time} now={now} />
          </span>
          <span className="report__title">{reportTitle(r)}</span>
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
                markers={[
                  {
                    at: r.at,
                    radiusKm: r.radiusKm,
                    color: flash ? '#ff4d5e' : '#ffb020',
                    shape: 'cross',
                    size: 4,
                  },
                ]}
                height={120}
                label={t('intel.minimap')}
              />
            ) : null}
          </div>
          {r.subject?.nationId ? (
            <div className="report__subject">
              <span>{t('intel.subject')}</span> <NationTag id={r.subject.nationId} />
              {r.subject.provinceId ? (
                <span className="muted">· {provinceName(r.subject.provinceId)}</span>
              ) : null}
            </div>
          ) : null}
          {r.actions.length ? (
            <div className="report__actions">
              {r.actions.map((a, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant={a.kind === 'plan_strike' ? 'danger' : 'subtle'}
                  icon={<Icon name={ACTION_ICON[a.kind]} size={12} />}
                  onClick={() => doAction(a)}
                >
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

export function LaunchDialog({
  dept,
  ops,
  onClose,
  initialOp,
  initialNation,
  initialProvince,
  initialAgent,
}: {
  dept: Department;
  ops: IntelOpKind[];
  onClose: () => void;
  initialOp?: IntelOpKind;
  initialNation?: NationId;
  initialProvince?: string;
  initialAgent?: string;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const balance = useWorld((s) => s.balance);
  const nations = useWorld((s) => s.nations);
  const defs = useWorld((s) => s.provinces);
  const catalog = useWorld((s) => s.catalog);
  const send = useSend();
  const [op, setOp] = useState<IntelOpKind>(
    initialOp && ops.includes(initialOp) ? initialOp : (ops[0] ?? 'infiltrate_spy'),
  );
  const kind = TARGET_KIND[op];
  const enemies = useMemo(
    () =>
      Object.values(nations)
        .filter((n) => n.id !== me && view?.nations[n.id]?.alive !== false)
        .sort((a, b) => {
          const ra = view?.nations[a.id]?.relation === 'war' ? 0 : 1;
          const rb = view?.nations[b.id]?.relation === 'war' ? 0 : 1;
          return ra - rb || compareNames(a.name, b.name);
        }),
    [nations, me, view?.nations],
  );
  const [nation, setNation] = useState<NationId>(initialNation ?? enemies[0]?.id ?? '');
  const provincesOf = (n: NationId | null) =>
    Object.values(view?.provinces ?? {})
      .filter((p) => p.owner === n)
      .map((p) => ({ id: p.id, name: provinceName(p.id), capital: !!defs[p.id]?.isCapital }))
      .sort((a, b) => Number(b.capital) - Number(a.capital) || compareNames(a.name, b.name));
  const targetProvinces = provincesOf(kind === 'ownArea' ? me : nation);
  const [province, setProvince] = useState<string>(initialProvince ?? '');
  // Reconnaissance : sur tout le pays (par défaut) ou sur une seule province.
  const recon = WHOLE_NATION_OK.has(op);
  const [scope, setScope] = useState<'nation' | 'province'>(
    initialProvince ? 'province' : 'nation',
  );
  const [cover, setCover] = useState<AgentCover>('diplomatic');
  const agents = (view?.intel?.agents ?? []).filter(
    (a) => a.status === 'active' && a.access !== 'staff',
  );
  const [agentId, setAgentId] = useState<string>(initialAgent ?? '');
  const aid = agents.find((a) => a.id === agentId)?.id ?? agents[0]?.id ?? '';
  const wholeNation = recon && scope === 'nation';
  const pid = wholeNation
    ? ''
    : (targetProvinces.find((p) => p.id === province)?.id ?? targetProvinces[0]?.id ?? '');
  const contacts = useMemo(
    () =>
      Object.values(view?.units ?? {})
        .filter((u) => u.owner !== me && u.level !== 'own')
        .slice(0, 200),
    [view?.units, me],
  );
  const [unitId, setUnitId] = useState<string>('');
  const uid = contacts.find((u) => u.id === unitId)?.id ?? contacts[0]?.id ?? '';
  const cost = wholeNation ? reconNationCost(balance, op as ReconOpKind) : balance?.intel?.ops[op];
  const target: IntelOpTarget = (() => {
    switch (kind) {
      case 'none':
        return {};
      case 'nation':
        return COVER_OPS.has(op) ? { nationId: nation, cover } : { nationId: nation };
      case 'province':
        return wholeNation ? { nationId: nation } : { provinceId: pid };
      case 'area':
      case 'ownArea': {
        const at = pid ? defs[pid]?.cityPoint : undefined;
        return {
          ...(at ? { at } : {}),
          ...(kind === 'area' ? { nationId: nation } : {}),
        };
      }
      case 'unit':
        return { unitId: uid };
      case 'agent': {
        const a = agents.find((x) => x.id === aid);
        return a ? { nationId: a.nationId, agentId: a.id } : {};
      }
    }
  })();
  const ready =
    kind === 'none' ||
    (kind === 'nation' && !!nation) ||
    (kind === 'province' && (wholeNation ? !!nation : !!pid)) ||
    ((kind === 'area' || kind === 'ownArea') && !!target.at) ||
    (kind === 'unit' && !!uid) ||
    (kind === 'agent' && !!aid);
  const pickNation = kind === 'nation' || kind === 'province' || kind === 'area';
  const pickProvince =
    (kind === 'province' && !wholeNation) || kind === 'area' || kind === 'ownArea';
  const dossier = view?.intel?.dossiers?.find((d) => d.nationId === nation);
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
            disabled={!ready}
            onClick={() => {
              void send(
                { kind: 'intelOp', op, target },
                t('intel.opLaunched', {
                  op: t(`intel.ops.${op}`),
                }),
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
          <Select
            value={op}
            onChange={(v) => setOp(v as IntelOpKind)}
            options={ops.map((o) => ({ value: o, label: t(`intel.ops.${o}`) }))}
            data-testid="intel-op-select"
          />
        </Field>
        <p className="hint">{t(`intel.opsHelp.${op}`)}</p>
        {pickNation ? (
          <Field label={t('intel.target')}>
            <Select
              value={nation}
              onChange={(v) => {
                setNation(v);
                setProvince('');
              }}
              options={enemies.map((n) => ({
                value: n.id,
                label: `${view?.nations[n.id]?.relation === 'war' ? '⚔ ' : ''}${n.name}`,
              }))}
              data-testid="intel-target-nation"
            />
          </Field>
        ) : null}
        {COVER_OPS.has(op) ? (
          <Field label={t('intel.cover')}>
            <Segmented
              label={t('intel.cover')}
              size="sm"
              value={cover}
              onChange={setCover}
              options={[
                { value: 'diplomatic', label: t('intel.covers.diplomatic') },
                { value: 'nonofficial', label: t('intel.covers.nonofficial') },
              ]}
            />
          </Field>
        ) : null}
        {kind === 'agent' ? (
          <Field label={t('intel.targetAgent')}>
            {agents.length ? (
              <Select
                value={aid}
                onChange={setAgentId}
                options={agents.map((a) => ({
                  value: a.id,
                  label: `${a.codename} · ${nationName(a.nationId)} · ${t(`intel.accessLevels.${a.access ?? 'street'}`)} · ${a.reliability ?? '—'}`,
                }))}
              />
            ) : (
              <p className="hint">{t('intel.noAgents')}</p>
            )}
          </Field>
        ) : null}
        {recon ? (
          <Field label={t('intel.scope')}>
            <Segmented
              label={t('intel.scope')}
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'nation', label: t('intel.scopeNation') },
                { value: 'province', label: t('intel.scopeProvince') },
              ]}
              className="intel-scope"
            />
          </Field>
        ) : null}
        {wholeNation && nation ? (
          <NationRecon nationId={nation} ops={[op as ReconOpKind]} bare readOnly />
        ) : null}
        {pickProvince ? (
          <Field label={kind === 'province' ? t('intel.targetProvince') : t('intel.targetArea')}>
            <Select
              value={pid}
              onChange={setProvince}
              options={targetProvinces.map((p) => ({
                value: p.id,
                label: `${p.capital ? '★ ' : ''}${p.name}`,
              }))}
              data-testid="intel-target-province"
            />
          </Field>
        ) : null}
        {kind === 'unit' ? (
          <Field label={t('intel.targetUnit')}>
            {contacts.length ? (
              <Select
                value={uid}
                onChange={setUnitId}
                options={contacts.map((u) => ({
                  value: u.id,
                  label: `${nationName(u.owner)} · ${
                    u.systemId
                      ? (catalog[u.systemId]?.name ?? u.systemId)
                      : t('intel.unknownContact')
                  }`,
                }))}
              />
            ) : (
              <p className="hint">{t('intel.noContacts')}</p>
            )}
          </Field>
        ) : null}
        {pickNation && dossier && (op === 'intercept_comms' || op === 'cryptanalysis') ? (
          <ProgressBar
            value={dossier.crypto}
            size="xs"
            tone="cyan"
            label={t('intel.crypto.title')}
            trailing={`${t('intel.crypto.title')} ${formatPct(dossier.crypto)} · ${t('intel.crypto.encryption')} ${formatPct(dossier.encryption)}`}
          />
        ) : null}
        <OpCost op={op} cost={cost} />
      </div>
    </Dialog>
  );
}

/** Coût, durée, réussite de base et risque d'une opération. */
function OpCost({
  cost,
}: {
  op: IntelOpKind;
  cost?: { money: number; durationH: number; baseSuccess: number; exposure: number };
}) {
  const { t } = useTranslation();
  return (
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
  );
}

/** Budget et capacité d'un département. */
function DeptBar({ dept }: { dept: Department }) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const send = useSend();
  const d = intel?.departments.find((x) => x.id === dept);
  if (!d) return null;
  // Pas de réglage : 10 % du budget courant (au moins 50 k$).
  const step = Math.max(50_000, Math.round(d.budgetPerDay * 0.1));
  return (
    <header className={`dept__head dept--${dept}`}>
      <span className="dept__icon">
        <Icon name={DEPT_ICON[dept]} size={15} />
      </span>
      <span className="dept__titles">
        <h3>{t(`intel.depts.${dept}`)}</h3>
        <span>{t(`intel.deptsShort.${dept}`)}</span>
      </span>
      <Badge tone="cyan" variant="outline">
        {t('intel.level', { level: d.level })}
      </Badge>
      <span className="dept__budget-ctl">
        <button
          type="button"
          onClick={() =>
            void send(
              { kind: 'intelBudget', dept, budgetPerDay: Math.max(0, d.budgetPerDay - step) },
              t('intel.budgetSet'),
            )
          }
          aria-label={t('intel.budgetDown')}
        >
          <Icon name="minus" size={11} />
        </button>
        <Money value={d.budgetPerDay} suffix={t('game.topbar.perDay')} />
        <button
          type="button"
          onClick={() =>
            void send(
              { kind: 'intelBudget', dept, budgetPerDay: d.budgetPerDay + step },
              t('intel.budgetSet'),
            )
          }
          aria-label={t('intel.budgetUp')}
        >
          <Icon name="plus" size={11} />
        </button>
      </span>
      <Gauge
        value={d.running / Math.max(1, d.capacity)}
        cells={d.capacity}
        tone={d.running >= d.capacity ? 'amber' : 'cyan'}
        valueText={`${d.running}/${d.capacity}`}
      />
    </header>
  );
}

/** Actions en deux clics : une carte par opération (coût, durée, chance, risque) → dialogue prérempli. */
function OpCards({ tab, onLaunch }: { tab: OpsTab; onLaunch: (op: IntelOpKind) => void }) {
  const { t } = useTranslation();
  const balance = useWorld((s) => s.balance);
  return (
    <div className="opcards" role="list" aria-label={t('intel.quick')}>
      {TAB_OPS[tab].map((op) => {
        const c = balance?.intel?.ops[op];
        return (
          <button
            key={op}
            type="button"
            role="listitem"
            className="opcard"
            onClick={() => onLaunch(op)}
            title={t(`intel.opsHelp.${op}`)}
            data-testid={`intel-op-${op}`}
          >
            <span className="opcard__name">{t(`intel.ops.${op}`)}</span>
            {c ? (
              <span className="opcard__meta">
                <span className="rl-money">{formatMoney(c.money)}</span>
                <span>{c.durationH} h</span>
                <span className="rl-tone-green">{formatPct(c.baseSuccess)}</span>
                <span className="rl-tone-red">{formatPct(c.exposure)}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Opérations en cours et terminées d'une liste. */
function OpsList({ kinds, now }: { kinds: IntelOpKind[]; now: number }) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const send = useSend();
  const ops = (intel?.operations ?? []).filter((o) => kinds.includes(o.kind));
  if (!ops.length) return null;
  return (
    <div className="dept__ops">
      <span className="dept__label">
        {t('intel.operations')} <b>{ops.length}</b>
      </span>
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
                <Badge
                  tone={
                    o.status === 'success' ? 'green' : o.status === 'compromised' ? 'red' : 'amber'
                  }
                >
                  {t(`intel.opStatus.${o.status}`)}
                </Badge>
              )}
              {o.status === 'running' ? (
                <button
                  type="button"
                  className="op__cancel"
                  onClick={() =>
                    void send({ kind: 'cancelIntelOp', opId: o.id }, t('intel.opCancelled'))
                  }
                  aria-label={t('app.cancel')}
                >
                  <Icon name="close" size={11} />
                </button>
              ) : null}
            </div>
            <div className="op__target">
              {o.target.nationId ? <NationTag id={o.target.nationId} size={9} /> : null}
              {o.target.provinceId ? <span>{provinceName(o.target.provinceId)}</span> : null}
              {o.recon ? (
                <span className="op__phase">
                  {t('intel.reconPhase', {
                    done: o.recon.done,
                    waves: o.recon.waves,
                    provinces: o.recon.provinces,
                  })}
                </span>
              ) : null}
              {o.target.at && !o.target.provinceId ? (
                <span>{t('intel.zone', { km: o.target.radiusKm ?? 0 })}</span>
              ) : null}
            </div>
            {o.status === 'running' ? (
              <ProgressBar
                value={f}
                size="xs"
                trailing={fmtDuration(Math.max(0, o.completesAt - now))}
                label={t('intel.progress')}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Liste de rapports cotés (dépliables). */
function ReportList({
  reports,
  now,
  openId,
  setOpenId,
}: {
  reports: IntelReport[];
  now: number;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!reports.length) return <EmptyState compact icon="intel" title={t('intel.noReports')} />;
  return (
    <div className="dept__reports">
      {reports.map((r) => (
        <ReportCard
          key={r.id}
          r={r}
          now={now}
          open={openId === r.id}
          onToggle={() => setOpenId(openId === r.id ? null : r.id)}
        />
      ))}
    </div>
  );
}

/** Réseau d'agents : couverture, accès, fiabilité, statut ; actions directes. */
function Agents({
  onLaunch,
}: {
  onLaunch: (op: IntelOpKind, n: NationId, agent?: string) => void;
}) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const send = useSend();
  const now = useGameTime(5000);
  if (!intel) return null;
  return (
    <div className="agents">
      <div className="agents__col">
        <span className="dept__label">{t('intel.agents')}</span>
        {intel.agents.length ? null : <p className="hint">{t('intel.noAgents')}</p>}
        <ul>
          {intel.agents.map((a) => (
            <li key={a.id} className={`agent agent--${a.status}`} data-testid={`agent-${a.id}`}>
              <span className="agent__code">{a.codename}</span>
              <NationTag id={a.nationId} size={9} />
              <span className="agent__info">
                {a.cover ? t(`intel.covers.${a.cover}`) : '—'} ·{' '}
                {t(`intel.accessLevels.${a.access ?? 'street'}`)} ·{' '}
                <b title={t('intel.dossier.reliability')}>{a.reliability ?? '—'}</b>
              </span>
              <Badge
                tone={
                  a.status === 'active'
                    ? 'green'
                    : a.status === 'double'
                      ? 'violet'
                      : a.status === 'burned' || a.status === 'captured'
                        ? 'red'
                        : 'neutral'
                }
              >
                {t(`intel.agentStatus.${a.status}`)}
              </Badge>
              <span className="agent__acts">
                {a.status === 'active' && a.access !== 'staff' ? (
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => onLaunch('cultivate_source', a.nationId, a.id)}
                  >
                    {t('intel.agentActions.cultivate')}
                  </Button>
                ) : null}
                {a.status === 'active' || a.status === 'burned' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onLaunch('vet_agents', a.nationId)}
                  >
                    {t('intel.agentActions.vet')}
                  </Button>
                ) : null}
                {a.status === 'active' || a.status === 'burned' || a.status === 'double' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onLaunch('exfiltrate', a.nationId)}
                  >
                    {t('intel.ops.exfiltrate')}
                  </Button>
                ) : null}
              </span>
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
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() =>
                    void send({ kind: 'turnAgent', agentId: c.id }, t('intel.turnedOk'))
                  }
                >
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

interface LaunchState {
  dept: Department;
  ops: IntelOpKind[];
  op?: IntelOpKind;
  nation?: NationId;
  agent?: string;
}

/**
 * Console de renseignement : SIGINT (écoutes, décryptage, émetteurs), HUMINT (réseaux d'agents),
 * militaire (reconnaissance, ciblage, menaces), intérieur (contre-espionnage), dossiers pays et
 * rapports cotés. Chaque onglet : département, actions en deux clics, opérations, rapports.
 */
export function IntelWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const now = useGameTime(5000);
  const [tab, setTab] = useState<IntelTab>('military');
  const [filter, setFilter] = useState<'all' | OpsTab>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  useEffect(() => {
    const r = win.params.reportId ? intel?.reports.find((x) => x.id === win.params.reportId) : null;
    if (r) {
      setTab('reports');
      setFilter('all');
      setOpenId(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.seq]);
  const reports = intel?.reports ?? [];
  const byTab = (x: OpsTab) => reports.filter((r) => tabOfReport(r) === x);
  const flashIn = (x: OpsTab) => byTab(x).some((r) => r.kind === 'flash');
  const dossiers = intel?.dossiers ?? [];
  const totalBudget = intel?.departments.reduce((s, d) => s + d.budgetPerDay, 0) ?? 0;
  const open = (x: OpsTab, op?: IntelOpKind, nation?: NationId, agent?: string) =>
    setLaunch({ dept: TAB_DEPT[x], ops: TAB_OPS[x], op, nation, agent });
  const label = (x: IntelTab) =>
    x === 'sigint'
      ? t('intel.sigint')
      : x === 'humint'
        ? t('intel.humint')
        : x === 'interior'
          ? t('intel.interiorTab')
          : t(`intel.tabs.${x}`);
  const opsTab = (x: OpsTab) => (
    <div className={`intel__tab intel__tab--${x}`}>
      <DeptBar dept={TAB_DEPT[x]} />
      <div className="intel__body">
        <div className="intel__main">
          {x === 'sigint' ? <SigintPanel /> : null}
          {x === 'military' ? (
            <div className="intel__threats">
              <span className="dept__label">{t('intel.threat.title')}</span>
              <ThreatMap dossiers={dossiers} />
              <ThreatList
                dossiers={dossiers}
                onOpen={() => {
                  setTab('dossiers');
                }}
              />
            </div>
          ) : null}
          {x === 'humint' ? <Agents onLaunch={(op, n, a) => open('humint', op, n, a)} /> : null}
          {x === 'interior' ? (
            <IntelInterior
              onOpenReport={(id) => {
                setTab('reports');
                setOpenId(id);
              }}
            />
          ) : null}
          <ReportList
            reports={byTab(x).slice(0, 8)}
            now={now}
            openId={openId}
            setOpenId={setOpenId}
          />
        </div>
        <aside className="intel__side">
          <div className="dept__ops-head">
            <span className="dept__label">{t('intel.quick')}</span>
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="plus" size={12} />}
              onClick={() => open(x)}
              data-testid={`intel-launch-${x}`}
            >
              {t('intel.launchShort')}
            </Button>
          </div>
          <OpCards tab={x} onLaunch={(op) => open(x, op)} />
          <OpsList kinds={TAB_OPS[x]} now={now} />
        </aside>
      </div>
    </div>
  );
  return (
    <Window
      {...frame}
      path={[t('sections.path.intel'), label(tab).toUpperCase()]}
      flush
      tabs={
        <div className="intel-tabs">
          <Tabs
            label={t('intel.sources')}
            value={tab}
            onChange={setTab}
            variant={mobile ? 'pill' : 'line'}
            tabs={INTEL_TABS.map((x) => ({
              id: x,
              label: label(x),
              icon: <Icon name={TAB_ICON[x]} size={13} />,
              ...(x === 'dossiers'
                ? { count: dossiers.length, dot: dossiers.some((d) => d.alert) }
                : x === 'reports'
                  ? { count: reports.length }
                  : x === 'interior'
                    ? {
                        count: intel?.interior?.threats.filter((y) => y.grade !== 'low').length,
                        dot: flashIn('interior'),
                      }
                    : { count: byTab(x).length, dot: flashIn(x) }),
            }))}
          />
        </div>
      }
      headerExtra={
        !mobile ? (
          <span className="win-meta">
            {intel?.hardenedUntil ? (
              <Badge tone="green" variant="outline">
                {t('intel.hardened')}
              </Badge>
            ) : null}
            <span>{t('intel.totalBudget')}</span>{' '}
            <Money value={totalBudget} suffix={t('game.topbar.perDay')} />
          </span>
        ) : null
      }
    >
      {!intel ? (
        <EmptyState icon="intel" title={t('intel.unavailable')} text={t('intel.unavailableHint')} />
      ) : tab === 'dossiers' ? (
        <Dossiers mobile={mobile} />
      ) : tab === 'reports' ? (
        <div className="intel__reports">
          <Segmented
            label={t('intel.sources')}
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('intel.allReports') },
              ...(['sigint', 'humint', 'military', 'interior'] as const).map((x) => ({
                value: x,
                label: label(x),
              })),
            ]}
          />
          <ReportList
            reports={filter === 'all' ? reports : byTab(filter)}
            now={now}
            openId={openId}
            setOpenId={setOpenId}
          />
        </div>
      ) : (
        opsTab(tab)
      )}
      {launch ? (
        <LaunchDialog
          dept={launch.dept}
          ops={launch.ops}
          initialOp={launch.op}
          initialNation={launch.nation}
          initialAgent={launch.agent}
          onClose={() => setLaunch(null)}
        />
      ) : null}
    </Window>
  );
}
