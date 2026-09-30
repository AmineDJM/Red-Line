import { useState } from 'react';
import type { CatalogChange } from '@redline/shared';
import { useSession } from '../context';
import { Badge, Button, Dialog, ErrorBox, Frame, Spinner, useToast } from '../components/ui';
import { T, date, fmt } from '../i18n';
import { diffObjects, formatValue } from '../lib/diff';
import { errorMessage } from '../lib/errors';
import { useLoad } from '../lib/hooks';
import { href } from '../lib/router';
import { fieldLabel } from '../lib/validation';

export function HistoryScreen({ id }: { id: string }) {
  const { api } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(
    () =>
      Promise.all([api.getSystem(id), api.history(id)]).then(([s, h]) => ({
        system: s.system,
        changes: sortChanges(h.changes),
      })),
    [api, id],
    T.roles.balance,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<CatalogChange | null>(null);
  const [busy, setBusy] = useState(false);

  const revert = async (c: CatalogChange) => {
    setBusy(true);
    try {
      const { system } = await api.revert(id, c.id);
      toast(fmt(T.history.reverted, { n: system.revision }));
      setConfirm(null);
      setSelected(null);
      await reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const current = data.changes.find((c) => c.id === selected) ?? data.changes[0] ?? null;
  const diff = current ? diffObjects(current.before, current.after) : [];

  return (
    <div className="editor">
      <div className="editor-bar">
        <a className="back" href={href({ name: 'system', id })}>
          ← {data.system.system.name}
        </a>
        <div className="editor-title">
          <h1>
            {T.history.title} — {data.system.system.name}
          </h1>
          <span className="mono muted">
            {id} · {fmt(T.editor.revision, { n: data.system.revision })}
          </span>
        </div>
      </div>
      <div className="history-grid">
        <Frame title={T.history.title}>
          {data.changes.length === 0 && <p className="muted">{T.history.empty}</p>}
          <ol className="changes">
            {data.changes.map((c) => {
              const n = diffObjects(c.before, c.after).length;
              return (
                <li key={c.id}>
                  <button
                    className={`change ${current?.id === c.id ? 'change-on' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <span className="change-top">
                      <strong className="mono">{fmt(T.history.revision, { n: c.revision })}</strong>
                      <span className="muted">{date(c.createdAt)}</span>
                    </span>
                    <span className="change-msg">{c.message || '—'}</span>
                    <span className="change-meta">
                      <span className="muted">{fmt(T.history.by, { author: c.author })}</span>
                      {!c.before ? (
                        <Badge tone="info">{T.history.created}</Badge>
                      ) : !c.after ? (
                        <Badge tone="crit">{T.history.deleted}</Badge>
                      ) : (
                        <Badge tone="off">{fmt(T.history.changes, { n })}</Badge>
                      )}
                      {c.scope === 'running_games' && (
                        <Badge tone="warn">{T.scope.running_games}</Badge>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Frame>
        <Frame
          title={
            current
              ? `${fmt(T.history.revision, { n: current.revision })} · ${current.message || '—'}`
              : T.history.title
          }
          actions={
            current?.before ? (
              <Button variant="danger" onClick={() => setConfirm(current)}>
                ↶ {T.history.revert}
              </Button>
            ) : undefined
          }
        >
          {!current && <p className="muted">{T.history.select}</p>}
          {current && diff.length === 0 && <p className="muted">{T.history.noDiff}</p>}
          {current && diff.length > 0 && (
            <table className="diff">
              <thead>
                <tr>
                  <th>{T.history.field}</th>
                  <th>{T.history.before}</th>
                  <th>{T.history.after}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((c) => (
                  <tr key={c.path}>
                    <td>
                      <div className="diff-field">
                        <span>{fieldLabel(c.path)}</span>
                        <span className="mono muted small">{c.path}</span>
                      </div>
                    </td>
                    <td className="mono diff-before">{formatValue(c.before)}</td>
                    <td className="mono diff-after">{formatValue(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Frame>
      </div>
      {confirm && (
        <Dialog
          title={T.history.revert}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button onClick={() => setConfirm(null)}>{T.app.cancel}</Button>
              <Button variant="danger" disabled={busy} onClick={() => void revert(confirm)}>
                {T.app.confirm}
              </Button>
            </>
          }
        >
          <p>{fmt(T.history.revertConfirm, { n: confirm.revision })}</p>
        </Dialog>
      )}
    </div>
  );
}

function sortChanges(c: CatalogChange[]): CatalogChange[] {
  return [...c].sort((a, b) => b.revision - a.revision || b.id - a.id);
}
