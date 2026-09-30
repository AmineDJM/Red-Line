import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LobbyGame, PublicUser } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Flag,
  Icon,
  Panel,
  ProgressBar,
  Spinner,
  formatPct,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { ApiError } from '../api/types.js';
import { Page } from '../components/Page.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';

const POLL_MS = 2500;

/**
 * Salle d'attente d'une partie multijoueur : joueurs inscrits (nation, pseudo), lien d'invitation,
 * lancement par le créateur ; tous les inscrits basculent dans la partie dès son lancement.
 */
export function LobbyRoomScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const nations = useWorld((s) => s.nations);
  const [game, setGame] = useState<LobbyGame | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const api = await getApi();
        void useWorld.getState().load(api);
        if (!me) setMe(await api.me());
        const g = await api.lobbyGame(id);
        if (!alive) return;
        setGame(g);
        setError(null);
        if (g.game.status === 'running' || g.game.status === 'paused') {
          navigate(`/game/${encodeURIComponent(id)}`, { replace: true });
          return;
        }
        if (g.game.status === 'ended') {
          setError(t('lobby.room.ended'));
          return;
        }
      } catch (e) {
        if (!alive) return;
        setError(
          e instanceof ApiError && e.status === 404 ? t('lobby.room.notFound') : t('lobby.error'),
        );
      }
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const link = `${window.location.origin}/lobby/${encodeURIComponent(id)}`;
  const isCreator = !!(me && game && game.creator === me.displayName);
  const players = Object.entries(game?.takenBy ?? {});
  const max = game?.game.maxPlayers ?? 64;

  const start = async () => {
    setBusy(true);
    try {
      const api = await getApi();
      const g = await api.startLobby(id);
      navigate(`/game/${encodeURIComponent(g.id)}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : t('lobby.room.startError'));
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    try {
      await (await getApi()).leaveLobby(id);
    } catch {
      /* déjà parti : rien à faire */
    }
    navigate('/lobby');
  };

  return (
    <Page
      path={[t('lobby.path'), t('lobby.room.path')]}
      title={game?.game.name ?? t('lobby.room.title')}
      subtitle={game ? `${game.scenarioName} · ${t('lobby.by', { name: game.creator })}` : ''}
      back="/lobby"
      actions={
        <>
          <Button variant="ghost" onClick={() => void leave()} disabled={busy}>
            {t('lobby.room.leave')}
          </Button>
          {isCreator ? (
            <Button
              variant="primary"
              icon={<Icon name="play" size={13} />}
              disabled={busy || !game}
              onClick={() => void start()}
              data-testid="lobby-start"
            >
              {t('lobby.room.start')}
            </Button>
          ) : null}
        </>
      }
    >
      {error && !game ? (
        <EmptyState icon="warning" title={error} />
      ) : !game ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="lobbyroom">
          {error ? <p className="hint hint--warn">{error}</p> : null}
          <Panel
            title={t('lobby.room.players')}
            meta={`${players.length}/${max}`}
            actions={<Badge tone="cyan">{t('lobby.room.waiting')}</Badge>}
          >
            <ProgressBar
              value={players.length / max}
              trailing={t('lobby.room.aiRest', { count: Math.max(0, max - players.length) })}
              label={t('lobby.room.players')}
            />
            <ul className="lobbyroom__players" data-testid="lobby-players">
              {players.map(([nationId, name]) => (
                <li key={nationId}>
                  <Flag nationId={nationId} size={14} />
                  <b>{nations[nationId]?.name ?? nationId}</b>
                  <span className="muted">{name}</span>
                  {name === game.creator ? (
                    <Badge tone="amber">{t('lobby.room.host')}</Badge>
                  ) : null}
                  {me && name === me.displayName ? (
                    <Badge tone="violet">{t('lobby.room.you')}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title={t('lobby.room.invite')}>
            <p className="hint">{t('lobby.room.inviteHint')}</p>
            <div className="lobbyroom__link">
              <code>{link}</code>
              <Button
                size="sm"
                icon={<Icon name={copied ? 'check' : 'document'} size={12} />}
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(link)
                    .then(() => setCopied(true))
                    .catch(() => undefined);
                }}
              >
                {copied ? t('lobby.room.copied') : t('lobby.room.copy')}
              </Button>
            </div>
          </Panel>
          <Panel title={t('lobby.room.rules')}>
            <ul className="plainlist">
              <li>{t('lobby.room.speed', { speed: game.speed })}</li>
              {game.game.victory ? (
                <li>
                  {t('lobby.room.victory', { share: formatPct(game.game.victory.provinceShare) })}
                  {game.game.victory.allEnemyCapitals ? ` · ${t('lobby.capitals')}` : ''}
                </li>
              ) : null}
              <li>
                {t('lobby.room.shop', {
                  policy: t(`shop.policies.${game.game.shopPolicy?.mode ?? 'open'}`),
                })}
              </li>
              <li className="muted">
                {isCreator ? t('lobby.room.hostHint') : t('lobby.room.guestHint')}
              </li>
            </ul>
          </Panel>
        </div>
      )}
    </Page>
  );
}
