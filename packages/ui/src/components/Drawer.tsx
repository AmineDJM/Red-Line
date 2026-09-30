import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Côté sur grand écran ; sur mobile, le tiroir glisse toujours depuis le bas. */
  side?: 'left' | 'right';
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel: string;
  /** Largeur sur grand écran. */
  width?: number;
}

/**
 * Tiroir : panneau latéral sur ordinateur, feuille glissante depuis le bas sur mobile
 * (glisser la poignée vers le bas pour fermer).
 */
export function Drawer({
  open,
  onClose,
  title,
  side = 'left',
  children,
  footer,
  closeLabel,
  width = 380,
}: DrawerProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const drag = useRef<{ y0: number; dy: number; id: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { y0: e.clientY, dy: 0, id: e.pointerId };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (sheetRef.current) sheetRef.current.style.transform = '';
    if (d && d.dy > 80) onClose();
  };

  return (
    <aside
      ref={sheetRef}
      className={['rl-drawer', `rl-drawer--${side}`, open ? 'rl-drawer--open' : ''].join(' ')}
      style={{ ['--rl-drawer-w' as string]: `${width}px` }}
      aria-hidden={!open}
      aria-label={title}
      role="dialog"
      inert={!open}
    >
      <div
        className="rl-drawer__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-hidden
      >
        <span />
      </div>
      <div className="rl-drawer__head">
        <h2 className="rl-drawer__title">{title}</h2>
        <button
          type="button"
          className="rl-drawer__close"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M5 5 L19 19 M19 5 L5 19"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="rl-drawer__body">{children}</div>
      {footer ? <div className="rl-drawer__foot">{footer}</div> : null}
    </aside>
  );
}
