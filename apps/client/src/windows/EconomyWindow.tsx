import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RESOURCES,
  type MarketOffer,
  type Order,
  type Resource,
  type TradeItem,
  type WeaponSystem,
} from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Field,
  Icon,
  Input,
  Money,
  Panel,
  ProgressBar,
  SearchInput,
  Segmented,
  Select,
  Sparkline,
  Stat,
  Table,
  Tabs,
  Toggle,
  WeaponPhoto,
  Window,
  formatCompact,
  formatMoney,
  formatNumber,
  formatPct,
} from '@redline/ui';
import { NationTag, Treasury } from '../components/Common.js';
import { BuildingRow } from '../components/Buildings.js';
import { constructionSites, economySummary, ledgerRows, resourceFlows } from '../lib/economy.js';
import { norm } from '../lib/commands.js';
import { provinceName } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { RESOURCE_ICON } from '../shell/TopBar.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError } from '../lib/loc.js';
import { DomesticTab } from './DomesticTab.js';

type Tab =
  | 'dashboard'
  | 'resources'
  | 'buildings'
  | 'market'
  | 'deliveries'
  | 'black'
  | 'logistics'
  | 'interior';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res)
      toast(orderError(res), 'error');
  };
}

function ItemLabel({ item }: { item: TradeItem }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  switch (item.type) {
    case 'resource':
      return (
        <span className="titem">
          <span className="titem__icon">
            <Icon name={RESOURCE_ICON[item.resource]} size={14} />
          </span>
          {formatCompact(item.qty)} {t(`game.resources.${item.resource}`).toLowerCase()}
        </span>
      );
    case 'money':
      return <span className="titem">{formatMoney(item.amount)}</span>;
    case 'units': {
      const s = catalog[item.systemId];
      return (
        <span className="titem">
          {s ? <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" /> : null}
          <span>
            {item.count} × <b>{s?.name ?? item.systemId}</b>
          </span>
        </span>
      );
    }
    case 'licence': {
      const s = catalog[item.systemId];
      return (
        <span className="titem">
          <span className="titem__icon">
            <Icon name="document" size={14} />
          </span>
          {t('economy.licenceOf', { name: s?.name ?? item.systemId })}
        </span>
      );
    }
  }
}

function FlowRow({ label, amount, max }: { label: string; amount: number; max: number }) {
  const out = amount < 0;
  return (
    <li>
      <span className="flows__label" title={label}>
        {label}
      </span>
      <span className="flows__bar">
        <span
          className={out ? 'flows__fill flows__fill--out' : 'flows__fill flows__fill--in'}
          style={{ width: `${Math.min(100, (Math.abs(amount) / max) * 100)}%` }}
        />
      </span>
      <span className={out ? 'flows__value rl-tone-red' : 'flows__value rl-tone-green'}>
        {formatMoney(amount, { signed: true })}
      </span>
    </li>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const focusOn = useUi((s) => s.focusOn);
  const selectProvince = useUi((s) => s.selectProvince);
  const defs = useWorld((s) => s.provinces);
  const now = useGameTime(2000);
  const [allProv, setAllProv] = useState(false);
  const sum = economySummary(view);
  const eco = view?.economy;
  const unlimited = !!eco?.unlimited;
  const d = sum.detail;
  const sites = constructionSites(view, now);
  const maxFlow = Math.max(
    1,
    ...sum.income.map((x) => Math.abs(x.amount)),
    ...sum.upkeep.map((x) => x.amount),
    sum.intel,
  );
  const useToday = !d?.lastDay || !Object.keys(d.lastDay).length;
  const ledger = ledgerRows(useToday ? d?.today : d?.lastDay);
  const ledgerMax = Math.max(1, ...ledger.map((x) => Math.abs(x.amount)));
  const provinces = [...(d?.provinces ?? [])].sort((a, b) => b.income - a.income);
  return (
    <div className="vstack">
      <div className="kpis">
        <Stat
          label={t('economy.treasury')}
          value={<Treasury value={eco?.money ?? 0} unlimited={unlimited} />}
          tone="amber"
          sub={
            unlimited
              ? t('game.unlimited.reserve')
              : d
                ? t('economy.forecast', {
                    d7: formatMoney(d.forecast.money7d),
                    d30: formatMoney(d.forecast.money30d),
                  })
                : null
          }
        />
        <Stat
          label={t('economy.annualBudget')}
          value={d?.budgetUsdPerYear ? formatMoney(d.budgetUsdPerYear) : '—'}
          sub={t('economy.budgetSource')}
        />
        <Stat
          label={t('economy.income')}
          value={formatMoney(sum.totalIncome, { signed: true })}
          tone="green"
          sub={t('economy.perDay')}
        />
        <Stat
          label={t('economy.expenses')}
          value={formatMoney(-sum.totalExpenses)}
          tone="red"
          sub={t('economy.perDay')}
        />
        <Stat
          label={t('economy.balance')}
          value={formatMoney(sum.balance, { signed: true })}
          tone={sum.balance >= 0 ? 'green' : 'red'}
          sub={
            sum.balance < 0 && eco && !unlimited
              ? t('economy.runway', { days: Math.max(0, Math.floor(eco.money / -sum.balance)) })
              : t('economy.perDay')
          }
        />
      </div>
      {sum.balance < 0 && eco && !unlimited && eco.money / -sum.balance < 30 ? (
        <p className="hint hint--warn">
          <Icon name="warning" size={13} /> {t('economy.deficitHint')}
        </p>
      ) : null}
      <div className="cols2">
        <Panel title={t('economy.incomeDetail')} meta={formatMoney(sum.totalIncome)}>
          <ul className="flows">
            {sum.income.map((x) => (
              <FlowRow
                key={x.key}
                label={t(`economy.incomeKeys.${x.key}`)}
                amount={x.amount}
                max={maxFlow}
              />
            ))}
          </ul>
        </Panel>
        <Panel title={t('economy.expenseDetail')} meta={formatMoney(sum.totalExpenses)}>
          <ul className="flows">
            {sum.upkeep.map((x) => (
              <FlowRow
                key={x.key}
                label={t(`categories.${x.key}`, { defaultValue: x.key })}
                amount={-x.amount}
                max={maxFlow}
              />
            ))}
            {sum.intel > 0 ? (
              <FlowRow label={t('economy.intelBudget')} amount={-sum.intel} max={maxFlow} />
            ) : null}
          </ul>
          {d?.upkeepAdjust && d.upkeepAdjust.catalog > 0 ? (
            <p className="muted small" title={t('economy.upkeepAdjustedHelp')}>
              {t('economy.upkeepAdjusted', {
                factor: formatNumber(d.upkeepAdjust.factor, 2),
                catalog: formatMoney(d.upkeepAdjust.catalog),
                index: formatNumber(d.upkeepAdjust.costIndex, 2),
              })}
            </p>
          ) : null}
        </Panel>
      </div>
      {d ? (
        <Panel
          title={useToday ? t('economy.ledgerToday') : t('economy.ledgerTitle')}
          meta={t('economy.tradeBalance', {
            value: formatMoney(d.tradeBalance, { signed: true }),
          })}
        >
          {ledger.length ? (
            <ul className="flows">
              {ledger.map((x) => (
                <FlowRow
                  key={x.key}
                  label={t(`economy.ledger.${x.key}`)}
                  amount={x.amount}
                  max={ledgerMax}
                />
              ))}
            </ul>
          ) : (
            <p className="muted small">{t('economy.ledgerEmpty')}</p>
          )}
        </Panel>
      ) : null}
      <Panel title={t('economy.construction')} meta={String(sites.length)} flush>
        {sites.length ? (
          <Table
            label={t('economy.construction')}
            rows={sites}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'b',
                header: t('economy.cols.building'),
                render: (c) => <b>{t(`buildings.${c.building}`)}</b>,
              },
              {
                key: 'p',
                header: t('economy.cols.province'),
                render: (c) => provinceName(c.provinceId),
              },
              {
                key: 'k',
                header: t('economy.cols.work'),
                render: (c) => (
                  <Badge tone={c.kind === 'repair' ? 'amber' : 'cyan'}>
                    {t(`economy.work.${c.kind}`, { level: c.level })}
                  </Badge>
                ),
              },
              {
                key: 'e',
                header: t('economy.cols.eta'),
                align: 'right',
                render: (c) => <Countdown ms={c.completesAt - now} dayUnit={t('time.dayUnit')} />,
              },
            ]}
          />
        ) : (
          <EmptyState
            compact
            icon="building"
            title={t('economy.noConstruction')}
            text={t('economy.constructionHint')}
          />
        )}
      </Panel>
      {d && provinces.length ? (
        <Panel
          title={t('economy.provincesTitle')}
          meta={t('economy.populationMorale', {
            pop: formatCompact(d.population),
            morale: formatNumber(d.morale, 0),
          })}
          flush
        >
          <Table
            label={t('economy.provincesTitle')}
            rows={allProv ? provinces : provinces.slice(0, 8)}
            rowKey={(p) => p.id}
            onRowClick={(p) => {
              selectProvince(p.id);
              const def = defs[p.id];
              if (def) focusOn(def.cityPoint, 6.5);
            }}
            columns={[
              {
                key: 'n',
                header: t('economy.cols.province'),
                render: (p) => <b>{provinceName(p.id)}</b>,
              },
              {
                key: 'pop',
                header: t('economy.cols.population'),
                align: 'right',
                hideOnMobile: true,
                render: (p) => formatCompact(p.population),
              },
              {
                key: 'm',
                header: t('economy.cols.morale'),
                width: '22%',
                hideOnMobile: true,
                render: (p) => (
                  <ProgressBar
                    value={p.morale / 100}
                    tone="auto"
                    size="xs"
                    trailing={formatNumber(p.morale, 0)}
                    label={t('economy.cols.morale')}
                  />
                ),
              },
              {
                key: 'i',
                header: t('economy.cols.income'),
                align: 'right',
                render: (p) => (
                  <span className="rl-tone-green">{formatMoney(p.income, { signed: true })}</span>
                ),
              },
            ]}
          />
          {provinces.length > 8 ? (
            <div className="win-pad win-pad--tight">
              <Button size="sm" variant="ghost" onClick={() => setAllProv(!allProv)}>
                {allProv
                  ? t('economy.showLess')
                  : t('economy.showAll', { count: provinces.length })}
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

function Resources() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const flows = resourceFlows(view);
  // Mode illimité : stocks « ∞ », jamais de pénurie.
  const unlimited = !!view?.economy.unlimited;
  return (
    <div className="vstack">
      <Table
        label={t('economy.tabs.resources')}
        rows={[...RESOURCES]}
        rowKey={(r) => r}
        columns={[
          {
            key: 'name',
            header: t('economy.cols.resource'),
            render: (r: Resource) => (
              <span className="titem">
                <span
                  className={
                    flows[r].shortage && !unlimited ? 'titem__icon titem__icon--red' : 'titem__icon'
                  }
                >
                  <Icon name={RESOURCE_ICON[r]} size={14} />
                </span>
                <b>{t(`game.resources.${r}`)}</b>
                {flows[r].shortage && !unlimited ? (
                  <Badge tone="red">{t('economy.shortage')}</Badge>
                ) : null}
              </span>
            ),
          },
          {
            key: 'stock',
            header: t('economy.cols.stock'),
            align: 'right',
            render: (r) =>
              unlimited ? (
                <b className="rl-tone-amber">{t('game.unlimited.value')}</b>
              ) : (
                formatNumber(flows[r].stock, 0)
              ),
            sort: (a, b) => flows[a].stock - flows[b].stock,
          },
          {
            key: 'prod',
            header: t('economy.cols.production'),
            align: 'right',
            render: (r) => (
              <span className="rl-tone-green">+{formatNumber(flows[r].production, 0)}</span>
            ),
          },
          {
            key: 'cons',
            header: t('economy.cols.consumption'),
            align: 'right',
            hideOnMobile: true,
            render: (r) => (
              <span className="rl-tone-red">−{formatNumber(flows[r].consumption, 0)}</span>
            ),
          },
          {
            key: 'net',
            header: t('economy.cols.net'),
            align: 'right',
            render: (r) => {
              const n = flows[r].net;
              return (
                <b
                  className={n >= 0 ? 'rl-tone-green' : 'rl-tone-amber'}
                >{`${n >= 0 ? '+' : '−'}${formatNumber(Math.abs(n), 0)}`}</b>
              );
            },
          },
          {
            key: 'days',
            header: t('economy.cols.autonomy'),
            align: 'right',
            hideOnMobile: true,
            render: (r) => {
              const dl = unlimited ? null : flows[r].daysLeft;
              return dl === null ? (
                <span className="muted">∞</span>
              ) : (
                <span className={dl < 7 ? 'rl-tone-red' : 'rl-tone-amber'}>
                  {t('economy.days', { count: Math.floor(dl) })}
                </span>
              );
            },
          },
        ]}
      />
      <p className="hint">{t('economy.resourcesHint')}</p>
    </div>
  );
}

function Buildings() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const defs = useWorld((s) => s.provinces);
  const focusOn = useUi((s) => s.focusOn);
  const selectProvince = useUi((s) => s.selectProvince);
  const now = useGameTime(3000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'damaged' | 'works'>('all');
  const provinces = useMemo(
    () =>
      Object.values(view?.provinces ?? {})
        .filter((p) => p.owner === me)
        .filter((p) => !q || norm(provinceName(p.id)).includes(norm(q)))
        .filter((p) =>
          filter === 'all'
            ? true
            : filter === 'damaged'
              ? (p.buildingState ?? []).some((b) => b.health < 1)
              : (p.buildingState ?? []).some(
                  (b) => (b.upgradeUntil ?? 0) > now || (b.repairUntil ?? 0) > now,
                ),
        )
        .sort(
          (a, b) =>
            Number(!!defs[b.id]?.isCapital) - Number(!!defs[a.id]?.isCapital) ||
            (b.buildingState?.length ?? 0) - (a.buildingState?.length ?? 0),
        ),
    [view?.provinces, me, q, filter, defs, now],
  );
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Object.values(view?.provinces ?? {}))
      if (p.owner === me)
        for (const b of p.buildingState ?? p.buildings.map((type) => ({ type })))
          m.set(b.type, (m.get(b.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [view?.provinces, me]);
  return (
    <div className="vstack">
      <div className="chips">
        {totals.map(([type, n]) => (
          <span key={type} className="chip">
            {t(`buildings.${type}`)} <b>{n}</b>
          </span>
        ))}
      </div>
      <div className="row">
        <SearchInput
          value={q}
          onChange={setQ}
          label={t('app.search')}
          placeholder={t('economy.searchProvince')}
          className="grow"
        />
        <Segmented
          size="sm"
          label={t('economy.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('app.all') },
            { value: 'damaged', label: t('economy.damaged') },
            { value: 'works', label: t('economy.works') },
          ]}
        />
      </div>
      {provinces.slice(0, 40).map((p) => (
        <section key={p.id} className="provblock">
          <header>
            <button
              type="button"
              onClick={() => {
                selectProvince(p.id);
                const d = defs[p.id];
                if (d) focusOn(d.cityPoint, 6.5);
              }}
            >
              <Icon name="mapPin" size={13} />
              <b>{provinceName(p.id)}</b>
              {defs[p.id]?.isCapital ? (
                <Badge tone="amber">{t('game.callout.capital')}</Badge>
              ) : null}
            </button>
            <span className="muted small">
              {t('economy.buildingsCount', {
                count: p.buildingState?.length ?? p.buildings.length,
              })}
            </span>
          </header>
          <ul className="bldgs">
            {(p.buildingState ?? p.buildings.map((type) => ({ type, level: 1, health: 1 }))).map(
              (b) => (
                <BuildingRow key={b.type} provinceId={p.id} b={b} now={now} editable compact />
              ),
            )}
          </ul>
        </section>
      ))}
      {!provinces.length ? (
        <EmptyState compact icon="building" title={t('economy.noProvince')} />
      ) : null}
    </div>
  );
}

function Market() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const send = useSend();
  const now = useGameTime(5000);
  const [kind, setKind] = useState<'all' | TradeItem['type']>('all');
  const [res, setRes] = useState<Resource>('oil');
  const [qty, setQty] = useState('1000');
  const [price, setPrice] = useState('50');
  const offers = (view?.market?.offers ?? []).filter((o) => kind === 'all' || o.item.type === kind);
  return (
    <div className="vstack">
      <div className="row row--between">
        <Segmented
          size="sm"
          label={t('economy.filter')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('app.all') },
            { value: 'units', label: t('economy.items.units') },
            { value: 'resource', label: t('economy.items.resource') },
            { value: 'licence', label: t('economy.items.licence') },
          ]}
        />
        {view?.market?.embargoed.includes(me ?? '') ? (
          <Badge tone="red">{t('economy.embargoed')}</Badge>
        ) : null}
      </div>
      <Table
        label={t('economy.tabs.market')}
        rows={offers}
        rowKey={(o) => o.id}
        empty={<EmptyState compact icon="market" title={t('economy.noOffers')} />}
        columns={[
          {
            key: 'seller',
            header: t('economy.cols.seller'),
            render: (o: MarketOffer) => <NationTag id={o.seller} />,
          },
          {
            key: 'item',
            header: t('economy.cols.item'),
            render: (o) => <ItemLabel item={o.item} />,
          },
          {
            key: 'to',
            header: '',
            render: (o) =>
              o.to ? (
                <Badge tone="violet" variant="outline">
                  {t('economy.reserved')}
                </Badge>
              ) : null,
            hideOnMobile: true,
          },
          {
            key: 'price',
            header: t('economy.cols.price'),
            align: 'right',
            render: (o) => <Money value={o.price} />,
            sort: (a, b) => a.price - b.price,
          },
          {
            key: 'exp',
            header: t('economy.cols.expires'),
            align: 'right',
            hideOnMobile: true,
            render: (o) => <Countdown ms={o.expiresAt - now} dayUnit={t('time.dayUnit')} />,
          },
          {
            key: 'act',
            header: '',
            align: 'right',
            render: (o) =>
              o.seller === me ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void send({ kind: 'cancelOffer', offerId: o.id }, t('economy.offerCancelled'))
                  }
                >
                  {t('economy.withdraw')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={(view?.economy.money ?? 0) < o.price}
                  onClick={() =>
                    void send({ kind: 'acceptOffer', offerId: o.id }, t('economy.bought'))
                  }
                >
                  {t('economy.buy')}
                </Button>
              ),
          },
        ]}
      />
      <Panel title={t('economy.sell')}>
        <div className="sellform">
          <Field label={t('economy.cols.resource')}>
            <Select
              value={res}
              onChange={setRes}
              options={RESOURCES.map((r) => ({ value: r, label: t(`game.resources.${r}`) }))}
            />
          </Field>
          <Field label={t('economy.quantity')}>
            <Input
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label={t('economy.priceM')}>
            <Input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ''))}
            />
          </Field>
          <Button
            variant="primary"
            icon={<Icon name="send" size={13} />}
            disabled={!Number(qty) || !Number(price.replace(',', '.'))}
            onClick={() =>
              void send(
                {
                  kind: 'sellOffer',
                  item: { type: 'resource', resource: res, qty: Number(qty) },
                  price: Number(price.replace(',', '.')) * 1e6,
                  to: null,
                },
                t('economy.offerPosted'),
              )
            }
          >
            {t('economy.post')}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Deliveries() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const focusOn = useUi((s) => s.focusOn);
  const now = useGameTime(2000);
  const list = view?.market?.deliveries ?? [];
  return (
    <Table
      label={t('economy.tabs.deliveries')}
      rows={list}
      rowKey={(d) => d.id}
      empty={<EmptyState compact icon="truck" title={t('economy.noDeliveries')} />}
      columns={[
        {
          key: 'from',
          header: t('economy.cols.from'),
          render: (d) =>
            d.from === 'xxx' ? (
              <span className="muted">{t('economy.unknownSeller')}</span>
            ) : (
              <NationTag id={d.from} />
            ),
        },
        { key: 'item', header: t('economy.cols.item'), render: (d) => <ItemLabel item={d.item} /> },
        {
          key: 'cov',
          header: '',
          render: (d) =>
            d.covert ? (
              <Badge tone="amber" variant="outline">
                {t('economy.covert')}
              </Badge>
            ) : (
              <Badge tone="neutral">{t('economy.official')}</Badge>
            ),
          hideOnMobile: true,
        },
        {
          key: 'eta',
          header: t('economy.cols.eta'),
          align: 'right',
          render: (d) => <Countdown ms={d.eta - now} dayUnit={t('time.dayUnit')} />,
          sort: (a, b) => a.eta - b.eta,
        },
        {
          key: 'act',
          header: '',
          align: 'right',
          render: (d) => {
            const u = d.carrierUnitId ? view?.units[d.carrierUnitId] : null;
            return u ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="mapPin" size={12} />}
                onClick={() => focusOn(u.pos, 6)}
              >
                {t('economy.track')}
              </Button>
            ) : null;
          },
        },
      ]}
    />
  );
}

