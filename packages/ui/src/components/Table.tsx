import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Contenu de la cellule. */
  render: (row: T, index: number) => ReactNode;
  /** Alignement : nombres à droite. */
  align?: 'left' | 'right' | 'center';
  /** Largeur CSS (`80px`, `20%`). */
  width?: string;
  /** Rend la colonne triable (comparateur croissant). */
  sort?: (a: T, b: T) => number;
  /** Masquée sous 720 px de large. */
  hideOnMobile?: boolean;
  /** Libellé accessible de l'en-tête si `header` n'est pas du texte. */
  title?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Tri initial. */
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Affiché si `rows` est vide. */
  empty?: ReactNode;
  dense?: boolean;
  /** Libellé accessible du tableau. */
  label: string;
  className?: string;
  /** Classe CSS par ligne (ton critique…). */
  rowClass?: (row: T) => string | undefined;
}

/**
 * Tableau aligné en chasse fixe : en-têtes triables (aria-sort), lignes cliquables au clavier,
 * en-tête collant, nombres alignés à droite.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  defaultSort,
  empty,
  dense,
  label,
  className,
  rowClass,
}: TableProps<T>) {
  const [sort, setSort] = useState(defaultSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const out = [...rows].sort(col.sort);
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

  return (
    <div className={['rl-table-wrap', className ?? ''].join(' ')}>
      <table className={dense ? 'rl-table rl-table--dense' : 'rl-table'} aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={{ width: c.width, textAlign: c.align ?? 'left' }}
                  className={c.hideOnMobile ? 'rl-hide-mobile' : undefined}
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  title={c.title}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className={active ? 'rl-th-sort rl-th-sort--on' : 'rl-th-sort'}
                      onClick={() =>
                        setSort(
                          active && sort!.dir === 'asc'
                            ? { key: c.key, dir: 'desc' }
                            : { key: c.key, dir: 'asc' },
                        )
                      }
                    >
                      {c.header}
                      <span className="rl-th-sort__arrow" aria-hidden>
                        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const k = rowKey(r);
            const cls = [
              onRowClick ? 'rl-tr--click' : '',
              selectedKey === k ? 'rl-tr--sel' : '',
              rowClass?.(r) ?? '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <tr
                key={k}
                className={cls || undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-selected={onRowClick ? selectedKey === k : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(r);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{ textAlign: c.align ?? 'left' }}
                    className={c.hideOnMobile ? 'rl-hide-mobile' : undefined}
                  >
                    {c.render(r, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty ? <div className="rl-table__empty">{empty}</div> : null}
    </div>
  );
}
