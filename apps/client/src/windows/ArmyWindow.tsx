import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HOUR,
  MINUTE,
  type GeneralView,
  type Order,
  type OperationView,
  type UnitId,
  type UnitView,
} from '@redline/shared';
import {
  Badge,
  Button,
  Checkbox,
  Countdown,
  EmptyState,
  Field,
  Gauge,
  Icon,
  Input,
  Panel,
  SearchInput,
  Segmented,
  Select,
  Slider,
  Table,
  Tabs,
  UnitMarker,
  Window,
  formatInt,
  pictogramFor,
} from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { norm, resolvePlace, type CommandCtx } from '../lib/commands.js';
import { unitPosition } from '../map/interpolation.js';
import { t as tr } from '../i18n/index.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

type Tab = 'units' | 'generals' | 'operations';
type Domain = 'all' | 'land' | 'air' | 'sea' | 'static';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
    return !!res?.ok;
  };
}

function Units({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const focusOn = useUi((s) => s.focusOn);
  const closeAll = useUi((s) => s.closeAllWindows);
  const [domain, setDomain] = useState<Domain>('all');
  const [q, setQ] = useState('');
  const own = useMemo(
    () =>
      Object.values(view?.units ?? {}).filter(
        (u) => u.owner === me && u.level === 'own' && u.status !== 'destroyed',
      ),
    [view?.units, me],
  );
  const dom = (u: UnitView): Domain =>
    (u.systemId ? (catalog[u.systemId]?.movement ?? 'land') : 'land') as Domain;
  const counts = useMemo(() => {
    const c: Record<Domain, number> = { all: own.length, land: 0, air: 0, sea: 0, static: 0 };
    for (const u of own) c[dom(u)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own, catalog]);
  const rows = own
    .filter((u) => domain === 'all' || dom(u) === domain)
    .filter(
      (u) =>
        !q || norm(catalog[u.systemId ?? '']?.name ?? '').includes(norm(q)) || u.id.includes(q),
    );
  const general = (u: UnitView) => view?.generals?.find((g) => g.id === u.generalId);
  const elements = rows.reduce((s, u) => s + (u.count ?? 1), 0);
  return (
    <div className="vstack">
      <div className="row row--between">
        <Segmented
          size="sm"
          label={t('army.domain')}
          value={domain}
          onChange={setDomain}
          options={(['all', 'land', 'air', 'sea', 'static'] as Domain[]).map((d) => ({
            value: d,
            label: `${t(`army.domains.${d}`)} ${counts[d]}`,
          }))}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          label={t('app.search')}
          placeholder={t('army.search')}
          className="army-search"
        />
      </div>
      <Table
        label={t('army.units')}
        rows={rows}
        rowKey={(u) => u.id}
        selectedKey={selection[0] ?? null}
        rowClass={(u) => (selection.includes(u.id) ? 'rl-tr--sel' : undefined)}
        onRowClick={(u) => {
          select([u.id]);
          focusOn(unitPosition(u, gameNow()), 6.5);
          if (mobile) closeAll();
        }}
        defaultSort={{ key: 'name', dir: 'asc' }}
        empty={<EmptyState compact icon="army" title={t('army.empty')} />}
        columns={[
          {
            key: 'name',
            header: t('army.cols.unit'),
            sort: (a, b) =>
              (catalog[a.systemId ?? '']?.name ?? '').localeCompare(
                catalog[b.systemId ?? '']?.name ?? '',
              ),
            render: (u) => {
              const s = u.systemId ? catalog[u.systemId] : undefined;
              return (
                <span className="urow">
                  <UnitMarker
                    pictogram={pictogramFor(s)}
                    nationId={u.owner}
                    tone="own"
                    size="sm"
                    health={u.hpRatio}
                  />
                  <span className="urow__name">
                    <b>{s?.name ?? u.systemId}</b>
                    <span>
                      {u.id}
                      {u.veterancy ? ` · ${'★'.repeat(u.veterancy)}` : ''}
                      <span className="rl-only-mobile">
                        {' '}
                        · {t(`game.status.${u.status ?? 'idle'}`)}
                      </span>
                    </span>
                  </span>
                </span>
              );
            },
          },
          {
            key: 'n',
            header: t('army.cols.count'),
            align: 'right',
            render: (u) => formatInt(u.count ?? 1),
            sort: (a, b) => (a.count ?? 1) - (b.count ?? 1),
          },
          {
            key: 'hp',
            header: t('army.cols.hp'),
            render: (u) => <Gauge value={u.hpRatio ?? 1} tone="auto" cells={8} />,
            sort: (a, b) => (a.hpRatio ?? 1) - (b.hpRatio ?? 1),
            hideOnMobile: true,
          },
          {
            key: 'st',
            header: t('army.cols.status'),
            hideOnMobile: true,
            render: (u) => (
              <Badge
                tone={u.status === 'combat' ? 'red' : u.status === 'moving' ? 'cyan' : 'neutral'}
                dot
                pulse={u.status === 'combat'}
              >
                {t(`game.status.${u.status ?? 'idle'}`)}
              </Badge>
            ),
          },
          {
            key: 'sup',
            header: t('army.cols.supply'),
            hideOnMobile: true,
            render: (u) =>
              u.supply ? (
                <span
                  className={
                    u.supply === 'supplied'
                      ? 'rl-tone-green'
                      : u.supply === 'limited'
                        ? 'rl-tone-amber'
                        : 'rl-tone-red'
                  }
                >
                  {t(`army.supplyState.${u.supply}`)}
                </span>
              ) : (
                '—'
              ),
          },
          {
            key: 'mis',
            header: t('army.cols.mission'),
            hideOnMobile: true,
            render: (u) =>
              u.mission && u.mission.kind !== 'none' ? (
                t(`army.mission.${u.mission.kind}`)
              ) : (
                <span className="muted">—</span>
              ),
          },
          {
            key: 'gen',
            header: t('army.cols.general'),
            hideOnMobile: true,
            render: (u) => general(u)?.name ?? <span className="muted">—</span>,
          },
        ]}
      />
      <p className="hint">
        {t('army.summary', { units: rows.length, elements: formatInt(elements) })}
      </p>
    </div>
  );
}

const DIRECTIVES = ['none', 'defend', 'advance', 'harass'] as const;

function GeneralCard({ g }: { g: GeneralView }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const catalog = useWorld((s) => s.catalog);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const send = useSend();
  const units = g.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
  const area = g.area ?? (units[0] ? unitPosition(units[0], gameNow()) : null);
  return (
    <Panel
      title={g.name}
      meta={t('army.unitsCount', { count: units.length })}
      accent={g.directive ? 'cyan' : undefined}
      actions={
        g.directive ? (
          <Badge tone="cyan" dot pulse>
            {t('army.delegated')}
          </Badge>
        ) : null
      }
    >
      <div className="general">
        <div className="general__traits">
          {g.traits.map((tr_) => (
            <Badge key={tr_} tone="violet" variant="outline">
              {t(`army.traits.${tr_}`)}
            </Badge>
          ))}
        </div>
        <div className="general__units">
          {units.slice(0, 10).map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => select([u.id])}
              title={catalog[u.systemId ?? '']?.name}
            >
              <UnitMarker
                pictogram={pictogramFor(catalog[u.systemId ?? ''])}
                tone="own"
                count={u.count}
                size="sm"
                health={u.hpRatio}
              />
            </button>
          ))}
          {units.length > 10 ? <span className="muted small">+{units.length - 10}</span> : null}
        </div>
        <div className="general__row">
          <span className="general__label">{t('army.directive')}</span>
          <Segmented
            size="sm"
            label={t('army.directive')}
            value={g.directive ?? 'none'}
            onChange={(d) =>
              void send(
                {
                  kind: 'delegate',
                  generalId: g.id,
                  directive: d === 'none' ? null : d,
                  area: d === 'none' ? null : area,
                },
                d === 'none' ? t('army.delegationOff') : t('army.delegationOn', { name: g.name }),
              )
            }
            options={DIRECTIVES.map((d) => ({ value: d, label: t(`army.directives.${d}`) }))}
          />
        </div>
        <div className="general__actions">
          <Button
            size="sm"
            variant="subtle"
            icon={<Icon name="army" size={12} />}
            onClick={() => select(g.unitIds)}
            disabled={!units.length}
          >
            {t('army.selectGroup')}
          </Button>
          <Button
            size="sm"
            variant="subtle"
            icon={<Icon name="plus" size={12} />}
            disabled={!selection.length}
            onClick={() =>
              void send(
                {
                  kind: 'appointGeneral',
                  generalId: g.id,
                  unitIds: [...new Set([...g.unitIds, ...selection])],
                },
                t('army.assigned', { name: g.name }),
              )
            }
          >
            {t('army.assignSelection', { count: selection.length })}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function Generals() {
  const { t } = useTranslation();
  const generals = useGame((s) => s.view?.generals ?? []);
  if (!generals.length) return <EmptyState icon="user" title={t('army.noGenerals')} />;
  return (
    <div className="generals">
      {generals.map((g) => (
        <GeneralCard key={g.id} g={g} />
      ))}
    </div>
  );
}

// ——— Opérations combinées ———

type StepKind = 'move' | 'attack' | 'strike' | 'patrol' | 'jam' | 'stop' | 'rtb';
interface DraftStep {
  id: number;
  offsetMin: number;
  label: string;
  kind: StepKind;
  unitIds: UnitId[];
  place: string;
  targetId: string;
}

function OperationEditor({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const world = useWorld();
  const selection = useUi((s) => s.selection);
  const send = useSend();
  const [name, setName] = useState(t('army.ops.defaultName'));
  const [inH, setInH] = useState(6);
  const [steps, setSteps] = useState<DraftStep[]>(() => [
    {
      id: 1,
      offsetMin: -60,
      label: t('army.ops.examples.prep'),
      kind: 'strike',
      unitIds: [],
      place: '',
      targetId: '',
    },
    {
      id: 2,
      offsetMin: 0,
      label: t('army.ops.examples.assault'),
      kind: 'move',
      unitIds: selection,
      place: '',
      targetId: '',
    },
  ]);
  const own = Object.values(view?.units ?? {}).filter((u) => u.owner === me && u.level === 'own');
  const ctx: CommandCtx | null =
    view && me
      ? {
          view,
          me,
          catalog: world.catalog,
          provinces: world.provinces,
          nations: world.nations,
          research: world.research,
          selection,
          label: (k, o) => tr(k, o),
        }
      : null;
  const update = (id: number, patch: Partial<DraftStep>) =>
    setSteps((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const toOrder = (s: DraftStep): Order | null => {
    if (!ctx || !s.unitIds.length) return null;
    const p = s.place ? resolvePlace(s.place, ctx) : null;
    switch (s.kind) {
      case 'move':
        return p ? { kind: 'move', unitIds: s.unitIds, to: p.at } : null;
      case 'attack':
        return s.targetId ? { kind: 'attack', unitIds: s.unitIds, targetId: s.targetId } : null;
      case 'strike':
        return p
          ? { kind: 'strike', unitIds: s.unitIds, target: { type: 'point', at: p.at } }
          : null;
      case 'patrol':
        return p ? { kind: 'patrol', unitIds: s.unitIds, at: p.at, radiusKm: 80 } : null;
      case 'jam':
        return { kind: 'jam', unitIds: s.unitIds, on: true };
      case 'stop':
        return { kind: 'stop', unitIds: s.unitIds };
      case 'rtb':
        return { kind: 'rtb', unitIds: s.unitIds };
    }
  };
  const orders = steps.map(toOrder);
  const valid = name.trim().length > 0 && orders.every(Boolean);
  const hHour = gameNow() + inH * HOUR;
  const enemies = Object.values(view?.units ?? {}).filter((u) => u.owner !== me);
  return (
    <Panel title={t('army.ops.new')} accent="cyan">
      <div className="opedit">
        <div className="opedit__head">
          <Field label={t('army.ops.name')}>
            <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label={t('army.ops.hHour')}
            hint={t('army.ops.hHourHint', { value: fmtDuration(inH * HOUR) })}
          >
            <Slider
              value={inH}
              onChange={setInH}
              min={1}
              max={72}
              label={t('army.ops.hHour')}
              format={(v) => `H+${v}`}
            />
          </Field>
        </div>
        <ol className="opedit__steps">
          {[...steps]
            .sort((a, b) => a.offsetMin - b.offsetMin)
            .map((s) => (
              <li key={s.id} className={toOrder(s) ? 'opstep' : 'opstep opstep--invalid'}>
                <div className="opstep__time">
                  <Input
                    aria-label={t('army.ops.offset')}
                    value={String(s.offsetMin)}
                    onChange={(e) =>
                      update(s.id, {
                        offsetMin: Math.max(
                          -10080,
                          Math.min(10080, Number(e.target.value.replace(/[^\d-]/g, '')) || 0),
                        ),
                      })
                    }
                  />
                  <span>
                    {s.offsetMin === 0
                      ? 'H'
                      : `H${s.offsetMin > 0 ? '+' : '−'}${Math.abs(s.offsetMin)} min`}
                  </span>
                </div>
                <div className="opstep__main">
                  <div className="opstep__row">
                    <Select
                      value={s.kind}
                      onChange={(k) => update(s.id, { kind: k as StepKind })}
                      options={(
                        ['move', 'attack', 'strike', 'patrol', 'jam', 'stop', 'rtb'] as StepKind[]
                      ).map((k) => ({ value: k, label: t(`army.ops.kinds.${k}`) }))}
                      label={t('army.ops.kind')}
                    />
                    <Input
                      value={s.label}
                      placeholder={t('army.ops.label')}
                      maxLength={80}
                      onChange={(e) => update(s.id, { label: e.target.value })}
                    />
                  </div>
                  <div className="opstep__row">
                    <Button
                      size="sm"
                      variant="subtle"
                      icon={<Icon name="army" size={12} />}
                      onClick={() => update(s.id, { unitIds: selection })}
                      disabled={!selection.length}
                    >
                      {t('army.ops.useSelection', { count: selection.length })}
                    </Button>
                    <span className="opstep__units">
                      {s.unitIds.length
                        ? t('army.ops.unitsCount', { count: s.unitIds.length })
                        : t('army.ops.noUnits')}
                    </span>
                    {s.kind === 'attack' ? (
                      <Select
                        value={s.targetId}
                        onChange={(v) => update(s.id, { targetId: v })}
                        options={[
                          { value: '', label: t('army.ops.pickTarget') },
                          ...enemies
                            .slice(0, 40)
                            .map((u) => ({
                              value: u.id,
                              label: `${u.id} · ${world.catalog[u.systemId ?? '']?.name ?? t('game.legend.detected')}`,
                            })),
                        ]}
                        label={t('game.orders.target')}
                      />
                    ) : ['move', 'strike', 'patrol'].includes(s.kind) ? (
                      <Input
                        value={s.place}
                        placeholder={t('army.ops.place')}
                        onChange={(e) => update(s.id, { place: e.target.value })}
                        aria-label={t('army.ops.place')}
                      />
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="opstep__del"
                  aria-label={t('army.ops.removeStep')}
                  onClick={() => setSteps((x) => x.filter((y) => y.id !== s.id))}
                >
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
        </ol>
        <div className="opedit__foot">
          <Button
            size="sm"
            variant="subtle"
            icon={<Icon name="plus" size={12} />}
            disabled={steps.length >= 30}
            onClick={() =>
              setSteps((s) => [
                ...s,
                {
                  id: Date.now(),
                  offsetMin: (s[s.length - 1]?.offsetMin ?? 0) + 30,
                  label: '',
                  kind: 'move',
                  unitIds: selection,
                  place: '',
                  targetId: '',
                },
              ])
            }
          >
            {t('army.ops.addStep')}
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onDone}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            icon={<Icon name="clock" size={13} />}
            onClick={() =>
              void send(
                {
                  kind: 'operation',
                  name: name.trim(),
                  hHour,
                  steps: steps.map((s, i) => ({
                    offsetMin: s.offsetMin,
                    label: s.label || undefined,
                    order: orders[i] as never,
                  })),
                },
                t('army.ops.planned', { name }),
              ).then((ok) => ok && onDone())
            }
            data-testid="op-submit"
          >
            {t('army.ops.plan')}
          </Button>
        </div>
        {!valid ? <p className="hint">{t('army.ops.invalid')}</p> : null}
      </div>
    </Panel>
  );
}

function OperationCard({ op, now }: { op: OperationView; now: number }) {
  const { t } = useTranslation();
  const send = useSend();
  const tone =
    op.status === 'running'
      ? 'cyan'
      : op.status === 'planned'
        ? 'amber'
        : op.status === 'done'
          ? 'green'
          : op.status === 'failed'
            ? 'red'
            : 'neutral';
  return (
    <Panel
      title={op.name}
      accent={tone === 'neutral' ? undefined : tone}
      meta={
        op.status === 'planned' ? (
          <Countdown ms={op.hHour - now} prefix="H−" dayUnit={t('time.dayUnit')} />
        ) : undefined
      }
      actions={
        <>
          <Badge tone={tone}>{t(`army.ops.status.${op.status}`)}</Badge>
          {op.status === 'planned' || op.status === 'running' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void send({ kind: 'cancelOperation', operationId: op.id }, t('army.ops.cancelled'))
              }
            >
              {t('app.cancel')}
            </Button>
          ) : null}
        </>
      }
    >
      <ol className="optimeline">
        {[...op.steps]
          .sort((a, b) => a.offsetMin - b.offsetMin)
          .map((s, i) => {
            const at = op.hHour + s.offsetMin * MINUTE;
            return (
              <li
                key={i}
                className={`optimeline__step optimeline__step--${s.status}${at <= now && s.status === 'pending' ? ' optimeline__step--due' : ''}`}
              >
                <span className="optimeline__t">
                  {s.offsetMin === 0
                    ? 'H'
                    : `H${s.offsetMin > 0 ? '+' : '−'}${Math.abs(s.offsetMin)}′`}
                </span>
                <span className="optimeline__dot" aria-hidden />
                <span className="optimeline__label">
                  {s.label}
                  {s.error ? <span className="rl-tone-red"> — {s.error}</span> : null}
                </span>
                <span className="optimeline__st">{t(`army.ops.stepStatus.${s.status}`)}</span>
              </li>
            );
          })}
      </ol>
    </Panel>
  );
}

function Operations() {
  const { t } = useTranslation();
  const ops = useGame((s) => s.view?.operations ?? []);
  const now = useGameTime(1000);
  const [editing, setEditing] = useState(false);
  return (
    <div className="vstack">
      {editing ? (
        <OperationEditor onDone={() => setEditing(false)} />
      ) : (
        <div className="row row--between">
          <p className="hint">{t('army.ops.help')}</p>
          <Button
            variant="primary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => setEditing(true)}
            data-testid="op-new"
          >
            {t('army.ops.new')}
          </Button>
        </div>
      )}
      {ops.length ? (
        ops.map((op) => <OperationCard key={op.id} op={op} now={now} />)
      ) : !editing ? (
        <EmptyState icon="clock" title={t('army.ops.none')} />
      ) : null}
    </div>
  );
}

/** Armée : unités, groupes et généraux (délégation IA), opérations combinées. */
export function ArmyWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const [tab, setTab] = useState<Tab>((win.params.tab as Tab) ?? 'units');
  useEffect(() => {
    if (win.params.tab) setTab(win.params.tab as Tab);
  }, [win.seq, win.params.tab]);
  const own = Object.values(view?.units ?? {}).filter((u) => u.owner === me && u.level === 'own');
  return (
    <Window
      {...frame}
      path={[t('sections.path.army'), t(`army.tabs.${tab}`)]}
      tabs={
        <Tabs
          label={t('sections.army')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'units',
              label: t('army.tabs.units'),
              count: own.length,
              icon: <Icon name="army" size={13} />,
            },
            {
              id: 'generals',
              label: t('army.tabs.generals'),
              count: view?.generals?.length ?? 0,
              icon: <Icon name="user" size={13} />,
            },
            {
              id: 'operations',
              label: t('army.tabs.operations'),
              count:
                view?.operations?.filter((o) => o.status === 'planned' || o.status === 'running')
                  .length ?? 0,
              icon: <Icon name="clock" size={13} />,
            },
          ]}
        />
      }
    >
      {tab === 'units' ? (
        <Units mobile={mobile} />
      ) : tab === 'generals' ? (
        <Generals />
      ) : (
        <Operations />
      )}
    </Window>
  );
}
