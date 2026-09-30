/** Arbre de recherche : graphe par branche et par rang, édition des nœuds, systèmes débloqués. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MODIFIER_KEYS,
  RESEARCH_BRANCHES,
  RESOURCES,
  ResearchNodeSchema,
  type ResearchNode,
} from '@redline/shared';
import { useSession } from '../context';
import { FormProvider, NumberField, SelectField, TextField } from '../components/fields';
import { Dialog } from '../components/overlay';
import { ChipList, Combo } from '../components/pickers';
import { SchemaNodeField, SchemaProvider } from '../components/SchemaForm';
import {
  Button,
  Empty,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  SectionTitle,
  Spinner,
  Win,
} from '../components/term';
import { CommitBar, RevisionPanel } from '../components/versioning';
import { HexIcon } from '../components/weapon';
import { T, fmt } from '../i18n';
import { describe, type SNode } from '../lib/schema';
import { hours, usd } from '../lib/format';
import { useResearch, useSystems } from '../lib/refs';
import { href, navigate } from '../lib/router';
import { matches } from '../lib/search';
import { useVersioned } from '../lib/useVersioned';
import {
  COL_GAP,
  LABEL_W,
  NODE_H,
  NODE_W,
  edgePath,
  findCycle,
  layout,
  relatives,
} from '../lib/researchGraph';

const SHAPE = (describe(ResearchNodeSchema) as SNode & { t: 'object' }).shape;
const COST_RES = (SHAPE.cost as SNode & { t: 'object' }).shape.resources!;
const EFFECTS = SHAPE.effects!;
const LABELS: Record<string, string> = {
  name: T.research.name,
  description: T.research.description,
  branch: T.research.branch,
  tier: T.research.tier,
  'cost.money': `${T.research.cost} ($)`,
  'cost.resources': `${T.research.cost} (ressources)`,
  durationH: `${T.research.duration} (h)`,
  requires: T.research.requires,
  effects: T.research.effects,
  eraYear: T.research.era,
  id: 'Identifiant',
};

export function ResearchScreen({ id }: { id?: string }) {
  const { api, cache } = useSession();
  const { data: nodes, error, reload } = useResearch();
  const systems = useSystems().data ?? [];
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newId, setNewId] = useState('research.');
  const wrap = useRef<HTMLDivElement>(null);

  const v = useVersioned<ResearchNode>({
    key: id ?? null,
    load: () => api.research.get(id!),
    save: (d, m) => api.research.save(id!, d, m),
    revert: (r, m) => api.research.revert(id!, r, m),
    reset: (m) => api.research.reset(id!, m),
    schema: ResearchNodeSchema,
    labelFor: (p) => LABELS[p] ?? p,
    role: T.roles.balance,
    onWritten: () => cache.invalidate('research'),
    blank: () => {
      const branch = (id?.split('.')[1] ?? 'industry') as ResearchNode['branch'];
      return {
        id: id!,
        name: '',
        description: '',
        branch: RESEARCH_BRANCHES.includes(branch) ? branch : 'industry',
        tier: 1,
        cost: { money: 100_000_000, resources: {} },
        durationH: 24,
        requires: [],
        effects: {},
      };
    },
  });

  const all = useMemo(() => nodes ?? [], [nodes]);
  // Le brouillon remplace le nœud enregistré dans le graphe (aperçu des prérequis en direct).
  const graphNodes = useMemo(() => {
    if (!v.draft || !id) return all;
    const d = v.draft;
    return all.some((n) => n.id === id)
      ? all.map((n) => (n.id === id ? { ...n, ...d } : n))
      : [...all, d];
  }, [all, v.draft, id]);
  const g = useMemo(() => layout(graphNodes), [graphNodes]);
  const rel = useMemo(() => (id ? relatives(graphNodes, id) : null), [graphNodes, id]);
  const hits = useMemo(
    () =>
      q.trim()
        ? new Set(
            graphNodes
              .filter((n) => matches(`${n.id} ${n.name} ${n.description}`, q))
              .map((n) => n.id),
          )
        : null,
    [graphNodes, q],
  );
  const unlocked = useMemo(
    () => (id ? systems.filter((s) => s.system.requires.includes(id)) : []),
    [systems, id],
  );

  // Centre le nœud sélectionné dans la vue.
  useEffect(() => {
    const p = id ? g.placed.get(id) : null;
    const el = wrap.current;
    if (!p || !el) return;
    el.scrollTo({
      left: Math.max(0, p.x - el.clientWidth / 2 + NODE_W / 2),
      top: Math.max(0, p.y - el.clientHeight / 2),
      behavior: 'smooth',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodes]);

  const warnings = useMemo(() => {
    const w: string[] = [];
    const d = v.draft;
    if (!d) return w;
    const byId = new Map(all.map((n) => [n.id, n]));
    for (const r of d.requires ?? []) {
      const n = byId.get(r);
      if (!n) w.push(fmt(T.research.unknownReq, { id: r }));
      else if (n.branch === d.branch && n.tier >= d.tier)
        w.push(fmt(T.research.tierOrder, { id: r }));
    }
    const c = findCycle(all, d);
    if (c) w.push(fmt(T.research.cycle, { path: c.join(' → ') }));
    return w;
  }, [v.draft, all]);

  const pickHit = () => {
    const first = hits && [...hits][0];
    if (first) navigate({ name: 'research', id: first });
  };

  return (
    <>
      <PageHead
        title={T.research.title}
        sub={fmt(T.research.sub, { n: all.length, b: new Set(all.map((n) => n.branch)).size })}
        actions={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={14} /> {T.research.newNode}
          </Button>
        }
      />
      <div className="split-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
        <Win
          title={T.research.title}
          cmd="Get-ResearchTree | Format-Graph"
          flush
          footer={
            <div className="legend">
              <span>
                <i style={{ background: 'var(--t-amber)' }} />
                {T.research.legendReq}
              </span>
              <span>
                <i style={{ background: 'var(--t-cyan)' }} />
                {T.research.legendUnl}
              </span>
              <span>
                <i
                  style={{
                    background:
                      'repeating-linear-gradient(90deg,#4a6275 0 3px,transparent 3px 6px)',
                  }}
                />
                {T.research.legendCross}
              </span>
            </div>
          }
        >
          <div style={{ padding: 10, borderBottom: '1px solid var(--t-line)' }}>
            <div className="row">
              <SearchBox
                value={q}
                onChange={setQ}
                placeholder={T.research.search}
                autoFocusKey
                onKeyDown={(e) => e.key === 'Enter' && pickHit()}
              />
              {hits && <span className="dim small">{hits.size}</span>}
            </div>
          </div>
          {error && <ErrorBox message={error} onRetry={reload} />}
          {!nodes && !error && <Spinner />}
          {nodes && (
            <div className="graph-wrap" ref={wrap} style={{ border: 0, borderRadius: 0 }}>
              <div className="graph-labels" aria-hidden>
                {g.lanes.map((l) => (
                  <div key={l.branch} style={{ top: l.y, height: l.h }}>
                    <b>{T.branches[l.branch as keyof typeof T.branches] ?? l.branch}</b>
                    <span>{graphNodes.filter((n) => n.branch === l.branch).length} nœuds</span>
                  </div>
                ))}
              </div>
              <svg
                className="graph"
                width={g.width}
                height={g.height}
                role="img"
                aria-label={T.research.title}
              >
                {g.lanes.map((l, i) => (
                  <g key={l.branch}>
                    <rect
                      className="lane-bg"
                      x={0}
                      y={l.y}
                      width={g.width}
                      height={l.h}
                      opacity={i % 2 ? 0.5 : 1}
                    />
                  </g>
                ))}
                {Array.from({ length: g.maxTier + 1 }, (_, t) => (
                  <text
                    key={t}
                    className="tier-label"
                    x={LABEL_W + t * (NODE_W + COL_GAP) + 4}
                    y={16}
                  >
                    {T.research.tier} {t}
                  </text>
                ))}
                {graphNodes.flatMap((n) =>
                  n.requires.map((r) => {
                    const a = g.placed.get(r);
                    const b = g.placed.get(n.id);
                    if (!a || !b) return null;
                    const hotUp =
                      id &&
                      (n.id === id || rel?.ancestors.has(n.id)) &&
                      (r === id || rel?.ancestors.has(r));
                    const hotDown =
                      id && (r === id || rel?.descendants.has(r)) && rel?.descendants.has(n.id);
                    return (
                      <path
                        key={`${r}>${n.id}`}
                        className={`edge ${a.node.branch !== b.node.branch ? 'cross' : ''} ${hotUp ? 'hot-up' : hotDown ? 'hot' : ''}`}
                        d={edgePath(a, b)}
                      />
                    );
                  }),
                )}
                {[...g.placed.values()].map(({ node: n, x, y }) => {
                  const cls = [
                    'node',
                    n.id === id ? 'sel' : '',
                    rel?.ancestors.has(n.id) ? 'anc' : '',
                    rel?.descendants.has(n.id) ? 'desc' : '',
                    hits ? (hits.has(n.id) ? 'match' : 'dimmed') : '',
                  ].join(' ');
                  const gates = systems.filter((s) => s.system.requires.includes(n.id)).length;
                  return (
                    <g
                      key={n.id}
                      className={cls}
                      transform={`translate(${x},${y})`}
                      onClick={() => navigate({ name: 'research', id: n.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && navigate({ name: 'research', id: n.id })
                      }
                    >
                      <title>{`${n.name}\n${n.id}\n${n.description}`}</title>
                      <rect width={NODE_W} height={NODE_H} rx={3} />
                      <text className="nm" x={9} y={17}>
                        {n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
                      </text>
                      <text className="id" x={9} y={32}>
                        {n.id.replace(/^research\./, '').slice(0, 20)}
                      </text>
                      <text className="cost" x={NODE_W - 8} y={32} textAnchor="end">
                        {usd(n.cost.money)}
                      </text>
                      {gates > 0 && (
                        <rect className="gate" x={0} y={8} width={2} height={NODE_H - 16} />
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </Win>

        <div className="stack sticky-col">
          {!id ? (
            <Win title={T.research.title} glyph="?">
              <Empty glyph="◇">{T.research.select}</Empty>
            </Win>
          ) : v.error ? (
            <ErrorBox message={v.error} onRetry={() => void v.reload()} />
          ) : !v.draft ? (
            <Spinner />
          ) : (
            <>
              <Win title={v.draft.name || id} path={`Recherche\\${id}`} glyph="◇">
                <FormProvider
                  draft={v.draft}
                  set={v.set}
                  errors={v.errors}
                  changed={v.changed}
                  labelFor={(k) => LABELS[k] ?? k}
                >
                  <SchemaProvider
                    env={{
                      help: (k) =>
                        k.startsWith('effects')
                          ? [T.research.effects, 'Clés reconnues : MODIFIER_KEYS (moteur).']
                          : undefined,
                      keysFor: (k) =>
                        k === 'effects'
                          ? MODIFIER_KEYS
                          : k === 'cost.resources'
                            ? RESOURCES
                            : undefined,
                      keyLabel: (k, key) =>
                        k === 'cost.resources'
                          ? (T.resources[key as keyof typeof T.resources] ?? key)
                          : key,
                      openDepth: 5,
                    }}
                  >
                    <div className="stack">
                      <p className="dim small">{id}</p>
                      <TextField path={['name']} />
                      <TextField path={['description']} multiline />
                      <div className="grid g2">
                        <SelectField
                          path={['branch']}
                          options={RESEARCH_BRANCHES.map((b) => [b, T.branches[b]] as const)}
                        />
                        <NumberField path={['tier']} />
                        <NumberField path={['cost', 'money']} affix={usd} />
                        <NumberField path={['durationH']} affix={hours} />
                        <NumberField path={['eraYear']} optional />
                      </div>
                      <SchemaNodeField
                        node={COST_RES}
                        path={['cost', 'resources']}
                        helpKey="cost.resources"
                        name="resources"
                        label={LABELS['cost.resources']}
                        depth={3}
                      />
                      <div className="field">
                        <span className="field-label">{T.research.requires}</span>
                        <ChipList
                          values={v.draft.requires}
                          label={(r) => (
                            <a href={href({ name: 'research', id: r })}>
                              {all.find((n) => n.id === r)?.name ?? r}
                            </a>
                          )}
                          onRemove={(r) =>
                            v.set(
                              ['requires'],
                              v.draft!.requires.filter((x) => x !== r),
                            )
                          }
                          picker={
                            <Combo
                              items={all.filter(
                                (n) => n.id !== id && !v.draft!.requires.includes(n.id),
                              )}
                              text={(n) => `${n.id} ${n.name}`}
                              render={(n) => (
                                <span className="ellipsis">
                                  {n.name} <span className="dim">{n.id}</span>
                                </span>
                              )}
                              hint={(n) => `${T.branches[n.branch]} · ${n.tier}`}
                              placeholder={`${T.app.add}…`}
                              onPick={(n) => v.set(['requires'], [...v.draft!.requires, n.id])}
                            />
                          }
                        />
                      </div>
                      <SchemaNodeField
                        node={EFFECTS}
                        path={['effects']}
                        helpKey="effects"
                        name="effects"
                        label={T.research.effects}
                        depth={3}
                      />
                      <SectionTitle n={rel?.children.length ?? 0}>
                        {T.research.unlocks}
                      </SectionTitle>
                      <div className="chips">
                        {(rel?.children ?? []).map((c) => (
                          <a key={c} className="chip" href={href({ name: 'research', id: c })}>
                            {all.find((n) => n.id === c)?.name ?? c}
                          </a>
                        ))}
                      </div>
                      <SectionTitle n={unlocked.length}>{T.research.systems}</SectionTitle>
                      {unlocked.length === 0 ? (
                        <p className="dim small">{T.research.noSystems}</p>
                      ) : (
                        <div className="stack-sm">
                          {unlocked.slice(0, 40).map((s) => (
                            <a
                              key={s.system.id}
                              href={href({ name: 'system', id: s.system.id })}
                              className="row small"
                            >
                              <HexIcon icon={s.system.icon || s.system.category} size={20} />
                              <span className="ellipsis">{s.system.name}</span>
                              <span className="dim" style={{ marginLeft: 'auto' }}>
                                {usd(s.system.unitPriceUsd)}
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </SchemaProvider>
                </FormProvider>
              </Win>
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
                  labelFor={(p) => LABELS[p] ?? p}
                />
              )}
            </>
          )}
        </div>
      </div>
      {newOpen && (
        <Dialog
          title={T.research.newNode}
          onClose={() => setNewOpen(false)}
          actions={
            <>
              <Button onClick={() => setNewOpen(false)}>{T.app.cancel}</Button>
              <Button
                variant="primary"
                disabled={!/^research\.[a-z0-9.-]+$/.test(newId) || all.some((n) => n.id === newId)}
                onClick={() => {
                  setNewOpen(false);
                  navigate({ name: 'research', id: newId });
                }}
              >
                {T.app.create}
              </Button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-rid">{T.research.newId}</label>
            <input id="new-rid" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
          </div>
        </Dialog>
      )}
    </>
  );
}
