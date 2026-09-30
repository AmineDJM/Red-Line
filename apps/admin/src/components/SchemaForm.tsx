/**
 * Formulaire construit à partir d'un schéma zod (introspection de lib/schema.ts) : nombres avec plage,
 * défaut et unité, interrupteurs, listes, enregistrements clé → valeur, tableaux d'objets, sections
 * facultatives activables. Utilisé par l'éditeur de règles et les blocs facultatifs des fiches d'arme.
 */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import type { AdminSystem } from '@redline/shared';
import { T } from '../i18n';
import type { HelpEntry, Unit } from '../i18n/rules';
import { compact, humanize, hours, num, pct, usd } from '../lib/format';
import { getIn, pathKey, type Path } from '../lib/paths';
import { initialValue, rangeLabel, type SNode } from '../lib/schema';
import {
  CheckField,
  ListField,
  NumberField,
  NumListField,
  SelectField,
  TextField,
  useFieldState,
  useForm,
  Wrap,
} from './fields';
import { SystemPicker } from './pickers';
import { Badge, Button, Icon } from './term';

export interface SchemaEnv {
  help: (helpKey: string) => HelpEntry | undefined;
  /** Suggestions de clés pour un enregistrement (ex. types de bâtiments). */
  keysFor?: (helpKey: string) => readonly string[] | undefined;
  keyLabel?: (helpKey: string, key: string) => string;
  systems?: readonly AdminSystem[];
  /** Blocs repliés par défaut au-delà de cette profondeur. */
  openDepth?: number;
}
const Env = createContext<SchemaEnv>({ help: () => undefined });

export function SchemaProvider({ env, children }: { env: SchemaEnv; children: ReactNode }) {
  return <Env.Provider value={env}>{children}</Env.Provider>;
}

export function affixFor(unit: Unit | undefined, v: number): string | undefined {
  switch (unit) {
    case '$':
      return usd(v);
    case 'frac':
      return pct(v, 2);
    case 'x':
      return `× ${num(v)}`;
    case 'min':
      return v >= 60 ? `= ${hours(v / 60)}` : `${num(v)} min`;
    case 'h':
      return v >= 48 ? `= ${hours(v)}` : `${num(v)} h`;
    case 'j':
      return `${num(v)} j`;
    case 'km':
      return `${num(v)} km`;
    case 'kmh':
      return `${num(v)} km/h`;
    default:
      return Math.abs(v) >= 10_000 ? compact(v) : undefined;
  }
}

function metaLine(node: SNode, unit?: Unit): ReactNode {
  const parts: ReactNode[] = [];
  const r = rangeLabel(node);
  if (r) parts.push(`${T.rules.range} ${r}`);
  if (
    node.hasDefault &&
    (typeof node.default === 'number' ||
      typeof node.default === 'boolean' ||
      typeof node.default === 'string')
  ) {
    const d =
      typeof node.default === 'number'
        ? (affixFor(unit, node.default) ?? num(node.default))
        : String(node.default);
    parts.push(
      <span key="d" className="def">
        {T.rules.default} {d}
      </span>,
    );
  }
  return parts.length ? (
    <span className="sf-meta">
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </span>
  ) : null;
}

function labelOf(env: SchemaEnv, helpKey: string, key: string | number): string {
  return env.help(helpKey)?.[0] ?? humanize(String(key));
}

