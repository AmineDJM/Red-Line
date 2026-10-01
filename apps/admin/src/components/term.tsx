/** Composants du style « Terminal tactique » : fenêtres à invite, boutons, pastilles, jauges, onglets. */
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { T } from '../i18n';

// ——— Fenêtre de terminal ———

export interface WinProps {
  /** Titre de l'onglet (majuscules espacées). */
  title: ReactNode;
  /** Commande affichée après l'invite (ex. « Get-WeaponSystem -Category fighter »). */
  cmd?: string;
  /** Chemin de l'invite (ex. « Catalogue\eu.rafale »). */
  path?: string;
  glyph?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  flush?: boolean;
  accent?: boolean;
  id?: string;
}

export function Win(p: WinProps) {
  return (
    <section
      id={p.id}
      className={`win ${p.accent ? 'accent' : ''} ${p.className ?? ''}`}
      aria-label={typeof p.title === 'string' ? p.title : undefined}
    >
      <header className="win-head">
        <div className="win-tab">
          <span className="glyph" aria-hidden>
            {p.glyph ?? '>_'}
          </span>
          <h2 className="win-title">{p.title}</h2>
        </div>
        {(p.cmd || p.path) && (
          <div className="win-prompt" aria-hidden>
            <span className="ps">PS RED-LINE:\Admin{p.path ? `\\${p.path}` : ''}&gt;</span>
            {p.cmd && <span className="cmdlet">{p.cmd}</span>}
          </div>
        )}
        {p.actions && <div className="win-actions">{p.actions}</div>}
      </header>
      {p.children !== undefined && (
        <div className={`win-body ${p.flush ? 'flush' : ''}`}>{p.children}</div>
      )}
      {p.footer && <footer className="win-foot">{p.footer}</footer>}
    </section>
  );
}