function BlackMarket() {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const balance = useWorld((s) => s.balance);
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const photos = usePhotos();
  const send = useSend();
  const [q, setQ] = useState('');
  const factor = balance?.blackMarket?.priceFactor ?? 2.5;
  const risk = balance?.blackMarket?.detectionChance ?? 0.25;
  const list = Object.values(catalog)
    .filter(
      (s: WeaponSystem) =>
        s.enabled !== false &&
        [
          'drone',
          'air_defense',
          'strike_missile',
          'tank',
          'helicopter',
          'artillery',
          'infantry',
        ].includes(s.category),
    )
    .filter((s) => !q || norm(s.name).includes(norm(q)))
    .sort((a, b) => a.cost.money - b.cost.money)
    .slice(0, 40);
  return (
    <div className="vstack">
      <div className="blackwarn">
        <Icon name="warning" size={16} />
        <div>
          <b>{t('economy.blackTitle')}</b>
          <p>
            {t('economy.blackText', { factor: formatNumber(factor, 1), risk: formatPct(risk) })}
          </p>
        </div>
      </div>
      <SearchInput
        value={q}
        onChange={setQ}
        label={t('app.search')}
        placeholder={t('arsenal.search')}
      />
      <Table
        label={t('economy.tabs.black')}
        rows={list}
        rowKey={(s) => s.id}
        columns={[
          {
            key: 'p',
            header: '',
            width: '64px',
            render: (s) => <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" />,
          },
          { key: 'n', header: t('arsenal.cols.name'), render: (s) => <b>{s.name}</b> },
          {
            key: 'c',
            header: t('arsenal.cols.category'),
            render: (s) => t(`categories.${s.category}`),
            hideOnMobile: true,
          },
          {
            key: 'pr',
            header: t('economy.cols.price'),
            align: 'right',
            render: (s) => <Money value={s.cost.money * factor} />,
          },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (s) => (
              <Button
                size="sm"
                variant="danger"
                disabled={money < s.cost.money * factor}
                onClick={() =>
                  void send(
                    { kind: 'blackMarket', systemId: s.id, count: 1 },
                    t('production.blackMarketOrdered'),
                  )
                }
              >
                {t('economy.buy')}
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

function Logistics() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const balance = useWorld((s) => s.balance);
  const focusOn = useUi((s) => s.focusOn);
  const send = useSend();
  const now = useGameTime(5000);
  const log = view?.logistics;
  const own = Object.values(view?.units ?? {}).filter((u) => u.owner === me && u.level === 'own');
  const supply = { supplied: 0, limited: 0, cut: 0 };
  for (const u of own) if (u.supply) supply[u.supply]++;
  const mob = balance?.mobilization;
  return (
    <div className="vstack">
      <Panel title={t('economy.mobilization')} accent={log?.mobilized ? 'amber' : undefined}>
        <div className="mob">
          <Toggle
            checked={!!log?.mobilized}
            onChange={(on) =>
              void send(
                { kind: 'mobilize', on },
                t(on ? 'console.done.mobilizeOn' : 'console.done.mobilizeOff'),
              )
            }
            label={log?.mobilized ? t('economy.mobilized') : t('economy.notMobilized')}
            description={t('economy.mobilizeHelp', {
              inf: mob?.infantryPerProvince ?? 1,
              penalty: formatPct(mob?.incomePenalty ?? 0.25),
              stab: mob?.stabilityPerDay ?? -1,
            })}
          />
          {log?.mobilizedSince ? (
            <span className="muted small">
              {t('economy.since', { value: Math.round((now - log.mobilizedSince) / 3_600_000) })}
            </span>
          ) : null}
        </div>
      </Panel>
      <div className="cols3">
        <Stat label={t('army.supply.supplied')} value={supply.supplied} tone="green" />
        <Stat label={t('army.supply.limited')} value={supply.limited} tone="amber" />
        <Stat label={t('army.supply.cut')} value={supply.cut} tone="red" />
      </div>
      <Panel title={t('economy.depots')} meta={String(log?.depots.length ?? 0)} flush>
        <Table
          label={t('economy.depots')}
          rows={log?.depots ?? []}
          rowKey={(d) => d.id}
          empty={<EmptyState compact icon="box" title={t('economy.noDepots')} />}
          columns={[
            {
              key: 'p',
              header: t('economy.cols.province'),
              render: (d) => <b>{provinceName(d.provinceId)}</b>,
            },
            {
              key: 'r',
              header: t('economy.cols.range'),
              align: 'right',
              render: (d) => <span className="rl-tone-amber">{d.rangeKm} km</span>,
            },
            {
              key: 'a',
              header: '',
              align: 'right',
              render: (d) => (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="mapPin" size={12} />}
                  onClick={() => focusOn(d.at, 6)}
                >
                  {t('economy.show')}
                </Button>
              ),
            },
          ]}
        />
      </Panel>
      {view?.blockades?.length ? (
        <Panel title={t('economy.blockades')} accent="red">
          <ul className="plainlist">
            {view.blockades.map((b) => (
              <li key={b.id}>
                <NationTag id={b.by} /> →{' '}
                {'provinceId' in b.target ? provinceName(b.target.provinceId) : b.target.straitId}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** Économie : tableau de bord, ressources, bâtiments, marché, livraisons, marché noir, logistique. */
export function EconomyWindow({ win, frame }: WindowContentProps) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const [tab, setTab] = useState<Tab>((win.params.tab as Tab) ?? 'dashboard');
  useEffect(() => {
    if (win.params.tab) setTab(win.params.tab as Tab);
  }, [win.seq, win.params.tab]);
  const tabs: { id: Tab; icon: Parameters<typeof Icon>[0]['name']; count?: number }[] = [
    { id: 'dashboard', icon: 'economy' },
    { id: 'resources', icon: 'oil' },
    { id: 'buildings', icon: 'building' },
    { id: 'market', icon: 'market', count: view?.market?.offers.length },
    { id: 'deliveries', icon: 'truck', count: view?.market?.deliveries.length },
    { id: 'black', icon: 'spy' },
    { id: 'logistics', icon: 'box' },
    {
      id: 'interior',
      icon: 'shield',
      count: view?.domestic?.policies.filter((p) => p.active).length,
    },
  ];
  return (
    <Window
      {...frame}
      path={[t('sections.path.economy'), t(`economy.tabs.${tab}`)]}
      tabs={
        <Tabs
          label={t('sections.economy')}
          value={tab}
          onChange={setTab}
          tabs={tabs.map((x) => ({
            id: x.id,
            label: t(`economy.tabs.${x.id}`),
            icon: <Icon name={x.icon} size={13} />,
            count: x.count,
          }))}
        />
      }
      headerExtra={
        <span className="win-meta">
          <span>{t('economy.treasury')}</span>{' '}
          <Treasury value={view?.economy.money ?? 0} unlimited={view?.economy.unlimited} />
        </span>
      }
    >
      {tab === 'dashboard' ? <Dashboard /> : null}
      {tab === 'resources' ? <Resources /> : null}
      {tab === 'buildings' ? <Buildings /> : null}
      {tab === 'market' ? <Market /> : null}
      {tab === 'deliveries' ? <Deliveries /> : null}
      {tab === 'black' ? <BlackMarket /> : null}
      {tab === 'logistics' ? <Logistics /> : null}
      {tab === 'interior' ? <DomesticTab /> : null}
    </Window>
  );
}
