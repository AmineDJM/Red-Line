/** Carte : nations (nom, couleur, capitale, type, fusion), provinces et territoires disputés, avec mini-carte. */
import { useCallback, useMemo, useState } from 'react';
import {
  BUILDING_TYPES,
  DisputedAreaSchema,
  NationDefSchema,
  ProvinceDefSchema,
  RESOURCES,
  type DisputedArea,
  type NationDef,
  type ProvinceDef,
} from '@redline/shared';
import { useCached, useSession } from '../context';
import { DataTable } from '../components/DataTable';
import {
  CheckField,
  FormProvider,
  NumberField,
  SelectField,
  TextField,
  useFieldState,
} from '../components/fields';
import { Flag, Nation } from '../components/Flag';
import { MiniMap } from '../components/MiniMap';
import { Dialog, useConfirm, useToast } from '../components/overlay';
import { ChipList, NationPicker, ProvincePicker } from '../components/pickers';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Gauge,
  Icon,
  PageHead,
  SearchBox,
  SectionTitle,
  Spinner,
  Tabs,
  Win,
} from '../components/term';
import { CommitBar, RevisionPanel } from '../components/versioning';
import { T, fmt } from '../i18n';
import { TOO_CLOSE, colorDistance, isVioletLike } from '../lib/colors';
import { errorMessage } from '../lib/errors';
import { compact, num } from '../lib/format';
import { useNations, useProvinces } from '../lib/refs';
import { href, navigate, type MapTab } from '../lib/router';
import { rank } from '../lib/search';
import { useVersioned } from '../lib/useVersioned';

const MAP_LABELS: Record<string, string> = {
  name: T.map.name,
  iso: T.map.iso,
  kind: T.map.kind,
  color: T.map.color,
  capitalProvinceId: T.map.capital,
  nationId: T.map.owner,
  isCapital: T.map.isCapital,
  coastal: T.map.coastal,
  'income.money': `${T.map.income} : ${T.map.money}`,
  ...Object.fromEntries(
    RESOURCES.map((r) => [`income.${r}`, `${T.map.income} : ${T.resources[r]}`]),
  ),
  buildings: T.map.buildings,
  cityName: T.map.cityName,
  cityRank: T.map.cityRank,
  population: T.map.population,
  areaKm2: T.map.area,
  'cityPoint.0': `${T.map.cityPoint} (lng)`,
  'cityPoint.1': `${T.map.cityPoint} (lat)`,
  provinceIds: T.map.provinces,
  claimants: T.map.claimants,
  tension: T.map.tension,
  revoltRate: T.map.revoltRate,
};
const labelFor = (p: string) => MAP_LABELS[p] ?? MAP_LABELS[p.split('.')[0]!] ?? p;

export function MapScreen({ tab, id }: { tab: MapTab; id?: string }) {
  const { api } = useSession();
  const nations = useNations();
  const provinces = useProvinces();
  const disputed = useCached('disputed', () => api.listDisputed().then((r) => r.disputed));
  const n = nations.data?.length ?? 0;
  return (
    <>
      <PageHead
        title={T.map.title}
        sub={`${n} nations · ${provinces.data?.length ?? '…'} provinces · ${disputed.data?.length ?? '…'} territoires disputés`}
      />
      <Tabs
        value={tab}
        tabs={(['nations', 'provinces', 'disputed'] as const).map((k) => ({
          key: k,
          label: T.map.tabs[k],
          n:
            k === 'nations'
              ? n
              : k === 'provinces'
                ? provinces.data?.length
                : disputed.data?.length,
          href: href({ name: 'map', tab: k }),
        }))}
      />
      {(nations.error || provinces.error) && (
        <ErrorBox message={nations.error ?? provinces.error ?? ''} />
      )}
      {!nations.data || !provinces.data ? (
        <Spinner />
      ) : tab === 'nations' ? (
        <NationsTab nations={nations.data} provinces={provinces.data} id={id} />
      ) : tab === 'provinces' ? (
        <ProvincesTab nations={nations.data} provinces={provinces.data} id={id} />
      ) : (
        <DisputedTab
          nations={nations.data}
          provinces={provinces.data}
          disputed={disputed.data ?? []}
          id={id}
        />
      )}
    </>
  );
}