export function PageHead(p: {
  title: ReactNode;
  sub?: ReactNode;
  crumbs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="grow">
        {p.crumbs && <div className="crumbs">{p.crumbs}</div>}
        <h1>{p.title}</h1>
        {p.sub && <div className="sub">{p.sub}</div>}
      </div>
      {p.actions && <div className="actions">{p.actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, n }: { children: ReactNode; n?: ReactNode }) {
  return (
    <h3 className="section-title">
      {children}
      {n !== undefined && <span className="n">{n}</span>}
    </h3>
  );
}

// ——— Boutons ———

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'success';
  small?: boolean;
  icon?: boolean;
  kbd?: string;
};
export function Button({
  variant = 'default',
  small,
  icon,
  kbd,
  className,
  type,
  children,
  ...rest
}: BtnProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`btn ${variant !== 'default' ? `btn-${variant}` : ''} ${small ? 'btn-sm' : ''} ${icon ? 'btn-icon' : ''} ${className ?? ''}`}
      {...rest}
    >
      {children}
      {kbd && <span className="k">{kbd}</span>}
    </button>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'off' | 'blue' | 'violet';
export function Badge({
  tone = 'info',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Seg<K extends string>(p: {
  value: K;
  options: readonly (readonly [K, ReactNode])[];
  onChange: (k: K) => void;
  small?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg ${p.small ? 'seg-sm' : ''}`} role="group" aria-label={p.label}>
      {p.options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          className={p.value === k ? 'on' : ''}
          aria-pressed={p.value === k}
          onClick={() => p.onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<K extends string>(p: {
  value: K;
  tabs: readonly { key: K; label: ReactNode; n?: ReactNode; href?: string }[];
  onChange?: (k: K) => void;
}) {
  return (
    <nav className="tabs" role="tablist">
      {p.tabs.map((t) =>
        t.href ? (
          <a
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={p.value === t.key}
            className={`tab ${p.value === t.key ? 'on' : ''}`}
          >
            {t.label}
            {t.n !== undefined && <span className="n">{t.n}</span>}
          </a>
        ) : (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={p.value === t.key}
            className={`tab ${p.value === t.key ? 'on' : ''}`}
            onClick={() => p.onChange?.(t.key)}
          >
            {t.label}
            {t.n !== undefined && <span className="n">{t.n}</span>}
          </button>
        ),
      )}
    </nav>
  );
}

// ——— Recherche à invite ———

export function SearchBox(
  p: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
    value: string;
    onChange: (v: string) => void;
    autoFocusKey?: boolean;
  },
) {
  const { value, onChange, autoFocusKey, placeholder, ...rest } = p;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocusKey) return;
    // « / » place le curseur dans la recherche de l'écran.
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [autoFocusKey]);
  return (
    <label className="search">
      <span className="ps" aria-hidden>
        PS&gt;
      </span>
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder ?? T.app.search}
        aria-label={placeholder ?? T.app.search}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        {...rest}
      />
      {value && (
        <button
          type="button"
          className="clear"
          aria-label={T.app.clear}
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </label>
  );
}

// ——— États ———

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      {label ?? T.app.loading}
    </div>
  );
}

export function ErrorBox(props: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span className="tag">ERR</span>
      <span className="grow">{props.message}</span>
      {props.onRetry && (
        <Button small onClick={props.onRetry}>
          {T.app.retry}
        </Button>
      )}
    </div>
  );
}

export function Note({ tone, children }: { tone?: 'warn' | 'ok' | 'crit'; children: ReactNode }) {
  return <div className={`note ${tone ?? ''}`}>{children}</div>;
}

export function Empty({ children, glyph }: { children: ReactNode; glyph?: string }) {
  return (
    <div className="empty">
      <span className="big" aria-hidden>
        {glyph ?? '∅'}
      </span>
      {children}
    </div>
  );
}

// ——— Jauges et statistiques ———

/** Jauge segmentée « ████░░░░ 54 % ». */
export function Gauge(p: {
  value: number;
  max?: number;
  color?: string;
  label?: ReactNode;
  wide?: boolean;
}) {
  const max = p.max ?? 1;
  const ratio = Math.max(0, Math.min(1, max ? p.value / max : 0));
  return (
    <span className={`gauge ${p.wide ? 'wide' : ''}`} style={{ color: p.color ?? 'var(--t-cyan)' }}>
      <span
        className="bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={p.value}
      >
        <span className="fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      {p.label !== undefined && <span style={{ color: 'var(--t-text)' }}>{p.label}</span>}
    </span>
  );
}

export function Stat(p: {
  k: ReactNode;
  v: ReactNode;
  unit?: string;
  d?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="stat">
      <div className="k">{p.k}</div>
      <div className="v" style={p.tone ? { color: p.tone } : undefined}>
        {p.v}
        {p.unit && <small>{p.unit}</small>}
      </div>
      {p.d && <div className="d">{p.d}</div>}
    </div>
  );
}

// ——— Icônes (trait 1,5 px, 24×24) ———

const PATHS: Record<string, string> = {
  catalog:
    'M12 3l1.6 5.6L20 12v1.6l-6.4-1.8-.6 4.6 2.4 1.8V20L12 19l-3.4 1v-1.8l2.4-1.8-.6-4.6L4 13.6V12l6.4-3.4z',
  rules: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  research: 'M6 6h4v4H6zM14 14h4v4h-4zM14 4h4v4h-4zM10 8h4M8 10v6h6',
  orbat: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM8 12h8M8 15h5M8 9h8',
  scenarios: 'M5 21V4M5 4h11l-2 4 2 4H5',
  map: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  games: 'M8 5v14l11-7z',
  chat: 'M4 5h16v11H9l-5 4z',
  security: 'M6 11h12v9H6zM9 11V8a3 3 0 016 0v3M12 15v2',
  users:
    'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20c.8-3.4 3.2-5 6-5s5.2 1.6 6 5M16 4.5a3.5 3.5 0 010 6.5M18 15c1.6.6 2.6 2.2 3 5',
  shop: 'M4 5h2l2 11h10l2-8H7M10 20h0M17 20h0',
  audit: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6M10 8h2',
  metrics: 'M3 12h4l2-6 4 12 2-6h6',
  data: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 5a6 6 0 100 12 6 6 0 000-12zM20 20l-4.5-4.5',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  history: 'M4 12a8 8 0 108-8 8 8 0 00-7 4M4 4v4h4M12 8v4l3 2',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  close: 'M6 6l12 12M18 6L6 18',
  pause: 'M8 5v14M16 5v14',
  play: 'M8 5v14l11-7z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff:
    'M3 3l18 18M10.6 6.1A10 10 0 0112 6c6.4 0 10 6 10 6a17 17 0 01-3.2 3.8M6.2 7.6C3.6 9.4 2 12 2 12s3.6 6 10 6c1.6 0 3-.4 4.2-.9',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  ban: 'M12 3a9 9 0 100 18 9 9 0 000-18zM5.6 5.6l12.8 12.8',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  merge: 'M6 4v5a5 5 0 005 5h7M14 10l4 4-4 4M6 20v-6',
  target:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  check: 'M5 12l5 5 9-10',
  warn: 'M12 4l9 16H3zM12 10v4M12 17v0',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM15 8.5c-.6-.9-1.7-1.5-3-1.5-1.9 0-3 1-3 2.3 0 3 6 1.6 6 4.6 0 1.3-1.2 2.4-3 2.4-1.4 0-2.6-.6-3.2-1.6M12 5.5v1.5M12 17v1.5',
  megaphone: 'M4 10v4h3l7 4V6l-7 4zM17 9a4 4 0 010 6M7 14l1.5 5h2.5l-1.2-5',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`ico ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name] ?? PATHS.data} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="3" fill="#0e141b" stroke="#2a3947" />
      <path
        d="M6 8l4 4-4 4"
        fill="none"
        stroke="#4cc9f0"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 16.5h6" stroke="#ff4d5e" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
