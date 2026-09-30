import { useState } from 'react';
import { DAY, HOUR, MINUTE, type AdminGame } from '@redline/shared';
import { useSession } from '../context';
import { Badge, Button, ErrorBox, Frame, Spinner, useToast } from '../components/ui';
import { T, fmt, num } from '../i18n';
import { errorMessage } from '../lib/errors';
import { useInterval, useLoad } from '../lib/hooks';

const REFRESH_S = 10;

/** Temps de jeu (ms) → « J3 14:20 ». */
export function formatGameTime(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  return `J${d + 1} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const TONE = { running: 'ok', paused: 'warn', lobby: 'info', ended: 'off' } as const;

export function GamesScreen() {
  const { api } = useSession();
  const toast = useToast();
  const { data, setData, error, loading, reload } = useLoad(
    () => api.listGames().then((r) => r.games),
    [api],
    T.roles.moderator,
  );
  const [busy, setBusy] = useState<string | null>(null);
  useInterval(() => void reload(true), REFRESH_S * 1000);

  const act = async (g: AdminGame, pause: boolean) => {
    setBusy(g.game.id);
    try {
      await (pause ? api.pauseGame(g.game.id) : api.resumeGame(g.game.id));
      setData((list) =>
        (list ?? []).map((x) =>
          x.game.id === g.game.id
            ? { ...x, game: { ...x.game, status: pause ? 'paused' : 'running' } }
            : x,
        ),
      );
      toast(fmt(pause ? T.games.paused : T.games.resumed, { name: g.game.name }));
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.moderator), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Frame
      title={T.games.title}
      actions={
        <Button small onClick={() => void reload()}>
          ⟳ {T.games.refresh}
        </Button>
      }
    >
      <p className="muted small">{fmt(T.games.autoRefresh, { n: REFRESH_S })}</p>
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {data && data.length === 0 && <p className="muted">{T.games.empty}</p>}
      {data && data.length > 0 && (
        <div className="game-list">
          {data.map((g) => {
            const humans = g.players.filter((p) => !p.isAi);
            const ai = g.players.length - humans.length;
            return (
              <article key={g.game.id} className="game-card">
                <header>
                  <div>
                    <strong className="game-name">{g.game.name}</strong>
                    <span className="mono muted small">
                      {g.game.id} · {g.game.scenarioId} · {T.games.modes[g.game.mode]}
                    </span>
                  </div>
                  <Badge tone={TONE[g.game.status]}>{T.games.statuses[g.game.status]}</Badge>
                </header>
                <dl className="game-stats">
                  <div>
                    <dt>{T.games.time}</dt>
                    <dd className="mono">{formatGameTime(g.gameTime)}</dd>
                  </div>
                  <div>
                    <dt>{T.games.players}</dt>
                    <dd>
                      {fmt(T.games.humans, { n: humans.length })} · {fmt(T.games.ai, { n: ai })}
                    </dd>
                  </div>
                  <div>
                    <dt>{T.games.units}</dt>
                    <dd className="mono">{num(g.unitCount)}</dd>
                  </div>
                  <div>
                    <dt>{T.games.queue}</dt>
                    <dd className="mono">{num(g.queueSize)}</dd>
                  </div>
                </dl>
                <div className="game-players small">
                  {g.players.map((p) => (
                    <span key={p.nationId} className="player-chip">
                      <span className="mono">{p.nationId.toUpperCase()}</span>{' '}
                      {p.isAi ? 'IA' : (p.userName ?? '—')}
                    </span>
                  ))}
                </div>
                <div className="game-actions">
                  {g.game.status === 'running' && (
                    <Button disabled={busy === g.game.id} onClick={() => void act(g, true)}>
                      ❚❚ {T.games.pause}
                    </Button>
                  )}
                  {g.game.status === 'paused' && (
                    <Button
                      variant="primary"
                      disabled={busy === g.game.id}
                      onClick={() => void act(g, false)}
                    >
                      ▶ {T.games.resume}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Frame>
  );
}
