/**
 * Éditeur structuré de data/balance : sections construites depuis BalanceSchema, aide contextuelle,
 * validation zod en direct, portée (nouvelles parties / en cours), historique et retour arrière.
 */
import { useMemo, useState } from 'react';
import {
  BUILDING_TYPES,
  BalanceSchema,
  CATEGORIES,
  RESOURCES,
  type Balance,
} from '@redline/shared';
import { useSession } from '../context';
import { FormProvider } from '../components/fields';
import {
  SchemaFields,
  SchemaNodeField,
  SchemaProvider,
  affixFor,
  countUnder,
} from '../components/SchemaForm';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  PageHead,
  SearchBox,
  Seg,
  Spinner,
  Win,
} from '../components/term';
import { CommitBar, RevisionPanel } from '../components/versioning';
import { T, fmt } from '../i18n';
import { RULE_HELP, RULE_SECTIONS } from '../i18n/rules';
import { humanize } from '../lib/format';
import { getIn } from '../lib/paths';
import { useSystems } from '../lib/refs';
import { navigate } from '../lib/router';
import { describe, rangeLabel, type SNode } from '../lib/schema';
import { matches } from '../lib/search';
import { useVersioned } from '../lib/useVersioned';

const ROOT = describe(BalanceSchema) as SNode & { t: 'object' };
const SECTIONS = Object.keys(ROOT.shape);

/** Chemin de données → clé d'aide (sans index de tableau ni clé d'enregistrement). */
export function helpKeyOf(path: string): string {
  const parts = path.split('.');
  const out: string[] = [];
  let node: SNode | null = ROOT;
  for (const p of parts) {
    if (!node) break;
    if (node.t === 'object') {
      out.push(p);
      node = node.shape[p] ?? null;
    } else if (node.t === 'array') node = node.of;
    else if (node.t === 'record') node = node.value;
    else if (node.t === 'tuple') node = node.items[Number(p)] ?? null;
    else break;
  }
  return out.join('.');
}

export function ruleLabel(path: string): string {
  const k = helpKeyOf(path);
  const section = k.split('.')[0]!;
  const label = RULE_HELP[k]?.[0] ?? humanize(k.split('.').at(-1) ?? k);
  return k === section
    ? (RULE_SECTIONS[section]?.[0] ?? label)
    : `${RULE_SECTIONS[section]?.[0] ?? section} › ${label}`;
}

const KEY_SETS: Record<string, readonly string[]> = {
  'buildings.effects': BUILDING_TYPES,
  'buildings.buildHours': BUILDING_TYPES,
  'buildings.buildCostUsd': BUILDING_TYPES,
  'buildings.levels': BUILDING_TYPES,
  'startingForces.stackMax': CATEGORIES,
  'economy.startingResources': RESOURCES,
};
function keyLabel(helpKey: string, key: string): string {
  const set = KEY_SETS[helpKey];
  if (set === BUILDING_TYPES) return T.buildings[key as keyof typeof T.buildings] ?? key;
  if (set === CATEGORIES) return T.categories[key as keyof typeof T.categories] ?? key;
  if (set === RESOURCES) return T.resources[key as keyof typeof T.resources] ?? key;
  return key;
}

interface Leaf {
  path: (string | number)[];
  helpKey: string;
  node: SNode;
  text: string;
}
/** Feuilles et blocs de l'arbre (recherche transversale). */
function leaves(node: SNode, path: string[], helpKey: string, out: Leaf[] = []): Leaf[] {
  if (node.t === 'object') {
    for (const [k, c] of Object.entries(node.shape))
      leaves(c, [...path, k], helpKey ? `${helpKey}.${k}` : k, out);
    return out;
  }
  const h = RULE_HELP[helpKey];
  out.push({ path, helpKey, node, text: `${helpKey} ${h?.[0] ?? ''} ${h?.[1] ?? ''}` });
  return out;
}
const ALL_LEAVES = leaves(ROOT, [], '');

/** Nœud du schéma pour une clé d'aide (traverse tableaux et enregistrements sans consommer de segment). */
function nodeForHelpKey(helpKey: string): SNode | null {
  let n: SNode | null = ROOT;
  for (const part of helpKey.split('.')) {
    while (n && (n.t === 'array' || n.t === 'record')) n = n.t === 'array' ? n.of : n.value;
    if (!n || n.t !== 'object') return null;
    n = n.shape[part] ?? null;
  }
  return n;
}

