/** Modération de la messagerie : recherche, masquage, sourdine. */
import { useEffect, useMemo, useState } from 'react';
import { hasRole } from '@redline/shared';
import { useSession } from '../context';
import type { AdminChatMessage } from '../api/types';
import { DataTable } from '../components/DataTable';
import { Flag } from '../components/Flag';
import { Dialog, useToast } from '../components/overlay';
import { Badge, Button, ErrorBox, Icon, PageHead, SearchBox, Win } from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { date, dateLong } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { href, navigate } from '../lib/router';

const channelLabel = (c: string) => {
  const kind = c.split(':')[0]!;
  return T.chat.channels[kind] ?? kind;
};

export function ChatScreen({ gameId }: { gameId?: string }) {
  const { api, user } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [muteFor, setMuteFor] = useState<AdminChatMessage | null>(null);
  const [hours, setHours] = useState(24);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const games = useLoad(() => api.listGames().then((r) => r.games), [api], T.roles.moderator);
  const msgs = useLoad(
    () =>
      api
        .listChat({ gameId, q: debounced || undefined, userId: userId ?? undefined, limit: 300 })
        .then((r) => r.messages),
    [api, gameId, debounced, userId],
    T.roles.moderator,
  );
  const gameName = useMemo(
    () => new Map((games.data ?? []).map((g) => [g.game.id, g.game.name])),
    [games.data],
  );
  const rows = useMemo(
    () => (msgs.data ?? []).filter((m) => !flagged || m.filtered || m.hidden),
    [msgs.data, flagged],
  );

  const hide = async (m: AdminChatMessage) => {
    const hidden = !m.hidden;
    try {
      await api.hideMessage(m.id, hidden);
      msgs.setData((l) =>
        (l ?? []).map((x) => (x.id === m.id ? { ...x, hidden: hidden || undefined } : x)),
      );
      toast(hidden ? T.chat.hiddenDone : T.chat.unhiddenDone);
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    }
  };
  const mute = async () => {
    if (!muteFor) return;
    try {
      const r = await api.mute(muteFor.from.userId, hours);
      toast(
        r.mutedUntil
          ? fmt(T.chat.muteDone, { name: muteFor.from.name, until: date(r.mutedUntil) })
          : fmt(T.chat.unmuteDone, { name: muteFor.from.name }),
      );
      setMuteFor(null);
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    }
  };
  const superadmin = hasRole(user.role, 'superadmin');

  return (
    <>
      <PageHead title={T.chat.title} sub={T.chat.sub} />
      <Win
        title={T.nav.chat}
        cmd={`Get-ChatMessage${gameId ? ` -Game ${gameId.slice(0, 8)}` : ''}${debounced ? ` -Match "${debounced}"` : ''}`}
      >
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder={T.chat.search} autoFocusKey />
          <select
            className="input"
            aria-label={T.chat.game}
            value={gameId ?? ''}
            onChange={(e) =>
              navigate(e.target.value ? { name: 'chat', gameId: e.target.value } : { name: 'chat' })
            }
          >
            <option value="">{T.chat.allGames}</option>
            {(games.data ?? []).map((g) => (
              <option key={g.game.id} value={g.game.id}>
                {g.game.name}
              </option>
            ))}
          </select>
          <label className="switch">
            <input
              type="checkbox"
              checked={flagged}
              onChange={(e) => setFlagged(e.target.checked)}
            />
            <span className="track" aria-hidden />
            {T.chat.onlyFlagged}
          </label>
          {userId && (
            <span className="chip on">
              {rows[0]?.from.name ?? userId.slice(0, 8)}
              <button type="button" aria-label={T.app.clear} onClick={() => setUserId(null)}>
                ×
              </button>
            </span>
          )}
          <span className="meta">{fmt(T.chat.count, { n: rows.length })}</span>
        </div>
        {msgs.error && <ErrorBox message={msgs.error} onRetry={() => void msgs.reload()} />}
        <DataTable
          rows={rows}
          rowKey={(m) => String(m.id)}
          rowClass={(m) => (m.hidden ? 'off' : '')}
          maxHeight="calc(100vh - 290px)"
          empty={msgs.loading ? T.app.loading : T.chat.empty}
          columns={[
            {
              key: 't',
              label: T.chat.time,
              sort: (m) => m.sentAt,
              render: (m) => (
                <span className="dim" title={dateLong(m.sentAt)}>
                  {date(m.sentAt)}
                </span>
              ),
            },
            {
              key: 'g',
              label: T.chat.game,
              hideM: true,
              render: (m) => (
                <a href={href({ name: 'games', id: m.gameId })}>
                  {gameName.get(m.gameId) ?? m.gameId.slice(0, 8)}
                </a>
              ),
            },
            {
              key: 'c',
              label: T.chat.channel,
              hideM: true,
              render: (m) => (
                <span className="muted" title={m.channel}>
                  {channelLabel(m.channel)}
                </span>
              ),
            },
            {
              key: 'a',
              label: T.chat.author,
              sort: (m) => m.from.name,
              render: (m) => (
                <span className="row" style={{ gap: 6 }}>
                  {m.from.nationId && <Flag id={m.from.nationId} />}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '0 4px' }}
                    title={T.chat.byUser}
                    onClick={() => setUserId(m.from.userId)}
                  >
                    {m.from.name}
                  </button>
                </span>
              ),
            },
            {
              key: 'x',
              label: T.chat.text,
              className: 'wrap',
              render: (m) => (
                <span
                  style={{
                    display: 'inline-block',
                    minWidth: 220,
                    maxWidth: 560,
                    padding: '5px 0',
                  }}
                >
                  {m.hidden && <Badge tone="off">{T.chat.hidden}</Badge>}{' '}
                  {m.filtered && <Badge tone="warn">{T.chat.filtered}</Badge>}{' '}
                  <span className={m.hidden ? 'dim' : ''}>{m.text}</span>
                </span>
              ),
            },
            {
              key: 'act',
              label: '',
              align: 'right',
              render: (m) => (
                <span className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                  <Button
                    small
                    variant="ghost"
                    onClick={() => void hide(m)}
                    title={m.hidden ? T.chat.unhide : T.chat.hide}
                  >
                    <Icon name={m.hidden ? 'eye' : 'eyeoff'} size={13} />
                    <span className="hide-m">{m.hidden ? T.chat.unhide : T.chat.hide}</span>
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    onClick={() => setMuteFor(m)}
                    title={T.chat.mute}
                    disabled={!m.from.userId}
                  >
                    <Icon name="mute" size={13} />
                    <span className="hide-m">{T.chat.mute}</span>
                  </Button>
                  {superadmin && m.from.userId && (
                    <a
                      className="btn btn-ghost btn-sm btn-icon"
                      href={href({ name: 'users', id: m.from.userId })}
                      title={T.security.profile}
                      aria-label={T.security.profile}
                    >
                      <Icon name="users" size={13} />
                    </a>
                  )}
                </span>
              ),
            },
          ]}
        />
      </Win>
      {muteFor && (
        <Dialog
          title={fmt(T.chat.muteTitle, { name: muteFor.from.name })}
          onClose={() => setMuteFor(null)}
          actions={
            <>
              <Button onClick={() => setMuteFor(null)}>{T.app.cancel}</Button>
              <Button variant={hours ? 'danger' : 'primary'} onClick={() => void mute()}>
                {hours ? T.chat.mute : T.chat.durations[0]}
              </Button>
            </>
          }
        >
          <p className="muted small">« {muteFor.text} »</p>
          <div className="field">
            <label htmlFor="mute-h">{T.chat.muteDuration}</label>
            <select id="mute-h" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[1, 24, 168, 720, 0].map((h) => (
                <option key={h} value={h}>
                  {T.chat.durations[h]}
                </option>
              ))}
            </select>
          </div>
        </Dialog>
      )}
    </>
  );
}
