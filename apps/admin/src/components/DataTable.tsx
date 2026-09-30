/**
 * Tableau dense aligné (chasse fixe) : tri par colonne, sélection, rendu progressif des longues listes
 * (les 2 567 provinces restent fluides : 150 lignes, puis chargement au défilement).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { T, fmt } from '../i18n';
import { Button } from './term';

export interface Column<R> {
  key: string;
  label: ReactNode;
  render: (r: R) => ReactNode;
  /** Valeur de tri (absente : colonne non triable). */
  sort?: (r: R) => number | string | null | undefined;
  align?: 'right';
  width?: number | string;
  className?: string;
  /** Masquée sur mobile. */
  hideM?: boolean;
  title?: string;
}

const PAGE = 150;

export function DataTable<R>(p: {
  rows: readonly R[];
  columns: Column<R>[];
  rowKey: (r: R) => string;
  onRowClick?: (r: R) => void;
  selected?: string | null;
  rowClass?: (r: R) => string;
  empty?: ReactNode;
  initialSort?: { key: string; dir: 1 | -1 };
  maxHeight?: number | string;
  bare?: boolean;
  label?: string;
}) {
  const [sort, setSort] = useState(p.initialSort ?? null);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!sort) return p.rows;
    const col = p.columns.find((c) => c.key === sort.key);
    if (!col?.sort) return p.rows;
    const get = col.sort;
    return [...p.rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (
        (typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y), 'fr')) * sort.dir
      );
    });
  }, [p.rows, p.columns, sort]);

  // Revenir en haut de liste quand le jeu de lignes change (filtre).
  const sig = `${p.rows.length}:${p.rows[0] ? p.rowKey(p.rows[0]) : ''}`;
  useEffect(() => setShown(PAGE), [sig]);

  // La ligne sélectionnée reste visible même au-delà de la page affichée.
  const selIndex = p.selected ? rows.findIndex((r) => p.rowKey(r) === p.selected) : -1;
  const limit = Math.max(shown, selIndex + 20);
  const visible = rows.length > limit ? rows.slice(0, limit) : rows;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || rows.length <= limit) return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) setShown((n) => n + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [rows.length, limit]);

  // Fait défiler la ligne sélectionnée dans la vue (sélection depuis la carte, la palette…).
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.selected) return;
    const row = wrapRef.current?.querySelector<HTMLElement>('tr.sel');
    const box = wrapRef.current;
    if (!row || !box) return;
    const top = row.offsetTop - box.clientHeight / 2;
    if (row.offsetTop < box.scrollTop + 30 || row.offsetTop > box.scrollTop + box.clientHeight - 40)
      box.scrollTo({ top: Math.max(0, top) });
  }, [p.selected, rows]);

  const clickSort = (key: string) =>
    setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  return (
    <div
      ref={wrapRef}
      className={`tbl-wrap ${p.bare ? 'bare' : ''}`}
      style={p.maxHeight ? { maxHeight: p.maxHeight } : undefined}
    >
      <table className="tbl" aria-label={p.label}>
        <thead>
          <tr>
            {p.columns.map((c) => (
              <th
                key={c.key}
                className={`${c.align === 'right' ? 'r' : ''} ${c.sort ? 'sortable' : ''} ${c.hideM ? 'hide-m' : ''}`}
                style={c.width ? { width: c.width } : undefined}
                onClick={c.sort ? () => clickSort(c.key) : undefined}
                aria-sort={
                  sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                }
                title={c.title}
              >
                {c.label}
                {sort?.key === c.key && <span className="arrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const k = p.rowKey(r);
            return (
              <tr
                key={k}
                className={`${p.onRowClick ? 'clickable' : ''} ${p.selected === k ? 'sel' : ''} ${p.rowClass?.(r) ?? ''}`}
                onClick={p.onRowClick ? () => p.onRowClick!(r) : undefined}
                tabIndex={p.onRowClick ? 0 : undefined}
                onKeyDown={
                  p.onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') p.onRowClick!(r);
                      }
                    : undefined
                }
                aria-selected={p.selected === k || undefined}
              >
                {p.columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${c.align === 'right' ? 'r' : ''} ${c.className ?? ''} ${c.hideM ? 'hide-m' : ''}`}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="tbl-empty">{p.empty ?? T.app.noResults}</div>}
      {rows.length > visible.length && (
        <div className="tbl-more" ref={sentinel}>
          <Button small variant="ghost" onClick={() => setShown((n) => n + PAGE * 4)}>
            {fmt(T.app.showMore, { n: rows.length - visible.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
