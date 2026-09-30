import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { Prompt } from './Window.js';

/** État vide : icône, titre, texte, action. */
export function EmptyState({
  icon = 'terminal',
  title,
  text,
  action,
  compact,
}: {
  icon?: IconName;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'rl-empty rl-empty--compact' : 'rl-empty'}>
      <Icon name={icon} size={compact ? 18 : 26} className="rl-empty__icon" />
      <div className="rl-empty__title">{title}</div>
      {text ? <div className="rl-empty__text">{text}</div> : null}
      {action ? <div className="rl-empty__action">{action}</div> : null}
    </div>
  );
}

/** Infobulle au survol et au focus (CSS, sans portail). */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <span className={['rl-tip', `rl-tip--${side}`, className ?? ''].join(' ')}>
      {children}
      <span className="rl-tip__bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}

export interface ToastItem {
  id: number | string;
  text: ReactNode;
  tone?: 'ok' | 'error' | 'info' | 'warn';
  /** Libellé d'action facultatif (« Voir »). */
  action?: { label: string; onClick: () => void };
}

/** Pile de notifications éphémères (bas droite sur ordinateur, haut sur mobile). */
export function ToastStack({
  items,
  onDismiss,
  dismissLabel = 'Fermer',
}: {
  items: ToastItem[];
  onDismiss: (id: ToastItem['id']) => void;
  dismissLabel?: string;
}) {
  return (
    <div className="rl-toasts" aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <div key={t.id} className={`rl-toast rl-toast--${t.tone ?? 'info'}`} role="status">
          <span className="rl-toast__mark" aria-hidden>
            {t.tone === 'error' ? '✕' : t.tone === 'ok' ? '✓' : t.tone === 'warn' ? '!' : '›'}
          </span>
          <span className="rl-toast__text">{t.text}</span>
          {t.action ? (
            <button type="button" className="rl-toast__action" onClick={t.action.onClick}>
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="rl-toast__close"
            onClick={() => onDismiss(t.id)}
            aria-label={dismissLabel}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Fenêtre modale centrée (confirmation, acceptation des conditions). Focus piégé sur le premier
 * élément, Échap ferme si `onClose`.
 */
export function Dialog({
  open,
  title,
  path,
  children,
  footer,
  onClose,
  closeLabel = 'Fermer',
  width = 520,
  tone,
}: {
  open: boolean;
  title: string;
  path?: string[];
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  width?: number;
  tone?: 'red' | 'amber' | 'cyan';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const els = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (!els.length) return;
        const f = els[0]!;
        const l = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="rl-dialog"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={ref}
        className={['rl-dialog__card', tone ? `rl-dialog__card--${tone}` : ''].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
      >
        <header className="rl-win__bar">
          <span className="rl-win__lights" aria-hidden>
            <i />
          </span>
          <h2 className="rl-win__title">
            <span className="rl-sr">{title}</span>
            <Prompt path={path ?? [title]} />
          </h2>
          {onClose ? (
            <div className="rl-win__actions">
              <button
                type="button"
                className="rl-win__btn rl-win__btn--close"
                onClick={onClose}
                aria-label={closeLabel}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          ) : null}
        </header>
        <div className="rl-dialog__body">{children}</div>
        {footer ? <footer className="rl-dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Indicateur de chargement façon terminal (`▍ chargement`). */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="rl-spinner" role="status">
      <span className="rl-spinner__bar" aria-hidden />
      {label ? <span className="rl-spinner__label">{label}</span> : null}
    </span>
  );
}