/** Rendu d'un nœud à un chemin. `helpKey` = chemin sans index ni clé d'enregistrement. */
export function SchemaNodeField(p: {
  node: SNode;
  path: Path;
  helpKey: string;
  name: string | number;
  depth?: number;
  label?: string;
  flat?: boolean;
}) {
  const env = useContext(Env);
  const { node, path, helpKey } = p;
  const h = env.help(helpKey);
  const label = p.label ?? labelOf(env, helpKey, p.name);
  const help = h?.[1];
  const unit = h?.[2];
  const hint = (
    <>
      {help && <span className="sf-help">{help} </span>}
      {metaLine(node, unit)}
    </>
  );
  const depth = p.depth ?? 0;
  switch (node.t) {
    case 'number':
      return (
        <NumberField
          path={path}
          label={label}
          hint={hint}
          optional={node.optional}
          nullable={node.nullable}
          affix={(v) => affixFor(unit, v) ?? ''}
        />
      );
    case 'boolean':
      return <CheckField path={path} label={label} hint={help} />;
    case 'enum':
      return (
        <SelectField
          path={path}
          label={label}
          optional={node.optional && !node.hasDefault}
          options={node.options.map((o) => [o, o] as const)}
          hint={hint}
        />
      );
    case 'literal':
      return <TextField path={path} label={label} hint={hint} />;
    case 'string':
      if (/systemId$/i.test(String(p.name)) && env.systems)
        return <SystemField path={path} label={label} hint={help} optional={node.optional} />;
      return <TextField path={path} label={label} hint={hint} optional={node.optional} />;
    case 'array':
    case 'tuple': {
      const items = node.t === 'array' ? [node.of] : node.items;
      if (items.every((i) => i.t === 'number'))
        return <NumListField path={path} label={label} hint={hint} />;
      if (items.every((i) => i.t === 'string' || i.t === 'enum'))
        return <ListField path={path} label={label} hint={help} />;
      if (node.t === 'array')
        return (
          <ArrayBlock
            node={node}
            path={path}
            helpKey={helpKey}
            label={label}
            help={help}
            depth={depth}
            flat={p.flat}
          />
        );
      return <RawBlock path={path} label={label} help={help} />;
    }
    case 'record':
      return (
        <RecordBlock
          node={node}
          path={path}
          helpKey={helpKey}
          label={label}
          help={help}
          depth={depth}
          flat={p.flat}
        />
      );
    case 'object':
      return (
        <ObjectBlock
          node={node}
          path={path}
          helpKey={helpKey}
          label={label}
          help={help}
          depth={depth}
        />
      );
    default:
      return <RawBlock path={path} label={label} help={help} />;
  }
}

/** Champs d'un objet dans une grille (sans cadre). */
export function SchemaFields(p: {
  node: SNode & { t: 'object' };
  path: Path;
  helpKey: string;
  depth?: number;
}) {
  return (
    <div className="sf-obj">
      {Object.entries(p.node.shape).map(([k, child]) => (
        <SchemaNodeField
          key={k}
          node={child}
          path={[...p.path, k]}
          helpKey={p.helpKey ? `${p.helpKey}.${k}` : k}
          name={k}
          depth={(p.depth ?? 0) + 1}
        />
      ))}
    </div>
  );
}

function BlockHead(p: {
  label: string;
  count?: ReactNode;
  errs: number;
  changed: boolean;
  right?: ReactNode;
}) {
  return (
    <>
      <b>{p.label}</b>
      {p.count}
      {p.changed && <span className="c-amber tiny">●</span>}
      {p.errs > 0 && <Badge tone="crit">{p.errs}</Badge>}
      {p.right && <span style={{ marginLeft: 'auto' }}>{p.right}</span>}
    </>
  );
}

function ObjectBlock(p: {
  node: SNode & { t: 'object' };
  path: Path;
  helpKey: string;
  label: string;
  help?: string;
  depth: number;
}) {
  const { f, errs, changed, value } = useFieldState(p.path);
  const env = useContext(Env);
  if (value === undefined && p.node.optional) {
    return (
      <div className="sf-block">
        <div className="sf-block-head">
          <BlockHead
            label={p.label}
            errs={0}
            changed={changed}
            right={
              <Button small onClick={() => f.set(p.path, initialValue(p.node))}>
                {T.rules.customize}
              </Button>
            }
          />
        </div>
      </div>
    );
  }
  return (
    <details className="sf-block" open={p.depth <= (env.openDepth ?? 2)}>
      <summary>
        <BlockHead
          label={p.label}
          errs={errs.length}
          changed={changed}
          right={
            p.node.optional && !p.node.hasDefault ? (
              <Button
                small
                variant="ghost"
                onClick={(e) => {
                  e.preventDefault();
                  f.set(p.path, undefined);
                }}
              >
                {T.app.remove}
              </Button>
            ) : undefined
          }
        />
      </summary>
      <div className="sf-body">
        {p.help && <p className="sf-help">{p.help}</p>}
        <SchemaFields node={p.node} path={p.path} helpKey={p.helpKey} depth={p.depth} />
      </div>
    </details>
  );
}

