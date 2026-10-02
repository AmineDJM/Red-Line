import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Order, UnitView } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Gauge,
  Icon,
  IconButton,
  Input,
  KeyValue,
  SearchInput,
  Segmented,
  Select,
  Stat,
  Table,
  Tabs,
  UnitMarker,
  Window,
  formatInt,
  formatMoney,
  pictogramFor,
  type Tone,
} from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import {
  ARMY_STATES,
  armyLocation,
  filterArmies,
  groupArmies,
  mergeGroups,
  ownPiles,
  pileDomain,
  summarizeArmies,
  type Army,
  type ArmyDomain,
  type ArmyLocation,
  type ArmyState,
} from '../lib/armies.js';
import { norm } from '../lib/commands.js';
import { nearestCity } from '../lib/location.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { Generals, Operations, useSend } from './armyCommand.js';
import { isMixed, splitByTypeOrder, splitHalfOrder, stackParts } from '../lib/stacks.js';

type Tab = 'armies' | 'generals' | 'operations';
type SortKey = 'state' | 'elements' | 'hp' | 'name';

const STATE_TONE: Record<ArmyState, Tone> = {
  combat: 'red',
  moving: 'cyan',
  resupply: 'amber',
  embarked: 'blue',
  idle: 'neutral',
};
const STATE_ORDER: Record<ArmyState, number> = {
  combat: 0,
  moving: 1,
  resupply: 2,
  embarked: 3,
  idle: 4,
};

/** Noms donnés par le joueur (sur cet appareil), par partie et par pile de tête. */
function useArmyNames(gameId: string | undefined) {
  const key = `rl.armies.names.${gameId ?? 'local'}`;
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      setNames(JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>);
    } catch {
      setNames({});
    }
  }, [key]);
  const rename = useCallback(
    (id: string, name: string) => {
      setNames((prev) => {
        const next = { ...prev };
        if (name.trim()) next[id] = name.trim().slice(0, 40);
        else delete next[id];
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* stockage indisponible */
        }
        return next;
      });
    },
    [key],
  );
  return { names, rename };
}

function StateBadge({ state }: { state: ArmyState }) {
  const { t } = useTranslation();
  return (
    <Badge tone={STATE_TONE[state]} dot pulse={state === 'combat'}>
      {t(`armies.state.${state}`)}
    </Badge>
  );
}

