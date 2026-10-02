/** Économie du service : coûts mesurés et attribués, recettes, marge, alertes, paramètres, dépenses. */
import { useEffect, useMemo, useState } from 'react';
import {
  COST_CATEGORIES,
  COST_PERIODS,
  CostSettingsSchema,
  DEFAULT_COST_SETTINGS,
  USER_KINDS,
  type CostCategory,
  type CostDashboard,
  type CostPeriod,
  type CostSettings,
  type GameCost,
  type UserCost,
} from '@redline/shared';
import { useSession } from '../context';
import { DataTable } from '../components/DataTable';
import { LineChart } from '../components/Charts';
import { GroupedBars, ShareBars } from '../components/EconomyCharts';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  Note,
  PageHead,
  Seg,
  Spinner,
  Stat,
  Tabs,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { O } from '../i18n/fr-ops';
import { downloadCsv } from '../lib/csv';
import { errorMessage } from '../lib/errors';
import { bytes, date, num, pct } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { money } from '../lib/money';
import { href, type EconomyTab } from '../lib/router';
import './ops.css';

const E = O.economy;

const PERIOD_KEY = 'rl.admin.costPeriod';
function savedPeriod(): CostPeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY) as CostPeriod | null;
    return v && COST_PERIODS.includes(v) ? v : 'month';
  } catch {
    return 'month';
  }
}

export function EconomyScreen({ tab }: { tab: EconomyTab }) {
  return (
    <>
      <PageHead title={E.title} sub={E.sub} />
      <Tabs
        value={tab}
        tabs={(['dashboard', 'settings', 'entries'] as const).map((k) => ({
          key: k,
          label: E.tabs[k],
          href: href({ name: 'economy', tab: k }),
        }))}
      />
      <div style={{ marginTop: 12 }}>
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'settings' && <SettingsForm />}
        {tab === 'entries' && <Entries />}
      </div>
    </>
  );
}

// ───────────────────────────── Tableau de bord ─────────────────────────────