function useColorOf(
  nations: readonly NationDef[],
  provinces: readonly ProvinceDef[],
  override?: { nation?: NationDef | null; province?: ProvinceDef | null },
) {
  return useMemo(() => {
    const col = new Map(nations.map((n) => [n.id, n.color]));
    if (override?.nation) col.set(override.nation.id, override.nation.color);
    const owner = new Map(provinces.map((p) => [p.id, p.nationId]));
    if (override?.province) owner.set(override.province.id, override.province.nationId);
    return (pid: string) => col.get(owner.get(pid) ?? '') ?? '#1e2a36';
  }, [nations, provinces, override?.nation, override?.province]);
}

// ─────────── Nations ───────────

function NationsTab({
  nations,
  provinces,
  id,
}: {
  nations: NationDef[];
  provinces: ProvinceDef[];
  id?: string;
}) {
  const { api, cache } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of provinces) m.set(p.nationId, (m.get(p.nationId) ?? 0) + 1);
    return m;
  }, [provinces]);
  const list = useMemo(
    () =>
      rank(
        [...nations].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        q,
        (n) => `${n.id} ${n.iso} ${n.name}`,
      ),
    [nations, q],
  );
  const v = useVersioned<NationDef>({
    key: id ?? null,
    load: () => api.nation.get(id!),
    save: (d, m) => api.nation.save(id!, d, m),
    revert: (r, m) => api.nation.revert(id!, r, m),
    schema: NationDefSchema,
    labelFor,
    role: T.roles.balance,
    onWritten: () => cache.invalidate('nations', 'nations-public'),
  });
  const d = v.draft;
  const own = useMemo(
    () =>
      provinces.filter((p) => p.nationId === id).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [provinces, id],
  );
  const ownIds = useMemo(() => own.map((p) => p.id), [own]);
  const neighbours = useMemo(() => {
    const provOwner = new Map(provinces.map((p) => [p.id, p.nationId]));
    const set = new Set<string>();
    for (const p of own)
      for (const nb of p.neighbors) {
        const o = provOwner.get(nb);
        if (o && o !== id) set.add(o);
      }
    return nations.filter((n) => set.has(n.id));
  }, [own, provinces, nations, id]);
  const colorOf = useColorOf(nations, provinces, { nation: d && v.validation?.ok ? d : null });
  const onPick = useCallback(
    (pid: string) => {
      const o = provinces.find((p) => p.id === pid)?.nationId;
      if (o) navigate({ name: 'map', tab: 'nations', id: o });
    },
    [provinces],
  );
  const label = useCallback(
    (pid: string) => {
      const p = provinces.find((x) => x.id === pid);
      return p
        ? `${p.name} · ${nations.find((n) => n.id === p.nationId)?.name ?? p.nationId}`
        : pid;
    },
    [provinces, nations],
  );

  const warnings: string[] = [];
  if (d && isVioletLike(d.color)) warnings.push(T.map.violet);
  const close = d ? neighbours.filter((n) => colorDistance(n.color, d.color) < TOO_CLOSE) : [];
  if (close.length)
    warnings.push(fmt(T.map.tooClose, { list: close.map((n) => n.name).join(', ') }));

  const doMerge = async () => {
    if (!id || !mergeInto || !d) return;
    const into = nations.find((n) => n.id === mergeInto);
    const ok = await confirm({
      title: T.map.merge,
      danger: true,
      message: fmt(T.map.mergeConfirm, {
        from: d.name,
        into: into?.name ?? mergeInto,
        n: own.length,
      }),
      typeToConfirm: id,
      confirm: T.map.merge,
    });
    if (!ok) return;
    try {
      const r = await api.nation.merge(id, mergeInto, {
        message: `Fusion de ${d.name} dans ${into?.name ?? mergeInto}`,
      });
      cache.invalidate('provinces', 'nations', 'nations-public');
      toast(fmt(T.map.merged, { n: r.merged, into: into?.name ?? mergeInto }));
      navigate({ name: 'map', tab: 'nations', id: mergeInto });
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    }
  };

  return (
    <div className={`tri ${id ? 'has-sel' : ''}`}>
      <Win title={T.map.tabs.nations} className="list-pane" cmd="Get-Nation" flush>
        <div style={{ padding: 10 }}>
          <SearchBox value={q} onChange={setQ} placeholder={T.map.search} autoFocusKey />
        </div>
        <DataTable
          rows={list}
          rowKey={(n) => n.id}
          selected={id}
          bare
          onRowClick={(n) => navigate({ name: 'map', tab: 'nations', id: n.id })}
          columns={[
            {
              key: 'c',
              label: '',
              width: 36,
              render: (n) => <span className="swatch" style={{ background: n.color }} />,
            },
            {
              key: 'n',
              label: T.map.colName,
              sort: (n) => n.name,
              render: (n) => <Nation id={n.id} name={n.name} color={n.color} />,
            },
            {
              key: 'p',
              label: T.map.colProvinces,
              align: 'right',
              width: 52,
              sort: (n) => counts.get(n.id) ?? 0,
              render: (n) => counts.get(n.id) ?? 0,
            },
          ]}
        />
      </Win>
      <div className="detail-pane stack">
        <div className="show-m">
          {id && (
            <Button small onClick={() => navigate({ name: 'map', tab: 'nations' })}>
              <Icon name="back" size={12} /> {T.app.back}
            </Button>
          )}
        </div>
        <Win
          title={T.map.title}
          cmd={id ? `Get-Province -Owner ${id} | Show-Map` : 'Show-Map -World'}
          flush
          glyph="◍"
        >
          <MiniMap
            provinces={provinces}
            colorOf={colorOf}
            selected={ownIds}
            focus={ownIds}
            onPick={onPick}
            label={label}
          />
        </Win>
        {!id ? (
          <Win title={T.map.tabs.nations} glyph="?">
            <Empty glyph="◍">{T.map.selectNation}</Empty>
          </Win>
        ) : v.error ? (
          <ErrorBox message={v.error} onRetry={() => void v.reload()} />
        ) : !d ? (
          <Spinner />
        ) : (
          <FormProvider
            draft={d}
            set={v.set}
            errors={v.errors}
            changed={v.changed}
            labelFor={labelFor}
          >
            <Win
              title={d.name}
              path={`Carte\\Nations\\${id}`}
              glyph="◍"
              actions={<Flag id={d.id} color={d.color} />}
            >
              <div className="grid g2">
                <TextField path={['name']} />
                <TextField path={['iso']} />
                <SelectField
                  path={['kind']}
                  options={[
                    ['state', T.map.kinds.state],
                    ['entity', T.map.kinds.entity],
                  ]}
                />
                <SelectField
                  path={['capitalProvinceId']}
                  options={own.map(
                    (p) => [p.id, `${p.name}${p.cityName ? ` (${p.cityName})` : ''}`] as const,
                  )}
                />
                <ColorField />
              </div>
              <SectionTitle n={neighbours.length}>{T.map.neighbours}</SectionTitle>
              <div className="neigh">
                {neighbours.map((n) => (
                  <a
                    key={n.id}
                    className={`n ${colorDistance(n.color, d.color) < TOO_CLOSE ? 'bad' : ''}`}
                    href={href({ name: 'map', tab: 'nations', id: n.id })}
                  >
                    <span className="swatch" style={{ background: n.color }} />
                    {n.name}
                  </a>
                ))}
              </div>
              <SectionTitle>{T.map.merge}</SectionTitle>
              <p className="field-hint" style={{ marginBottom: 8 }}>
                {T.map.mergeHint}
              </p>
              <div className="row-wrap">
                <div style={{ flex: '1 1 240px', maxWidth: 360 }}>
                  <NationPicker
                    nations={nations}
                    exclude={new Set([id])}
                    value={mergeInto ?? ''}
                    placeholder={T.map.mergeInto}
                    onPick={setMergeInto}
                  />
                </div>
                <Button variant="danger" disabled={!mergeInto} onClick={() => void doMerge()}>
                  <Icon name="merge" size={14} /> {T.map.merge}
                </Button>
              </div>
            </Win>
          </FormProvider>
        )}
      </div>
      {id && d && (
        <div className="side-pane stack">
          <CommitBar
            valid={!!v.validation?.ok}
            issues={v.issues}
            changes={v.changes.length}
            dirty={v.dirty}
            busy={v.busy}
            warnings={warnings}
            onSave={v.save}
            onDiscard={v.discard}
          />
          <RevisionPanel
            revisions={v.revisions}
            source={v.source}
            current={v.original}
            busy={v.busy}
            onRestore={(r) => void v.restore(r)}
            labelFor={labelFor}
          />
        </div>
      )}
    </div>
  );
}

