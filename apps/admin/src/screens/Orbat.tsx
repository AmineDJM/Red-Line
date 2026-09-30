/** ORBAT : budget de défense réel et arsenal estimé par jeu de données (2025, 1985…) et par nation. */
import { useEffect, useMemo, useState } from 'react';
import { DOCTRINES, OrbatSchema, type AdminSystem, type Orbat } from '@redline/shared';
import { useCached, useSession } from '../context';
import { DataTable, type Column } from '../components/DataTable';
import { FormProvider, NumberField, SelectField, TextField } from '../components/fields';
import { Nation } from '../components/Flag';
import { ChipList, GatePicker, SystemPicker } from '../components/pickers';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  SectionTitle,
  Spinner,
  Stat,
  Tabs,
  Win,
} from '../components/term';
import { CommitBar, RevisionPanel } from '../components/versioning';
import { Thumb } from '../components/weapon';
import { T, fmt } from '../i18n';
import { compact, num, usd } from '../lib/format';
import { useNations, usePhotos, useResearch, useSystems } from '../lib/refs';
import { href, navigate } from '../lib/router';
import { matches, rank } from '../lib/search';
import { useVersioned } from '../lib/useVersioned';

type Item = Orbat['inventory'][number];
const LABELS: Record<string, string> = {
  defenseBudgetUsd: T.orbat.budgetShort,
  activePersonnel: T.orbat.personnel,
  year: T.orbat.year,
  doctrine: T.orbat.doctrine,
  confidence: T.orbat.confidence,
  description: T.orbat.description,
  doctrineText: T.orbat.doctrineText,
  inventory: T.orbat.inventory,
  research: T.orbat.research,
  licences: T.orbat.licences,
  sources: T.orbat.sources,
};
const labelFor = (p: string) => {
  const m = /^inventory\.(\d+)\.(\w+)$/.exec(p);
  if (m)
    return `${T.orbat.inventory} n° ${Number(m[1]) + 1} : ${m[2] === 'count' ? T.orbat.colCount : m[2]}`;
  return LABELS[p.split('.')[0]!] ?? p;
};

export function OrbatScreen({ set: routeSet, nation }: { set?: string; nation?: string }) {
  const { api, cache } = useSession();
  const sets = useCached('orbat-sets', () => api.orbatSets().then((r) => r.sets));
  const nations = useNations().data ?? [];
  const setIds = Object.keys(sets.data ?? {})
    .sort()
    .reverse();
  const set = routeSet ?? setIds[0] ?? '2025';
  const inSet = useMemo(() => new Set(sets.data?.[set] ?? []), [sets.data, set]);
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      rank(
        [...nations].sort(
          (a, b) =>
            Number(inSet.has(b.id)) - Number(inSet.has(a.id)) || a.name.localeCompare(b.name, 'fr'),
        ),
        q,
        (n) => `${n.id} ${n.name}`,
      ),
    [nations, inSet, q],
  );

  return (
    <>
      <PageHead title={T.orbat.title} sub={T.orbat.sub} />
      <Tabs
        value={set}
        tabs={(setIds.length ? setIds : [set]).map((s) => ({
          key: s,
          label: `${T.orbat.set} ${s}`,
          n: sets.data?.[s]?.length ?? 0,
          href: href({ name: 'orbat', set: s, nation }),
        }))}
      />
      {sets.error && <ErrorBox message={sets.error} onRetry={sets.reload} />}
      <div className={`tri ${nation ? 'has-sel' : ''}`}>
        <Win
          title={fmt(T.orbat.nations, { n: inSet.size })}
          className="list-pane"
          cmd={`Get-Orbat -Set ${set}`}
          flush
        >
          <div style={{ padding: 10 }}>
            <SearchBox value={q} onChange={setQ} placeholder={T.orbat.search} autoFocusKey />
          </div>
          <DataTable
            rows={list}
            rowKey={(n) => n.id}
            selected={nation}
            onRowClick={(n) => navigate({ name: 'orbat', set, nation: n.id })}
            rowClass={(n) => (inSet.has(n.id) ? '' : 'off')}
            bare
            columns={[
              {
                key: 'n',
                label: T.map.colName,
                render: (n) => <Nation id={n.id} name={n.name} color={n.color} />,
              },
              {
                key: 'o',
                label: 'ORBAT',
                align: 'right',
                width: 70,
                render: (n) =>
                  inSet.has(n.id) ? <Badge tone="ok">{set}</Badge> : <span className="dim">—</span>,
              },
            ]}
          />
        </Win>
        {nation ? (
          <OrbatEditor
            key={`${set}/${nation}`}
            set={set}
            nation={nation}
            onWritten={() => cache.invalidate('orbat-sets')}
          />
        ) : (
          <div className="detail-pane">
            <Win title={T.orbat.title} glyph="?">
              <Empty glyph="⛨">{T.orbat.select}</Empty>
            </Win>
          </div>
        )}
      </div>
    </>
  );
}

