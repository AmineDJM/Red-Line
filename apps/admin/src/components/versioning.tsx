/** Barre d'enregistrement (motif, portée, message aux joueurs) et historique des révisions avec diff. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChangeScope } from '@redline/shared';
import type { DataRevision } from '../api/types';
import { T, fmt } from '../i18n';
import { diffObjects, formatValue, type FieldChange } from '../lib/diff';
import { ago, dateLong } from '../lib/format';
import type { ReadableIssue } from '../lib/validation';
import { useConfirm } from './overlay';
import { Badge, Button, Empty, Icon, Seg, Win } from './term';

export interface CommitMeta {
  message: string;
  scope: ChangeScope;
  playerMessage: string;
}

export function CommitBar(p: {
  valid: boolean;
  issues: readonly ReadableIssue[];
  changes: number;
  dirty: boolean;
  busy: boolean;
  isNew?: boolean;
  warnings?: readonly string[];
  onSave: (m: CommitMeta) => Promise<boolean>;
  onDiscard?: () => void;
  onIssueClick?: (path: string) => void;
  /** Portée proposée (masquée pour les données sans effet sur les parties en cours). */
  scopes?: boolean;
  saveLabel?: string;
  title?: string;
  children?: ReactNode;
}) {
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [scope, setScope] = useState<ChangeScope>('new_games');
  const [playerMessage, setPlayerMessage] = useState('');
  const canSave = p.valid && p.dirty && !p.busy;
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (!canSave) return;
    void p.onSave({ message, scope, playerMessage }).then((ok) => {
      if (ok) {
        setMessage('');
        setPlayerMessage('');
      }
    });
  };
  // Ctrl+S / Cmd+S enregistre.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // Garde-fou : quitter la page avec des modifications en cours.
  useEffect(() => {
    if (!p.dirty) return;
    const b = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', b);
    return () => window.removeEventListener('beforeunload', b);
  }, [p.dirty]);

  const status = (
    <div className="status">
      {p.valid ? (
        <Badge tone="ok">✓ {T.commit.valid}</Badge>
      ) : (
        <Badge tone="crit">✕ {fmt(T.commit.invalid, { n: p.issues.length })}</Badge>
      )}
      {p.isNew ? (
        <Badge tone="info">{T.app.create}</Badge>
      ) : p.changes ? (
        <Badge tone="warn">● {fmt(T.commit.changed, { n: p.changes })}</Badge>
      ) : (
        <Badge tone="off">{T.commit.unchanged}</Badge>
      )}
      {!!p.warnings?.length && (
        <Badge tone="warn">! {fmt(T.commit.warnings, { n: p.warnings.length })}</Badge>
      )}
    </div>
  );
  const label = p.busy ? T.app.saving : (p.saveLabel ?? T.app.save);

  return (
    <>
      <Win title={p.title ?? T.commit.title} glyph="$">
        <div className="commit">
          {status}
          {!p.valid && (
            <ul className="issues">
              {p.issues.slice(0, 14).map((i, k) => (
                <li key={k}>
                  <button type="button" onClick={() => p.onIssueClick?.(i.path)}>
                    <b>{i.label}</b> : {i.message}
                  </button>
                </li>
              ))}
              {p.issues.length > 14 && <li>…</li>}
            </ul>
          )}
          {!!p.warnings?.length && (
            <ul className="issues warn">
              {p.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {p.children}
          <div className="field">
            <label htmlFor="commit-msg">{T.commit.message}</label>
            <input
              id="commit-msg"
              value={message}
              maxLength={500}
              placeholder={T.commit.messagePlaceholder}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {p.scopes !== false && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label" style={{ marginBottom: 6 }}>
                {T.commit.scope}
              </legend>
              <div className="stack-sm">
                {(['new_games', 'running_games'] as const).map((s) => (
                  <label key={s} className="radio">
                    <input
                      type="radio"
                      name="commit-scope"
                      checked={scope === s}
                      onChange={() => setScope(s)}
                    />
                    <span className="radio-dot" aria-hidden />
                    {T.scope[s]}
                  </label>
                ))}
              </div>
              {scope === 'running_games' && (
                <>
                  <small className="field-warn" style={{ marginTop: 6 }}>
                    {T.commit.runningWarn}
                  </small>
                  <div className="field" style={{ marginTop: 8 }}>
                    <label htmlFor="commit-pmsg">{T.commit.playerMessage}</label>
                    <textarea
                      id="commit-pmsg"
                      rows={2}
                      maxLength={500}
                      value={playerMessage}
                      placeholder={T.commit.playerPlaceholder}
                      onChange={(e) => setPlayerMessage(e.target.value)}
                    />
                  </div>
                </>
              )}
            </fieldset>
          )}
          <div className="row">
            <Button
              variant="primary"
              className="grow"
              disabled={!canSave}
              onClick={() => saveRef.current()}
              kbd={T.commit.shortcut}
            >
              <Icon name="save" size={14} />
              {label}
            </Button>
            {p.onDiscard && p.dirty && !p.isNew && (
              <Button
                icon
                title={T.commit.discard}
                aria-label={T.commit.discard}
                onClick={async () => {
                  if (
                    await confirm({
                      title: T.commit.discard,
                      message: T.commit.discardConfirm,
                      danger: true,
                    })
                  )
                    p.onDiscard!();
                }}
              >
                <Icon name="undo" size={14} />
              </Button>
            )}
          </div>
        </div>
      </Win>
      <div className="save-dock">
        {status}
        <Button
          variant="primary"
          className="grow"
          disabled={!canSave}
          onClick={() => saveRef.current()}
        >
          {label}
        </Button>
      </div>
    </>
  );
}

/** Tableau de différences champ par champ. */
export function DiffTable({
  changes,
  labelFor,
}: {
  changes: FieldChange[];
  labelFor?: (p: string) => string;
}) {
  if (!changes.length) return <p className="muted small">{T.revisions.noDiff}</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="diff">
        <colgroup>
          <col style={{ width: '34%' }} />
          <col style={{ width: '33%' }} />
          <col style={{ width: '33%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>{T.revisions.field}</th>
            <th>{T.revisions.before}</th>
            <th>{T.revisions.after}</th>
          </tr>
        </thead>
        <tbody>
          {changes.slice(0, 200).map((c) => (
            <tr key={c.path}>
              <td>
                {labelFor ? labelFor(c.path) : c.path}
                {labelFor && <span className="path">{c.path}</span>}
              </td>
              <td className="before">{formatValue(c.before)}</td>
              <td className="after">{formatValue(c.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Historique des révisions d'une donnée : liste chronologique, diff, restauration et retour au dépôt. */
export function RevisionPanel<T>(p: {
  revisions: DataRevision<T>[];
  source: 'admin' | 'repo';
  current: T | null;
  busy: boolean;
  onRestore: (rev: DataRevision<T>) => void;
  onReset?: () => void;
  labelFor?: (path: string) => string;
  authorName?: (id: string | null) => string;
}) {
  const confirm = useConfirm();
  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<'prev' | 'current'>('prev');
  const revs = p.revisions;
  const idx = Math.max(
    0,
    revs.findIndex((r) => r.id === sel),
  );
  const rev = revs[idx] ?? null;
  const prev = revs[idx + 1] ?? null;
  const effective = (r: DataRevision<T> | null) => (r ? r.data : null);
  let diff: FieldChange[] = [];
  let note: string | null = null;
  if (rev) {
    if (mode === 'prev' && prev) diff = diffObjects(effective(prev) ?? {}, effective(rev) ?? {});
    else {
      diff = diffObjects(effective(rev) ?? {}, p.current ?? {});
      if (mode === 'prev') note = T.revisions.noPrev;
    }
  }
  return (
    <Win
      title={T.revisions.title}
      glyph="↶"
      actions={
        p.onReset && p.source === 'admin' ? (
          <Button
            small
            variant="danger"
            disabled={p.busy}
            onClick={async () => {
              if (
                await confirm({
                  title: T.revisions.reset,
                  message: T.revisions.resetConfirm,
                  danger: true,
                  confirm: T.revisions.reset,
                })
              )
                p.onReset!();
            }}
          >
            {T.revisions.reset}
          </Button>
        ) : undefined
      }
    >
      <div className="spread small" style={{ marginBottom: 10 }}>
        <span className="muted">
          {T.revisions.source} :{' '}
          <span className={p.source === 'admin' ? 'c-amber' : 'c-green'}>
            {p.source === 'admin' ? T.revisions.sourceAdmin : T.revisions.sourceRepo}
          </span>
        </span>
      </div>
      {revs.length === 0 ? (
        <Empty glyph="≡">{T.revisions.empty}</Empty>
      ) : (
        <>
          <ol className="revs" style={{ maxHeight: 260, overflow: 'auto' }}>
            {revs.map((r, i) => (
              <li key={r.id}>
                <div
                  className={`rev ${rev?.id === r.id ? 'on' : ''} ${i === 0 ? 'current' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSel(r.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setSel(r.id)}
                >
                  <span />
                  <div>
                    <div className="rev-top">
                      <b className="c-cyan">#{r.id}</b>
                      <span className="muted" title={dateLong(r.createdAt)}>
                        {ago(r.createdAt)}
                      </span>
                      {i === 0 && <Badge tone="ok">{T.revisions.current}</Badge>}
                      {r.data === null && <Badge tone="blue">{T.revisions.repo}</Badge>}
                      {r.scope === 'running_games' && (
                        <Badge tone="warn">{T.scopeShort.running_games}</Badge>
                      )}
                    </div>
                    <div className="rev-msg">{r.message || '—'}</div>
                    {p.authorName && (
                      <div className="rev-meta">
                        {fmt(T.revisions.by, { author: p.authorName(r.authorId) })}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {rev && (
            <div style={{ marginTop: 12 }}>
              <div className="spread" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                <Seg
                  small
                  value={mode}
                  onChange={setMode}
                  options={[
                    ['prev', T.revisions.vsPrev],
                    ['current', T.revisions.vsCurrent],
                  ]}
                />
                <Button
                  small
                  disabled={p.busy || (revs[0]?.id === rev.id && diff.length === 0)}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: T.revisions.restore,
                        message: fmt(T.revisions.restoreConfirm, { n: rev.id }),
                        confirm: T.revisions.restore,
                      })
                    )
                      p.onRestore(rev);
                  }}
                >
                  <Icon name="undo" size={13} /> {T.revisions.restoreShort}
                </Button>
              </div>
              {note && <p className="dim tiny">{note}</p>}
              {rev.data === null && mode === 'prev' ? (
                <p className="muted small">{T.revisions.sourceRepo}</p>
              ) : (
                <DiffTable changes={diff} labelFor={p.labelFor} />
              )}
            </div>
          )}
        </>
      )}
    </Win>
  );
}
