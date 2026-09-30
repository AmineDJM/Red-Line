import { useMemo, useState } from 'react';
import { CATEGORIES, DOCTRINES, type AdminSystem, type Doctrine } from '@redline/shared';
import { useSession } from '../context';
import { DataTable, type Column } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  Seg,
  Spinner,
  Stat,
  Win,
} from '../components/term';
import { Thumb } from '../components/weapon';
import { T, fmt } from '../i18n';
import { ago, hours, usd } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { usePhotos, useSystems } from '../lib/refs';
import { navigate } from '../lib/router';
import { matches } from '../lib/search';

const PREFS_KEY = 'rl-admin-catalog-filters';
interface Filters {
  doctrine: Doctrine | 'all';
  category: string;
  generation: string;
  status: 'all' | 'on' | 'off';
  photo: 'all' | 'with' | 'without';
  q: string;
}
function loadPrefs(): Filters {
  const d: Filters = {
    doctrine: 'all',
    category: '',
    generation: '',
    status: 'all',
    photo: 'all',
    q: '',
  };
  try {
    return { ...d, ...(JSON.parse(sessionStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Filters>) };
  } catch {
    return d;
  }
}

const CAT_ORDER = new Map(CATEGORIES.map((c, i) => [c, i]));
const DOC_ORDER = new Map(DOCTRINES.map((d, i) => [d, i]));
function sortSystems(a: AdminSystem, b: AdminSystem): number {
  const x = a.system;
  const y = b.system;
  return (
    (CAT_ORDER.get(x.category) ?? 0) - (CAT_ORDER.get(y.category) ?? 0) ||
    (DOC_ORDER.get(x.doctrine) ?? 0) - (DOC_ORDER.get(y.doctrine) ?? 0) ||
    x.generation - y.generation ||
    (x.unitPriceUsd ?? x.cost.money) - (y.unitPriceUsd ?? y.cost.money) ||
    x.name.localeCompare(y.name, 'fr')
  );
}

export function CatalogScreen() {
  const { api, cache } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useSystems();
  const photos = usePhotos().data ?? {};
  const [f, setF] = useState<Filters>(loadPrefs);
  const [busy, setBusy] = useState<string | null>(null);
  const update = (patch: Partial<Filters>) => {
    const next = { ...f, ...patch };
    setF(next);
    try {
      sessionStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* ignoré */
    }
  };

  const all = useMemo(() => [...(data ?? [])].sort(sortSystems), [data]);
  const presentCategories = useMemo(
    () => CATEGORIES.filter((c) => all.some((s) => s.system.category === c)),
    [all],
  );
  const photoOf = (s: AdminSystem['system']) => s.photo ?? photos[s.id] ?? null;

  const list = useMemo(
    () =>
      all.filter(({ system: s }) => {
        if (f.doctrine !== 'all' && s.doctrine !== f.doctrine) return false;
        if (f.category && s.category !== f.category) return false;
        if (f.generation && String(s.generation) !== f.generation) return false;
        if (f.status === 'on' && !s.enabled) return false;
        if (f.status === 'off' && s.enabled) return false;
        const has = !!(s.photo ?? photos[s.id]);
        if (f.photo === 'with' && !has) return false;
        if (f.photo === 'without' && has) return false;
        return matches(
          `${s.name} ${s.id} ${s.roles.join(' ')} ${s.requires.join(' ')} ${T.categories[s.category]}`,
          f.q,
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, f, photos],
  );

  const toggle = async (a: AdminSystem) => {
    const enabled = !a.system.enabled;
    if (
      !enabled &&
      !(await confirm({
        title: T.catalog.deactivate,
        message: fmt(T.catalog.toggleConfirm, { name: a.system.name }),
        danger: true,
        confirm: T.catalog.deactivate,
      }))
    )
      return;
    setBusy(a.system.id);
    try {
      const action = enabled ? T.catalog.activate : T.catalog.deactivate;
      await api.updateSystem(a.system.id, {
        data: { ...a.system, enabled },
        message: fmt(T.catalog.toggleMessage, { action }),
        scope: 'new_games',
      });
      cache.invalidate('systems');
      toast(
        fmt(T.catalog.toggled, {
          name: a.system.name,
          state: (enabled ? T.catalog.active : T.catalog.inactive).toLowerCase(),
        }),
      );
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<AdminSystem>[] = [
    {
      key: 'photo',
      label: '',
      width: 64,
      render: (a) => (
        <Thumb
          photo={photoOf(a.system)}
          icon={a.system.icon || a.system.category}
          muted={!a.system.enabled}
        />
      ),
    },
    {
      key: 'name',
      label: T.catalog.colName,
      sort: (a) => a.system.name,
      className: 'two',
      render: (a) => (
        <>
          <b className={a.system.enabled ? 'bright' : ''}>{a.system.name}</b>
          <span className="sub">{a.system.id}</span>
        </>
      ),
    },
    {
      key: 'cat',
      label: T.catalog.colCategory,
      sort: (a) => CAT_ORDER.get(a.system.category),
      hideM: true,
      render: (a) => <span className="muted">{T.categories[a.system.category]}</span>,
    },
    {
      key: 'doc',
      label: T.catalog.colDoctrine,
      sort: (a) => a.system.doctrine,
      hideM: true,
      render: (a) => T.doctrinesShort[a.system.doctrine],
    },
    {
      key: 'gen',
      label: T.catalog.colGen,
      align: 'right',
      hideM: true,
      sort: (a) => a.system.generation,
      render: (a) => a.system.generation,
    },
    {
      key: 'price',
      label: T.catalog.colPrice,
      align: 'right',
      sort: (a) => a.system.unitPriceUsd ?? null,
      render: (a) => <span className="val">{usd(a.system.unitPriceUsd)}</span>,
    },
    {
      key: 'build',
      label: T.catalog.colBuild,
      align: 'right',
      sort: (a) => a.system.buildTimeH,
      hideM: true,
      render: (a) => hours(a.system.buildTimeH),
    },
    {
      key: 'era',
      label: T.catalog.colEra,
      sort: (a) => a.system.era?.introduced ?? null,
      hideM: true,
      render: (a) =>
        a.system.era ? (
          `${a.system.era.introduced}${a.system.era.retired ? `–${a.system.era.retired}` : ''}`
        ) : (
          <span className="dim">—</span>
        ),
    },
    {
      key: 'req',
      label: T.catalog.colReq,
      align: 'right',
      sort: (a) => a.system.requires.length,
      hideM: true,
      render: (a) => <span title={a.system.requires.join('\n')}>{a.system.requires.length}</span>,
    },
    {
      key: 'rev',
      label: T.catalog.colRev,
      align: 'right',
      sort: (a) => a.revision,
      hideM: true,
      render: (a) => <span className="dim">r{a.revision}</span>,
    },
    {
      key: 'upd',
      label: T.catalog.colUpdated,
      sort: (a) => a.updatedAt,
      hideM: true,
      render: (a) => <span className="dim">{ago(a.updatedAt)}</span>,
    },
    {
      key: 'st',
      label: T.catalog.colStatus,
      sort: (a) => (a.system.enabled ? 0 : 1),
      render: (a) => (
        <span className="row" onClick={(e) => e.stopPropagation()}>
          <Badge tone={a.system.enabled ? 'ok' : 'off'}>
            {a.system.enabled ? T.catalog.active : T.catalog.inactive}
          </Badge>
          <Button
            small
            variant="ghost"
            className="hide-m"
            disabled={busy === a.system.id}
            onClick={() => void toggle(a)}
          >
            {a.system.enabled ? T.catalog.deactivate : T.catalog.activate}
          </Button>
        </span>
      ),
    },
  ];

  const withPhoto = all.filter((a) => photoOf(a.system)).length;
  return (
    <>
      <PageHead
        title={T.catalog.title}
        sub={fmt(T.catalog.sub, { n: all.length })}
        actions={
          <Button variant="primary" onClick={() => navigate({ name: 'new' })}>
            <Icon name="plus" size={14} /> {T.catalog.create}
          </Button>
        }
      />
      {data && (
        <div className="stats">
          <Stat k={T.catalog.stats.total} v={all.length} />
          <Stat
            k={T.catalog.stats.active}
            v={all.filter((a) => a.system.enabled).length}
            tone="var(--t-green)"
          />
          <Stat
            k={T.catalog.stats.priced}
            v={all.filter((a) => a.system.unitPriceUsd != null).length}
            tone="var(--t-amber)"
          />
          <Stat
            k={T.catalog.stats.photos}
            v={withPhoto}
            d={`${Math.round((withPhoto / Math.max(1, all.length)) * 100)} %`}
          />
        </div>
      )}
      <Win
        title={T.catalog.title}
        path="Catalogue"
        cmd={`Get-WeaponSystem${f.category ? ` -Category ${f.category}` : ''}${f.doctrine !== 'all' ? ` -Doctrine ${f.doctrine}` : ''} | Sort-Object category`}
      >
        <div className="toolbar">
          <SearchBox
            value={f.q}
            onChange={(q) => update({ q })}
            placeholder={T.catalog.search}
            autoFocusKey
          />
          <Seg
            small
            label={T.doctrines.us}
            value={f.doctrine}
            onChange={(doctrine) => update({ doctrine })}
            options={[
              ['all', T.catalog.all],
              ...DOCTRINES.map((d) => [d, T.doctrinesShort[d]] as const),
            ]}
          />
          <select
            className="input"
            aria-label={T.catalog.category}
            value={f.category}
            onChange={(e) => update({ category: e.target.value })}
          >
            <option value="">{T.catalog.allCategories}</option>
            {presentCategories.map((c) => (
              <option key={c} value={c}>
                {T.categories[c]} ({all.filter((a) => a.system.category === c).length})
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={T.catalog.generation}
            value={f.generation}
            onChange={(e) => update({ generation: e.target.value })}
            style={{ minWidth: 110 }}
          >
            <option value="">
              {T.catalog.generation} : {T.catalog.allGenerations}
            </option>
            {[1, 2, 3, 4, 5].map((g) => (
              <option key={g} value={g}>
                {T.catalog.generation} {g}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={T.catalog.status}
            value={f.status}
            onChange={(e) => update({ status: e.target.value as Filters['status'] })}
            style={{ minWidth: 110 }}
          >
            <option value="all">
              {T.catalog.status} : {T.catalog.allStatus}
            </option>
            <option value="on">{T.catalog.active}</option>
            <option value="off">{T.catalog.inactive}</option>
          </select>
          <select
            className="input"
            aria-label={T.catalog.photo}
            value={f.photo}
            onChange={(e) => update({ photo: e.target.value as Filters['photo'] })}
            style={{ minWidth: 110 }}
          >
            <option value="all">
              {T.catalog.photo} : {T.catalog.allStatus}
            </option>
            <option value="with">{T.catalog.withPhoto}</option>
            <option value="without">{T.catalog.withoutPhoto}</option>
          </select>
          <span className="meta">{fmt(T.catalog.count, { n: list.length })}</span>
        </div>
        {!data && !error && <Spinner />}
        {error && <ErrorBox message={error} onRetry={reload} />}
        {data && (
          <DataTable
            label={T.catalog.title}
            rows={list}
            columns={columns}
            rowKey={(a) => a.system.id}
            onRowClick={(a) => navigate({ name: 'system', id: a.system.id })}
            rowClass={(a) => (a.system.enabled ? '' : 'off')}
            empty={T.catalog.empty}
            maxHeight="calc(100vh - 330px)"
          />
        )}
      </Win>
    </>
  );
}
