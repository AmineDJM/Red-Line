import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, Icon, formatInt } from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { emitMapEvent } from '../map/events.js';
import { getActiveGameMap } from '../map/MapView.js';
import { REL_COLOR } from '../map/palette.js';
import { glyphDataUrl } from '../map/pions.js';
import {
  catCounts,
  filterRows,
  onlyCat,
  pickedSummary,
  selectableIds,
  stackRows,
  toggleAll,
  togglePicked,
  useStackMenu,
  type StackRow,
} from '../map/stackMenu.js';
import { CAT_TONE } from '../map/unitCat.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useIsMobile } from './useMedia.js';
import './mapui.css';

/** Au-delà de cet étalement (km), le menu propose de zoomer sur la pile. */
const ZOOM_SPREAD_KM = 30;
/** Lignes affichées au plus (piles de l'échelle du monde). */
const MAX_ROWS = 160;

function hpTone(r: number) {
  return r > 0.6 ? 'var(--rl-green)' : r > 0.3 ? 'var(--rl-amber)' : 'var(--rl-red)';
}

function Row({
  r,
  checked,
  onToggle,
  onOnly,
  action,
}: {
  r: StackRow;
  checked: boolean;
  onToggle?: () => void;
  onOnly?: () => void;
  action?: { label: string; tone: 'red' | 'cyan'; run: () => void };
}) {
  const { t } = useTranslation();
  const status = r.status && r.status !== 'idle' ? t(`map.status.${r.status}`) : null;
  const eta = r.eta !== null ? t('map.stack.eta', { value: fmtDuration(r.eta - gameNow()) }) : null;
  const selectable = !!onToggle;
  return (
    <li
      className={`stk__row${checked ? ' stk__row--on' : ''}${selectable ? '' : ' stk__row--foreign'}`}
      style={{ '--rel': REL_COLOR[r.rel] } as CSSProperties}
      data-testid="stack-row"
      data-unit={r.id}
      onClick={onToggle}
      onDoubleClick={onOnly}
      role={selectable ? 'checkbox' : undefined}
      aria-checked={selectable ? checked : undefined}
      tabIndex={selectable ? 0 : undefined}
      onKeyDown={(e) => {
        if (selectable && (e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) {
          e.preventDefault();
          if (e.key === ' ') onToggle?.();
          else onOnly?.();
        }
      }}
    >
      {selectable ? (
        <span className="stk__check" aria-hidden>
          {checked ? <Icon name="check" size={11} /> : null}
        </span>
      ) : (
        <span className="stk__flag">
          <Flag nationId={r.owner} size={11} />
        </span>
      )}
      <span className="stk__glyph" aria-hidden>
        <img src={glyphDataUrl(r.glyph, '#f2f6fa', 18)} alt="" />
      </span>
      <span className="stk__main">
        <span className="stk__name">{r.name}</span>
        <span className="stk__meta">
          <span className="stk__cat" style={{ color: CAT_TONE[r.cat] }}>
            {t(`map.stack.cat.${r.cat}`)}
          </span>
          {status ? (
            <span className={r.status === 'combat' ? 'stk__st stk__st--combat' : 'stk__st'}>
              {status}
            </span>
          ) : null}
          {eta ? <span className="stk__st">{eta}</span> : null}
        </span>
      </span>
      <span className="stk__nums">
        {r.count !== undefined ? <b>×{formatInt(r.count)}</b> : <b className="muted">?</b>}
        {r.hp !== undefined ? (
          <span className="stk__hp" title={`${Math.round(r.hp * 100)} %`}>
            <i style={{ width: `${Math.round(r.hp * 100)}%`, background: hpTone(r.hp) }} />
          </span>
        ) : null}
      </span>
      {action ? (
        <button
          type="button"
          className={`stk__act stk__act--${action.tone}`}
          onClick={(e) => {
            e.stopPropagation();
            action.run();
          }}
        >
          {action.label}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Menu de pile (style terminal) : liste ancrée au point touché sur ordinateur, feuille en bas
 * d'écran sur mobile. Choix simple ou multiple, « tout », filtres par famille, puis ordre.
 */
export function StackMenu() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const open = useStackMenu((s) => s.open);
  const picked = useStackMenu((s) => s.picked);
  const filter = useStackMenu((s) => s.filter);
  const setPicked = useStackMenu((s) => s.setPicked);
  const setFilter = useStackMenu((s) => s.setFilter);
  const close = useStackMenu((s) => s.close);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const selection = useUi((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const ctx = useMemo(
    () => ({
      me,
      nations: view?.nations ?? {},
      catalog,
      t: gameNow(),
      unknown: t('map.tip.unknown'),
    }),
    [me, view?.nations, catalog, t],
  );
  const rows = useMemo(
    () =>
      open && view ? stackRows(open.ids.map((id) => view.units[id]!).filter(Boolean), ctx) : [],
    [open, view, ctx],
  );
  const near = useMemo(
    () =>
      open && view ? stackRows(open.near.map((id) => view.units[id]!).filter(Boolean), ctx) : [],
    [open, view, ctx],
  );
  const own = rows.filter((r) => r.own);
  const foreign = [...rows.filter((r) => !r.own), ...near];
  const cats = catCounts(rows);
  const shown = filterRows(own, filter);
  const ids = selectableIds(rows);
  const visibleIds = selectableIds(shown);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => picked.includes(id));
  const sum = pickedSummary(rows, picked);
  const touch = mobile || !!open?.touch;

  // Unités disparues entre-temps (détruites, embarquées) : retirées du choix.
  useEffect(() => {
    if (!open) return;
    const alive = picked.filter((id) => ids.includes(id));
    if (alive.length !== picked.length) setPicked(alive);
    if (!rows.length && !near.length) close();
  }, [open, rows, near, ids, picked, setPicked, close]);

  // Ancrage (ordinateur) : à droite du point touché, recadré dans l'écran.
  useLayoutEffect(() => {
    if (!open || touch) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const hw = host.clientWidth;
    const hh = host.clientHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = open.x + 18;
    let top = open.y - 28;
    if (left + w > hw - 8) left = open.x - w - 18;
    if (top + h > hh - 8) top = hh - h - 8;
    setPos({ left: Math.max(60, left), top: Math.max(52, top) });
  }, [open, touch, rows.length, foreign.length, filter]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter' && picked.length) {
        e.preventDefault();
        apply(picked);
      } else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPicked(toggleAll(rows, picked, filter));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open || !view) return null;

  const dismiss = () => {
    close();
    emitMapEvent({ kind: 'stack-menu', open: false });
  };
  const apply = (list: string[], add = false) => {
    if (!list.length) return;
    const ui = useUi.getState();
    ui.select(add ? [...new Set([...ui.selection, ...list])] : list);
    dismiss();
  };
  const hostile = selection.length > 0;

  return (
    <div
      ref={ref}
      className={touch ? 'stk stk--sheet' : 'stk'}
      style={pos ? { left: pos.left, top: pos.top } : touch ? undefined : { visibility: 'hidden' }}
      role="dialog"
      aria-label={t('map.stack.title')}
      data-map-avoid
      data-testid="stack-menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="stk__head">
        <span className="stk__prompt">
          <span>map:\&gt;</span> {t('map.stack.prompt')}{' '}
          <b>{t('map.stack.units', { count: rows.length + near.length })}</b>
        </span>
        {open.spreadKm > ZOOM_SPREAD_KM ? (
          <button
            type="button"
            className="stk__iconbtn"
            onClick={() => {
              getActiveGameMap()?.fitUnits(open.ids);
              dismiss();
            }}
            title={t('map.stack.zoom')}
          >
            <Icon name="search" size={13} />
            <span>{t('map.stack.zoom')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="stk__iconbtn"
          onClick={dismiss}
          aria-label={t('map.stack.close')}
          title={`${t('map.stack.close')} · Échap`}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      {own.length ? (
        <>
          {cats.length > 1 ? (
            <div className="stk__filters" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'all'}
                className={filter === 'all' ? 'stk__chip stk__chip--on' : 'stk__chip'}
                onClick={() => setFilter('all')}
              >
                {t('map.stack.all')} <b>{own.length}</b>
              </button>
              {catCounts(own).map(({ cat, n }) => (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={filter === cat}
                  className={filter === cat ? 'stk__chip stk__chip--on' : 'stk__chip'}
                  style={{ '--tone': CAT_TONE[cat] } as CSSProperties}
                  onClick={() => setFilter(cat)}
                  onDoubleClick={() => setPicked(onlyCat(rows, cat))}
                  title={`${t('map.stack.only')} : ${t(`map.stack.cat.${cat}`)}`}
                >
                  <i />
                  {t(`map.stack.cat.${cat}`)} <b>{n}</b>
                </button>
              ))}
            </div>
          ) : null}
          <label className="stk__all">
            <span
              className={`stk__check${allOn ? ' stk__check--on' : ''}`}
              role="checkbox"
              aria-checked={allOn}
              tabIndex={0}
              onClick={() => setPicked(toggleAll(rows, picked, filter))}
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault();
                  setPicked(toggleAll(rows, picked, filter));
                }
              }}
            >
              {allOn ? <Icon name="check" size={11} /> : null}
            </span>
            <span onClick={() => setPicked(toggleAll(rows, picked, filter))}>
              {t('map.stack.selectAll')}
              {filter !== 'all' ? ` · ${t(`map.stack.cat.${filter}`)}` : ''}
            </span>
            <span className="stk__sum">
              {sum.units
                ? t('map.stack.picked', { units: sum.units, count: formatInt(sum.count) })
                : t('map.stack.pickedNone')}
            </span>
          </label>
          <ul className="stk__list" data-testid="stack-own">
            {shown.slice(0, MAX_ROWS).map((r) => (
              <Row
                key={r.id}
                r={r}
                checked={picked.includes(r.id)}
                onToggle={r.missile ? undefined : () => setPicked(togglePicked(rows, picked, r.id))}
                onOnly={() => apply([r.id])}
              />
            ))}
            {shown.length > MAX_ROWS ? (
              <li className="stk__more">
                {t('map.stack.more', { count: shown.length - MAX_ROWS })}
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {foreign.length ? (
        <>
          <div className="stk__section">
            {own.length ? t('map.stack.near') : t('map.stack.notOwn')}
            <b>{foreign.length}</b>
          </div>
          <ul className="stk__list stk__list--foreign">
            {foreign.slice(0, 40).map((r) => (
              <Row
                key={r.id}
                r={r}
                checked={false}
                action={
                  hostile && r.rel !== 'own' && r.rel !== 'ally'
                    ? {
                        label: t('map.stack.attack'),
                        tone: 'red',
                        run: () => {
                          useUi
                            .getState()
                            .setPending({ kind: 'attack', unitIds: selection, targetId: r.id });
                          dismiss();
                        },
                      }
                    : {
                        label: t('map.stack.inspect'),
                        tone: 'cyan',
                        run: () => {
                          useUi.getState().inspect(r.id);
                          dismiss();
                        },
                      }
                }
              />
            ))}
          </ul>
        </>
      ) : null}

      {own.length ? (
        <footer className="stk__foot">
          <span className="stk__hint">
            {touch ? t('map.stack.hintTouch') : t('map.stack.hint')}
          </span>
          <div className="stk__btns">
            {selection.length && !touch ? (
              <button
                type="button"
                className="stk__btn"
                disabled={!picked.length}
                onClick={() => apply(picked, true)}
              >
                {t('map.stack.add')}
              </button>
            ) : null}
            <button
              type="button"
              className="stk__btn stk__btn--primary"
              disabled={!picked.length}
              onClick={() => apply(picked)}
              data-testid="stack-select"
            >
              {t('map.stack.selectN', { count: picked.length })}
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