function Dashboard() {
  const { api } = useSession();
  const toast = useToast();
  const [period, setPeriod] = useState<CostPeriod>(savedPeriod);
  useEffect(() => {
    try {
      localStorage.setItem(PERIOD_KEY, period);
    } catch {
      /* stockage indisponible */
    }
  }, [period]);
  const { data, error, loading, reload } = useLoad<CostDashboard>(
    () => api.costDashboard(period),
    [api, period],
    T.roles.superadmin,
  );

  const exportAll = async (what: 'users' | 'games') => {
    try {
      const { report } = await api.costReportFull(period);
      if (what === 'users')
        downloadCsv(`redline-couts-comptes-${period}.csv`, report.users ?? [], USER_CSV);
      else downloadCsv(`redline-couts-parties-${period}.csv`, report.games ?? [], GAME_CSV);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };

  const toolbar = (
    <div className="row-wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <Seg
        label={E.period}
        value={period}
        onChange={setPeriod}
        options={COST_PERIODS.map((p) => [p, O.periods[p]] as const)}
      />
      <Button small onClick={() => void reload()}>
        <Icon name="refresh" size={12} /> {E.refresh}
      </Button>
    </div>
  );
  if (error)
    return (
      <>
        {toolbar}
        <ErrorBox message={error} onRetry={() => void reload()} />
      </>
    );
  if (loading && !data)
    return (
      <>
        {toolbar}
        <Spinner />
      </>
    );
  if (!data) return null;
  const r = data.report;
  const c = r.cohorts;
  const day = period !== '24h';
  const labels = data.series.map((p) =>
    day
      ? new Date(p.t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : `${new Date(p.t).getHours()} h`,
  );
  const times = data.series.map((p) => Date.parse(p.t));
  const timeLabel = (t: number) =>
    day
      ? new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const marginTone = r.marginUsd >= 0 ? 'var(--t-green)' : 'var(--t-red)';

  return (
    <>
      {toolbar}
      <div className="stats">
        <Stat
          k={E.costTotal}
          v={money(r.cost.total)}
          d={`${E.projected} : ${money(r.projectedMonthUsd)}`}
        />
        <Stat
          k={E.revenue}
          v={money(r.revenue.netUsd)}
          tone="var(--t-amber)"
          d={`${E.revenueHint} · ${r.revenue.payments} paiement(s)`}
        />
        <Stat
          k={E.margin}
          v={money(r.marginUsd)}
          tone={marginTone}
          d={r.marginPct === null ? '—' : pct(r.marginPct)}
        />
        <Stat
          k={E.perFree}
          v={money(c.free.costPerUser)}
          d={fmt(E.perFreeHint, {
            m: money(c.free.monthlyPerUser),
            g: money(c.free.marginalPerUser),
          })}
        />
        <Stat
          k={E.perPaying}
          v={money(c.paying.costPerUser)}
          d={`${c.paying.users} · ${money(c.paying.monthlyPerUser)} / mois`}
        />
        <Stat
          k={E.perGuest}
          v={money(c.guest.costPerUser)}
          d={`${c.guest.users} · ${money(c.guest.monthlyPerUser)} / mois`}
        />
        <Stat
          k={E.perHour}
          v={money(r.costPerPlayHour)}
          d={fmt(E.playHours, { h: num(r.playHours, 1) })}
        />
        <Stat k={E.arpu} v={money(r.arpuUsd)} d={`${E.arppu} ${money(r.arppuUsd)}`} />
        <Stat
          k={E.conversion}
          v={pct(r.conversion, 1)}
          d={`${E.active} : ${r.activeUsers} · ${fmt(E.payingUsers, { n: r.payingUsers })}`}
        />
        <Stat
          k={E.utilization}
          v={pct(r.utilization.cpu)}
          d={fmt(E.utilizationHint, {
            cpu: pct(r.utilization.cpu),
            mem: pct(r.utilization.memory),
            plan: r.plan.label,
          })}
        />
      </div>

      <div className="eco-grid">
        <Win title={E.alerts} glyph="!">
          {data.alerts.length === 0 ? (
            <Note tone="ok">{E.noAlert}</Note>
          ) : (
            data.alerts.map((a) => (
              <div key={a.code} className={`eco-alert ${a.level}`} role="alert">
                <span className="tag">{a.level === 'crit' ? 'CRIT' : 'ALERTE'}</span>
                <span>{a.message}</span>
              </div>
            ))
          )}
          <h3 className="section-title" style={{ marginTop: 12 }}>
            {E.recommendations}
          </h3>
          {data.recommendations.length === 0 ? (
            <p className="dim small">{E.noReco}</p>
          ) : (
            data.recommendations.map((a) => (
              <div key={a.code} className="eco-alert reco">
                <span className="tag">CONSEIL</span>
                <span>{a.message}</span>
              </div>
            ))
          )}
        </Win>
        <Win title={E.breakdownTitle} glyph="$">
          <ShareBars
            format={money}
            rows={(Object.keys(O.breakdown) as (keyof typeof O.breakdown)[]).map((k) => ({
              label: O.breakdown[k],
              value: r.cost[k],
            }))}
          />
          <p className="eco-method">
            {fmt(E.egress, { gb: num(r.egressGb, 2) })} ·{' '}
            {fmt(E.db, { gb: num(r.load.dbBytes / 1e9, 2) })}
            <br />
            {fmt(E.unattributed, { v: money(r.unattributedUsd) })}
          </p>
        </Win>
      </div>

      <div className="eco-grid eco-grid-wide">
        <Win title={E.cohortsTitle} glyph="☺" flush>
          <DataTable
            rows={USER_KINDS.map((k) => ({ k, ...c[k] }))}
            rowKey={(x) => x.k}
            bare
            columns={[
              {
                key: 'k',
                label: E.kind,
                render: (x) => <b className="bright">{O.kindsPlural[x.k]}</b>,
              },
              { key: 'n', label: E.active, align: 'right', render: (x) => num(x.users) },
              { key: 'c', label: E.total, align: 'right', render: (x) => money(x.costUsd) },
              {
                key: 'u',
                label: 'Par compte',
                align: 'right',
                render: (x) => money(x.costPerUser),
              },
              {
                key: 'm',
                label: 'Par mois',
                align: 'right',
                hideM: true,
                render: (x) => money(x.monthlyPerUser),
              },
              {
                key: 'r',
                label: E.net,
                align: 'right',
                hideM: true,
                render: (x) => money(x.revenueNetUsd),
              },
            ]}
          />
        </Win>
        <Win title={E.modesTitle} glyph="▶">
          <ShareBars
            format={money}
            rows={(['solo', 'multi'] as const).map((m) => ({
              label: T.games.modes[m],
              value: r.modes[m].costUsd,
              hint: fmt(E.perGame, { c: money(r.modes[m].costPerGame), n: r.modes[m].games }),
            }))}
          />
          <p className="eco-method">
            {(['solo', 'multi'] as const).map((m) => (
              <span key={m} style={{ display: 'block' }}>
                {T.games.modes[m]} :{' '}
                {fmt(E.perGame, { c: money(r.modes[m].costPerGame), n: r.modes[m].games })}
              </span>
            ))}
          </p>
        </Win>
      </div>

      {data.series.length > 0 ? (
        <>
          <div className="chart-card" style={{ marginBottom: 10 }}>
            <div className="head">
              <span className="k">{E.costRevenue}</span>
              <span className="v">{money(r.cost.total)}</span>
            </div>
            <GroupedBars
              title={E.costRevenue}
              labels={labels}
              format={money}
              series={[
                { label: E.cost, values: data.series.map((p) => p.costUsd) },
                {
                  label: E.revenueShort,
                  values: data.series.map((p) => Math.max(0, p.revenueNetUsd)),
                },
              ]}
            />
          </div>
          <div className="charts" style={{ marginBottom: 12 }}>
            <ChartCard title={E.cpu} value={`${num(r.load.cpuAvgPct, 1)} %`}>
              <LineChart
                title={E.cpu}
                times={times}
                timeLabel={timeLabel}
                series={[{ label: E.cpu, values: data.series.map((p) => p.cpuPct) }]}
                format={(v) => `${num(v, 0)} %`}
              />
            </ChartCard>
            <ChartCard title={E.rss} value={`${num(r.load.rssMaxMb, 0)} Mo`}>
              <LineChart
                title={E.rss}
                times={times}
                timeLabel={timeLabel}
                series={[{ label: E.rss, values: data.series.map((p) => p.rssMb) }]}
                format={(v) => `${num(v, 0)}`}
              />
            </ChartCard>
            <ChartCard title={E.players} value={num(r.load.peakPlayers)}>
              <LineChart
                title={E.players}
                times={times}
                timeLabel={timeLabel}
                series={[{ label: E.players, values: data.series.map((p) => p.peakPlayers) }]}
                format={(v) => num(v, 0)}
              />
            </ChartCard>
          </div>
        </>
      ) : (
        <Empty glyph="∅">{E.empty}</Empty>
      )}

      <Win
        title={E.topUsers}
        glyph="☺"
        flush
        actions={
          <>
            <Button
              small
              onClick={() =>
                downloadCsv(`redline-couts-top-comptes-${period}.csv`, r.topUsers, USER_CSV)
              }
            >
              <Icon name="download" size={12} /> {E.exportCsv}
            </Button>
            <Button small onClick={() => void exportAll('users')}>
              <Icon name="download" size={12} /> {E.exportAll}
            </Button>
          </>
        }
      >
        <UserCostTable rows={r.topUsers} />
      </Win>
      <div style={{ height: 12 }} />
      <Win
        title={E.topGames}
        glyph="▶"
        flush
        actions={
          <>
            <Button
              small
              onClick={() =>
                downloadCsv(`redline-couts-top-parties-${period}.csv`, r.topGames, GAME_CSV)
              }
            >
              <Icon name="download" size={12} /> {E.exportCsv}
            </Button>
            <Button small onClick={() => void exportAll('games')}>
              <Icon name="download" size={12} /> {E.exportAll}
            </Button>
          </>
        }
      >
        <GameCostTable rows={r.topGames} />
      </Win>
      <p className="eco-method">
        {fmt(E.unit, {
          cpu: money(r.unit.cpuHourUsd),
          mem: money(r.unit.gbHourUsd),
          gb: money(r.unit.egressGbUsd),
        })}
        <br />
        {E.method}
      </p>
    </>
  );
}

function ChartCard(p: { title: string; value: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <div className="head">
        <span className="k">{p.title}</span>
        <span className="v">{p.value}</span>
      </div>
      {p.children}
    </div>
  );
}

const USER_CSV: [string, (u: UserCost) => string | number][] = [
  ['id', (u) => u.id],
  ['nom', (u) => u.name],
  ['type', (u) => O.kinds[u.kind]],
  ['parties', (u) => u.games],
  ['heures_de_jeu', (u) => u.playHours],
  ['cpu_s', (u) => u.cpuS],
  ['memoire_mo_h', (u) => u.memMbH],
  ['octets', (u) => u.bytes],
  ['cout_calcul_usd', (u) => u.cost.compute],
  ['cout_base_usd', (u) => u.cost.database],
  ['cout_bande_passante_usd', (u) => u.cost.bandwidth],
  ['frais_stripe_usd', (u) => u.cost.stripe],
  ['cout_push_usd', (u) => u.cost.push],
  ['autres_usd', (u) => u.cost.other],
  ['cout_total_usd', (u) => u.cost.total],
  ['cout_marginal_usd', (u) => u.marginalUsd],
  ['recettes_nettes_usd', (u) => u.revenueNetUsd],
  ['marge_usd', (u) => u.marginUsd],
];

const GAME_CSV: [string, (g: GameCost) => string | number][] = [
  ['id', (g) => g.id],
  ['nom', (g) => g.name],
  ['mode', (g) => g.mode],
  ['statut', (g) => g.status],
  ['joueurs', (g) => g.humans],
  ['heures_de_jeu', (g) => g.playHours],
  ['cpu_s', (g) => g.cpuS],
  ['memoire_mo_h', (g) => g.memMbH],
  ['stockage_octets', (g) => g.storageBytes],
  ['cout_calcul_usd', (g) => g.cost.compute],
  ['cout_base_usd', (g) => g.cost.database],
  ['cout_total_usd', (g) => g.cost.total],
  ['cout_marginal_usd', (g) => g.marginalUsd],
];

const KIND_TONE = { free: 'info', paying: 'ok', guest: 'off', staff: 'violet' } as const;

function UserCostTable({ rows }: { rows: UserCost[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(u) => u.id}
      bare
      maxHeight={360}
      empty={E.empty}
      columns={[
        {
          key: 'n',
          label: E.user,
          sort: (u) => u.name,
          render: (u) => (
            <a href={href({ name: 'users', id: u.id })} className="bright">
              {u.name}
            </a>
          ),
        },
        {
          key: 'k',
          label: E.kind,
          render: (u) => <Badge tone={KIND_TONE[u.kind]}>{O.kinds[u.kind]}</Badge>,
        },
        {
          key: 'g',
          label: E.games,
          align: 'right',
          hideM: true,
          sort: (u) => u.games,
          render: (u) => num(u.games),
        },
        {
          key: 'h',
          label: E.hours,
          align: 'right',
          hideM: true,
          sort: (u) => u.playHours,
          render: (u) => num(u.playHours, 1),
        },
        {
          key: 'c',
          label: E.cpuS,
          align: 'right',
          hideM: true,
          sort: (u) => u.cpuS,
          render: (u) => `${num(u.cpuS, 1)} s`,
        },
        {
          key: 'b',
          label: E.bytes,
          align: 'right',
          hideM: true,
          sort: (u) => u.bytes,
          render: (u) => bytes(u.bytes),
        },
        {
          key: 't',
          label: E.total,
          align: 'right',
          sort: (u) => u.cost.total,
          render: (u) => <b>{money(u.cost.total)}</b>,
        },
        {
          key: 'm',
          label: E.marginal,
          align: 'right',
          hideM: true,
          sort: (u) => u.marginalUsd,
          render: (u) => <span className="dim">{money(u.marginalUsd)}</span>,
        },
        {
          key: 'r',
          label: E.net,
          align: 'right',
          sort: (u) => u.revenueNetUsd,
          render: (u) =>
            u.revenueNetUsd ? (
              <span className="c-amber">{money(u.revenueNetUsd)}</span>
            ) : (
              <span className="dim">—</span>
            ),
        },
      ]}
    />
  );
}

function GameCostTable({ rows }: { rows: GameCost[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(g) => g.id}
      bare
      maxHeight={360}
      empty={E.empty}
      columns={[
        {
          key: 'n',
          label: E.game,
          className: 'two',
          sort: (g) => g.name,
          render: (g) => (
            <>
              <a href={href({ name: 'games', id: g.id })} className="bright">
                {g.name}
              </a>
              <span className="sub">
                {g.id.slice(0, 8)} ·{' '}
                {T.games.statuses[g.status as keyof typeof T.games.statuses] ?? g.status}
              </span>
            </>
          ),
        },
        { key: 'm', label: E.mode, render: (g) => T.games.modes[g.mode] },
        {
          key: 'p',
          label: E.humans,
          align: 'right',
          sort: (g) => g.humans,
          render: (g) => num(g.humans),
        },
        {
          key: 'c',
          label: E.cpuS,
          align: 'right',
          hideM: true,
          sort: (g) => g.cpuS,
          render: (g) => `${num(g.cpuS, 1)} s`,
        },
        {
          key: 'r',
          label: E.memory,
          align: 'right',
          hideM: true,
          sort: (g) => g.memMbH,
          render: (g) => `${num(g.memMbH, 0)} Mo·h`,
        },
        {
          key: 's',
          label: E.storage,
          align: 'right',
          hideM: true,
          sort: (g) => g.storageBytes,
          render: (g) => bytes(g.storageBytes),
        },
        {
          key: 't',
          label: E.total,
          align: 'right',
          sort: (g) => g.cost.total,
          render: (g) => <b>{money(g.cost.total)}</b>,
        },
        {
          key: 'x',
          label: E.marginal,
          align: 'right',
          hideM: true,
          sort: (g) => g.marginalUsd,
          render: (g) => <span className="dim">{money(g.marginalUsd)}</span>,
        },
      ]}
    />
  );
}

// ───────────────────────────── Paramètres de coût ─────────────────────────────

const S = O.settings;

function NumField(p: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(p.value));
  useEffect(() => setText(String(p.value)), [p.value]);
  return (
    <div className="field">
      <label htmlFor={p.id}>{p.label}</label>
      <input
        id={p.id}
        className="input"
        inputMode="decimal"
        value={text}
        disabled={p.disabled}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value.replace(',', '.'));
          if (e.target.value.trim() !== '' && Number.isFinite(v)) p.onChange(v);
        }}
      />
      {p.hint && <small className="field-hint">{p.hint}</small>}
    </div>
  );
}