function RecordBlock(p: {
  node: SNode & { t: 'record' };
  path: Path;
  helpKey: string;
  label: string;
  help?: string;
  depth: number;
  flat?: boolean;
}) {
  const env = useContext(Env);
  const { f, errs, changed, value } = useFieldState(p.path);
  const [newKey, setNewKey] = useState('');
  const listId = useId();
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const keys = Object.keys(obj);
  const suggestions = (p.node.keys ?? env.keysFor?.(p.helpKey) ?? []).filter(
    (k) => !keys.includes(k),
  );
  const scalar =
    p.node.value.t === 'number' || p.node.value.t === 'string' || p.node.value.t === 'boolean';
  const add = () => {
    const k = newKey.trim();
    if (!k || k in obj) return;
    f.set(p.path, { ...obj, [k]: initialValue(p.node.value) });
    setNewKey('');
  };
  const remove = (k: string) => {
    const next = { ...obj };
    delete next[k];
    f.set(p.path, next);
  };
  const keyLabel = (k: string) => env.keyLabel?.(p.helpKey, k) ?? k;
  const body = (
    <>
      {p.help && !p.flat && <p className="sf-help">{p.help}</p>}
      <div className="sf-rows">
        {keys.map((k) =>
          scalar ? (
            <div key={k} className="sf-row">
              <span className="key" title={k}>
                {keyLabel(k)}
                {keyLabel(k) !== k && <span className="dim tiny"> · {k}</span>}
              </span>
              <ScalarInline node={p.node.value} path={[...p.path, k]} helpKey={p.helpKey} />
              <Button
                small
                icon
                variant="ghost"
                aria-label={`${T.app.remove} ${k}`}
                onClick={() => remove(k)}
              >
                <Icon name="close" size={12} />
              </Button>
            </div>
          ) : (
            <details
              key={k}
              className="sf-block"
              style={{ gridColumn: 'auto' }}
              open={keys.length <= 4}
            >
              <summary>
                <b>{keyLabel(k)}</b>
                {keyLabel(k) !== k && <span className="dim tiny">{k}</span>}
                <Button
                  small
                  variant="ghost"
                  style={{ marginLeft: 'auto' }}
                  onClick={(e) => {
                    e.preventDefault();
                    remove(k);
                  }}
                >
                  {T.app.remove}
                </Button>
              </summary>
              <div className="sf-body">
                {p.node.value.t === 'object' ? (
                  <SchemaFields
                    node={p.node.value}
                    path={[...p.path, k]}
                    helpKey={p.helpKey}
                    depth={p.depth + 1}
                  />
                ) : (
                  <SchemaNodeField
                    node={p.node.value}
                    path={[...p.path, k]}
                    helpKey={p.helpKey}
                    name={k}
                    label={keyLabel(k)}
                    depth={p.depth + 1}
                    flat
                  />
                )}
              </div>
            </details>
          ),
        )}
      </div>
      <div className="sf-add">
        <input
          className="input"
          list={listId}
          value={newKey}
          placeholder={T.rules.addKey}
          aria-label={T.rules.addKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s}>
              {keyLabel(s)}
            </option>
          ))}
        </datalist>
        <Button small onClick={add} disabled={!newKey.trim() || newKey.trim() in obj}>
          <Icon name="plus" size={12} /> {T.app.add}
        </Button>
      </div>
    </>
  );
  if (p.flat) return <div className="field-wide">{body}</div>;
  return (
    <details className="sf-block" open={p.depth <= (env.openDepth ?? 2)}>
      <summary>
        <BlockHead
          label={p.label}
          count={<span className="dim tiny">{keys.length}</span>}
          errs={errs.length}
          changed={changed}
        />
      </summary>
      <div className="sf-body">{body}</div>
    </details>
  );
}

/** Scalaire sans libellé (ligne d'enregistrement). */
function ScalarInline(p: { node: SNode; path: Path; helpKey: string }) {
  const env = useContext(Env);
  const unit = env.help(p.helpKey)?.[2];
  if (p.node.t === 'number')
    return <NumberField path={p.path} label="" affix={(v) => affixFor(unit, v) ?? ''} />;
  if (p.node.t === 'boolean') return <CheckField path={p.path} label="" />;
  return <TextField path={p.path} label="" />;
}

