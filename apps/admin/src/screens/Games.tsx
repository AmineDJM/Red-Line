/** Parties en direct : liste, détail, pause et reprise, joueurs, événements mondiaux. */
import { useMemo, useState } from 'react';
import { DAY, HOUR, MINUTE, WorldEventBodySchema, type AdminGame } from '@redline/shared';
import { useSession } from '../context';
import type { WorldEventId } from '../api/types';
import { DataTable } from '../components/DataTable';
import { Nation } from '../components/Flag';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  Note,
  PageHead,
  SearchBox,
  SectionTitle,
  Spinner,
  Stat,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { ago, num } from '../lib/format';
import { useInterval, useLoad } from '../lib/hooks';
import { useNationMap } from '../lib/refs';
import { href, navigate } from '../lib/router';
import { matches } from '../lib/search';

const REFRESH_S = 10;
type AiLevel = 'easy' | 'normal' | 'hard';
const EVENTS = WorldEventBodySchema.shape.event.options as readonly WorldEventId[];

/** Temps de jeu (ms) → « J3 14:20 ». */
export function formatGameTime(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  return `J${d + 1} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const STATUS_TONE = { running: 'ok', paused: 'warn', lobby: 'info', ended: 'off' } as const;

export function GamesScreen({ id }: { id?: string }) {
  const { api } = useSession();
  const { data, setData, error, loading, reload } = useLoad(
    () => api.listGames().then((r) => r.games),
    [api],
    T.roles.moderator,
  );
  const [q, setQ] = useState('');
  useInterval(() => void reload(true), REFRESH_S * 1000);
  const list = useMemo(
    () =>
      (data ?? []).filter((g) =>
        matches(
          `${g.game.name} ${g.game.id} ${g.game.scenarioId} ${g.players.map((p) => `${p.nationId} ${p.userName ?? ''}`).join(' ')}`,
          q,
        ),
      ),
    [data, q],
  );
  const game = data?.find((g) => g.game.id === id) ?? null;

  return (
    <>
      <PageHead
        title={T.games.title}
        sub={fmt(T.games.sub, { n: data?.length ?? 0, s: REFRESH_S })}
        actions={
          <Button onClick={() => void reload()}>
            <Icon name="refresh" size={14} /> {T.games.refresh}
          </Button>
        }
      />
      {data && (
        <div className="stats">
          <Stat
            k={T.games.statuses.running}
            v={data.filter((g) => g.game.status === 'running').length}
            tone="var(--t-green)"
          />
          <Stat
            k={T.games.statuses.paused}
            v={data.filter((g) => g.game.status === 'paused').length}
            tone="var(--t-amber)"
          />
          <Stat
            k={T.games.statuses.lobby}
            v={data.filter((g) => g.game.status === 'lobby').length}
          />
          <Stat
            k={T.games.players}
            v={data.reduce((a, g) => a + g.players.filter((p) => !p.isAi).length, 0)}
            d={fmt(T.games.ai, {
              n: data.reduce((a, g) => a + g.players.filter((p) => p.isAi).length, 0),
            })}
          />
        </div>
      )}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      <div
        className={`split-list ${id ? 'has-sel' : ''}`}
        style={{ gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)' }}
      >
        <Win
          title={T.games.title}
          className="list-pane"
          cmd="Get-Game -Status running,paused,lobby"
          flush
        >
          <div style={{ padding: 10 }}>
            <SearchBox value={q} onChange={setQ} autoFocusKey />
          </div>
          {loading && !data ? (
            <Spinner />
          ) : (
            <DataTable
              rows={list}
              rowKey={(g) => g.game.id}
              selected={id}
              bare
              onRowClick={(g) => navigate({ name: 'games', id: g.game.id })}
              empty={T.games.empty}
              columns={[
                {
                  key: 'n',
                  label: T.games.name,
                  className: 'two',
                  sort: (g) => g.game.name,
                  render: (g) => (
                    <>
                      <b className="bright">{g.game.name}</b>
                      <span className="sub">
                        {g.game.id.slice(0, 8)} · {g.game.scenarioId} · {T.games.modes[g.game.mode]}
                      </span>
                    </>
                  ),
                },
                {
                  key: 's',
                  label: T.games.status,
                  sort: (g) => g.game.status,
                  render: (g) => (
                    <Badge tone={STATUS_TONE[g.game.status]}>
                      {T.games.statuses[g.game.status]}
                    </Badge>
                  ),
                },
                {
                  key: 't',
                  label: T.games.time,
                  align: 'right',
                  sort: (g) => g.gameTime,
                  render: (g) => formatGameTime(g.gameTime),
                },
                {
                  key: 'p',
                  label: T.games.players,
                  align: 'right',
                  sort: (g) => g.players.filter((p) => !p.isAi).length,
                  render: (g) => (
                    <>
                      <span className="bright">{g.players.filter((p) => !p.isAi).length}</span>
                      <span className="dim"> / {g.players.length}</span>
                    </>
                  ),
                },
                {
                  key: 'u',
                  label: T.games.units,
                  align: 'right',
                  hideM: true,
                  sort: (g) => g.unitCount,
                  render: (g) => num(g.unitCount),
                },
                {
                  key: 'q',
                  label: T.games.queue,
                  align: 'right',
                  hideM: true,
                  sort: (g) => g.queueSize,
                  render: (g) => <span className="dim">{num(g.queueSize)}</span>,
                },
              ]}
            />
          )}
        </Win>
        <div className="detail-pane stack">
          {game ? (
            <GameDetail
              game={game}
              onChanged={(g) =>
                setData((l) => (l ?? []).map((x) => (x.game.id === g.game.id ? g : x)))
              }
              reload={() => void reload(true)}
            />
          ) : (
            <Win title={T.games.title} glyph="?">
              <Empty glyph="▶">{id && data ? T.errors.notFound : T.games.select}</Empty>
            </Win>
          )}
        </div>
      </div>
    </>
  );
}

function GameDetail({
  game: g,
  onChanged,
  reload,
}: {
  game: AdminGame;
  onChanged: (g: AdminGame) => void;
  reload: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const nations = useNationMap();
  const [busy, setBusy] = useState(false);
  const [event, setEvent] = useState<WorldEventId>('oil_crisis');
  const [message, setMessage] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [aiLevel, setAiLevel] = useState<AiLevel>('normal');

  const act = async (pause: boolean) => {
    if (
      pause &&
      !(await confirm({
        title: T.games.pause,
        message: fmt(T.games.pauseConfirm, { name: g.game.name }),
        confirm: T.games.pause,
      }))
    )
      return;
    setBusy(true);
    try {
      await (pause ? api.pauseGame(g.game.id) : api.resumeGame(g.game.id));
      onChanged({ ...g, game: { ...g.game, status: pause ? 'paused' : 'running' } });
      toast(fmt(pause ? T.games.paused : T.games.resumed, { name: g.game.name }));
      reload();
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fire = async () => {
    const name = T.games.events[event]?.[0] ?? event;
    if (
      !(await confirm({
        title: T.games.event,
        message: fmt(T.games.eventConfirm, { name, game: g.game.name }),
        danger: true,
        confirm: T.games.eventSend,
      }))
    )
      return;
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(params))
      if (v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))))
        p[k] = Number(v.replace(',', '.'));
    setBusy(true);
    try {
      await api.worldEvent(g.game.id, {
        event,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(Object.keys(p).length ? { params: p } : {}),
      });
      toast(fmt(T.games.eventSent, { name, game: g.game.name }));
      setMessage('');
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** IA imposée à la place d'un joueur, ou nation rendue à son joueur. */
  const setAi = async (p: AdminGame['players'][number], ai: boolean) => {
    const nation = nations.get(p.nationId)?.name ?? p.nationId;
    const player = p.userName ?? '?';
    if (
      !(await confirm({
        title: ai ? T.games.giveAi : T.games.giveBack,
        message: fmt(ai ? T.games.giveAiConfirm : T.games.giveBackConfirm, {
          nation,
          player,
          level: T.games.aiLevels[aiLevel],
        }),
        danger: ai,
        confirm: ai ? T.games.giveAi : T.games.giveBack,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.setPlayerAi(g.game.id, p.nationId, ai, aiLevel);
      onChanged({
        ...g,
        players: g.players.map((x) =>
          x.nationId === p.nationId ? { ...x, isAi: ai, aiForced: ai } : x,
        ),
      });
      toast(fmt(ai ? T.games.aiGiven : T.games.givenBack, { nation, player }));
      reload();
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    } finally {
      setBusy(false);
    }
  };

  const live = g.game.status === 'running' || g.game.status === 'paused';
  return (
    <>
      <div className="show-m">
        <Button small onClick={() => navigate({ name: 'games' })}>
          <Icon name="back" size={12} /> {T.app.back}
        </Button>
      </div>
      <Win
        title={g.game.name}
        path={`Parties\\${g.game.id.slice(0, 8)}`}
        glyph="▶"
        actions={
          <>
            {g.game.status === 'running' && (
              <Button small disabled={busy} onClick={() => void act(true)}>
                <Icon name="pause" size={12} /> {T.games.pause}
              </Button>
            )}
            {g.game.status === 'paused' && (
              <Button small variant="primary" disabled={busy} onClick={() => void act(false)}>
                <Icon name="play" size={12} /> {T.games.resume}
              </Button>
            )}
          </>
        }
      >
        <div className="stats" style={{ marginBottom: 12 }}>
          <Stat
            k={T.games.status}
            v={<Badge tone={STATUS_TONE[g.game.status]}>{T.games.statuses[g.game.status]}</Badge>}
          />
          <Stat k={T.games.time} v={formatGameTime(g.gameTime)} />
          <Stat k={T.games.units} v={num(g.unitCount)} />
          <Stat k={T.games.queue} v={num(g.queueSize)} />
        </div>
        <dl className="kv">
          <dt>ID</dt>
          <dd>{g.game.id}</dd>
          <dt>{T.games.scenario}</dt>
          <dd>{g.game.scenarioId}</dd>
          <dt>{T.games.mode}</dt>
          <dd>
            {T.games.modes[g.game.mode]}
            {g.game.maxPlayers
              ? ` · ${g.game.playerCount ?? g.players.filter((p) => !p.isAi).length} / ${g.game.maxPlayers}`
              : ''}
          </dd>
          <dt>{T.games.speed}</dt>
          <dd>{g.game.speeds.map((s) => `×${s}`).join(' ')}</dd>
          {g.game.createdAt && (
            <>
              <dt>{T.games.created}</dt>
              <dd>{ago(g.game.createdAt)}</dd>
            </>
          )}
        </dl>
        <SectionTitle n={g.players.length}>{T.games.players}</SectionTitle>
        {live && g.players.some((p) => p.userId) && (
          <div className="row-wrap" style={{ marginBottom: 8, alignItems: 'center', gap: 8 }}>
            <label className="dim small" htmlFor="ai-level">
              {T.games.aiLevel}
            </label>
            <select
              id="ai-level"
              className="input"
              style={{ width: 'auto' }}
              value={aiLevel}
              onChange={(e) => setAiLevel(e.target.value as AiLevel)}
            >
              {(['easy', 'normal', 'hard'] as const).map((l) => (
                <option key={l} value={l}>
                  {T.games.aiLevels[l]}
                </option>
              ))}
            </select>
          </div>
        )}
        <DataTable
          rows={g.players}
          rowKey={(p) => p.nationId}
          maxHeight={260}
          columns={[
            {
              key: 'n',
              label: 'Nation',
              sort: (p) => nations.get(p.nationId)?.name ?? p.nationId,
              render: (p) => (
                <Nation
                  id={p.nationId}
                  name={nations.get(p.nationId)?.name}
                  color={nations.get(p.nationId)?.color}
                />
              ),
            },
            {
              key: 'u',
              label: T.users.name,
              sort: (p) => p.userName ?? '',
              render: (p) =>
                p.userName ? (
                  <span title={p.connected ? T.games.online : T.games.offline}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        marginRight: 6,
                        background: p.connected ? 'var(--t-green)' : 'var(--t-dim, #556)',
                      }}
                    />
                    {p.userName}
                  </span>
                ) : (
                  <span className="dim">—</span>
                ),
            },
            {
              key: 'k',
              label: '',
              align: 'right',
              render: (p) =>
                p.aiForced ? (
                  <Badge tone="crit">{T.games.aiForced}</Badge>
                ) : p.isAi ? (
                  <Badge tone={p.userName ? 'violet' : 'off'}>
                    {p.userName ? T.games.aiReplacement : T.games.aiPlayer}
                  </Badge>
                ) : (
                  <Badge tone="ok">{T.games.human}</Badge>
                ),
            },
            {
              key: 'a',
              label: '',
              align: 'right',
              render: (p) =>
                !live || !p.userId ? null : p.aiForced || p.isAi ? (
                  <Button small disabled={busy} onClick={() => void setAi(p, false)}>
                    <Icon name="undo" size={12} /> {T.games.giveBack}
                  </Button>
                ) : (
                  <Button small disabled={busy} onClick={() => void setAi(p, true)}>
                    <Icon name="orbat" size={12} /> {T.games.giveAi}
                  </Button>
                ),
            },
          ]}
        />
        <p className="dim tiny" style={{ marginTop: 8 }}>
          {T.games.replaceHint}
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn btn-sm" href={href({ name: 'chat', gameId: g.game.id })}>
            <Icon name="chat" size={12} /> {T.games.chatLink}
          </a>
        </div>
      </Win>
      <Win
        title={T.games.event}
        glyph="⚡"
        cmd={`Invoke-WorldEvent -Game ${g.game.id.slice(0, 8)} -Event ${event}`}
      >
        {!live && <Note tone="warn">{T.games.statuses[g.game.status]}</Note>}
        <div className="stack">
          <div className="grid g2" role="radiogroup" aria-label={T.games.event}>
            {EVENTS.map((e) => (
              <label
                key={e}
                className={`optsec ${event === e ? '' : 'absent'}`}
                style={{
                  cursor: 'pointer',
                  padding: '8px 10px',
                  borderColor: event === e ? 'var(--t-cyan)' : undefined,
                }}
              >
                <span className="radio">
                  <input
                    type="radio"
                    name="world-event"
                    checked={event === e}
                    onChange={() => setEvent(e)}
                  />
                  <span className="radio-dot" aria-hidden />
                  <b>{T.games.events[e]?.[0] ?? e}</b>
                </span>
                <span
                  className="dim small"
                  style={{ display: 'block', marginTop: 4, paddingLeft: 22 }}
                >
                  {T.games.events[e]?.[1]}
                </span>
              </label>
            ))}
          </div>
          <div className="field">
            <label htmlFor="ev-msg">{T.games.eventMessage}</label>
            <input
              id="ev-msg"
              value={message}
              maxLength={500}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {event !== 'emergency_council' && (
            <div>
              <span className="field-label">{T.games.eventParams}</span>
              <small className="field-hint">{T.games.eventParamsHint}</small>
              <div className="grid g3" style={{ marginTop: 6 }}>
                {Object.entries(T.games.params).map(([k, [label]]) => (
                  <div key={k} className="field">
                    <label htmlFor={`ev-${k}`}>{label}</label>
                    <input
                      id={`ev-${k}`}
                      inputMode="decimal"
                      value={params[k] ?? ''}
                      placeholder="défaut"
                      onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <Button variant="danger" disabled={busy || !live} onClick={() => void fire()}>
              <Icon name="bolt" size={14} /> {T.games.eventSend}
            </Button>
          </div>
        </div>
      </Win>
    </>
  );
}