function SettingsForm() {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () => api.costSettings().then((r) => r.settings),
    [api],
    T.roles.superadmin,
  );
  const [s, setS] = useState<CostSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setS(structuredClone(data));
  }, [data]);
  const issues = useMemo(() => {
    if (!s) return [];
    const r = CostSettingsSchema.safeParse(s);
    const out = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`);
    if (!s.compute.plans.some((p) => p.id === s.compute.plan))
      out.push(`offre inconnue : ${s.compute.plan}`);
    return out;
  }, [s]);
  if (error) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading || !s) return <Spinner />;
  const set = <K extends keyof CostSettings>(k: K, v: Partial<CostSettings[K]>) =>
    setS({ ...s, [k]: { ...(s[k] as object), ...v } } as CostSettings);
  const dirty = JSON.stringify(s) !== JSON.stringify(data);

  const save = async () => {
    if (!(await confirm({ title: S.title, message: S.confirm, confirm: T.app.save }))) return;
    setBusy(true);
    try {
      const r = await api.saveCostSettings(s);
      setS(structuredClone(r.settings));
      toast(S.saved);
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  const plans = s.compute.plans;
  const setPlan = (i: number, patch: Partial<(typeof plans)[number]>) =>
    set('compute', { plans: plans.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  return (
    <div className="stack">
      <p className="dim small">{S.sub}</p>
      <Win title={S.plans} glyph="▤">
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="cs-plan">{S.plan}</label>
            <select
              id="cs-plan"
              className="input"
              value={s.compute.plan}
              onChange={(e) => set('compute', { plan: e.target.value })}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.usdPerMonth} $/mois
                </option>
              ))}
            </select>
          </div>
          <NumField
            id="cs-inst"
            label={S.instances}
            value={s.compute.instances}
            onChange={(v) => set('compute', { instances: Math.round(v) })}
          />
          <NumField
            id="cs-w"
            label={S.cpuWeight}
            hint={S.cpuWeightHint}
            value={s.compute.cpuWeight}
            onChange={(v) => set('compute', { cpuWeight: v })}
          />
          <NumField
            id="cs-ws"
            label={S.workspace}
            hint={S.workspaceHint}
            value={s.compute.workspaceUsdPerMonth}
            onChange={(v) => set('compute', { workspaceUsdPerMonth: v })}
          />
        </div>
        <DataTable
          rows={plans.map((p, i) => ({ ...p, i }))}
          rowKey={(p) => String(p.i)}
          columns={[
            {
              key: 'id',
              label: 'id',
              render: (p) => (
                <input
                  className="input"
                  aria-label="id"
                  value={p.id}
                  onChange={(e) => setPlan(p.i, { id: e.target.value })}
                />
              ),
            },
            {
              key: 'l',
              label: S.label,
              render: (p) => (
                <input
                  className="input"
                  aria-label={S.label}
                  value={p.label}
                  onChange={(e) => setPlan(p.i, { label: e.target.value })}
                />
              ),
            },
            {
              key: 'u',
              label: S.price,
              render: (p) => (
                <PlanNum
                  value={p.usdPerMonth}
                  label={S.price}
                  onChange={(v) => setPlan(p.i, { usdPerMonth: v })}
                />
              ),
            },
            {
              key: 'c',
              label: S.cpu,
              render: (p) => (
                <PlanNum value={p.cpu} label={S.cpu} onChange={(v) => setPlan(p.i, { cpu: v })} />
              ),
            },
            {
              key: 'r',
              label: S.ram,
              render: (p) => (
                <PlanNum
                  value={p.ramMb}
                  label={S.ram}
                  onChange={(v) => setPlan(p.i, { ramMb: v })}
                />
              ),
            },
            {
              key: 'x',
              label: '',
              align: 'right',
              render: (p) => (
                <Button
                  small
                  variant="ghost"
                  disabled={plans.length <= 1}
                  aria-label={T.app.remove}
                  onClick={() => set('compute', { plans: plans.filter((_, j) => j !== p.i) })}
                >
                  <Icon name="close" size={12} />
                </Button>
              ),
            },
          ]}
        />
        <div style={{ marginTop: 8 }}>
          <Button
            small
            onClick={() =>
              set('compute', {
                plans: [
                  ...plans,
                  {
                    id: `offre-${plans.length + 1}`,
                    label: 'Nouvelle offre',
                    usdPerMonth: 0,
                    cpu: 1,
                    ramMb: 1024,
                  },
                ],
              })
            }
          >
            <Icon name="plus" size={12} /> {S.addPlan}
          </Button>
        </div>
      </Win>
      <div className="eco-grid" style={{ margin: 0 }}>
        <Win title={S.db} glyph="◎">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="cs-dbp">{S.dbPlan}</label>
              <input
                id="cs-dbp"
                className="input"
                value={s.database.plan}
                onChange={(e) => set('database', { plan: e.target.value })}
              />
            </div>
            <NumField
              id="cs-dbu"
              label={S.dbPrice}
              value={s.database.usdPerMonth}
              onChange={(v) => set('database', { usdPerMonth: v })}
            />
            <NumField
              id="cs-dbg"
              label={S.dbStorage}
              value={s.database.storageGb}
              onChange={(v) => set('database', { storageGb: v })}
            />
            <NumField
              id="cs-dbs"
              label={S.dbStoragePrice}
              value={s.database.storageUsdPerGbMonth}
              onChange={(v) => set('database', { storageUsdPerGbMonth: v })}
            />
          </div>
        </Win>
        <Win title={`${S.bandwidth} · ${S.stripe} · ${S.revenue}`} glyph="⇅">
          <div className="form-grid">
            <NumField
              id="cs-bi"
              label={S.included}
              value={s.bandwidth.includedGb}
              onChange={(v) => set('bandwidth', { includedGb: v })}
            />
            <NumField
              id="cs-bp"
              label={S.perGb}
              value={s.bandwidth.usdPerGb}
              onChange={(v) => set('bandwidth', { usdPerGb: v })}
            />
            <NumField
              id="cs-sp"
              label={S.stripePct}
              value={s.stripe.percent}
              onChange={(v) => set('stripe', { percent: v })}
            />
            <NumField
              id="cs-sf"
              label={S.stripeFixed}
              value={s.stripe.fixedEurCents}
              onChange={(v) => set('stripe', { fixedEurCents: v })}
            />
            <NumField
              id="cs-eur"
              label={S.eurToUsd}
              value={s.eurToUsd}
              onChange={(v) => setS({ ...s, eurToUsd: v })}
            />
            <NumField
              id="cs-vat"
              label={S.vat}
              value={s.vatPercent}
              onChange={(v) => setS({ ...s, vatPercent: v })}
            />
            <NumField
              id="cs-push"
              label={S.push}
              value={s.push.usdPerThousand}
              onChange={(v) => set('push', { usdPerThousand: v })}
            />
          </div>
        </Win>
        <Win title={S.memory} glyph="▦">
          <div className="form-grid">
            <NumField
              id="cs-m1"
              label={S.mbPerStateMiB}
              value={s.memory.mbPerStateMiB}
              onChange={(v) => set('memory', { mbPerStateMiB: v })}
            />
            <NumField
              id="cs-m2"
              label={S.mbMin}
              value={s.memory.mbMinPerGame}
              onChange={(v) => set('memory', { mbMinPerGame: v })}
            />
            <NumField
              id="cs-m3"
              label={S.mbPerConn}
              value={s.memory.mbPerConnection}
              onChange={(v) => set('memory', { mbPerConnection: v })}
            />
          </div>
        </Win>
        <Win title={S.alerts} glyph="!">
          <div className="form-grid">
            <NumField
              id="cs-a1"
              label={S.freeUser}
              value={s.alerts.freeUserMonthlyUsd}
              onChange={(v) => set('alerts', { freeUserMonthlyUsd: v })}
            />
            <NumField
              id="cs-a2"
              label={S.cpuStarter}
              value={s.alerts.cpuPctStarter}
              onChange={(v) => set('alerts', { cpuPctStarter: v })}
            />
            <NumField
              id="cs-a3"
              label={S.cpuOther}
              value={s.alerts.cpuPctOther}
              onChange={(v) => set('alerts', { cpuPctOther: v })}
            />
            <NumField
              id="cs-a4"
              label={S.rssStarter}
              value={s.alerts.rssMbStarter}
              onChange={(v) => set('alerts', { rssMbStarter: v })}
            />
            <NumField
              id="cs-a5"
              label={S.loopP99}
              value={s.alerts.loopP99Ms}
              onChange={(v) => set('alerts', { loopP99Ms: v })}
            />
            <NumField
              id="cs-a6"
              label={S.dbGb}
              value={s.alerts.dbGbWarn}
              onChange={(v) => set('alerts', { dbGbWarn: v })}
            />
            <NumField
              id="cs-a7"
              label={S.playersStarter}
              value={s.alerts.playersStarter}
              onChange={(v) => set('alerts', { playersStarter: v })}
            />
            <NumField
              id="cs-a8"
              label={S.gamesStarter}
              value={s.alerts.gamesStarter}
              onChange={(v) => set('alerts', { gamesStarter: v })}
            />
          </div>
        </Win>
        <Win title={S.retention} glyph="⧗">
          <div className="form-grid">
            <NumField
              id="cs-r1"
              label={S.hourlyDays}
              value={s.retention.hourlyDays}
              onChange={(v) => set('retention', { hourlyDays: Math.round(v) })}
            />
            <NumField
              id="cs-r2"
              label={S.dailyDays}
              value={s.retention.dailyDays}
              onChange={(v) => set('retention', { dailyDays: Math.round(v) })}
            />
          </div>
        </Win>
      </div>
      {issues.length > 0 && <Note tone="crit">{issues.slice(0, 4).join(' ; ')}</Note>}
      <div className="row" style={{ gap: 8 }}>
        <Button
          variant="primary"
          disabled={busy || !dirty || issues.length > 0}
          onClick={() => void save()}
        >
          <Icon name="save" size={14} /> {T.app.save}
        </Button>
        <Button disabled={busy} onClick={() => setS(structuredClone(DEFAULT_COST_SETTINGS))}>
          <Icon name="undo" size={14} /> {S.reset}
        </Button>
        {dirty && <Badge tone="warn">●</Badge>}
      </div>
    </div>
  );
}

function PlanNum(p: { value: number; label: string; onChange: (v: number) => void }) {
  const [t, setT] = useState(String(p.value));
  useEffect(() => setT(String(p.value)), [p.value]);
  return (
    <input
      className="input"
      aria-label={p.label}
      inputMode="decimal"
      style={{ width: 90 }}
      value={t}
      onChange={(e) => {
        setT(e.target.value);
        const v = Number(e.target.value.replace(',', '.'));
        if (e.target.value.trim() !== '' && Number.isFinite(v)) p.onChange(v);
      }}
    />
  );
}

// ───────────────────────────── Dépenses ─────────────────────────────

const N = O.entries;

function Entries() {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () => api.costEntries().then((r) => r.entries),
    [api],
    T.roles.superadmin,
  );
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<CostCategory>('video_api');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [monthly, setMonthly] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = Number(amount.replace(',', '.'));
  const add = async () => {
    setBusy(true);
    try {
      await api.addCostEntry({ day, category, label: label.trim(), amountUsd: value, monthly });
      toast(N.added);
      setLabel('');
      setAmount('');
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p className="dim small">{N.sub}</p>
      <Win title={N.add} glyph="+">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ce-day">{N.day}</label>
            <input
              id="ce-day"
              type="date"
              className="input"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ce-cat">{N.category}</label>
            <select
              id="ce-cat"
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value as CostCategory)}
            >
              {COST_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {O.categories[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ce-label">{N.label}</label>
            <input
              id="ce-label"
              className="input"
              maxLength={200}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ce-amount">{N.amount}</label>
            <input
              id="ce-amount"
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <label
            className="check"
            style={{ alignSelf: 'end', display: 'flex', gap: 6, alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={monthly}
              onChange={(e) => setMonthly(e.target.checked)}
            />{' '}
            {N.monthly}
          </label>
        </div>
        <div style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            disabled={busy || !label.trim() || !(value >= 0) || amount.trim() === '' || !day}
            onClick={() => void add()}
          >
            <Icon name="plus" size={14} /> {N.add}
          </Button>
        </div>
      </Win>
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      <Win title={N.title} glyph="$" flush>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={data ?? []}
            rowKey={(e) => String(e.id)}
            bare
            empty={N.none}
            columns={[
              {
                key: 'd',
                label: N.day,
                sort: (e) => e.day,
                render: (e) => date(`${e.day}T12:00:00Z`).slice(0, 10),
              },
              {
                key: 'c',
                label: N.category,
                render: (e) => O.categories[e.category] ?? e.category,
              },
              { key: 'l', label: N.label, className: 'wrap', render: (e) => e.label },
              {
                key: 'a',
                label: N.amount,
                align: 'right',
                sort: (e) => e.amountUsd,
                render: (e) => <b>{money(e.amountUsd)}</b>,
              },
              {
                key: 'm',
                label: N.monthly,
                render: (e) =>
                  e.monthly ? (
                    <Badge tone="blue">{N.monthly}</Badge>
                  ) : (
                    <span className="dim">—</span>
                  ),
              },
              {
                key: 's',
                label: N.source,
                render: (e) => (
                  <Badge tone={e.source === 'measured' ? 'ok' : 'off'}>{N.sources[e.source]}</Badge>
                ),
              },
              {
                key: 'x',
                label: '',
                align: 'right',
                render: (e) => (
                  <Button
                    small
                    variant="ghost"
                    aria-label={N.remove}
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: N.remove,
                          message: fmt(N.removeConfirm, {
                            label: e.label,
                            amount: money(e.amountUsd),
                          }),
                          danger: true,
                          confirm: N.remove,
                        }))
                      )
                        return;
                      try {
                        await api.deleteCostEntry(e.id);
                        toast(N.removed);
                        void reload(true);
                      } catch (err) {
                        toast(errorMessage(err, T.roles.superadmin), 'error');
                      }
                    }}
                  >
                    <Icon name="close" size={12} />
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Win>
    </div>
  );
}
