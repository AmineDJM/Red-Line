import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DOCTRINES, type Category, type Doctrine, type WeaponSystem } from '@redline/shared';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  Pictogram,
  SearchInput,
  Segmented,
  Table,
  Tabs,
  WeaponPhoto,
  WeaponTile,
  formatHours,
  formatMoney,
  pictogramForCategory,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import {
  CATEGORY_GROUPS,
  NAV_CATEGORIES,
  arsenalMatches,
  categoryCounts,
  defaultCategory,
  isSearching,
  readCategory,
  sectionsOf,
  writeCategory,
  type ArsenalFilter,
  type CategoryFilter,
} from '../lib/arsenal.js';
import { ownedCounts, productionStatus, systemPrice } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';
import { WeaponDetail } from './WeaponDetail.js';

type DoctrineTab = Doctrine | 'all';

export interface ArsenalBrowserProps {
  /** `production` : faits de jeu et actions ; `encyclopedia` : fiches seules. */
  mode: 'production' | 'encyclopedia';
  mobile: boolean;
  /** Fiche ouverte au départ (paramètre de fenêtre). */
  initialSystemId?: string;
  /** Actions de la fiche (produire, importer…), fournies par la fenêtre Production. */
  renderActions?: (s: WeaponSystem) => ReactNode;
}

/**
 * Navigation par catégories (chasseurs, chars, défense aérienne…) avec compteurs : colonne à gauche
 * sur ordinateur, bandeau défilant sur mobile. Liste d'onglets accessible (flèches, Début, Fin).
 */