function ColorField() {
  const { f, errs, changed, value } = useFieldState(['color']);
  const c = typeof value === 'string' ? value : '#000000';
  const valid = /^#[0-9a-fA-F]{6}$/.test(c);
  return (
    <div className={`field ${errs.length ? 'field-error' : ''} ${changed ? 'field-changed' : ''}`}>
      <label htmlFor="nation-color">{T.map.color}</label>
      <div className="color-row">
        <input
          type="color"
          aria-label={T.map.color}
          value={valid ? c : '#000000'}
          onChange={(e) => f.set(['color'], e.target.value)}
        />
        <input
          id="nation-color"
          className="input"
          style={{ width: 110 }}
          value={c}
          onChange={(e) => f.set(['color'], e.target.value.trim())}
        />
        <span
          className="swatch lg"
          style={{ background: valid ? c : 'transparent' }}
          title={T.map.preview}
        />
        {valid && isVioletLike(c) && <Badge tone="crit">violet</Badge>}
      </div>
      {errs.map((e) => (
        <small key={e} className="field-msg">
          {e}
        </small>
      ))}
    </div>
  );
}

// ─────────── Provinces ───────────

function ProvincesTab({
  nations,
  provinces,
  id,
}: {
  nations: NationDef[];
  provinces: ProvinceDef[];
  id?: string;
}) {
  const { api, cache } = useSession();
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const byNation = useMemo(() => new Map(nations.map((n) => [n.id, n])), [nations]);
  const list = useMemo(
    () =>
      rank(
        owner ? provinces.filter((p) => p.nationId === owner) : provinces,
        q,
        (p) => `${p.id} ${p.name} ${p.cityName ?? ''} ${byNation.get(p.nationId)?.name ?? ''}`,
      ),
    [provinces, q, owner, byNation],
  );
  const v = useVersioned<ProvinceDef>({
    key: id ?? null,
    load: () => api.province.get(id!),
    save: (d, m) => api.province.save(id!, d, m),
    revert: (r, m) => api.province.revert(id!, r, m),
    reset: (m) => api.province.reset(id!, m),
    schema: ProvinceDefSchema,
    labelFor,
    role: T.roles.balance,
    onWritten: () => cache.invalidate('provinces'),
  });
  const d = v.draft;
  const colorOf = useColorOf(nations, provinces, { province: d && v.validation?.ok ? d : null });
  const sel = useMemo(() => (id ? [id] : []), [id]);
  const focus = useMemo(
    () =>
      d
        ? [d.id, ...d.neighbors]
        : owner
          ? provinces.filter((p) => p.nationId === owner).map((p) => p.id)
          : [],
    [d, owner, provinces],
  );
  const onPick = useCallback(
    (pid: string) => navigate({ name: 'map', tab: 'provinces', id: pid }),
    [],
  );
  const label = useCallback(
    (pid: string) => {
      const p = provinces.find((x) => x.id === pid);
      return p ? `${p.name} · ${byNation.get(p.nationId)?.name ?? p.nationId}` : pid;
    },
    [provinces, byNation],
  );

  return (
    <div className={`tri ${id ? 'has-sel' : ''}`}>
      <Win title={T.map.tabs.provinces} className="list-pane" cmd="Get-Province" flush>
        <div className="stack-sm" style={{ padding: 10 }}>
          <SearchBox value={q} onChange={setQ} placeholder={T.map.search} autoFocusKey />
          <select
            className="input"
            aria-label={T.map.owner}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">{T.app.all}</option>
            {[...nations]
              .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </div>
        <DataTable
          rows={list}
          rowKey={(p) => p.id}
          selected={id}
          bare
          onRowClick={(p) => navigate({ name: 'map', tab: 'provinces', id: p.id })}
          columns={[
            {
              key: 'n',
              label: T.map.colName,
              className: 'two',
              sort: (p) => p.name,
              render: (p) => (
                <>
                  <span className="row" style={{ gap: 6 }}>
                    <Flag id={p.nationId} color={byNation.get(p.nationId)?.color} />
                    <span className="ellipsis">{p.name}</span>
                    {p.isCapital && (
                      <span className="c-amber" title={T.map.isCapital}>
                        ★
                      </span>
                    )}
                  </span>
                  <span className="sub">
                    {p.id}
                    {p.cityName ? ` · ${p.cityName}` : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'i',
              label: T.map.colIncome,
              align: 'right',
              width: 72,
              sort: (p) => p.income.money,
              render: (p) => <span className="val">{num(p.income.money)}</span>,
            },
          ]}
        />
      </Win>
      <div className="detail-pane stack">
        <div className="show-m">
          {id && (
            <Button small onClick={() => navigate({ name: 'map', tab: 'provinces' })}>
              <Icon name="back" size={12} /> {T.app.back}
            </Button>
          )}
        </div>
        <Win
          title={T.map.title}
          cmd={id ? `Show-Map -Province ${id}` : 'Show-Map -World'}
          flush
          glyph="◍"
        >
          <MiniMap
            provinces={provinces}
            colorOf={colorOf}
            selected={sel}
            focus={focus}
            onPick={onPick}
            label={label}
          />
        </Win>
        {!id ? (
          <Win title={T.map.tabs.provinces} glyph="?">
            <Empty glyph="◍">{T.map.selectProvince}</Empty>
          </Win>
        ) : v.error ? (
          <ErrorBox message={v.error} onRetry={() => void v.reload()} />
        ) : !d ? (
          <Spinner />
        ) : (
          <FormProvider
            draft={d}
            set={v.set}
            errors={v.errors}
            changed={v.changed}
            labelFor={labelFor}
          >
            <Win
              title={d.name}
              path={`Carte\\Provinces\\${id}`}
              glyph="▰"
              actions={
                <Nation
                  id={d.nationId}
                  name={byNation.get(d.nationId)?.name}
                  color={byNation.get(d.nationId)?.color}
                  code={false}
                />
              }
            >
              <div className="grid g3">
                <TextField path={['name']} />
                <OwnerField nations={nations} />
                <div className="stack-sm" style={{ justifyContent: 'flex-end' }}>
                  <CheckField path={['isCapital']} />
                  <CheckField path={['coastal']} />
                </div>
              </div>
              <SectionTitle>{T.map.income}</SectionTitle>
              <div className="grid g4">
                <NumberField path={['income', 'money']} label={T.map.money} affix={compact} />
                {RESOURCES.map((r) => (
                  <NumberField key={r} path={['income', r]} optional label={T.resources[r]} />
                ))}
              </div>
              <SectionTitle n={d.buildings.length}>{T.map.buildings}</SectionTitle>
              <div className="chips">
                {BUILDING_TYPES.map((b) => {
                  const on = d.buildings.includes(b);
                  return (
                    <button
                      key={b}
                      type="button"
                      className={`chip ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        v.set(
                          ['buildings'],
                          on ? d.buildings.filter((x) => x !== b) : [...d.buildings, b],
                        )
                      }
                    >
                      {T.buildings[b]}
                    </button>
                  );
                })}
              </div>
              <SectionTitle>{T.map.city}</SectionTitle>
              <div className="grid g3">
                <TextField path={['cityName']} optional />
                <SelectField
                  path={['cityRank']}
                  asNumber
                  optional
                  options={[1, 2, 3, 4].map(
                    (r) => [String(r), `${r} · ${T.map.cityRanks[r]}`] as const,
                  )}
                />
                <NumberField path={['population']} optional affix={compact} />
                <NumberField path={['cityPoint', 0]} />
                <NumberField path={['cityPoint', 1]} />
                <NumberField path={['areaKm2']} affix={compact} />
              </div>
              <SectionTitle n={d.neighbors.length}>{T.map.neighbours}</SectionTitle>
              <div className="chips">
                {d.neighbors.map((nb) => {
                  const p = provinces.find((x) => x.id === nb);
                  return (
                    <a
                      key={nb}
                      className="chip"
                      href={href({ name: 'map', tab: 'provinces', id: nb })}
                    >
                      <Flag id={p?.nationId ?? ''} color={byNation.get(p?.nationId ?? '')?.color} />
                      {p?.name ?? nb}
                    </a>
                  );
                })}
              </div>
            </Win>
          </FormProvider>
        )}
      </div>
      {id && d && (
        <div className="side-pane stack">
          <CommitBar
            valid={!!v.validation?.ok}
            issues={v.issues}
            changes={v.changes.length}
            dirty={v.dirty}
            busy={v.busy}
            onSave={v.save}
            onDiscard={v.discard}
          />
          <RevisionPanel
            revisions={v.revisions}
            source={v.source}
            current={v.original}
            busy={v.busy}
            onRestore={(r) => void v.restore(r)}
            onReset={() => void v.reset()}
            labelFor={labelFor}
          />
        </div>
      )}
    </div>
  );
}

function OwnerField({ nations }: { nations: NationDef[] }) {
  const { f, errs, changed, value } = useFieldState(['nationId']);
  const n = nations.find((x) => x.id === value);
  return (
    <div className={`field ${errs.length ? 'field-error' : ''} ${changed ? 'field-changed' : ''}`}>
      <span className="field-label">{T.map.owner}</span>
      <NationPicker
        nations={nations}
        value={typeof value === 'string' ? value : ''}
        placeholder={T.map.owner}
        onPick={(id) => f.set(['nationId'], id)}
      />
      {n && <small className="field-hint">{n.id}</small>}
    </div>
  );
}

// ─────────── Territoires disputés ───────────

function DisputedTab({
  nations,
  provinces,
  disputed,
  id,
}: {
  nations: NationDef[];
  provinces: ProvinceDef[];
  disputed: DisputedArea[];
  id?: string;
}) {
  const { api, cache } = useSession();
  const [newOpen, setNewOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const byNation = useMemo(() => new Map(nations.map((n) => [n.id, n])), [nations]);
  const byProv = useMemo(() => new Map(provinces.map((p) => [p.id, p])), [provinces]);
  const v = useVersioned<DisputedArea>({
    key: id ?? null,
    load: () => api.disputed.get(id!),
    save: (d, m) => api.disputed.save(id!, d, m),
    revert: (r, m) => api.disputed.revert(id!, r, m),
    reset: (m) => api.disputed.reset(id!, m),
    schema: DisputedAreaSchema,
    labelFor,
    role: T.roles.balance,
    onWritten: () => cache.invalidate('disputed'),
    blank: () => ({
      id: id!,
      name: '',
      provinceIds: [],
      claimants: [],
      tension: 50,
      revoltRate: 0.02,
    }),
  });
  const d = v.draft;
  const base = useColorOf(nations, provinces);
  const inArea = useMemo(() => new Set(d?.provinceIds ?? []), [d?.provinceIds]);
  const colorOf = useCallback(
    (pid: string) => (inArea.has(pid) ? '#ffb020' : base(pid)),
    [inArea, base],
  );
  const sel = useMemo(
    () => d?.provinceIds ?? disputed.flatMap((x) => x.provinceIds),
    [d?.provinceIds, disputed],
  );
  const hl = useMemo(
    () => (d ? [...inArea] : disputed.flatMap((x) => x.provinceIds)),
    [d, inArea, disputed],
  );
  const onPick = useCallback(
    (pid: string) => {
      if (!d) {
        const hit = disputed.find((x) => x.provinceIds.includes(pid));
        if (hit) navigate({ name: 'map', tab: 'disputed', id: hit.id });
        return;
      }
      v.set(
        ['provinceIds'],
        inArea.has(pid) ? d.provinceIds.filter((x) => x !== pid) : [...d.provinceIds, pid],
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, inArea, disputed],
  );
  const label = useCallback(
    (pid: string) => {
      const p = byProv.get(pid);
      return p ? `${p.name} · ${byNation.get(p.nationId)?.name ?? p.nationId}` : pid;
    },
    [byProv, byNation],
  );

  return (
    <>
      <div className={`tri ${id ? 'has-sel' : ''}`}>
        <Win
          title={T.map.tabs.disputed}
          className="list-pane"
          cmd="Get-DisputedArea"
          flush
          actions={
            <Button
              small
              icon
              title={T.map.newDisputed}
              aria-label={T.map.newDisputed}
              onClick={() => setNewOpen(true)}
            >
              <Icon name="plus" size={12} />
            </Button>
          }
        >
          <DataTable
            rows={disputed}
            rowKey={(x) => x.id}
            selected={id}
            bare
            onRowClick={(x) => navigate({ name: 'map', tab: 'disputed', id: x.id })}
            columns={[
              {
                key: 'n',
                label: T.map.colName,
                className: 'two',
                render: (x) => (
                  <>
                    <b className="bright">{x.name}</b>
                    <span className="sub row" style={{ gap: 4 }}>
                      {x.claimants.map((c) => (
                        <Flag key={c} id={c} color={byNation.get(c)?.color} />
                      ))}
                    </span>
                  </>
                ),
              },
              {
                key: 't',
                label: T.map.colTension,
                width: 118,
                sort: (x) => x.tension,
                render: (x) => (
                  <Gauge
                    value={x.tension}
                    max={100}
                    color={x.tension >= 70 ? 'var(--t-red)' : 'var(--t-amber)'}
                    label={x.tension}
                  />
                ),
              },
            ]}
          />
        </Win>
        <div className="detail-pane stack">
          <div className="show-m">
            {id && (
              <Button small onClick={() => navigate({ name: 'map', tab: 'disputed' })}>
                <Icon name="back" size={12} /> {T.app.back}
              </Button>
            )}
          </div>
          <Win
            title={T.map.title}
            cmd={id ? `Show-Map -Disputed ${id}` : 'Show-Map -Disputed *'}
            flush
            glyph="◍"
            footer={d ? T.map.pickOnMap : undefined}
          >
            <MiniMap
              provinces={provinces}
              colorOf={colorOf}
              selected={sel}
              highlight={hl.length ? hl : null}
              focus={d ? d.provinceIds : hl}
              onPick={onPick}
              label={label}
            />
          </Win>
          {!id ? (
            <Win title={T.map.tabs.disputed} glyph="?">
              <Empty glyph="◍">{T.map.selectDisputed}</Empty>
            </Win>
          ) : v.error ? (
            <ErrorBox message={v.error} onRetry={() => void v.reload()} />
          ) : !d ? (
            <Spinner />
          ) : (
            <FormProvider
              draft={d}
              set={v.set}
              errors={v.errors}
              changed={v.changed}
              labelFor={labelFor}
            >
              <Win title={d.name || id} path={`Carte\\Disputes\\${id}`} glyph="⚔">
                <div className="grid g3">
                  <TextField path={['name']} />
                  <NumberField path={['revoltRate']} />
                  <div className="field">
                    <label htmlFor="tension">
                      {T.map.tension} <span className="c-amber">{num(d.tension)}</span>
                    </label>
                    <input
                      id="tension"
                      className="tension"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={d.tension}
                      onChange={(e) => v.set(['tension'], Number(e.target.value))}
                    />
                  </div>
                </div>
                <SectionTitle n={d.claimants.length}>{T.map.claimants}</SectionTitle>
                <ChipList
                  values={d.claimants}
                  label={(c) => (
                    <Nation
                      id={c}
                      name={byNation.get(c)?.name}
                      color={byNation.get(c)?.color}
                      code={false}
                    />
                  )}
                  onRemove={(c) =>
                    v.set(
                      ['claimants'],
                      d.claimants.filter((x) => x !== c),
                    )
                  }
                  picker={
                    <NationPicker
                      nations={nations}
                      exclude={new Set(d.claimants)}
                      placeholder={`${T.app.add}…`}
                      onPick={(c) => v.set(['claimants'], [...d.claimants, c])}
                    />
                  }
                />
                <SectionTitle n={d.provinceIds.length}>{T.map.provinces}</SectionTitle>
                <ChipList
                  values={d.provinceIds}
                  label={(p) => (
                    <>
                      <Flag id={byProv.get(p)?.nationId ?? ''} />
                      {byProv.get(p)?.name ?? p}
                    </>
                  )}
                  onRemove={(p) =>
                    v.set(
                      ['provinceIds'],
                      d.provinceIds.filter((x) => x !== p),
                    )
                  }
                  picker={
                    <ProvincePicker
                      provinces={provinces}
                      nations={byNation}
                      exclude={inArea}
                      placeholder={T.map.addProvince}
                      onPick={(p) => v.set(['provinceIds'], [...d.provinceIds, p])}
                    />
                  }
                />
                <p className="dim small" style={{ marginTop: 8 }}>
                  {T.map.pickOnMap}
                </p>
              </Win>
            </FormProvider>
          )}
        </div>
        {id && d && (
          <div className="side-pane stack">
            <CommitBar
              valid={!!v.validation?.ok}
              issues={v.issues}
              changes={v.changes.length}
              dirty={v.dirty}
              busy={v.busy}
              isNew={v.isNew}
              onSave={v.save}
              onDiscard={v.discard}
            />
            {!v.isNew && (
              <RevisionPanel
                revisions={v.revisions}
                source={v.source}
                current={v.original}
                busy={v.busy}
                onRestore={(r) => void v.restore(r)}
                onReset={() => void v.reset()}
                labelFor={labelFor}
              />
            )}
          </div>
        )}
      </div>
      {newOpen && (
        <Dialog
          title={T.map.newDisputed}
          onClose={() => setNewOpen(false)}
          actions={
            <>
              <Button onClick={() => setNewOpen(false)}>{T.app.cancel}</Button>
              <Button
                variant="primary"
                disabled={!/^[a-z0-9-]{2,64}$/.test(newId) || disputed.some((x) => x.id === newId)}
                onClick={() => {
                  setNewOpen(false);
                  navigate({ name: 'map', tab: 'disputed', id: newId });
                }}
              >
                {T.app.create}
              </Button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-did">{T.map.newId}</label>
            <input id="new-did" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
          </div>
        </Dialog>
      )}
    </>
  );
}
