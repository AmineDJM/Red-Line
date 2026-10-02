import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, NationId } from '@redline/shared';
import { Button, EmptyState, Flag, Icon, Select, Window } from '@redline/ui';
import { nationName } from '../lib/game.js';
import type { ChatChannel } from '../net/connection.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';
import { LOCALE, compareNames } from '../i18n/index.js';

interface Conv {
  key: string;
  kind: ChatChannel;
  to?: NationId;
  label: string;
}

function convKey(m: ChatMessage): string {
  return m.channel.startsWith('alliance:') ? 'alliance' : m.channel;
}

/** Messagerie : salon de la partie, alliance, messages privés. */
export function ChatWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const chat = useGame((s) => s.chat);
  const me = useGame((s) => s.me);
  const view = useGame((s) => s.view);
  const chatRead = useGame((s) => s.chatRead);
  const markChannelRead = useGame((s) => s.markChannelRead);
  const nations = useWorld((s) => s.nations);
  const [active, setActive] = useState<string>(
    win.params.channel === 'alliance' ? 'alliance' : 'game',
  );
  const [text, setText] = useState('');
  const [newTo, setNewTo] = useState('');
  const [showList, setShowList] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (win.params.channel)
      setActive(win.params.channel === 'alliance' ? 'alliance' : win.params.channel);
  }, [win.seq, win.params.channel]);

  const alliance = view?.diplomacy?.alliances.find((a) => a.id === view.diplomacy?.myAllianceId);
  const convs: Conv[] = useMemo(() => {
    const list: Conv[] = [{ key: 'game', kind: 'game', label: t('chat.game') }];
    if (alliance)
      list.push({
        key: 'alliance',
        kind: 'alliance',
        label: t('chat.alliance', { name: alliance.name }),
      });
    const privates = new Set(
      chat.filter((m) => m.channel.startsWith('private:')).map((m) => m.channel),
    );
    if (active.startsWith('private:')) privates.add(active);
    for (const ch of privates) {
      const other =
        ch
          .slice('private:'.length)
          .split('|')
          .find((x) => x !== me) ?? '';
      list.push({ key: ch, kind: 'private', to: other, label: nationName(other) });
    }
    return list;
  }, [chat, alliance, me, active, t]);

  const cur = convs.find((c) => c.key === active) ?? convs[0]!;
  const messages = chat.filter((m) => convKey(m) === cur.key);
  const unread = (c: Conv) =>
    chat.filter(
      (m) => convKey(m) === c.key && m.from.nationId !== me && m.id > (chatRead[m.channel] ?? 0),
    ).length;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    const ch = messages[messages.length - 1]?.channel;
    if (ch) markChannelRead(ch);
  }, [messages.length, cur.key, markChannelRead]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    useGame.getState().connection?.sendChat?.(cur.kind, v, cur.to);
    setText('');
  };

  const openPrivate = (id: string) => {
    if (!id || !me) return;
    setActive(`private:${[me, id].sort().join('|')}`);
    setNewTo('');
    if (mobile) setShowList(false);
  };

  const list = (
    <aside className="chat__convs">
      <ul>
        {convs.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              className={c.key === cur.key ? 'conv conv--on' : 'conv'}
              onClick={() => {
                setActive(c.key);
                if (mobile) setShowList(false);
              }}
            >
              {c.kind === 'private' && c.to ? (
                <Flag nationId={c.to} size={11} />
              ) : (
                <Icon name={c.kind === 'game' ? 'globe' : 'users'} size={14} />
              )}
              <span className="conv__label">{c.label}</span>
              {unread(c) ? <i className="conv__badge">{unread(c)}</i> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="chat__new">
        <span className="dept__label">{t('chat.newPrivate')}</span>
        <Select
          value={newTo}
          onChange={openPrivate}
          label={t('chat.newPrivate')}
          options={[
            { value: '', label: t('chat.pickNation') },
            ...Object.values(nations)
              .filter((n) => n.id !== me)
              .sort((a, b) => compareNames(a.name, b.name))
              .map((n) => ({ value: n.id, label: n.name })),
          ]}
        />
      </div>
    </aside>
  );

  return (
    <Window {...frame} path={[t('sections.path.chat'), cur.label]} flush>
      <div className={mobile ? 'chat chat--mobile' : 'chat'}>
        {!mobile || showList ? list : null}
        {!mobile || !showList ? (
          <section className="chat__main" aria-label={cur.label}>
            {mobile ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="chevronLeft" size={13} />}
                onClick={() => setShowList(true)}
              >
                {t('chat.channels')}
              </Button>
            ) : null}
            <div className="chat__log" role="log" aria-live="polite">
              {messages.length ? (
                messages.map((m, i) => {
                  const mine = m.from.nationId === me && m.from.userId !== 'bot';
                  const prev = messages[i - 1];
                  const grouped = prev && prev.from.userId === m.from.userId;
                  const time = new Date(m.sentAt).toLocaleTimeString(LOCALE, {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  return (
                    <div
                      key={m.id}
                      className={[
                        'msg',
                        mine ? 'msg--mine' : '',
                        grouped ? 'msg--grouped' : '',
                      ].join(' ')}
                    >
                      {!grouped ? (
                        <div className="msg__head">
                          {m.from.nationId ? <Flag nationId={m.from.nationId} size={10} /> : null}
                          <b>{m.from.name}</b>
                          {m.from.nationId ? (
                            <span className="muted">{nationName(m.from.nationId)}</span>
                          ) : null}
                          <span className="msg__time">{time}</span>
                        </div>
                      ) : null}
                      <p className={m.hidden ? 'msg__text msg__text--hidden' : 'msg__text'}>
                        {m.hidden ? t('chat.hidden') : m.text}
                      </p>
                    </div>
                  );
                })
              ) : (
                <EmptyState compact icon="chat" title={t('chat.empty')} />
              )}
              <div ref={bottom} />
            </div>
            <form className="chat__compose" onSubmit={send}>
              <span className="chat__prompt" aria-hidden>
                &gt;
              </span>
              <input
                value={text}
                maxLength={1000}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('chat.placeholder', { channel: cur.label })}
                aria-label={t('chat.message')}
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={<Icon name="send" size={12} />}
                disabled={!text.trim()}
              >
                {t('chat.send')}
              </Button>
            </form>
          </section>
        ) : null}
      </div>
    </Window>
  );
}
