import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Category } from '@redline/shared';
import {
  Button,
  EmptyState,
  Gauge,
  Icon,
  SearchInput,
  Stat,
  Table,
  Tabs,
  Window,
  WeaponPhoto,
  formatInt,
  formatMoney,
} from '@redline/ui';
import { ArsenalBrowser, CategoryNav } from '../components/ArsenalBrowser.js';
import { inventory, type InventoryRow } from '../lib/armies.js';
import {
  NAV_CATEGORIES,
  readCategory,
  writeCategory,
  type CategoryFilter,
} from '../lib/arsenal.js';
import { norm } from '../lib/commands.js';
import { totalUpkeep } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

const CATEGORY_KEY = 'inventory';

type Tab = 'inventory' | 'catalog';

/**
 * Arsenal de guerre : inventaire du matériel possédé (onglet « Inventaire ») et catalogue complet
 * des matériels par catégorie, avec photos et fiches (onglet « Catalogue », ex-Encyclopédie).
 * La gestion des groupes sur la carte est dans « Mes armées ».
 */
export function ArmyWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const spectator = useGame((s) => !!s.view?.spectator);
  const [tab, setTab] = useState<Tab>(
    spectator ? 'catalog' : ((win.params.tab as Tab | undefined) ?? 'inventory'),
  );
  useEffect(() => {
    if (win.params.tab) setTab(win.params.tab as Tab);
  }, [win.seq, win.params.tab]);
  const cur: Tab = spectator ? 'catalog' : tab;
  return (
    <Window
      {...frame}
      path={[t('sections.path.army'), t(`inventory.tabs.${cur}`)]}
      flush
      tabs={
        <Tabs
          label={t('sections.army')}
          value={cur}
          onChange={setTab}
          tabs={[
            ...(spectator
              ? []
              : [
                  {
                    id: 'inventory' as Tab,
                    label: t('inventory.tabs.inventory'),
                    icon: <Icon name="army" size={13} />,
                  },
                ]),
            {
              id: 'catalog' as Tab,
              label: t('inventory.tabs.catalog'),
              icon: <Icon name="encyclopedia" size={13} />,
            },
          ]}
        />
      }
    >
      {cur === 'inventory' ? (
        <Inventory mobile={mobile} />
      ) : (
        <ArsenalBrowser mode="encyclopedia" mobile={mobile} initialSystemId={win.params.systemId} />
      )}
    </Window>
  );
}

