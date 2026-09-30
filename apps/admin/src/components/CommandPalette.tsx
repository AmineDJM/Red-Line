/**
 * Palette de commandes (Ctrl+K ou « : ») : navigation et actions au clavier.
 * Préfixes : goto, sys, nation, prov, rule, research, scen — ex. « sys rafale », « goto regles ».
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { hasRole } from '@redline/shared';
import { useSession } from '../context';
import { T } from '../i18n';
import { RULE_HELP, RULE_SECTIONS } from '../i18n/rules';
import { useNations, useProvinces, useResearch, useSystems } from '../lib/refs';
import { navigate, type Route } from '../lib/router';
import { SCREENS } from '../lib/screens';
import { fold, score, tokens } from '../lib/search';
import { Flag } from './Flag';
import { Icon, Kbd } from './term';

interface Cmd {
  id: string;
  group: keyof typeof T.palette.groups;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  search: string;
  run: () => void;
}

const PREFIX: Record<string, Cmd['group']> = {
  goto: 'nav',
  aller: 'nav',
  sys: 'systems',
  system: 'systems',
  fiche: 'systems',
  nation: 'nations',
  pays: 'nations',
  prov: 'provinces',
  province: 'provinces',
  rule: 'rules',
  regle: 'rules',
  research: 'research',
  rech: 'research',
  scen: 'scenarios',
};
const ORDER: Cmd['group'][] = [
  'nav',
  'actions',
  'systems',
  'nations',
  'research',
  'rules',
  'scenarios',
  'provinces',
];

function Highlight({ text, q }: { text: string; q: string[] }) {
  if (!q.length) return <>{text}</>;
  const f = fold(text);
  const marks: [number, number][] = [];
  for (const w of q) {
    const i = f.indexOf(w);
    if (i >= 0) marks.push([i, i + w.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach(([s, e], k) => {
    if (s < at) return;
    out.push(text.slice(at, s), <mark key={k}>{text.slice(s, e)}</mark>);
    at = e;
  });
  out.push(text.slice(at));
  return <>{out}</>;
}

export function CommandPalette(p: {
  onClose: () => void;
  onLogout: () => void;
  onExport: () => void;
}) {
  const { user, cache } = useSession();
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const balance = hasRole(user.role, 'balance');
  const t = tokens(q);
  const forced = t[0] ? PREFIX[t[0]] : undefined;
  const words = forced ? t.slice(1) : t;
  const systems = useSystems(balance);
  const nations = useNations();
  const research = useResearch(balance);
  const provinces = useProvinces(balance && forced === 'provinces');
  const sys = balance ? systems.data : null;
  const res = balance ? research.data : null;
  const provs = balance && forced === 'provinces' ? provinces.data : null;

  useEffect(() => input.current?.focus(), []);

  const go = (r: Route) => () => {
    navigate(r);
    p.onClose();
  };

  const cmds = useMemo(() => {
    const out: Cmd[] = [];
    for (const s of SCREENS)
      if (hasRole(user.role, s.role))
        out.push({
          id: `nav:${s.id}`,
          group: 'nav',
          label: s.label,
          hint: `goto ${s.alias}`,
          icon: <Icon name={s.icon} size={14} />,
          search: `goto ${s.alias} ${s.label}`,
          run: go(s.route),
        });
    if (balance) {
      out.push({
        id: 'act:new',
        group: 'actions',
        label: T.palette.newSystem,
        hint: 'new system',
        icon: <Icon name="plus" size={14} />,
        search: 'new nouveau nouvelle fiche system',
        run: go({ name: 'new' }),
      });
      out.push({
        id: 'act:export',
        group: 'actions',
        label: T.palette.exportCatalog,
        hint: 'export',
        icon: <Icon name="download" size={14} />,
        search: 'export exporter catalogue',
        run: () => (p.onExport(), p.onClose()),
      });
      out.push({
        id: 'act:reload',
        group: 'actions',
        label: T.palette.reload,
        hint: 'reload',
        icon: <Icon name="refresh" size={14} />,
        search: 'reload recharger cache',
        run: () => (
          cache.invalidate('systems', 'nations', 'research', 'provinces', 'photos'),
          p.onClose()
        ),
      });
    }
    out.push({
      id: 'act:logout',
      group: 'actions',
      label: T.palette.logout,
      hint: 'logout',
      icon: <Icon name="logout" size={14} />,
      search: 'logout deconnexion quitter',
      run: () => (p.onClose(), p.onLogout()),
    });
    for (const s of sys ?? [])
      out.push({
        id: `sys:${s.system.id}`,
        group: 'systems',
        label: s.system.name,
        hint: s.system.id,
        icon: <Icon name="catalog" size={14} />,
        search: `sys ${s.system.id} ${s.system.name} ${T.categories[s.system.category]}`,
        run: go({ name: 'system', id: s.system.id }),
      });
    for (const n of balance ? (nations.data ?? []) : [])
      out.push({
        id: `nat:${n.id}`,
        group: 'nations',
        label: n.name,
        hint: n.id,
        icon: <Flag id={n.id} color={n.color} />,
        search: `nation ${n.id} ${n.iso} ${n.name}`,
        run: go({ name: 'map', tab: 'nations', id: n.id }),
      });
    for (const r of res ?? [])
      out.push({
        id: `res:${r.id}`,
        group: 'research',
        label: r.name,
        hint: r.id,
        icon: <Icon name="research" size={14} />,
        search: `research ${r.id} ${r.name}`,
        run: go({ name: 'research', id: r.id }),
      });
    if (balance) {
      for (const [k, [label]] of Object.entries(RULE_SECTIONS))
        out.push({
          id: `rule:${k}`,
          group: 'rules',
          label: `${T.nav.rules} › ${label}`,
          hint: k,
          icon: <Icon name="rules" size={14} />,
          search: `rule regle ${k} ${label}`,
          run: go({ name: 'rules', section: k }),
        });
      for (const [k, [label]] of Object.entries(RULE_HELP)) {
        const section = k.split('.')[0]!;
        if (!k.includes('.')) continue;
        out.push({
          id: `rulek:${k}`,
          group: 'rules',
          label: `${RULE_SECTIONS[section]?.[0] ?? section} › ${label}`,
          hint: k,
          icon: <Icon name="rules" size={14} />,
          search: `rule ${k} ${label}`,
          run: go({ name: 'rules', section }),
        });
      }
    }
    for (const x of provs ?? [])
      out.push({
        id: `prov:${x.id}`,
        group: 'provinces',
        label: x.name,
        hint: `${x.id} · ${x.cityName ?? ''}`,
        icon: <Flag id={x.nationId} />,
        search: `prov ${x.id} ${x.name} ${x.cityName ?? ''}`,
        run: go({ name: 'map', tab: 'provinces', id: x.id }),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.role, sys, nations.data, res, provs, balance]);

  const shown = useMemo(() => {
    const groups = new Map<Cmd['group'], [Cmd, number][]>();
    for (const c of cmds) {
      if (forced && c.group !== forced) continue;
      // Sans requête : navigation et actions seulement.
      if (!words.length && !forced && c.group !== 'nav' && c.group !== 'actions') continue;
      const s = words.length ? score(c.search, words) : 1;
      if (s <= 0) continue;
      const g = groups.get(c.group) ?? [];
      g.push([c, s]);
      groups.set(c.group, g);
    }
    const flat: Cmd[] = [];
    for (const g of ORDER) {
      const items = groups.get(g);
      if (!items) continue;
      items.sort((a, b) => b[1] - a[1]);
      flat.push(
        ...items.slice(0, forced ? 60 : g === 'nav' || g === 'actions' ? 20 : 6).map(([c]) => c),
      );
    }
    return flat;
  }, [cmds, forced, words]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  let lastGroup: string | null = null;
  return (
    <div className="backdrop" onMouseDown={p.onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal
        aria-label="Palette de commandes"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <span className="ps">PS RED-LINE:\Admin&gt;</span>
          <input
            ref={input}
            value={q}
            placeholder={T.palette.placeholder}
            aria-label={T.app.commandHint}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi((h) => Math.min(shown.length - 1, h + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                shown[hi]?.run();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                p.onClose();
              } else if (e.key === 'Tab' && shown[hi]) {
                // Autocomplétion : reprend l'alias de la commande.
                e.preventDefault();
                const h = shown[hi]!.hint;
                if (h)
                  setQ(
                    shown[hi]!.group === 'nav'
                      ? h
                      : `${Object.entries(PREFIX).find(([, g]) => g === shown[hi]!.group)?.[0] ?? ''} ${h}`.trim(),
                  );
              }
            }}
          />
          <Kbd>Échap</Kbd>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {shown.length === 0 && (
            <div className="empty">
              {forced === 'provinces' && !provs ? T.app.loading : T.palette.empty}
            </div>
          )}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? T.palette.groups[c.group] : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="palette-group">{head}</div>}
                <div
                  className={`palette-item ${i === hi ? 'on' : ''}`}
                  role="option"
                  aria-selected={i === hi}
                  onMouseMove={() => setHi(i)}
                  onClick={() => c.run()}
                >
                  <span className="ico">{c.icon}</span>
                  <span className="ellipsis">
                    <Highlight text={c.label} q={words} />
                  </span>
                  {c.hint && <span className="hint">{c.hint}</span>}
                </div>
              </div>
            );
          })}
          {!forced && !words.length && balance && (
            <div className="palette-group" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {T.palette.provincesHint}
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {T.palette.navigate}
          </span>
          <span>
            <Kbd>Entrée</Kbd> {T.palette.run}
          </span>
          <span>
            <Kbd>Tab</Kbd> autocomplétion
          </span>
          <span>
            <Kbd>Échap</Kbd> {T.palette.close}
          </span>
        </div>
      </div>
    </div>
  );
}