function OrbatEditor({
  set,
  nation,
  onWritten,
}: {
  set: string;
  nation: string;
  onWritten: () => void;
}) {
  const { api } = useSession();
  const systems = useSystems().data ?? [];
  const research = useResearch().data ?? [];
  const photos = usePhotos().data ?? {};
  const nations = useNations().data ?? [];
  const nat = nations.find((n) => n.id === nation);
  const key = `${set}/${nation}`;
  const [invQ, setInvQ] = useState('');
  const v = useVersioned<Orbat>({
    key,
    load: () => api.orbat.get(key),
    save: (d, m) => api.orbat.save(key, d, m),
    revert: (r, m) => api.orbat.revert(key, r, m),
    reset: (m) => api.orbat.reset(key, m),
    schema: OrbatSchema,
    labelFor,
    role: T.roles.balance,
    onWritten,
    blank: () => ({
      nationId: nation,
      year: Number(set) || 2025,
      doctrine: 'other',
      defenseBudgetUsd: 0,
      inventory: [],
      research: [],
      licences: [],
      sources: [],
      confidence: 'medium',
    }),
  });
  const sysById = useMemo(() => new Map(systems.map((s) => [s.system.id, s])), [systems]);
  const d = v.draft;
  const known = useMemo(() => new Set(d?.research ?? []), [d?.research]);

  const warnings = useMemo(() => {
    if (!d) return [];
    const w: string[] = [];
    const seen = new Set<string>();
    for (const it of d.inventory) {
      if (!sysById.has(it.systemId) && systems.length)
        w.push(fmt(T.orbat.unknownSystem, { id: it.systemId }));
      if (seen.has(it.systemId)) w.push(fmt(T.orbat.duplicateSystem, { id: it.systemId }));
      seen.add(it.systemId);
    }
    return w;
  }, [d, sysById, systems.length]);

  if (v.error)
    return (
      <div className="detail-pane">
        <ErrorBox message={v.error} onRetry={() => void v.reload()} />
      </div>
    );
  if (!d)
    return (
      <div className="detail-pane">
        <Spinner />
      </div>
    );

  const rows = d.inventory.map((it, i) => ({ it, i, s: sysById.get(it.systemId) }));
  const shown = invQ.trim()
    ? rows.filter((r) =>
        matches(`${r.it.systemId} ${r.s?.system.name ?? ''} ${r.it.variant ?? ''}`, invQ),
      )
    : rows;
  const value = rows.reduce((a, r) => a + r.it.count * (r.s?.system.unitPriceUsd ?? 0), 0);
  const elements = rows.reduce((a, r) => a + r.it.count, 0);
  const missing = (s: AdminSystem | undefined) =>
    s ? s.system.requires.filter((g) => !known.has(g)) : [];
  const setItem = (i: number, k: keyof Item, val: unknown) => v.set(['inventory', i, k], val);

  const cols: Column<(typeof rows)[number]>[] = [
    {
      key: 'p',
      label: '',
      width: 60,
      render: (r) => (
        <Thumb
          photo={r.s ? (r.s.system.photo ?? photos[r.s.system.id]) : null}
          icon={r.s?.system.icon ?? '?'}
        />
      ),
    },
    {
      key: 's',
      label: T.orbat.colSystem,
      className: 'two',
      sort: (r) => r.s?.system.name ?? r.it.systemId,
      render: (r) => (
        <>
          {r.s ? (
            <a
              href={href({ name: 'system', id: r.it.systemId })}
              onClick={(e) => e.stopPropagation()}
            >
              {r.s.system.name}
            </a>
          ) : (
            <span className="c-red">{r.it.systemId}</span>
          )}
          <span className="sub">
            {r.s ? `${T.categories[r.s.system.category]} · ${r.it.systemId}` : '?'}
          </span>
        </>
      ),
    },
    {
      key: 'c',
      label: T.orbat.colCount,
      align: 'right',
      sort: (r) => r.it.count,
      render: (r) => (
        <input
          className="input num"
          style={{ width: 84, textAlign: 'right', height: 26 }}
          inputMode="numeric"
          aria-label={T.orbat.colCount}
          value={r.it.count}
          onChange={(e) =>
            setItem(
              r.i,
              'count',
              e.target.value === '' ? 0 : Math.max(0, Math.round(Number(e.target.value) || 0)),
            )
          }
        />
      ),
    },
    {
      key: 'v',
      label: T.orbat.colVariant,
      hideM: true,
      render: (r) => (
        <input
          className="input"
          style={{ height: 26, minWidth: 120 }}
          aria-label={T.orbat.colVariant}
          value={r.it.variant ?? ''}
          onChange={(e) => setItem(r.i, 'variant', e.target.value || undefined)}
        />
      ),
    },
    {
      key: 'val',
      label: T.orbat.colValue,
      align: 'right',
      sort: (r) => r.it.count * (r.s?.system.unitPriceUsd ?? 0),
      render: (r) => (
        <span className="val">{usd(r.it.count * (r.s?.system.unitPriceUsd ?? 0))}</span>
      ),
    },
    {
      key: 'prod',
      label: T.orbat.colProduce,
      hideM: true,
      render: (r) => {
        const m = missing(r.s);
        return m.length ? (
          <Badge tone="warn" title={fmt(T.orbat.cannotProduceHint, { gates: m.join(', ') })}>
            {T.orbat.cannotProduce}
          </Badge>
        ) : (
          <Badge tone="ok">{T.orbat.canProduce}</Badge>
        );
      },
    },
    {
      key: 'x',
      label: '',
      width: 34,
      render: (r) => (
        <Button
          small
          icon
          variant="ghost"
          aria-label={T.app.remove}
          onClick={(e) => (
            e.stopPropagation(),
            v.set(
              ['inventory'],
              d.inventory.filter((_, j) => j !== r.i),
            )
          )}
        >
          <Icon name="close" size={12} />
        </Button>
      ),
    },
  ];

  return (
    <FormProvider draft={d} set={v.set} errors={v.errors} changed={v.changed} labelFor={labelFor}>
      <div className="detail-pane stack">
        <div className="show-m">
          <Button small onClick={() => navigate({ name: 'orbat', set })}>
            <Icon name="back" size={12} /> {T.app.back}
          </Button>
        </div>
        <Win
          title={nat?.name ?? nation}
          path={`ORBAT\\${set}\\${nation}`}
          cmd={`Get-Orbat ${nation} -Set ${set}`}
          glyph="⛨"
          actions={v.isNew ? <Badge tone="info">{T.orbat.newOrbat}</Badge> : null}
        >
          {v.isNew && (
            <p className="note warn" style={{ marginBottom: 12 }}>
              {T.orbat.missing}
            </p>
          )}
          <div className="stats" style={{ marginBottom: 14 }}>
            <Stat
              k={T.orbat.budget}
              v={usd(d.defenseBudgetUsd)}
              d={fmt(T.orbat.perDay, { v: usd(d.defenseBudgetUsd / 365) })}
              tone="var(--t-amber)"
            />
            <Stat k={T.orbat.totals} v={usd(value)} />
            <Stat
              k={T.orbat.units}
              v={compact(elements)}
              d={`${rows.length} ${T.orbat.items.toLowerCase()}`}
            />
            <Stat k={T.orbat.personnel} v={compact(d.activePersonnel ?? null)} />
          </div>
          <div className="grid g3">
            <NumberField path={['defenseBudgetUsd']} affix={usd} />
            <NumberField path={['activePersonnel']} optional affix={(n) => compact(n)} />
            <NumberField path={['year']} />
            <SelectField
              path={['doctrine']}
              options={DOCTRINES.map((k) => [k, T.doctrines[k]] as const)}
            />
            <SelectField
              path={['confidence']}
              options={(['high', 'medium', 'low'] as const).map(
                (k) => [k, T.orbat.confidences[k]] as const,
              )}
            />
          </div>
          <div className="grid g2" style={{ marginTop: 12 }}>
            <TextField path={['description']} multiline optional />
            <TextField path={['doctrineText']} multiline optional />
          </div>
        </Win>
        <Win
          title={T.orbat.inventory}
          glyph="≡"
          cmd={`$orbat.inventory | Measure-Object count -Sum  # ${num(elements)}`}
        >
          <div className="toolbar">
            <SearchBox value={invQ} onChange={setInvQ} placeholder={T.app.search} />
            <div style={{ flex: '1 1 260px', maxWidth: 380 }}>
              <SystemPicker
                systems={systems}
                exclude={new Set(d.inventory.map((x) => x.systemId))}
                onPick={(id) => v.set(['inventory'], [...d.inventory, { systemId: id, count: 1 }])}
              />
            </div>
          </div>
          <DataTable
            rows={shown}
            columns={cols}
            rowKey={(r) => `${r.i}:${r.it.systemId}`}
            maxHeight={480}
            empty={T.app.none}
          />
        </Win>
        <Win title={T.orbat.research} glyph="◇">
          <p className="field-hint" style={{ marginBottom: 10 }}>
            {T.orbat.researchHint}
          </p>
          <GatePicker
            nodes={research}
            value={d.research}
            onChange={(r) => v.set(['research'], r)}
          />
          <SectionTitle>{T.orbat.licences}</SectionTitle>
          <ChipList
            values={d.licences}
            label={(id) => sysById.get(id)?.system.name ?? id}
            onRemove={(id) =>
              v.set(
                ['licences'],
                d.licences.filter((x) => x !== id),
              )
            }
            picker={
              <SystemPicker
                systems={systems}
                exclude={new Set(d.licences)}
                placeholder={`${T.app.add}…`}
                onPick={(id) => v.set(['licences'], [...d.licences, id])}
              />
            }
          />
          <SectionTitle>{T.orbat.sources}</SectionTitle>
          <div className="field">
            <LinesInput
              value={d.sources}
              onChange={(l) => v.set(['sources'], l)}
              label={T.orbat.sources}
            />
            <small className="field-hint">{T.orbat.sourcesHint}</small>
          </div>
        </Win>
      </div>
      <div className="side-pane stack">
        <CommitBar
          valid={!!v.validation?.ok}
          issues={v.issues}
          changes={v.changes.length}
          dirty={v.dirty}
          busy={v.busy}
          isNew={v.isNew}
          warnings={warnings}
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
    </FormProvider>
  );
}

/** Zone de texte « une valeur par ligne » (texte local : les lignes vides restent saisissables). */
function LinesInput({
  value,
  onChange,
  label,
}: {
  value: readonly string[];
  onChange: (l: string[]) => void;
  label: string;
}) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => {
    const cur = text
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    if (JSON.stringify(cur) !== JSON.stringify(value)) setText(value.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <textarea
      className="input"
      rows={3}
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