export function CategoryNav({
  value,
  counts,
  available,
  searching,
  mobile,
  onChange,
}: {
  value: CategoryFilter;
  counts: Record<CategoryFilter, number>;
  /** Catégories présentes au catalogue (les autres ne sont pas proposées). */
  available: Set<Category>;
  searching: boolean;
  mobile: boolean;
  onChange: (c: CategoryFilter) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef(new Map<CategoryFilter, HTMLButtonElement | null>());
  const order: CategoryFilter[] = ['all', ...NAV_CATEGORIES.filter((c) => available.has(c))];
  // Catégorie active visible dans le bandeau mobile (mémorisée hors de l'écran).
  useEffect(() => {
    if (mobile) refs.current.get(value)?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [mobile, value]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const prev = mobile ? 'ArrowLeft' : 'ArrowUp';
    const next = mobile ? 'ArrowRight' : 'ArrowDown';
    const i = order.indexOf(value);
    let j = -1;
    if (e.key === next) j = Math.min(order.length - 1, i + 1);
    else if (e.key === prev) j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = order.length - 1;
    if (j < 0) return;
    e.preventDefault();
    const c = order[j]!;
    onChange(c);
    refs.current.get(c)?.focus();
  };
  const label = (c: CategoryFilter) =>
    c === 'all' ? t('arsenal.allCategories') : t(`arsenal.cats.${c}`);
  const item = (c: CategoryFilter) => {
    const on = !searching && c === value;
    const n = counts[c] ?? 0;
    return (
      <button
        key={c}
        ref={(el) => {
          refs.current.set(c, el);
        }}
        type="button"
        role="tab"
        aria-selected={on}
        tabIndex={c === value ? 0 : -1}
        className={[
          'catnav__item',
          on ? 'catnav__item--on' : '',
          n === 0 ? 'catnav__item--empty' : '',
        ].join(' ')}
        onClick={() => onChange(c)}
        data-testid={`arsenal-cat-${c}`}
      >
        <span className="catnav__icon" aria-hidden>
          {c === 'all' ? (
            <Icon name="grid" size={14} />
          ) : (
            <Pictogram id={pictogramForCategory(c)} size={16} />
          )}
        </span>
        <span className="catnav__label">{label(c)}</span>
        <span className="catnav__count">{n}</span>
      </button>
    );
  };
  return (
    <div
      className={mobile ? 'catnav catnav--strip' : 'catnav'}
      role="tablist"
      aria-orientation={mobile ? 'horizontal' : 'vertical'}
      aria-label={t('arsenal.categories')}
      onKeyDown={onKey}
      data-testid="arsenal-categories"
    >
      {item('all')}
      {CATEGORY_GROUPS.map((g) => {
        const cats = g.categories.filter((c) => available.has(c));
        if (!cats.length) return null;
        return mobile ? (
          cats.map(item)
        ) : (
          <div key={g.id} className="catnav__group" role="presentation">
            <div className="catnav__title" aria-hidden>
              {t(`arsenal.groups.${g.id}`)}
            </div>
            {cats.map(item)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Arsenal : doctrines et fournisseurs en onglets, une catégorie à la fois (navigation dédiée,
 * catégorie mémorisée), recherche globale, filtres (génération, productible, importable, possédé),
 * tuiles avec photo et prix en dollars, fiche détaillée.
 */
export function ArsenalBrowser({
  mode,
  mobile,
  initialSystemId,
  renderActions,
}: ArsenalBrowserProps) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const photos = usePhotos();
  const nationInfo = useWorld((s) => (me ? s.nationInfo[me] : undefined));
  useEffect(() => {
    void getApi().then((api) => useWorld.getState().loadNationInfo(api));
  }, []);
  const myDoctrine = ((me && view?.nations[me]?.doctrine) || nationInfo?.doctrine) as
    Doctrine | undefined;
  const [tab, setTab] = useState<DoctrineTab>(
    () => (initialSystemId && catalog[initialSystemId]?.doctrine) || myDoctrine || 'all',
  );
  // Doctrine connue après le chargement des fiches nationales : onglet de sa doctrine par défaut.
  const [tabTouched, setTabTouched] = useState(!!initialSystemId);
  useEffect(() => {
    if (!tabTouched && myDoctrine) setTab(myDoctrine);
  }, [myDoctrine, tabTouched]);
  // Catégorie : celle de la fiche demandée, sinon la dernière consultée, sinon la première non vide.
  const [category, setCategoryState] = useState<CategoryFilter | null>(
    () => (initialSystemId && catalog[initialSystemId]?.category) || readCategory(mode),
  );
  const [gen, setGen] = useState<number | 0>(0);
  const [query, setQuery] = useState('');
  const [onlyProducible, setOnlyProducible] = useState(false);
  const [onlyImportable, setOnlyImportable] = useState(false);
  const [onlyOwned, setOnlyOwned] = useState(false);
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<string | null>(initialSystemId ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialSystemId) {
      setSelected(initialSystemId);
      const s = catalog[initialSystemId];
      if (s) {
        setTab(s.doctrine);
        setCategoryState(s.category);
      }
    }
  }, [initialSystemId, catalog]);

  const owned = useMemo(() => ownedCounts(view, me), [view, me]);
  const systems = useMemo(
    () =>
      Object.values(catalog).filter(
        (s) => s.enabled !== false && (mode === 'encyclopedia' || s.category !== 'logistics'),
      ),
    [catalog, mode],
  );
  const available = useMemo(() => new Set(systems.map((s) => s.category)), [systems]);
  const doctrineCounts = useMemo(() => {
    const c: Record<string, number> = { all: systems.length };
    for (const s of systems) c[s.doctrine] = (c[s.doctrine] ?? 0) + 1;
    return c;
  }, [systems]);

  const extra = useMemo(() => {
    if (!onlyOwned && !onlyProducible && !onlyImportable) return undefined;
    return (s: WeaponSystem) => {
      if (onlyOwned && !(owned[s.id] ?? 0)) return false;
      if (!onlyProducible && !onlyImportable) return true;
      const st = productionStatus(s, view, me);
      return (!onlyProducible || st.producible) && (!onlyImportable || st.importable);
    };
  }, [onlyOwned, onlyProducible, onlyImportable, owned, view, me]);

  const filter = useMemo<Omit<ArsenalFilter, 'category'>>(
    () => ({ doctrine: tab, query, gen, extra }),
    [tab, query, gen, extra],
  );
  const counts = useMemo(
    () => categoryCounts(systems, { ...filter, category: 'all' }),
    [systems, filter],
  );
  const cat: CategoryFilter = category ?? defaultCategory(counts);
  const searching = isSearching({ query });

  const list = useMemo(
    () =>
      systems
        .filter((s) => arsenalMatches(s, { ...filter, category: cat }))
        .sort(
          (a, b) =>
            NAV_CATEGORIES.indexOf(a.category) - NAV_CATEGORIES.indexOf(b.category) ||
            Number((owned[b.id] ?? 0) > 0) - Number((owned[a.id] ?? 0) > 0) ||
            b.generation - a.generation ||
            a.name.localeCompare(b.name),
        ),
    [systems, filter, cat, owned],
  );
  // Plusieurs catégories affichées (tout l'arsenal, recherche) : une section par catégorie.
  const sections = useMemo(
    () => (searching || cat === 'all' ? sectionsOf(list) : null),
    [list, searching, cat],
  );

  const pickCategory = (c: CategoryFilter) => {
    setCategoryState(c);
    writeCategory(mode, c);
    if (searching) setQuery('');
    listRef.current?.scrollTo?.({ top: 0 });
  };

  const cur = selected ? catalog[selected] : null;

  const badgesFor = (s: WeaponSystem) => {
    if (mode === 'encyclopedia') return null;
    const st = productionStatus(s, view, me);
    return (
      <>
        {st.producible ? (
          <Badge tone="green">{t('arsenal.producible')}</Badge>
        ) : (
          <Badge tone="amber" variant="outline">
            {t('arsenal.rdRequired')}
          </Badge>
        )}
        {st.licensed ? <Badge tone="violet">{t('arsenal.licence')}</Badge> : null}
        {!st.producible && st.importable ? (
          <Badge tone="blue" variant="outline">
            {t('arsenal.import')}
          </Badge>
        ) : null}
      </>
    );
  };

  const detail = cur ? (
    <div className="arsenal__detail" data-testid="arsenal-detail">
      {mobile ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="chevronLeft" size={13} />}
          onClick={() => setSelected(null)}
        >
          {t('arsenal.back')}
        </Button>
      ) : null}
      <WeaponDetail system={cur} mode={mode} actions={renderActions?.(cur)} />
    </div>
  ) : (
    <EmptyState icon="encyclopedia" title={t('arsenal.pick')} text={t('arsenal.pickHint')} />
  );

  const tiles = (items: WeaponSystem[]) => (
    <div className="arsenal__grid">
      {items.map((s) => (
        <WeaponTile
          key={s.id}
          system={s}
          photo={photoFor(s, photos)}
          subtitle={t(`categories.${s.category}`)}
          price={formatMoney(systemPrice(s))}
          delay={formatHours(s.buildTimeH, t('time.dayUnit'))}
          delayLabel={t('arsenal.buildTime')}
          generationLabel={t('weapon.gen')}
          footer={
            mode === 'production' && owned[s.id]
              ? t('arsenal.ownedShort', { count: owned[s.id] })
              : undefined
          }
          badges={badgesFor(s)}
          selected={selected === s.id}
          dimmed={
            mode === 'production' &&
            !productionStatus(s, view, me).producible &&
            !productionStatus(s, view, me).importable
          }
          onSelect={() => setSelected(s.id)}
        />
      ))}
    </div>
  );

  const table = (
    <Table
      label={t('arsenal.title')}
      rows={list}
      rowKey={(s) => s.id}
      selectedKey={selected}
      onRowClick={(s) => setSelected(s.id)}
      columns={[
        {
          key: 'photo',
          header: '',
          width: '64px',
          render: (s) => <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" />,
        },
        {
          key: 'name',
          header: t('arsenal.cols.name'),
          render: (s) => <b>{s.name}</b>,
          sort: (a, b) => a.name.localeCompare(b.name),
        },
        {
          key: 'cat',
          header: t('arsenal.cols.category'),
          render: (s) => t(`categories.${s.category}`),
          hideOnMobile: true,
        },
        {
          key: 'gen',
          header: t('weapon.gen'),
          align: 'right',
          render: (s) => s.generation,
          sort: (a, b) => a.generation - b.generation,
        },
        {
          key: 'price',
          header: t('arsenal.price'),
          align: 'right',
          render: (s) => <span className="rl-money">{formatMoney(systemPrice(s))}</span>,
          sort: (a, b) => systemPrice(a) - systemPrice(b),
        },
        ...(mode === 'production'
          ? [
              {
                key: 'owned',
                header: t('arsenal.cols.owned'),
                align: 'right' as const,
                render: (s: WeaponSystem) => owned[s.id] ?? '—',
                sort: (a: WeaponSystem, b: WeaponSystem) => (owned[a.id] ?? 0) - (owned[b.id] ?? 0),
              },
              {
                key: 'status',
                header: t('arsenal.cols.status'),
                render: (s: WeaponSystem) => (
                  <span className="arsenal__badges">{badgesFor(s)}</span>
                ),
                hideOnMobile: true,
              },
            ]
          : [
              {
                key: 'time',
                header: t('arsenal.buildTime'),
                align: 'right' as const,
                render: (s: WeaponSystem) => formatHours(s.buildTimeH, t('time.dayUnit')),
                hideOnMobile: true,
              },
            ]),
      ]}
    />
  );

  const listPane = (
    <div className="arsenal__list" ref={listRef} data-testid="arsenal-list">
      {searching ? (
        <p className="arsenal__scope">
          <Icon name="search" size={12} />
          {t('arsenal.searchAll', { count: list.length })}
        </p>
      ) : null}
      {list.length === 0 ? (
        <EmptyState
          icon="filter"
          title={t('arsenal.empty')}
          text={
            !searching && cat !== 'all'
              ? t('arsenal.emptyCategory', { category: t(`arsenal.cats.${cat}`) })
              : t('arsenal.emptyHint')
          }
          compact
        />
      ) : layout === 'list' ? (
        table
      ) : sections ? (
        sections.map((sec) => (
          <section key={sec.category} className="arsenal__section">
            <h3 className="arsenal__sectitle">
              <Pictogram id={pictogramForCategory(sec.category)} size={14} />
              {t(`arsenal.cats.${sec.category}`)}
              <span>{sec.items.length}</span>
            </h3>
            {tiles(sec.items)}
          </section>
        ))
      ) : (
        tiles(list)
      )}
    </div>
  );

  const nav = (
    <CategoryNav
      value={cat}
      counts={counts}
      available={available}
      searching={searching}
      mobile={mobile}
      onChange={pickCategory}
    />
  );

  return (
    <div className={mobile ? 'arsenal arsenal--mobile' : 'arsenal'}>
      <div className="arsenal__tabs">
        <Tabs
          label={t('arsenal.doctrines')}
          value={tab}
          onChange={(d) => {
            setTab(d);
            setTabTouched(true);
          }}
          tabs={[
            { id: 'all' as DoctrineTab, label: t('arsenal.all'), count: doctrineCounts.all },
            ...DOCTRINES.map((d) => ({
              id: d as DoctrineTab,
              label: t(`doctrines.${d}`),
              count: doctrineCounts[d] ?? 0,
              dot: d === myDoctrine,
            })),
          ]}
        />
      </div>
      <div className="arsenal__filters">
        <SearchInput
          value={query}
          onChange={setQuery}
          label={t('app.search')}
          placeholder={t('arsenal.search')}
          className="arsenal__search"
        />
        <Segmented
          size="sm"
          label={t('weapon.gen')}
          value={gen}
          onChange={setGen}
          options={[
            { value: 0, label: t('arsenal.allGen') },
            ...[1, 2, 3, 4, 5].map((g) => ({
              value: g,
              label: `G${g}`,
              title: `${t('weapon.gen')} ${g}`,
            })),
          ]}
        />
        {mode === 'production' ? (
          <span className="arsenal__checks">
            <Checkbox
              checked={onlyProducible}
              onChange={setOnlyProducible}
              label={t('arsenal.producible')}
            />
            <Checkbox
              checked={onlyImportable}
              onChange={setOnlyImportable}
              label={t('arsenal.importable')}
            />
            <Checkbox
              checked={onlyOwned}
              onChange={setOnlyOwned}
              label={t('arsenal.ownedFilter')}
            />
          </span>
        ) : null}
        <span className="arsenal__spacer" />
        <span className="arsenal__count">{t('arsenal.count', { count: list.length })}</span>
        {!mobile ? (
          <Segmented
            size="sm"
            label={t('arsenal.layout')}
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'grid', label: <Icon name="grid" size={13} />, title: t('arsenal.grid') },
              { value: 'list', label: <Icon name="list" size={13} />, title: t('arsenal.list') },
            ]}
          />
        ) : null}
      </div>
      {mobile ? (
        cur ? (
          detail
        ) : (
          <>
            {nav}
            {listPane}
          </>
        )
      ) : (
        <div className="arsenal__split">
          {nav}
          {listPane}
          {detail}
        </div>
      )}
    </div>
  );
}