function ArrayBlock(p: {
  node: SNode & { t: 'array' };
  path: Path;
  helpKey: string;
  label: string;
  help?: string;
  depth: number;
  flat?: boolean;
}) {
  const env = useContext(Env);
  const { f, errs, changed, value } = useFieldState(p.path);
  const arr = Array.isArray(value) ? value : [];
  const item = p.node.of;
  const remove = (i: number) =>
    f.set(
      p.path,
      arr.filter((_, j) => j !== i),
    );
  const add = () => f.set(p.path, [...arr, initialValue(item)]);
  const full = p.node.maxLength !== undefined && arr.length >= p.node.maxLength;
  const body = (
    <>
      {p.help && !p.flat && <p className="sf-help">{p.help}</p>}
      <div className="sf-rows">
        {arr.map((_, i) => (
          <div
            key={i}
            className="row"
            style={{
              alignItems: 'flex-end',
              gap: 10,
              paddingBottom: 8,
              borderBottom: '1px solid var(--t-line)',
            }}
          >
            <span className="dim tiny" style={{ width: 22, paddingBottom: 8 }}>
              {i + 1}.
            </span>
            <div className="grow">
              {item.t === 'object' ? (
                <div
                  className="sf-obj"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
                >
                  {Object.entries(item.shape).map(([k, child]) => (
                    <SchemaNodeField
                      key={k}
                      node={child}
                      path={[...p.path, i, k]}
                      helpKey={`${p.helpKey}.${k}`}
                      name={k}
                      depth={p.depth + 2}
                    />
                  ))}
                </div>
              ) : (
                <SchemaNodeField
                  node={item}
                  path={[...p.path, i]}
                  helpKey={p.helpKey}
                  name={i}
                  depth={p.depth + 1}
                />
              )}
            </div>
            <Button
              small
              icon
              variant="ghost"
              aria-label={`${T.app.remove} ${i + 1}`}
              onClick={() => remove(i)}
              style={{ marginBottom: 4 }}
            >
              <Icon name="close" size={12} />
            </Button>
          </div>
        ))}
      </div>
      <div className="sf-add">
        <Button small onClick={add} disabled={full}>
          <Icon name="plus" size={12} /> {T.rules.addRow}
        </Button>
      </div>
    </>
  );
  if (p.flat) return <div className="field-wide">{body}</div>;
  return (
    <details className="sf-block" open={p.depth <= (env.openDepth ?? 2)}>
      <summary>
        <BlockHead
          label={p.label}
          count={<span className="dim tiny">{arr.length}</span>}
          errs={errs.length}
          changed={changed}
        />
      </summary>
      <div className="sf-body">{body}</div>
    </details>
  );
}

/** Valeur non structurée : édition JSON locale. */
function RawBlock(p: { path: Path; label: string; help?: string }) {
  const { f, key, errs, changed, value } = useFieldState(p.path);
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState<string | null>(null);
  return (
    <Wrap
      id={id}
      label={p.label}
      errs={bad ? [bad, ...errs] : errs}
      changed={changed}
      wide
      hint={p.help}
      pathKey={key}
    >
      <textarea
        id={id}
        className="json-editor"
        style={{ minHeight: 120 }}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            f.set(p.path, JSON.parse(e.target.value));
            setBad(null);
          } catch (err) {
            setBad(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </Wrap>
  );
}

function SystemField(p: { path: Path; label: string; hint?: string; optional?: boolean }) {
  const env = useContext(Env);
  const { key, errs, changed, value } = useFieldState(p.path);
  const f = useForm();
  const id = useId();
  const sys = env.systems?.find((s) => s.system.id === value);
  return (
    <Wrap
      id={id}
      label={p.label}
      errs={errs}
      changed={changed}
      hint={sys ? `${sys.system.name} · ${T.categories[sys.system.category]}` : p.hint}
      pathKey={key}
    >
      <SystemPicker
        systems={env.systems ?? []}
        value={typeof value === 'string' ? value : ''}
        placeholder={T.orbat.addSystem}
        onPick={(sid) => f.set(p.path, sid)}
      />
    </Wrap>
  );
}

/** Compte les erreurs d'un sous-arbre (navigation par section). */
export function countUnder(errors: ReadonlyMap<string, string[]>, prefix: string): number {
  let n = 0;
  for (const [k, v] of errors) if (k === prefix || k.startsWith(`${prefix}.`)) n += v.length;
  return n;
}

export { getIn, pathKey };
