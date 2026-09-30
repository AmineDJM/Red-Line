/** Sélecteurs avec recherche : systèmes du catalogue, nations, provinces, portes de recherche. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminSystem, NationDef, ProvinceDef, ResearchNode } from '@redline/shared';
import { T } from '../i18n';
import { usd } from '../lib/format';
import { rank } from '../lib/search';
import { Nation } from './Flag';

/** Liste déroulante avec recherche au clavier (↑ ↓ Entrée Échap). */
export function Combo<I>(p: {
  items: readonly I[];
  text: (i: I) => string;
  render: (i: I) => ReactNode;
  hint?: (i: I) => ReactNode;
  onPick: (i: I) => void;
  placeholder?: string;
  limit?: number;
  id?: string;
  /** Garder le texte après sélection (sélecteur simple) au lieu de vider (ajout à une liste). */
  keep?: string;
  ariaLabel?: string;
}) {
  const [q, setQ] = useState(p.keep ?? '');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setQ(p.keep ?? ''), [p.keep]);
  const results = useMemo(
    () => (open ? rank(p.items, q === p.keep ? '' : q, p.text, p.limit ?? 40) : []),
    [open, q, p.items, p.text, p.limit, p.keep],
  );
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ(p.keep ?? '');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, p.keep]);
  const pick = (i: I) => {
    p.onPick(i);
    setOpen(false);
    if (p.keep === undefined) setQ('');
  };
  return (
    <div className="picker" ref={box}>
      <input
        id={p.id}
        className="input"
        value={q}
        placeholder={p.placeholder}
        aria-label={p.ariaLabel ?? p.placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(results.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const r = results[hi];
            if (r) pick(r);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
            setQ(p.keep ?? '');
          }
        }}
      />
      {open && results.length > 0 && (
        <div className="picker-menu" role="listbox">
          {results.map((r, i) => (
            <div
              key={i}
              role="option"
              aria-selected={i === hi}
              className={`picker-opt ${i === hi ? 'on' : ''}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
            >
              {p.render(r)}
              {p.hint && <span className="hint">{p.hint(r)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const sysText = (s: AdminSystem) =>
  `${s.system.id} ${s.system.name} ${T.categories[s.system.category]} ${s.system.roles.join(' ')}`;

export function SystemPicker(p: {
  systems: readonly AdminSystem[];
  onPick: (id: string) => void;
  placeholder?: string;
  value?: string;
  exclude?: ReadonlySet<string>;
}) {
  const items = useMemo(
    () => (p.exclude ? p.systems.filter((s) => !p.exclude!.has(s.system.id)) : p.systems),
    [p.systems, p.exclude],
  );
  return (
    <Combo
      items={items}
      text={sysText}
      keep={
        p.value === undefined
          ? undefined
          : (p.systems.find((s) => s.system.id === p.value)?.system.name ?? p.value)
      }
      placeholder={p.placeholder ?? T.orbat.addSystem}
      render={(s) => (
        <span className="ellipsis">
          <b>{s.system.name}</b> <span className="dim">{s.system.id}</span>
        </span>
      )}
      hint={(s) => (
        <>
          {T.categories[s.system.category]} ·{' '}
          <span className="c-amber">{usd(s.system.unitPriceUsd)}</span>
        </>
      )}
      onPick={(s) => p.onPick(s.system.id)}
    />
  );
}

export function NationPicker(p: {
  nations: readonly NationDef[];
  onPick: (id: string) => void;
  placeholder?: string;
  value?: string;
  exclude?: ReadonlySet<string>;
}) {
  const items = useMemo(
    () =>
      [...(p.exclude ? p.nations.filter((n) => !p.exclude!.has(n.id)) : p.nations)].sort((a, b) =>
        a.name.localeCompare(b.name, 'fr'),
      ),
    [p.nations, p.exclude],
  );
  return (
    <Combo
      items={items}
      text={(n) => `${n.id} ${n.iso} ${n.name}`}
      keep={
        p.value === undefined
          ? undefined
          : (p.nations.find((n) => n.id === p.value)?.name ?? p.value)
      }
      placeholder={p.placeholder}
      render={(n) => <Nation id={n.id} name={n.name} color={n.color} />}
      onPick={(n) => p.onPick(n.id)}
    />
  );
}

export function ProvincePicker(p: {
  provinces: readonly ProvinceDef[];
  nations: ReadonlyMap<string, NationDef>;
  onPick: (id: string) => void;
  placeholder?: string;
  exclude?: ReadonlySet<string>;
}) {
  const items = useMemo(
    () => (p.exclude ? p.provinces.filter((x) => !p.exclude!.has(x.id)) : p.provinces),
    [p.provinces, p.exclude],
  );
  return (
    <Combo
      items={items}
      text={(x) => `${x.id} ${x.name} ${x.cityName ?? ''} ${p.nations.get(x.nationId)?.name ?? ''}`}
      placeholder={p.placeholder}
      render={(x) => (
        <span className="ellipsis">
          {x.name} <span className="dim">{x.id}</span>
        </span>
      )}
      hint={(x) => p.nations.get(x.nationId)?.name ?? x.nationId}
      onPick={(x) => p.onPick(x.id)}
    />
  );
}

/** Liste d'identifiants sous forme de pastilles, avec ajout par sélecteur. */
export function ChipList(p: {
  values: readonly string[];
  label: (id: string) => ReactNode;
  onRemove: (id: string) => void;
  picker: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <div className="stack-sm">
      <div className="chips">
        {p.values.length === 0 && <span className="dim small">{p.empty ?? T.app.none}</span>}
        {p.values.map((v) => (
          <span key={v} className="chip">
            {p.label(v)}
            <button type="button" aria-label={`${T.app.remove} ${v}`} onClick={() => p.onRemove(v)}>
              ×
            </button>
          </span>
        ))}
      </div>
      {p.picker}
    </div>
  );
}

/** Sélection de portes de recherche : cases à cocher groupées par branche. */
export function GatePicker(p: {
  nodes: readonly ResearchNode[];
  value: readonly string[];
  onChange: (v: string[]) => void;
  filter?: string;
}) {
  const set = new Set(p.value);
  const byBranch = useMemo(() => {
    const m = new Map<string, ResearchNode[]>();
    for (const n of [...p.nodes].sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))) {
      const list = m.get(n.branch) ?? [];
      list.push(n);
      m.set(n.branch, list);
    }
    return m;
  }, [p.nodes]);
  const unknown = p.value.filter((v) => !p.nodes.some((n) => n.id === v));
  const toggle = (id: string) =>
    p.onChange(set.has(id) ? p.value.filter((x) => x !== id) : [...p.value, id]);
  return (
    <div className="stack-sm">
      {[...byBranch].map(([branch, nodes]) => (
        <div key={branch} className="row-wrap" style={{ alignItems: 'flex-start' }}>
          <span className="dim tiny upper" style={{ width: 110, paddingTop: 4, flex: 'none' }}>
            {T.branches[branch as keyof typeof T.branches] ?? branch}
          </span>
          <div className="chips grow">
            {nodes.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`chip ${set.has(n.id) ? 'on' : ''}`}
                title={`${n.id}\n${n.description}`}
                aria-pressed={set.has(n.id)}
                onClick={() => toggle(n.id)}
              >
                {n.id.replace(/^research\.[a-z]+\./, '')}
              </button>
            ))}
          </div>
        </div>
      ))}
      {unknown.length > 0 && (
        <div className="chips">
          {unknown.map((u) => (
            <span
              key={u}
              className="chip"
              style={{ borderColor: 'var(--t-red)' }}
              title={T.editor.warnGate.replace('{id}', u)}
            >
              {u}
              <button type="button" onClick={() => toggle(u)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
