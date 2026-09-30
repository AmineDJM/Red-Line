import { useState } from 'react';
import type { CatalogChange } from '@redline/shared';
import { useSession } from '../context';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, Empty, ErrorBox, Icon, PageHead, Spinner, Win } from '../components/term';
import { DiffTable } from '../components/versioning';
import { T, fmt } from '../i18n';
import { diffObjects } from '../lib/diff';
import { errorMessage } from '../lib/errors';
import { ago, dateLong } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { href } from '../lib/router';
import { fieldLabel } from '../lib/validation';

/** Historique d'une fiche d'arme : chaque modification, son diff et le retour à l'état d'avant. */
export function HistoryScreen({ id }: { id: string }) {
  const { api, cache } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () =>
      Promise.all([api.getSystem(id), api.history(id)]).then(([s, h]) => ({
        system: s.system,
        changes: [...h.changes].sort((a, b) => b.id - a.id),
      })),
    [api, id],
    T.roles.balance,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const revert = async (c: CatalogChange) => {
    if (
      !(await confirm({
        title: T.history.revert,
        message: fmt(T.history.revertConfirm, { n: c.revision }),
        confirm: T.history.revert,
      }))
    )
      return;
    setBusy(true);
    try {
      const { system } = await api.revert(id, c.id);
      cache.invalidate('systems');
      toast(fmt(T.history.reverted, { n: system.revision }));
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
    <>
      <PageHead
        crumbs={
          <>
            <a href={href({ name: 'catalog' })}>{T.nav.catalog}</a> /{' '}
            <a href={href({ name: 'system', id })}>{data.system.system.name}</a>
          </>
        }
        title={`${T.history.title} — ${data.system.system.name}`}
        sub={`${id} · ${fmt(T.editor.revision, { n: data.system.revision })}`}
      />
      <div className="split-list">
        <Win title={T.history.title} cmd={`Get-History ${id}`} flush>
          {data.changes.length === 0 ? (
            <Empty>{T.history.empty}</Empty>
          ) : (
            <ol
              className="revs"
              style={{ padding: 10, maxHeight: 'calc(100vh - 220px)', overflow: 'auto' }}
            >
              {data.changes.map((c, i) => {
                const n = diffObjects(c.before, c.after).length;
                return (
                  <li key={c.id}>
                    <div
                      className={`rev ${current?.id === c.id ? 'on' : ''} ${i === 0 ? 'current' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(c.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setSelected(c.id)}
                    >
                      <span />
                      <div>
                        <div className="rev-top">
                          <b className="c-cyan">{fmt(T.history.revision, { n: c.revision })}</b>
                          <span className="muted" title={dateLong(c.createdAt)}>
                            {ago(c.createdAt)}
                          </span>
                        </div>
                        <div className="rev-msg">{c.message || '—'}</div>
                        <div className="rev-meta">
                          <span>{fmt(T.history.by, { author: c.author })}</span>
                          {!c.before ? (
                            <Badge tone="info">{T.history.created}</Badge>
                          ) : !c.after ? (
                            <Badge tone="crit">{T.history.deleted}</Badge>
                          ) : (
                            <Badge tone="off">{fmt(T.history.changes, { n })}</Badge>
                          )}
                          {c.scope === 'running_games' && (
                            <Badge tone="warn">{T.scopeShort.running_games}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Win>
        <Win
          title={
            current
              ? `${fmt(T.history.revision, { n: current.revision })} · ${current.message || '—'}`
              : T.history.title
          }
          glyph="Δ"
          actions={
            current?.before ? (
              <Button small variant="danger" disabled={busy} onClick={() => void revert(current)}>
                <Icon name="undo" size={13} /> {T.history.revert}
              </Button>
            ) : undefined
          }
        >
          {!current ? (
            <Empty>{T.history.select}</Empty>
          ) : (
            <DiffTable changes={diff} labelFor={fieldLabel} />
          )}
        </Win>
      </div>
    </>
  );
}
