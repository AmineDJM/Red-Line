/** Composants de base du back-office (style Red Line : panneaux marine, coins en crochets, accents orange). */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { T } from '../i18n';

export function Frame(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <section className={`frame ${props.accent ? 'frame-accent' : ''} ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <header className="frame-head">
          {props.title && <h2 className="frame-title">{props.title}</h2>}
          {props.actions && <div className="frame-actions">{props.actions}</div>}
        </header>
      )}
      <div className="frame-body">{props.children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  small?: boolean;
};
export function Button({ variant = 'default', small, className, type, ...rest }: BtnProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`btn btn-${variant} ${small ? 'btn-small' : ''} ${className ?? ''}`}
      {...rest}
    />
  );
}

export function Badge(props: {
  tone?: 'ok' | 'off' | 'warn' | 'info' | 'crit';
  children: ReactNode;
}) {
  return <span className={`badge badge-${props.tone ?? 'info'}`}>{props.children}</span>;
}

export function Spinner() {
  return (
    <div className="spinner" role="status">
      <span className="spinner-hex" aria-hidden />
      {T.app.loading}
    </div>
  );
}

export function ErrorBox(props: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{props.message}</span>
      {props.onRetry && (
        <Button small onClick={props.onRetry}>
          {T.app.retry}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Notifications éphémères
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === 'error' ? 7000 : 3500,
    );
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- Boîte de dialogue
export function Dialog(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog frame frame-accent"
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="frame-title">{props.title}</h2>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-actions">{props.actions}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Icône hexagonale
const GLYPHS: Record<string, ReactNode> = {
  fighter: (
    <path d="M12 3l1.4 5.2 6.1 3.6v1.6l-6-1.6-.5 4.3 2.2 1.7v1.3L12 18.4l-3.2.7v-1.3l2.2-1.7-.5-4.3-6 1.6v-1.6l6.1-3.6z" />
  ),
  tank: <path d="M5 13h14l1.5 2.5-1.5 2.5H5l-1.5-2.5zM8 9.5h6l1.5 3.5h-9zM14 10.5h6v1h-6z" />,
  ifv: <path d="M4 12.5h15l1.5 2.5-1.5 2.5H5.5L4 15zM7 9.5h7l2 3H7zM15 10.5h4v1h-4z" />,
  artillery: <path d="M4 15h12l1.5 2H3zM9 12l9-6 .8 1.2-9 6zM6 12.5h6v2.5H6z" />,
  air_defense: (
    <path d="M6 16h12v2H6zM8 13h8l1 3H7zM11 13l4-8 1.3.6-4 7.4zM8.2 13l2.2-6 1.2.4-2 5.6z" />
  ),
  jammer: (
    <path d="M11 11h2v7h-2zM7 18h10v1.5H7zM12 4a7 7 0 016.3 4l-1.4.7A5.5 5.5 0 0012 5.5a5.5 5.5 0 00-4.9 3.2L5.7 8A7 7 0 0112 4zm0 3a4 4 0 013.6 2.3l-1.4.7A2.5 2.5 0 0012 8.5a2.5 2.5 0 00-2.2 1.5l-1.4-.7A4 4 0 0112 7z" />
  ),
  drone: <path d="M3 11.2h18v1.6H3zM11 7h2v10h-2zM8.5 16h7v1.4h-7zM10.5 5.5h3V8h-3z" />,
  helicopter: (
    <path d="M3 6h18v1.3H3zM11.3 7h1.4v2h-1.4zM7 10h8.5a3 3 0 010 6H9l-2-2.2zM15 12.5h6v1h-6zM8 17h9v1.2H8z" />
  ),
  infantry: <path d="M12 4.5a2 2 0 110 4 2 2 0 010-4zM9.5 9.5h5l1 5h-1.8l-.5 5h-2.4l-.5-5H8.5z" />,
  infantry_mech: (
    <path d="M12 3.5a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6zM9.8 8h4.4l.8 4H9zM4 14h16l1 2.5-1 2.5H4l-1-2.5z" />
  ),
};

export function HexIcon(props: { icon: string; size?: number; muted?: boolean }) {
  const size = props.size ?? 36;
  return (
    <svg
      className={`hex-icon ${props.muted ? 'hex-muted' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <polygon points="12,0.8 21.8,6.4 21.8,17.6 12,23.2 2.2,17.6 2.2,6.4" className="hex-bg" />
      <g className="hex-glyph" transform="translate(3.6 3.6) scale(0.7)">
        {GLYPHS[props.icon] ?? (
          <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700">
            {props.icon.slice(0, 2).toUpperCase()}
          </text>
        )}
      </g>
    </svg>
  );
}
