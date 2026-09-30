import { useMemo, useState } from 'react';
import { CATEGORIES, DOCTRINES, type AdminSystem, type Doctrine } from '@redline/shared';
import { useSession } from '../context';
import { Badge, Button, ErrorBox, Frame, HexIcon, Spinner, useToast } from '../components/ui';
import { T, date, fmt, num } from '../i18n';
import { errorMessage } from '../lib/errors';
import { useLoad } from '../lib/hooks';
import { href, navigate } from '../lib/router';

const PREFS_KEY = 'rl-admin-catalog-filters';
interface Filters {
  doctrine: Doctrine | 'all';
  category: string;
  generation: string;
  status: 'all' | 'on' | 'off';
  q: string;
}
function loadPrefs(): Filters {
  const d: Filters = { doctrine: 'all', category: '', generation: '', status: 'all', q: '' };
  try {
    return { ...d, ...(JSON.parse(sessionStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Filters>) };
  } catch {
    return d;
  }
}

export function CatalogScreen() {
  const { api } = useSession();
  const toast = useToast();
  const { data, setData, error, loading, reload } = useLoad(
    () => api.listSystems().then((r) => r.systems),
    [api],
    T.roles.balance,
  );
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
  const byDoctrine = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of all) m.set(s.system.doctrine, (m.get(s.system.doctrine) ?? 0) + 1);
    return m;
  }, [all]);
  const presentCategories = useMemo(
    () => CATEGORIES.filter((c) => all.some((s) => s.system.category === c)),
    [all],
  );

  const q = f.q.trim().toLowerCase();
  const list = all.filter(({ system: s }) => {
    if (f.doctrine !== 'all' && s.doctrine !== f.doctrine) return false;
    if (f.category && s.category !== f.category) return false;
    if (f.generation && String(s.generation) !== f.generation) return false;
    if (f.status === 'on' && !s.enabled) return false;
    if (f.status === 'off' && s.enabled) return false;
    if (q && !`${s.name} ${s.id} ${s.roles.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const toggle = async (a: AdminSystem) => {
    const enabled = !a.system.enabled;
    setBusy(a.system.id);
    try {
      const action = enabled ? T.catalog.activate : T.catalog.deactivate;
      const { system } = await api.updateSystem(a.system.id, {
        data: { ...a.system, enabled },
        message: fmt(T.catalog.toggleMessage, { action }),
        scope: 'new_games',
      });
      setData((d) => (d ?? []).map((x) => (x.system.id === system.system.id ? system : x)));
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

  return (
    <Frame
      title={T.catalog.title}
      actions={
        <Button variant="primary" onClick={() => navigate({ name: 'new' })}>
          + {T.catalog.create}
        </Button>
      }
    >
      <div className="doctrine-tabs" role="tablist">
        {(['all', ...DOCTRINES] as const).map((d) => (
          <button
            key={d}
            role="tab"
            aria-selected={f.doctrine === d}
            className={`dtab ${f.doctrine === d ? 'dtab-active' : ''}`}
            onClick={() => update({ doctrine: d })}
          >
            {d === 'all' ? T.catalog.all : T.doctrines[d]}
            <span className="dtab-count">
              {d === 'all' ? all.length : (byDoctrine.get(d) ?? 0)}
            </span>
          </button>
        ))}
      </div>
      <div className="filters">
        <input
          className="filter-search"
          type="search"
          placeholder={T.catalog.search}
          aria-label={T.catalog.search}
          value={f.q}
          onChange={(e) => update({ q: e.target.value })}
        />
        <select
          aria-label={T.catalog.category}
          value={f.category}
          onChange={(e) => update({ category: e.target.value })}
        >
          <option value="">{T.catalog.allCategories}</option>
          {presentCategories.map((c) => (
            <option key={c} value={c}>
              {T.categories[c]}
            </option>
          ))}
        </select>
        <select
          aria-label={T.catalog.generation}
          value={f.generation}
          onChange={(e) => update({ generation: e.target.value })}
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
          aria-label={T.catalog.status}
          value={f.status}
          onChange={(e) => update({ status: e.target.value as Filters['status'] })}
        >
          <option value="all">
            {T.catalog.status} : {T.catalog.allStatus}
          </option>
          <option value="on">{T.catalog.active}</option>
          <option value="off">{T.catalog.inactive}</option>
        </select>
      </div>

      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {data && (
        <>
          <div className="list-meta muted">{fmt(T.catalog.count, { n: list.length })}</div>
          <div className="sys-list" role="table">
            <div className="sys-row sys-head" role="row">
              <span />
              <span>{T.catalog.colName}</span>
              <span>{T.catalog.colCategory}</span>
              <span className="r">{T.catalog.colGen}</span>
              <span className="r">{T.catalog.colCost}</span>
              <span className="r">{T.catalog.colBuild}</span>
              <span className="r">{T.catalog.colRev}</span>
              <span>{T.catalog.colUpdated}</span>
              <span>{T.catalog.colStatus}</span>
            </div>
            {list.map((a) => {
              const s = a.system;
              return (
                <div key={s.id} className={`sys-row ${s.enabled ? '' : 'sys-off'}`} role="row">
                  <span className="c-icon">
                    <HexIcon icon={s.icon} size={34} muted={!s.enabled} />
                  </span>
                  <a className="c-name" href={href({ name: 'system', id: s.id })}>
                    <strong>{s.name}</strong>
                    <span className="mono muted">{s.id}</span>
                  </a>
                  <span className="c-cat">{T.categories[s.category]}</span>
                  <span className="c-mobile-meta muted">
                    {T.categories[s.category]} · {T.catalog.colGen} {s.generation} ·{' '}
                    <span className="m-cost mono">{num(s.cost.money)}</span> · {s.buildTimeH} h
                  </span>
                  <span className="c-gen r mono">{s.generation}</span>
                  <span className="c-cost r mono">{num(s.cost.money)}</span>
                  <span className="c-build r mono">{s.buildTimeH} h</span>
                  <span className="c-rev r mono muted">r{a.revision}</span>
                  <span className="c-date muted">{date(a.updatedAt)}</span>
                  <span className="c-status">
                    <Badge tone={s.enabled ? 'ok' : 'off'}>
                      {s.enabled ? T.catalog.active : T.catalog.inactive}
                    </Badge>
                    <Button
                      small
                      variant="ghost"
                      disabled={busy === s.id}
                      onClick={() => void toggle(a)}
                    >
                      {s.enabled ? T.catalog.deactivate : T.catalog.activate}
                    </Button>
                  </span>
                </div>
              );
            })}
            {list.length === 0 && <p className="muted empty">{T.catalog.empty}</p>}
          </div>
        </>
      )}
    </Frame>
  );
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
    x.cost.money - y.cost.money ||
    x.name.localeCompare(y.name, 'fr')
  );
}
