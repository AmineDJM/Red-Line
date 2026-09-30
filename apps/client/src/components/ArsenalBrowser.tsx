import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CATEGORIES,
  DOCTRINES,
  type Category,
  type Doctrine,
  type WeaponSystem,
} from '@redline/shared';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  SearchInput,
  Segmented,
  Select,
  Table,
  Tabs,
  WeaponCard,
  WeaponPhoto,
  WeaponTile,
  formatHours,
  formatMoney,
  type WeaponFact,
} from '@redline/ui';
import { norm } from '../lib/commands.js';
import { ownedCounts, productionStatus, researchName, systemPrice } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { weaponLabels, weaponSubtitle } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

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
 * Arsenal : doctrines et fournisseurs en onglets, filtres (catégorie, génération, productible,
 * importable, possédé), tuiles avec photo et prix en dollars, fiche détaillée.
 */
export function ArsenalBrowser({
  mode,
  mobile,
  initialSystemId,
  renderActions,
}: ArsenalBrowserProps) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const research = useWorld((s) => s.research);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const photos = usePhotos();
  const myDoctrine = (me && view?.nations[me]?.doctrine) as Doctrine | undefined;
  const [tab, setTab] = useState<DoctrineTab>(
    () => (initialSystemId && catalog[initialSystemId]?.doctrine) || myDoctrine || 'all',
  );
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [gen, setGen] = useState<number | 0>(0);
  const [query, setQuery] = useState('');
  const [onlyProducible, setOnlyProducible] = useState(false);
  const [onlyImportable, setOnlyImportable] = useState(false);
  const [onlyOwned, setOnlyOwned] = useState(false);
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<string | null>(initialSystemId ?? null);

  useEffect(() => {
    if (initialSystemId) {
      setSelected(initialSystemId);
      const d = catalog[initialSystemId]?.doctrine;
      if (d) setTab(d);
    }
  }, [initialSystemId, catalog]);

  const owned = useMemo(() => ownedCounts(view, me), [view, me]);
  const systems = useMemo(
    () => Object.values(catalog).filter((s) => s.enabled !== false && s.category !== 'logistics'),
    [catalog],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: systems.length };
    for (const s of systems) c[s.doctrine] = (c[s.doctrine] ?? 0) + 1;
    return c;
  }, [systems]);

  const list = useMemo(() => {
    const q = norm(query);
    return systems
      .filter((s) => tab === 'all' || s.doctrine === tab)
      .filter((s) => category === 'all' || s.category === category)
      .filter((s) => !gen || s.generation === gen)
      .filter((s) => !q || norm(s.name).includes(q) || s.id.includes(q))
      .filter((s) => !onlyOwned || (owned[s.id] ?? 0) > 0)
      .filter((s) => {
        if (!onlyProducible && !onlyImportable) return true;
        const st = productionStatus(s, view, me);
        return (!onlyProducible || st.producible) && (!onlyImportable || st.importable);
      })
      .sort(
        (a, b) =>
          CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
          b.generation - a.generation ||
          a.name.localeCompare(b.name),
      );
  }, [
    systems,
    tab,
    category,
    gen,
    query,
    onlyOwned,
    onlyProducible,
    onlyImportable,
    owned,
    view,
    me,
  ]);

  const cur = selected ? catalog[selected] : null;
  const presentCats = CATEGORIES.filter((c) =>
    systems.some((s) => s.category === c && (tab === 'all' || s.doctrine === tab)),
  );

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

  const facts = (s: WeaponSystem): WeaponFact[] => {
    const st = productionStatus(s, view, me);
    const out: WeaponFact[] = [
      {
        label: t('arsenal.price'),
        value: `${formatMoney(systemPrice(s))}${s.unitSize > 1 ? ` · ${s.unitSize} ${s.unitLabel ?? t('arsenal.elements')}` : ''}`,
        tone: 'amber',
      },
      {
        label: t('arsenal.unitPrice'),
        value: s.unitPriceUsd ? formatMoney(s.unitPriceUsd) : '—',
        tone: 'amber',
      },
      {
        label: t('arsenal.upkeep'),
        value: `${formatMoney(s.upkeepPerDay)} ${t('arsenal.perDay')}`,
        tone: 'dim',
      },
      { label: t('arsenal.buildTime'), value: formatHours(s.buildTimeH, t('time.dayUnit')) },
    ];
    if (mode === 'production') {
      out.unshift({
        label: t('arsenal.owned'),
        value: String(owned[s.id] ?? 0),
        tone: (owned[s.id] ?? 0) > 0 ? 'green' : 'dim',
      });
      out.push({
        label: t('arsenal.producibleLabel'),
        value: st.producible
          ? st.licensed && !st.researched
            ? t('arsenal.yesLicence')
            : t('app.yes')
          : t('arsenal.noResearch', {
              nodes: st.missing.map((m) => researchName(m, research)).join(', '),
            }),
        tone: st.producible ? 'green' : 'red',
      });
      out.push({
        label: t('arsenal.importLabel'),
        value: st.embargoed
          ? t('arsenal.embargo')
          : s.exportable
            ? t('arsenal.importPossible')
            : t('arsenal.notExportable'),
        tone: st.embargoed ? 'red' : s.exportable ? 'cyan' : 'dim',
      });
      out.push({
        label: t('arsenal.licenceLabel'),
        value: st.licensed
          ? t('arsenal.licenceOwned')
          : s.licensable
            ? t('arsenal.licenceAvailable')
            : t('arsenal.licenceNone'),
        tone: st.licensed ? 'green' : 'dim',
      });
    }
    return out;
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
      <WeaponCard
        system={cur}
        labels={weaponLabels()}
        subtitle={weaponSubtitle(cur)}
        photo={photoFor(cur, photos)}
        facts={facts(cur)}
        badges={
          <>
            <Badge tone="neutral">{t(`doctrines.${cur.doctrine}`)}</Badge>
            <Badge tone="neutral">{t(`categories.${cur.category}`)}</Badge>
            {cur.stealth > 0.3 ? (
              <Badge tone="violet" variant="outline">
                {t('arsenal.stealth')}
              </Badge>
            ) : null}
            {cur.requires.map((r) => (
              <Badge
                key={r}
                tone={view?.research?.done.includes(r) ? 'green' : 'amber'}
                variant="outline"
                title={researchName(r, research)}
              >
                {r.replace(/^research\./, '')}
              </Badge>
            ))}
          </>
        }
        actions={renderActions?.(cur)}
      />
    </div>
  ) : (
    <EmptyState icon="encyclopedia" title={t('arsenal.pick')} text={t('arsenal.pickHint')} />
  );

  const listPane = (
    <div className="arsenal__list">
      {list.length === 0 ? (
        <EmptyState
          icon="filter"
          title={t('arsenal.empty')}
          text={t('arsenal.emptyHint')}
          compact
        />
      ) : layout === 'grid' ? (
        <div className="arsenal__grid">
          {list.map((s) => (
            <WeaponTile
              key={s.id}
              system={s}
              photo={photoFor(s, photos)}
              subtitle={t(`categories.${s.category}`)}
              price={formatMoney(systemPrice(s))}
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
      ) : (
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
                    sort: (a: WeaponSystem, b: WeaponSystem) =>
                      (owned[a.id] ?? 0) - (owned[b.id] ?? 0),
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
      )}
    </div>
  );

  return (
    <div className={mobile ? 'arsenal arsenal--mobile' : 'arsenal'}>
      <div className="arsenal__tabs">
        <Tabs
          label={t('arsenal.doctrines')}
          value={tab}
          onChange={(d) => {
            setTab(d);
            setCategory('all');
          }}
          tabs={[
            { id: 'all' as DoctrineTab, label: t('arsenal.all'), count: counts.all },
            ...DOCTRINES.map((d) => ({
              id: d as DoctrineTab,
              label: t(`doctrines.${d}`),
              count: counts[d] ?? 0,
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
        <Select
          label={t('arsenal.category')}
          value={category}
          onChange={(v) => setCategory(v as Category | 'all')}
          options={[
            { value: 'all', label: t('arsenal.allCategories') },
            ...presentCats.map((c) => ({ value: c, label: t(`categories.${c}`) })),
          ]}
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
          listPane
        )
      ) : (
        <div className="arsenal__split">
          {listPane}
          {detail}
        </div>
      )}
    </div>
  );
}