export function RulesScreen({ section: routeSection }: { section?: string }) {
  const { api, cache } = useSession();
  const systems = useSystems().data ?? undefined;
  const section = routeSection && SECTIONS.includes(routeSection) ? routeSection : 'time';
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const v = useVersioned<Balance>({
    key: 'rules',
    load: async () => {
      const r = await api.getRules();
      return { data: r.rules, revisions: r.revisions, source: r.source };
    },
    save: (data, m) => api.saveRules(data, m),
    revert: (id, m) => api.revertRules(id, m),
    reset: (m) => api.resetRules(m),
    schema: BalanceSchema,
    labelFor: ruleLabel,
    role: T.roles.balance,
    onWritten: () => cache.invalidate('rules'),
  });

  const env = useMemo(
    () => ({
      help: (k: string) => RULE_HELP[k],
      keysFor: (k: string) => KEY_SETS[k],
      keyLabel,
      systems,
      openDepth: 2,
    }),
    [systems],
  );
  const found = useMemo(() => (q.trim() ? ALL_LEAVES.filter((l) => matches(l.text, q)) : []), [q]);

  if (v.error) return <ErrorBox message={v.error} onRetry={() => void v.reload()} />;
  if (!v.draft) return <Spinner />;

  const node = ROOT.shape[section]!;
  const present = getIn(v.draft, [section]) !== undefined;
  const helpK = focus ? helpKeyOf(focus) : null;
  const help = helpK ? RULE_HELP[helpK] : null;
  const helpNode = helpK ? nodeForHelpKey(helpK) : null;

  const switchMode = (m: 'form' | 'json') => {
    if (m === 'json') {
      setJsonText(JSON.stringify(v.draft, null, 2));
      setJsonErr(null);
    }
    setMode(m);
  };

  return (
    <>
      <PageHead
        title={T.rules.title}
        sub={fmt(T.rules.sub, { n: SECTIONS.length })}
        actions={
          <Seg
            value={mode}
            onChange={switchMode}
            options={[
              ['form', T.rules.formToggle],
              ['json', T.rules.jsonToggle],
            ]}
          />
        }
      />
      <div className="rules">
        <Win title={T.rules.sections} className="nav-col sticky-col" glyph="§">
          <div className="stack-sm">
            <SearchBox value={q} onChange={setQ} placeholder={T.rules.search} autoFocusKey />
            <nav className="secnav" aria-label={T.rules.sections}>
              {SECTIONS.map((s) => {
                const errs = countUnder(v.errors, s);
                const ch = [...v.changed].some((c) => c === s || c.startsWith(`${s}.`));
                const opt = ROOT.shape[s]!.optional;
                const absent = getIn(v.draft, [s]) === undefined;
                return (
                  <button
                    key={s}
                    type="button"
                    className={s === section && !q ? 'on' : ''}
                    onClick={() => {
                      setQ('');
                      navigate({ name: 'rules', section: s });
                    }}
                  >
                    <span className={absent ? 'dim' : ''}>
                      {RULE_SECTIONS[s]?.[0] ?? humanize(s)}
                    </span>
                    <span className="n">
                      {ch && <span className="c-amber tiny">●</span>}
                      {errs > 0 && <Badge tone="crit">{errs}</Badge>}
                      {opt && absent && <span className="opt">·</span>}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>
        </Win>

        <div className="stack" style={{ minWidth: 0 }}>
          {mode === 'json' ? (
            <Win
              title="data/balance/default.json"
              cmd="Get-Content data/balance/default.json | ConvertFrom-Json"
            >
              <textarea
                className="json-editor"
                style={{ minHeight: '60vh' }}
                spellCheck={false}
                value={jsonText}
                aria-label="JSON"
                onChange={(e) => {
                  setJsonText(e.target.value);
                  try {
                    v.setDraft(JSON.parse(e.target.value) as Balance);
                    setJsonErr(null);
                  } catch (err) {
                    setJsonErr(
                      fmt(T.rules.invalidJson, {
                        msg: err instanceof Error ? err.message : String(err),
                      }),
                    );
                  }
                }}
              />
              {jsonErr && <ErrorBox message={jsonErr} />}
            </Win>
          ) : (
            <FormProvider
              draft={v.draft}
              set={v.set}
              errors={v.errors}
              changed={v.changed}
              labelFor={(k) => RULE_HELP[helpKeyOf(k)]?.[0] ?? humanize(k.split('.').at(-1) ?? k)}
              onFocusPath={setFocus}
            >
              <SchemaProvider env={env}>
                {q.trim() ? (
                  <Win
                    title={fmt(T.rules.results, { n: found.length })}
                    cmd={`Get-Rule *${q.trim()}*`}
                  >
                    {found.length === 0 ? (
                      <Empty>{T.rules.noResults}</Empty>
                    ) : (
                      <div className="stack">
                        {found.slice(0, 60).map((l) => {
                          const sec = String(l.path[0]);
                          const sectionAbsent = getIn(v.draft, [sec]) === undefined;
                          return (
                            <div key={l.helpKey} className="stack-sm">
                              <span className="dim tiny upper">
                                {RULE_SECTIONS[sec]?.[0] ?? sec}
                              </span>
                              {sectionAbsent ? (
                                <span className="muted small">
                                  {T.rules.absent}{' '}
                                  <Button
                                    small
                                    onClick={() => navigate({ name: 'rules', section: sec })}
                                  >
                                    {T.app.open}
                                  </Button>
                                </span>
                              ) : (
                                <div className="sf-obj">
                                  <SchemaNodeField
                                    node={l.node}
                                    path={l.path}
                                    helpKey={l.helpKey}
                                    name={String(l.path.at(-1))}
                                    depth={1}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Win>
                ) : (
                  <Win
                    title={RULE_SECTIONS[section]?.[0] ?? humanize(section)}
                    path={`Regles\\${section}`}
                    cmd={`Set-Rule -Section ${section}`}
                    glyph="§"
                  >
                    <p className="muted small" style={{ marginBottom: 14 }}>
                      {RULE_SECTIONS[section]?.[1]}
                      {node.optional && <Badge tone="off">{T.rules.optional}</Badge>}
                    </p>
                    {node.optional && !present ? (
                      <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
                        <p className="small">{T.rules.absent}</p>
                        <SchemaNodeField
                          node={node}
                          path={[section]}
                          helpKey={section}
                          name={section}
                          depth={0}
                        />
                      </div>
                    ) : node.t === 'object' ? (
                      <>
                        <SchemaFields node={node} path={[section]} helpKey={section} />
                        {node.optional && (
                          <div style={{ marginTop: 16 }}>
                            <Button
                              small
                              variant="ghost"
                              onClick={() => v.set([section], undefined)}
                            >
                              {T.rules.removeSection}
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="sf-obj">
                        <SchemaNodeField
                          node={node}
                          path={[section]}
                          helpKey={section}
                          name={section}
                          depth={0}
                        />
                      </div>
                    )}
                  </Win>
                )}
              </SchemaProvider>
            </FormProvider>
          )}
        </div>

        <div className="stack side-col sticky-col">
          <CommitBar
            valid={!!v.validation?.ok && !jsonErr}
            issues={v.issues}
            changes={v.changes.length}
            dirty={v.dirty}
            busy={v.busy}
            onSave={v.save}
            onDiscard={v.discard}
            onIssueClick={(p) => navigate({ name: 'rules', section: p.split('.')[0]! })}
          />
          <Win title={T.rules.help} glyph="?" className="help-col">
            <div className="help-panel">
              {helpK ? (
                <>
                  <h3>{help?.[0] ?? humanize(helpK.split('.').at(-1) ?? helpK)}</h3>
                  <span className="path">{focus}</span>
                  {help?.[1] && <p>{help[1]}</p>}
                  {helpNode && rangeLabel(helpNode) && (
                    <p className="small">
                      {T.rules.range} : <span className="c-amber">{rangeLabel(helpNode)}</span>
                    </p>
                  )}
                  {helpNode?.hasDefault && typeof helpNode.default === 'number' && (
                    <p className="small">
                      {T.rules.default} :{' '}
                      <span className="c-cyan">
                        {affixFor(help?.[2], helpNode.default) ?? String(helpNode.default)}
                      </span>
                    </p>
                  )}
                </>
              ) : (
                <p className="dim small">{T.rules.helpEmpty}</p>
              )}
            </div>
          </Win>
          <RevisionPanel
            revisions={v.revisions}
            source={v.source}
            current={v.original}
            busy={v.busy}
            onRestore={(r) => void v.restore(r)}
            onReset={() => void v.reset()}
            labelFor={ruleLabel}
          />
        </div>
      </div>
    </>
  );
}
