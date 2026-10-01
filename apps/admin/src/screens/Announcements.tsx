/** Annonces globales : message à tous les joueurs connectés, rappelé à chaque connexion. */
import { useState } from 'react';
import type { Announcement } from '@redline/shared';
import { useSession } from '../context';
import { DataTable } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, ErrorBox, Icon, PageHead, Seg, Spinner, Win } from '../components/term';
import { T, fmt } from '../i18n';
import { O } from '../i18n/fr-ops';
import { fromLocalInput, toLocalInput } from '../lib/dates';
import { errorMessage } from '../lib/errors';
import { ago, date } from '../lib/format';
import { useLoad } from '../lib/hooks';
import './ops.css';

const A = O.announcements;

function stateOf(a: Announcement, now = Date.now()): ['ok' | 'off' | 'info' | 'warn', string] {
  if (!a.active) return ['off', A.inactive];
  if (Date.parse(a.endsAt) <= now) return ['off', A.expired];
  if (Date.parse(a.startsAt) > now) return ['info', A.upcoming];
  return ['ok', A.active];
}

export function AnnouncementsScreen() {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () => api.announcements().then((r) => r.announcements),
    [api],
    T.roles.superadmin,
  );
  const [text, setText] = useState('');
  const [level, setLevel] = useState<'info' | 'warn'>('info');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState(() =>
    toLocalInput(new Date(Date.now() + 24 * 3600_000).toISOString()),
  );
  const [broadcast, setBroadcast] = useState(true);
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    if (
      !(await confirm({
        title: A.publish,
        message: `${A.confirm}\n\n« ${text.trim()} »`,
        confirm: A.publish,
      }))
    )
      return;
    setBusy(true);
    try {
      const start = startsAt ? fromLocalInput(startsAt) : null;
      const r = await api.createAnnouncement({
        text: text.trim(),
        level,
        ...(start ? { startsAt: start } : {}),
        endsAt: fromLocalInput(endsAt)!,
        active: true,
        broadcast,
      });
      toast(fmt(A.published, { n: r.sent }));
      setText('');
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };

  return (
    <>
      <PageHead title={A.title} sub={A.sub} />
      <div className="stack">
        <Win title={A.publish} glyph="!" cmd="Send-Announcement">
          <div className="stack">
            <div className="field">
              <label htmlFor="an-text">{A.text}</label>
              <textarea
                id="an-text"
                className="input"
                rows={3}
                maxLength={500}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <small className="field-hint">{text.length} / 500</small>
            </div>
            <div className="form-grid">
              <div className="field">
                <span className="field-label">{A.level}</span>
                <Seg
                  small
                  label={A.level}
                  value={level}
                  onChange={setLevel}
                  options={[
                    ['info', A.levels.info],
                    ['warn', A.levels.warn],
                  ]}
                />
              </div>
              <div className="field">
                <label htmlFor="an-start">{A.startsAt}</label>
                <input
                  id="an-start"
                  type="datetime-local"
                  className="input"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="an-end">{A.endsAt}</label>
                <input
                  id="an-end"
                  type="datetime-local"
                  className="input"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              </div>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={broadcast}
                onChange={(e) => setBroadcast(e.target.checked)}
              />
              {A.broadcast}
            </label>
            <div>
              <Button
                variant="primary"
                disabled={busy || !text.trim() || !endsAt}
                onClick={() => void publish()}
              >
                <Icon name="megaphone" size={14} /> {A.publish}
              </Button>
            </div>
          </div>
        </Win>
        {error && <ErrorBox message={error} onRetry={() => void reload()} />}
        <Win title={A.list} glyph="≡" flush>
          {loading && !data ? (
            <Spinner />
          ) : (
            <DataTable
              rows={data ?? []}
              rowKey={(a) => String(a.id)}
              bare
              empty={A.none}
              columns={[
                {
                  key: 's',
                  label: '',
                  render: (a) => {
                    const [tone, label] = stateOf(a);
                    return <Badge tone={tone}>{label}</Badge>;
                  },
                },
                {
                  key: 't',
                  label: A.text,
                  className: 'wrap',
                  render: (a) => (
                    <span className={a.level === 'warn' ? 'c-amber' : undefined}>{a.text}</span>
                  ),
                },
                { key: 'b', label: A.startsAt, hideM: true, render: (a) => date(a.startsAt) },
                {
                  key: 'e',
                  label: A.endsAt,
                  render: (a) => <span title={date(a.endsAt)}>{ago(a.endsAt)}</span>,
                },
                { key: 'w', label: A.author, hideM: true, render: (a) => a.authorName ?? '—' },
                {
                  key: 'x',
                  label: '',
                  align: 'right',
                  render: (a) => (
                    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <Button
                        small
                        onClick={() =>
                          void act(() => api.updateAnnouncement(a.id, { active: !a.active }))
                        }
                      >
                        {a.active ? A.disable : A.enable}
                      </Button>
                      <Button
                        small
                        variant="ghost"
                        aria-label={A.remove}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: A.remove,
                              message: A.removeConfirm,
                              danger: true,
                              confirm: A.remove,
                            })
                          )
                            void act(() => api.deleteAnnouncement(a.id));
                        }}
                      >
                        <Icon name="close" size={12} />
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Win>
      </div>
    </>
  );
}
