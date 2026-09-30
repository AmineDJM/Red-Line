import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IS_MOCK } from '../config.js';
import { getApi } from '../api/index.js';
import { GameHud } from '../hud/GameHud.js';
import type { GameConnection } from '../net/connection.js';
import { WsGameConnection } from '../net/ws.js';
import { bindConnection, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { LoadingScreen, ErrorScreen } from './Loading.js';

/** Crée la connexion à la partie : WebSocket, ou simulée en mode ?mock=1. */
async function connect(gameId: string): Promise<GameConnection> {
  if (!IS_MOCK) return new WsGameConnection(gameId);
  const [{ MockGameConnection }, { loadFixtures }, api] = await Promise.all([import('../net/mock.js'), import('../api/mock.js'), getApi()]);
  const f = await loadFixtures();
  const { me } = await api.game(gameId);
  return new MockGameConnection({ nations: f.nations, provinces: f.provinces, catalog: f.catalog, geo: f.geo }, { me });
}

export function GameScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const world = useWorld();
  const view = useGame((s) => s.view);
  const meta = useGame((s) => s.meta);
  const me = useGame((s) => s.me);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getApi().then((api) => world.load(api));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unbind: (() => void) | null = null;
    let cancelled = false;
    useUi.getState().clearSelection();
    connect(id)
      .then((conn) => {
        if (cancelled) return conn.close();
        unbind = bindConnection(conn);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      unbind?.();
    };
  }, [id]);

  if (world.status === 'error' || error) return <ErrorScreen message={world.error ?? error ?? ''} />;
  if (world.status !== 'ready') return <LoadingScreen text={t('app.loadingMap')} />;

  const nationName = (me && (view?.nations[me]?.name ?? world.nations[me]?.name)) || '';
  return (
    <GameHud
      mode="game"
      fog
      tutorial
      title={nationName ? t('game.bannerTitle', { nation: nationName }) : t('app.name')}
      subtitle={meta ? t('game.bannerSubtitle', { game: meta.name, scenario: meta.scenarioId === 'world-today' ? t('newGame.scenario') : meta.scenarioId }) : t('game.connecting')}
      badge={IS_MOCK ? <span className="mock-badge">{t('app.mockBadge')}</span> : null}
    />
  );
}
