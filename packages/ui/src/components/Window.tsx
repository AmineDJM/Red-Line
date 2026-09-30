import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Icon } from '../icons.js';
import { Kbd } from './Kbd.js';

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowProps {
  /** Libellé accessible de la fenêtre (dialog). */
  title: string;
  /**
   * Chemin affiché dans l'invite : `['Armée', 'Groupes']` → `PS RED-LINE:\Armée\Groupes>`.
   * Par défaut : `[title]`.
   */
  path?: string[];
  /** Hôte de l'invite (défaut `RED-LINE`). */
  host?: string;
  /** Raccourci clavier qui ouvre la fenêtre (affiché à droite de la barre). */
  shortcut?: string;
  /**
   * `floating` : fenêtre déplaçable et redimensionnable (ordinateur).
   * `sheet` : plein écran (tiroir mobile). `inline` : panneau dans le flux (pas de position).
   */
  mode?: 'floating' | 'sheet' | 'inline';
  /** Position et taille (mode floating). */
  rect?: WindowRect;
  onRectChange?: (r: WindowRect) => void;
  /** Taille minimale en mode floating. */
  minSize?: { w: number; h: number };
  /** Zone autorisée (px dans la fenêtre du navigateur) ; défaut : tout l'écran. */
  bounds?: { top: number; left: number; right: number; bottom: number };
  zIndex?: number;
  /** Fenêtre au premier plan (barre de titre accentuée). */
  focused?: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** Plein écran dans la zone autorisée. */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  maximizeLabel?: string;
  /** Onglets, barre d'outils : sous la barre de titre, hors défilement. */
  tabs?: ReactNode;
  toolbar?: ReactNode;
  /** Contenu à droite de la barre de titre (avant le raccourci). */
  headerExtra?: ReactNode;
  footer?: ReactNode;
  /** Corps sans marge intérieure (tableaux pleine largeur, cartes). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
  id?: string;
}

/** Invite de terminal : `PS RED-LINE:\Armée>` suivie d'un curseur clignotant discret. */
export function Prompt({
  path,
  host = 'RED-LINE',
  caret = true,
}: {
  path: string[];
  host?: string;
  caret?: boolean;
}) {
  return (
    <span className="rl-prompt" aria-hidden>
      <span className="rl-prompt__ps">PS</span>
      <span className="rl-prompt__host">{host}:</span>
      <span className="rl-prompt__path">
        {path.map((p, i) => (
          <span key={i}>
            <span className="rl-prompt__sep">\</span>
            {p}
          </span>
        ))}
      </span>
      <span className="rl-prompt__gt">&gt;</span>
      {caret ? <span className="rl-caret" /> : null}
    </span>
  );
}

/**
 * Fenêtre de terminal : barre de titre avec invite, onglets, corps défilant, pied.
 * Mode `floating` : déplaçable par la barre de titre, redimensionnable par le coin (souris et doigt).
 * Mode `sheet` : plein écran, boutons ≥ 44 px (mobile). Échap ferme la fenêtre au premier plan.
 * La fenêtre porte `data-map-avoid` : la carte n'y place pas d'étiquettes.
 */
export function Window({
  title,
  path,
  host,
  shortcut,
  mode = 'floating',
  rect,
  onRectChange,
  minSize = { w: 360, h: 240 },
  bounds,
  zIndex,
  focused = true,
  onFocus,
  onClose,
  closeLabel = 'Fermer',
  maximized,
  onToggleMaximize,
  maximizeLabel = 'Agrandir',
  tabs,
  toolbar,
  headerExtra,
  footer,
  flush,
  className,
  children,
  id,
}: WindowProps) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{
    kind: 'move' | 'resize';
    x: number;
    y: number;
    start: WindowRect;
  } | null>(null);

  useEffect(() => {
    if (!focused || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && ref.current && !ref.current.contains(t) && t !== document.body) return;
      e.preventDefault();
      onClose();
    };
    // Phase de capture : passe avant les raccourcis globaux de l'application.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focused, onClose]);

  const area = () =>
    bounds ?? { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

  const clamp = (r: WindowRect): WindowRect => {
    const b = area();
    const w = Math.max(minSize.w, Math.min(r.w, b.right - b.left));
    const h = Math.max(minSize.h, Math.min(r.h, b.bottom - b.top));
    return {
      w,
      h,
      x: Math.min(Math.max(r.x, b.left), b.right - Math.min(w, 120)),
      y: Math.min(Math.max(r.y, b.top), b.bottom - 40),
    };
  };

  const onPointerDown = (kind: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    onFocus?.();
    if (mode !== 'floating' || !rect || !onRectChange || maximized) return;
    if (e.button !== 0) return;
    if (kind === 'move' && (e.target as HTMLElement).closest('button, a, input, select')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, start: rect };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !onRectChange) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    onRectChange(
      clamp(
        d.kind === 'move'
          ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
          : { ...d.start, w: d.start.w + dx, h: d.start.h + dy },
      ),
    );
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const b = mode === 'floating' && maximized ? (bounds ?? null) : null;
  const style =
    mode === 'floating'
      ? b
        ? { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top, zIndex }
        : rect
          ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }
          : { zIndex }
      : { zIndex };

  return (
    <section
      ref={ref}
      id={id}
      className={[
        'rl-win',
        `rl-win--${mode}`,
        focused ? 'rl-win--focused' : '',
        maximized ? 'rl-win--max' : '',
        className ?? '',
      ].join(' ')}
      style={style}
      role={mode === 'inline' ? 'region' : 'dialog'}
      aria-label={title}
      data-map-avoid=""
      onPointerDownCapture={() => onFocus?.()}
    >
      <header
        className="rl-win__bar"
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button') && onToggleMaximize) onToggleMaximize();
        }}
      >
        <span className="rl-win__lights" aria-hidden>
          <i />
        </span>
        <h2 className="rl-win__title">
          <span className="rl-sr">{title}</span>
          <Prompt path={path ?? [title]} host={host} caret={focused} />
        </h2>
        <div className="rl-win__actions">
          {headerExtra}
          {shortcut ? <Kbd className="rl-win__kbd">{shortcut}</Kbd> : null}
          {onToggleMaximize && mode === 'floating' ? (
            <button
              type="button"
              className="rl-win__btn"
              onClick={onToggleMaximize}
              aria-label={maximizeLabel}
              title={maximizeLabel}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="rl-win__btn rl-win__btn--close"
              onClick={onClose}
              aria-label={closeLabel}
              title={closeLabel}
            >
              <Icon name="close" size={mode === 'sheet' ? 20 : 15} />
            </button>
          ) : null}
        </div>
      </header>
      {tabs ? <div className="rl-win__tabs">{tabs}</div> : null}
      {toolbar ? <div className="rl-win__toolbar">{toolbar}</div> : null}
      <div className={flush ? 'rl-win__body rl-win__body--flush' : 'rl-win__body'}>{children}</div>
      {footer ? <footer className="rl-win__foot">{footer}</footer> : null}
      {mode === 'floating' && onRectChange && !maximized ? (
        <div
          className="rl-win__resize"
          onPointerDown={onPointerDown('resize')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-hidden
        />
      ) : null}
    </section>
  );
}
