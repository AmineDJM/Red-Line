/** Notifications éphémères, boîtes de dialogue et confirmations des actions destructives. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { T } from '../i18n';
import { Button, Win } from './term';

// ——— Notifications ———

type ToastTone = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}
const ToastCtx = createContext<(text: string, tone?: ToastTone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

const TAG: Record<ToastTone, string> = { ok: 'OK', error: 'ERR', info: 'INFO' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const drop = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((text: string, tone: ToastTone = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => drop(id), tone === 'error' ? 8000 : 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.tone}`}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="tag">[{TAG[t.tone]}]</span>
            <span className="grow">{t.text}</span>
            <button type="button" aria-label={T.app.close} onClick={() => drop(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ——— Dialogue ———

export function Dialog(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  danger?: boolean;
  wide?: boolean;
}) {
  const { onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    const prev = document.activeElement as HTMLElement | null;
    // Focus sur le premier champ, sinon sur le dialogue.
    const first = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, [data-autofocus]',
    );
    (first ?? ref.current)?.focus();
    return () => {
      window.removeEventListener('keydown', k);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`dialog ${props.danger ? 'danger' : ''}`}
        style={props.wide ? { width: 'min(760px, 100%)' } : undefined}
        role="dialog"
        aria-modal
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Win
          title={props.title}
          glyph={props.danger ? '!' : '>_'}
          className={props.danger ? 'accent' : ''}
        >
          {props.children}
          {props.actions && <div className="dialog-actions">{props.actions}</div>}
        </Win>
      </div>
    </div>
  );
}

// ——— Confirmation (promesse) ———

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirm?: string;
  danger?: boolean;
  /** Texte à retaper pour confirmer (actions irréversibles). */
  typeToConfirm?: string;
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (b: boolean) => void }) | null>(
    null,
  );
  const [typed, setTyped] = useState('');
  const ask = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ ...o, resolve });
      }),
    [],
  );
  const close = useCallback(
    (v: boolean) => {
      state?.resolve(v);
      setState(null);
    },
    [state],
  );
  const blocked = !!state?.typeToConfirm && typed.trim() !== state.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Dialog
          title={state.title}
          danger={state.danger}
          onClose={() => close(false)}
          actions={
            <>
              <Button onClick={() => close(false)}>{T.app.cancel}</Button>
              <Button
                variant={state.danger ? 'danger' : 'primary'}
                disabled={blocked}
                data-autofocus
                onClick={() => close(true)}
              >
                {state.confirm ?? T.app.confirm}
              </Button>
            </>
          }
        >
          <div className="stack-sm" style={{ fontSize: 12.5 }}>
            {state.message}
          </div>
          {state.typeToConfirm && (
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="confirm-type">
                {T.app.typeToConfirm} <code className="c-amber">{state.typeToConfirm}</code>
              </label>
              <input
                id="confirm-type"
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !blocked && close(true)}
              />
            </div>
          )}
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}