/** Armées du joueur : vue d'ensemble, filtres, fiche d'armée et actions directes. */
function Armies({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const gameId = useGame((s) => s.meta?.id);
  const catalog = useWorld((s) => s.catalog);
  const provinces = useWorld((s) => s.provinces);
  const now = useGameTime(2000);
  const { names, rename } = useArmyNames(gameId);
  const [domain, setDomain] = useState<ArmyDomain | 'all'>('all');
  const [state, setState] = useState<ArmyState | 'all'>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('state');
  const [selected, setSelected] = useState<string | null>(null);

  const armies = useMemo(
    () => groupArmies(ownPiles(view, me), catalog, now, view),
    [view, me, catalog, now],
  );
  const summary = useMemo(() => summarizeArmies(armies, catalog), [armies, catalog]);
  const locs = useMemo(() => {
    const m = new Map<string, ArmyLocation>();
    for (const a of armies) m.set(a.id, armyLocation(a, catalog, provinces, now));
    return m;
  }, [armies, catalog, provinces, now]);

  const nameOf = useCallback(
    (a: Army) => names[a.id] ?? t(`armies.name.${a.domain}`, { n: a.number }),
    [names, t],
  );
  const locLabel = (l: ArmyLocation | undefined): string =>
    !l
      ? '—'
      : l.kind === 'city'
        ? (l.city ?? '—')
        : l.kind === 'near'
          ? t('army.loc.near', { city: l.city, km: l.km })
          : t(`army.loc.${l.kind}`);
  const composition = (a: Army, max = 3): string => {
    const by = new Map<string, number>();
    for (const u of a.units) {
      const n = catalog[u.systemId ?? '']?.name ?? u.systemId ?? '?';
      by.set(n, (by.get(n) ?? 0) + (u.count ?? 1));
    }
    const parts = [...by.entries()].sort((x, y) => y[1] - x[1]);
    const shown = parts.slice(0, max).map(([n, c]) => `${n} ×${formatInt(c)}`);
    return parts.length > max ? `${shown.join(' · ')} · +${parts.length - max}` : shown.join(' · ');
  };
  const orderLabel = (a: Army): string => {
    const o = a.order;
    if (o.kind === 'move') {
      const c = nearestCity(provinces, o.to);
      return t('armies.order.move', {
        place: c?.name ?? `${o.to[1].toFixed(1)}, ${o.to[0].toFixed(1)}`,
        eta: fmtDuration(Math.max(0, o.eta - now)),
      });
    }
    if (o.kind === 'attack') {
      const u = view?.units[o.targetId];
      return t('armies.order.attack', {
        target: (u?.systemId && catalog[u.systemId]?.name) || o.targetId,
      });
    }
    if (o.kind === 'mission') return t(`army.mission.${o.mission}`);
    if (o.kind === 'delegated')
      return t('armies.order.delegated', { directive: t(`army.directives.${o.directive}`) });
    return t('armies.order.none');
  };
  const generalName = (a: Army) =>
    a.generalId ? (view?.generals?.find((g) => g.id === a.generalId)?.name ?? null) : null;

  const domainCounts = useMemo(() => {
    const c: Record<ArmyDomain | 'all', number> = { all: armies.length, land: 0, air: 0, sea: 0 };
    for (const a of armies) c[a.domain]++;
    return c;
  }, [armies]);

  const rows = useMemo(() => {
    const list = filterArmies(
      armies,
      { domain, state, query: q },
      (a) =>
        [
          nameOf(a),
          composition(a, 99),
          locLabel(locs.get(a.id)),
          locs.get(a.id)?.province ?? '',
          a.unitIds.join(' '),
        ].join(' '),
      norm,
    );
    const cmp: Record<SortKey, (x: Army, y: Army) => number> = {
      state: (x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || y.elements - x.elements,
      elements: (x, y) => y.elements - x.elements,
      hp: (x, y) => x.hp - y.hp,
      name: (x, y) => nameOf(x).localeCompare(nameOf(y), 'fr', { numeric: true }),
    };
    return [...list].sort(cmp[sort]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armies, domain, state, q, sort, nameOf, locs]);

  const cur = selected
    ? armies.find((a) => a.id === selected || a.unitIds.includes(selected))
    : null;

  const header = (
    <div className="kpis armies__kpis" data-testid="armies-summary">
      <Stat
        label={t('armies.kpi.armies')}
        value={formatInt(summary.armies)}
        tone={summary.inCombat ? 'red' : 'default'}
        icon={<Icon name="army" size={12} />}
        sub={t('armies.kpi.armiesSub', {
          combat: summary.inCombat,
          moving: summary.byState.moving,
        })}
      />
      {(['land', 'air', 'sea', 'static'] as const).map((d) => (
        <Stat
          key={d}
          label={t(`armies.kpi.${d}`)}
          value={formatInt(summary.byDomain[d].elements)}
          sub={t('armies.kpi.piles', { count: summary.byDomain[d].piles })}
          tone={summary.byDomain[d].elements ? 'default' : undefined}
        />
      ))}
      <Stat
        label={t('armies.kpi.value')}
        value={formatMoney(summary.value)}
        tone="amber"
        sub={t('armies.kpi.valueSub')}
      />
    </div>
  );

  const filters = (
    <div className="armies__filters">
      <Segmented
        size="sm"
        label={t('armies.domain')}
        value={domain}
        onChange={setDomain}
        options={(['all', 'land', 'air', 'sea'] as const).map((d) => ({
          value: d,
          label: `${t(`armies.domains.${d}`)} ${domainCounts[d]}`,
        }))}
      />
      <Select
        label={t('armies.stateFilter')}
        value={state}
        onChange={(v) => setState(v as ArmyState | 'all')}
        options={[
          { value: 'all', label: t('armies.allStates') },
          ...ARMY_STATES.map((s) => ({
            value: s,
            label: `${t(`armies.state.${s}`)} (${summary.byState[s]})`,
          })),
        ]}
      />
      <Select
        label={t('armies.sort')}
        value={sort}
        onChange={(v) => setSort(v as SortKey)}
        options={(['state', 'elements', 'hp', 'name'] as const).map((k) => ({
          value: k,
          label: t(`armies.sortBy.${k}`),
        }))}
      />
      <SearchInput
        value={q}
        onChange={setQ}
        label={t('app.search')}
        placeholder={t('armies.search')}
        className="armies__search"
      />
    </div>
  );

  const table = (
    <Table
      label={t('sections.armies')}
      rows={rows}
      rowKey={(a) => a.id}
      selectedKey={cur?.id ?? null}
      onRowClick={(a) => setSelected(a.id)}
      empty={
        <EmptyState
          compact
          icon="army"
          title={armies.length ? t('armies.noMatch') : t('armies.empty')}
        />
      }
      columns={[
        {
          key: 'name',
          header: t('armies.cols.army'),
          render: (a) => {
            const lead = a.units[0]!;
            return (
              <span className="urow">
                <UnitMarker
                  pictogram={pictogramFor(catalog[lead.systemId ?? ''])}
                  nationId={me ?? undefined}
                  tone="own"
                  size="sm"
                  count={a.piles > 1 ? a.piles : undefined}
                  health={a.hp}
                />
                <span className="urow__name">
                  <b>{nameOf(a)}</b>
                  <span>{composition(a)}</span>
                  <span className="rl-only-mobile">
                    {t(`armies.state.${a.state}`)} · {locLabel(locs.get(a.id))} ·{' '}
                    {t('armies.elements', { count: a.elements })}
                  </span>
                </span>
              </span>
            );
          },
        },
        {
          key: 'n',
          header: t('armies.cols.strength'),
          align: 'right',
          hideOnMobile: true,
          render: (a) => (
            <span className="armies__n">
              <b>{formatInt(a.elements)}</b>
              <span>{t('armies.piles', { count: a.piles })}</span>
            </span>
          ),
        },
        {
          key: 'hp',
          header: t('armies.cols.hp'),
          hideOnMobile: true,
          render: (a) => <Gauge value={a.hp} tone="auto" cells={6} label={t('armies.cols.hp')} />,
        },
        {
          key: 'state',
          header: t('armies.cols.state'),
          hideOnMobile: true,
          render: (a) => <StateBadge state={a.state} />,
        },
        {
          key: 'loc',
          header: t('armies.cols.location'),
          hideOnMobile: true,
          render: (a) => {
            const l = locs.get(a.id);
            return (
              <span className="armies__loc">
                <span>{locLabel(l)}</span>
                {l?.province && l.province !== l.city ? <small>{l.province}</small> : null}
              </span>
            );
          },
        },
        {
          key: 'order',
          header: t('armies.cols.orders'),
          hideOnMobile: true,
          render: (a) =>
            a.order.kind === 'none' ? (
              <span className="armies__order muted">{orderLabel(a)}</span>
            ) : (
              <span
                className={
                  a.order.kind === 'attack' ? 'armies__order rl-tone-red' : 'armies__order'
                }
                title={orderLabel(a)}
              >
                {orderLabel(a)}
              </span>
            ),
        },
      ]}
    />
  );

  const detail = cur ? (
    <ArmyDetail
      key={cur.id}
      army={cur}
      name={nameOf(cur)}
      onRename={(n) => rename(cur.id, n)}
      location={locs.get(cur.id)}
      locLabel={locLabel(locs.get(cur.id))}
      orderLabel={orderLabel(cur)}
      general={generalName(cur)}
      mobile={mobile}
      onBack={() => setSelected(null)}
    />
  ) : (
    <EmptyState icon="army" title={t('armies.pick')} text={t('armies.pickHint')} />
  );

  if (mobile && cur) return <div className="armies armies--mobile">{detail}</div>;
  return (
    <div className={mobile ? 'armies armies--mobile' : 'armies'}>
      {header}
      {filters}
      {mobile ? (
        <div className="armies__list">{table}</div>
      ) : (
        <div className="armies__split">
          <div className="armies__list">{table}</div>
          <div className="armies__detail">{detail}</div>
        </div>
      )}
    </div>
  );
}

/** Fiche d'une armée : état, localisation, ordres, actions, composition (piles). */
function ArmyDetail({
  army: a,
  name,
  onRename,
  location,
  locLabel,
  orderLabel,
  general,
  mobile,
  onBack,
}: {
  army: Army;
  name: string;
  onRename: (name: string) => void;
  location: ArmyLocation | undefined;
  locLabel: string;
  orderLabel: string;
  general: string | null;
  mobile: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const balance = useWorld((s) => s.balance);
  const me = useGame((s) => s.me);
  const select = useUi((s) => s.select);
  const focusOn = useUi((s) => s.focusOn);
  const closeAll = useUi((s) => s.closeAllWindows);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const send = useSend();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const mobileUnits = a.units.filter((u) => pileDomain(u, catalog) !== 'static');
  const flyers = mobileUnits.filter((u) => {
    const d = pileDomain(u, catalog);
    return d === 'air' || d === 'sea';
  });
  const merges = mergeGroups(a, catalog, balance);
  const busy = a.state === 'moving' || a.state === 'combat';

  const center = () => {
    focusOn(a.at, a.spreadKm > 60 ? 5.2 : 6.5);
    if (mobile) closeAll();
  };
  const selectAll = () => {
    select(a.unitIds);
    focusOn(a.at, 6.5);
    closeAll();
  };
  const move = () => {
    select(mobileUnits.map((u) => u.id));
    focusOn(a.at, 6);
    closeAll();
    toast(t('armies.moveHint', { name }), 'info');
  };
  const run = (order: Order, ok: string) => void send(order, ok);

  const facts: {
    label: ReactNode;
    value: ReactNode;
    tone?: 'amber' | 'green' | 'red' | 'cyan' | 'dim';
  }[] = [
    {
      label: t('armies.cols.location'),
      value:
        location?.province && location.province !== location.city
          ? `${locLabel} · ${location.province}`
          : locLabel,
    },
    {
      label: t('armies.cols.orders'),
      value: orderLabel,
      tone: a.order.kind === 'attack' ? 'red' : a.order.kind === 'move' ? 'cyan' : undefined,
    },
    { label: t('armies.cols.general'), value: general ?? '—', tone: general ? undefined : 'dim' },
    {
      label: t('armies.cols.strength'),
      value: `${t('armies.elements', { count: a.elements })} · ${t('armies.piles', { count: a.piles })}`,
    },
    {
      label: t('armies.supply'),
      value: a.supply ? t(`army.supplyState.${a.supply}`) : '—',
      tone: a.supply === 'cut' ? 'red' : a.supply === 'limited' ? 'amber' : 'green',
    },
    {
      label: t('armies.veterancy'),
      value: a.veterancy ? '★'.repeat(a.veterancy) : '—',
      tone: a.veterancy ? 'amber' : 'dim',
    },
    { label: t('armies.kpi.value'), value: formatMoney(a.value), tone: 'amber' },
  ];

  return (
    <section className="armydetail" aria-label={name} data-testid="army-detail">
      {mobile ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="chevronLeft" size={13} />}
          onClick={onBack}
        >
          {t('armies.back')}
        </Button>
      ) : null}
      <header className="armydetail__head">
        {editing ? (
          <form
            className="armydetail__rename"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(draft);
              setEditing(false);
            }}
          >
            <Input
              autoFocus
              value={draft}
              maxLength={40}
              aria-label={t('armies.rename')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <Button size="sm" type="submit" variant="primary">
              {t('armies.save')}
            </Button>
          </form>
        ) : (
          <>
            <h3 className="armydetail__name">{name}</h3>
            <IconButton
              size="sm"
              label={t('armies.rename')}
              icon={<Icon name="edit" size={13} />}
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
            />
          </>
        )}
        <span className="grow" />
        <StateBadge state={a.state} />
      </header>
      <div className="armydetail__hp">
        <span>{t('armies.cols.hp')}</span>
        <Gauge value={a.hp} tone="auto" cells={16} label={t('armies.cols.hp')} />
      </div>
      <KeyValue items={facts} />
      <div className="armydetail__actions">
        <Button
          size="sm"
          icon={<Icon name="target" size={12} />}
          onClick={center}
          data-testid="army-center"
        >
          {t('armies.actions.center')}
        </Button>
        <Button size="sm" icon={<Icon name="army" size={12} />} onClick={selectAll}>
          {t('armies.actions.select')}
        </Button>
        <Button
          size="sm"
          icon={<Icon name="arrowRight" size={12} />}
          onClick={move}
          disabled={!mobileUnits.length}
        >
          {t('armies.actions.move')}
        </Button>
        {busy ? (
          <Button
            size="sm"
            icon={<Icon name="stop" size={12} />}
            onClick={() => run({ kind: 'stop', unitIds: a.unitIds }, t('armies.done.stop'))}
          >
            {t('armies.actions.stop')}
          </Button>
        ) : null}
        {flyers.length ? (
          <>
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="radio" size={12} />}
              onClick={() =>
                run(
                  { kind: 'patrol', unitIds: flyers.map((u) => u.id), at: a.at, radiusKm: 80 },
                  t('armies.done.patrol'),
                )
              }
            >
              {t('armies.actions.patrol')}
            </Button>
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="home" size={12} />}
              onClick={() =>
                run({ kind: 'rtb', unitIds: flyers.map((u) => u.id) }, t('armies.done.rtb'))
              }
            >
              {t('army.rtb')}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="subtle"
          icon={<Icon name="plus" size={12} />}
          disabled={!merges.length}
          title={merges.length ? undefined : t('armies.mergeNone')}
          onClick={() => {
            for (const ids of merges) run({ kind: 'merge', unitIds: ids }, t('armies.done.merge'));
          }}
        >
          {t('armies.actions.merge')}
        </Button>
      </div>
      <h4 className="armydetail__title">
        {t('armies.composition')} <span>{a.piles}</span>
      </h4>
      <ul className="armydetail__piles">
        {a.units.map((u) => (
          <PileRow
            key={u.id}
            u={u}
            meId={me}
            onSheet={() => u.systemId && openSheet(u.systemId, u.id)}
            onSelect={() => {
              select([u.id]);
              closeAll();
            }}
            onSplit={() => {
              const o = splitHalfOrder(u);
              if (o) run(o, t('armies.done.split'));
            }}
            onSplitType={() => {
              const o = splitByTypeOrder(u);
              if (o) run(o, t('armies.done.split'));
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function PileRow({
  u,
  meId,
  onSheet,
  onSelect,
  onSplit,
  onSplitType,
}: {
  u: UnitView;
  meId: string | null;
  onSheet: () => void;
  onSelect: () => void;
  onSplit: () => void;
  onSplitType: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const s = u.systemId ? catalog[u.systemId] : undefined;
  const canSplit =
    (u.count ?? 1) >= 2 && pileDomain(u, catalog) !== 'static' && u.status !== 'embarked';
  return (
    <li className="pilerow">
      <UnitMarker
        pictogram={pictogramFor(s)}
        nationId={meId ?? undefined}
        tone="own"
        size="sm"
        health={u.hpRatio}
      />
      <span className="pilerow__name">
        <b>
          {s?.name ?? u.systemId}
          {isMixed(u) ? (
            <span className="muted"> {t('stacks.more', { count: stackParts(u).length - 1 })}</span>
          ) : null}
        </b>
        <span>
          {u.id} · {formatInt(u.count ?? 1)}{' '}
          {isMixed(u) ? t('stacks.elements') : (s?.unitLabel ?? t('arsenal.elements'))} ·{' '}
          {t(`game.status.${u.status ?? 'idle'}`)}
          {u.veterancy ? ` · ${'★'.repeat(u.veterancy)}` : ''}
        </span>
      </span>
      <span className="pilerow__hp">
        <Gauge value={u.hpRatio ?? 1} tone="auto" cells={6} label={t('armies.cols.hp')} />
      </span>
      <span className="pilerow__actions">
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="encyclopedia" size={12} />}
          onClick={onSheet}
          disabled={!s}
          data-testid="pile-sheet"
        >
          {t('game.selection.sheet')}
        </Button>
        <IconButton
          size="sm"
          label={t('armies.actions.split')}
          icon={<Icon name="minus" size={12} />}
          onClick={onSplit}
          disabled={!canSplit}
        />
        {isMixed(u) ? (
          <IconButton
            size="sm"
            label={t('stacks.byType')}
            icon={<Icon name="filter" size={12} />}
            onClick={onSplitType}
          />
        ) : null}
        <IconButton
          size="sm"
          label={t('armies.actions.selectPile')}
          icon={<Icon name="target" size={12} />}
          onClick={onSelect}
        />
      </span>
    </li>
  );
}

/** « Mes armées » : armées sur la carte (vue d'ensemble et gestion), généraux, opérations. */
export function ArmiesWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const [tab, setTab] = useState<Tab>((win.params.tab as Tab) ?? 'armies');
  useEffect(() => {
    if (win.params.tab) setTab(win.params.tab as Tab);
  }, [win.seq, win.params.tab]);
  const count = useMemo(
    () => groupArmies(ownPiles(view, me), catalog, view?.time ?? 0, view).length,
    [view, me, catalog],
  );
  return (
    <Window
      {...frame}
      path={[t('sections.path.armies'), t(`armies.tabs.${tab}`)]}
      flush={tab === 'armies'}
      tabs={
        <Tabs
          label={t('sections.armies')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'armies',
              label: t('armies.tabs.armies'),
              count,
              icon: <Icon name="army" size={13} />,
            },
            {
              id: 'generals',
              label: t('armies.tabs.generals'),
              count: view?.generals?.length ?? 0,
              icon: <Icon name="user" size={13} />,
            },
            {
              id: 'operations',
              label: t('armies.tabs.operations'),
              count:
                view?.operations?.filter((o) => o.status === 'planned' || o.status === 'running')
                  .length ?? 0,
              icon: <Icon name="clock" size={13} />,
            },
          ]}
        />
      }
    >
      {tab === 'armies' ? (
        <Armies mobile={mobile} />
      ) : tab === 'generals' ? (
        <Generals />
      ) : (
        <Operations />
      )}
    </Window>
  );
}