/** Inventaire : nombre, valeur en dollars, disponibilité, en production, pertes par matériel. */
function Inventory({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  const openSheet = useUi((s) => s.openSheet);
  const openWindow = useUi((s) => s.openWindow);
  const now = useGameTime(5000);
  const [category, setCategory] = useState<CategoryFilter>(
    () => readCategory(CATEGORY_KEY) ?? 'all',
  );
  const [q, setQ] = useState('');

  const rows = useMemo(() => inventory(view, me, catalog, now), [view, me, catalog, now]);
  const totals = useMemo(() => {
    const s = {
      elements: 0,
      available: 0,
      engaged: 0,
      inProduction: 0,
      losses: 0,
      value: 0,
      systems: 0,
    };
    for (const r of rows) {
      s.elements += r.elements;
      s.available += r.available;
      s.engaged += r.engaged;
      s.inProduction += r.inProduction;
      s.losses += r.losses;
      s.value += r.value;
      if (r.elements) s.systems++;
    }
    return s;
  }, [rows]);
  const upkeep = useMemo(() => totalUpkeep(view, me, catalog), [view, me, catalog]);

  const searching = norm(q).length > 0;
  const counts = useMemo(() => {
    const c = { all: 0 } as Record<CategoryFilter, number>;
    for (const k of NAV_CATEGORIES) c[k] = 0;
    for (const r of rows) {
      c.all++;
      c[r.category] = (c[r.category] ?? 0) + 1;
    }
    return c;
  }, [rows]);
  const available = useMemo(() => new Set<Category>(rows.map((r) => r.category)), [rows]);
  const list = useMemo(() => {
    const nq = norm(q);
    return rows
      .filter((r) =>
        nq
          ? norm(catalog[r.systemId]?.name ?? r.systemId).includes(nq) || r.systemId.includes(nq)
          : category === 'all' || r.category === category,
      )
      .sort(
        (a, b) =>
          NAV_CATEGORIES.indexOf(a.category) - NAV_CATEGORIES.indexOf(b.category) ||
          b.elements - a.elements ||
          b.inProduction - a.inProduction,
      );
  }, [rows, q, category, catalog]);

  const name = (r: InventoryRow) => catalog[r.systemId]?.name ?? r.systemId;
  const availability = totals.elements ? totals.available / totals.elements : 0;

  return (
    <div className={mobile ? 'inv inv--mobile' : 'inv'}>
      <div className="kpis inv__kpis" data-testid="inventory-summary">
        <Stat
          label={t('inventory.kpi.elements')}
          value={formatInt(totals.elements)}
          sub={t('inventory.kpi.systems', { count: totals.systems })}
          icon={<Icon name="army" size={12} />}
        />
        <Stat
          label={t('inventory.kpi.value')}
          value={formatMoney(totals.value)}
          tone="amber"
          sub={t('inventory.kpi.upkeep', { value: formatMoney(upkeep) })}
        />
        <Stat
          label={t('inventory.kpi.available')}
          value={`${Math.round(availability * 100)} %`}
          tone={availability > 0.6 ? 'green' : availability > 0.3 ? 'amber' : 'red'}
          sub={t('inventory.kpi.availableSub', {
            available: formatInt(totals.available),
            engaged: formatInt(totals.engaged),
          })}
        />
        <Stat
          label={t('inventory.kpi.production')}
          value={formatInt(totals.inProduction)}
          tone="cyan"
          sub={t('inventory.kpi.productionSub', {
            count: view?.economy.production.length ?? 0,
          })}
        />
        <Stat
          label={t('inventory.kpi.losses')}
          value={formatInt(totals.losses)}
          tone={totals.losses ? 'red' : 'default'}
          sub={t('inventory.kpi.lossesSub')}
        />
      </div>
      <div className="inv__bar">
        <SearchInput
          value={q}
          onChange={setQ}
          label={t('app.search')}
          placeholder={t('inventory.search')}
          className="inv__search"
        />
        <span className="grow" />
        <Button
          size="sm"
          variant="subtle"
          icon={<Icon name="production" size={12} />}
          onClick={() => openWindow('production')}
        >
          {t('inventory.toProduction')}
        </Button>
      </div>
      <CategoryNav
        value={category}
        counts={counts}
        available={available}
        searching={searching}
        mobile
        onChange={(c) => {
          setCategory(c);
          writeCategory(CATEGORY_KEY, c);
          if (searching) setQ('');
        }}
      />
      <div className="inv__table">
        <Table
          label={t('sections.army')}
          rows={list}
          rowKey={(r) => r.systemId}
          onRowClick={(r) => openSheet(r.systemId)}
          empty={
            <EmptyState
              compact
              icon="army"
              title={rows.length ? t('inventory.noMatch') : t('inventory.empty')}
            />
          }
          columns={[
            {
              key: 'sys',
              header: t('inventory.cols.system'),
              sort: (a, b) => name(a).localeCompare(name(b)),
              render: (r) => {
                const s = catalog[r.systemId];
                return (
                  <span className="invrow">
                    {s ? (
                      <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" />
                    ) : null}
                    <span className="invrow__name">
                      <b>{name(r)}</b>
                      <span>
                        {t(`categories.${r.category}`)}
                        <span className="rl-only-mobile">
                          {' · '}
                          {t('inventory.mobileLine', {
                            n: formatInt(r.elements),
                            available: formatInt(r.available),
                            value: formatMoney(r.value),
                          })}
                        </span>
                      </span>
                    </span>
                  </span>
                );
              },
            },
            {
              key: 'n',
              header: t('inventory.cols.inService'),
              align: 'right',
              sort: (a, b) => a.elements - b.elements,
              render: (r) => (
                <span className="armies__n">
                  <b>{formatInt(r.elements)}</b>
                  <span>{t('armies.piles', { count: r.piles })}</span>
                </span>
              ),
            },
            {
              key: 'av',
              header: t('inventory.cols.available'),
              align: 'right',
              hideOnMobile: true,
              sort: (a, b) => a.available - b.available,
              render: (r) => (
                <span className={r.available ? 'rl-tone-green' : 'muted'}>
                  {formatInt(r.available)}
                </span>
              ),
            },
            {
              key: 'eng',
              header: t('inventory.cols.engaged'),
              align: 'right',
              hideOnMobile: true,
              sort: (a, b) => a.engaged + a.deployed - (b.engaged + b.deployed),
              render: (r) =>
                r.engaged || r.deployed ? (
                  <span>
                    {r.engaged ? <span className="rl-tone-red">{formatInt(r.engaged)}</span> : null}
                    {r.engaged && r.deployed ? ' · ' : null}
                    {r.deployed ? (
                      <span className="rl-tone-cyan">{formatInt(r.deployed)}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: 'hp',
              header: t('inventory.cols.hp'),
              hideOnMobile: true,
              render: (r) =>
                r.elements ? (
                  <Gauge value={r.hp} tone="auto" cells={6} label={t('inventory.cols.hp')} />
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: 'prod',
              header: t('inventory.cols.production'),
              align: 'right',
              hideOnMobile: true,
              sort: (a, b) => a.inProduction - b.inProduction,
              render: (r) =>
                r.inProduction ? (
                  <span className="rl-tone-cyan">+{formatInt(r.inProduction)}</span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: 'loss',
              header: t('inventory.cols.losses'),
              align: 'right',
              hideOnMobile: true,
              sort: (a, b) => a.losses - b.losses,
              render: (r) =>
                r.losses ? (
                  <span className="rl-tone-red">−{formatInt(r.losses)}</span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: 'val',
              header: t('inventory.cols.value'),
              align: 'right',
              hideOnMobile: true,
              sort: (a, b) => a.value - b.value,
              render: (r) => <span className="rl-money">{formatMoney(r.value)}</span>,
            },
          ]}
        />
      </div>
      <p className="hint inv__hint">{t('inventory.hint')}</p>
    </div>
  );
}
