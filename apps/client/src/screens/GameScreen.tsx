import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@redline/ui';
import { DEBUG_HOOKS, IS_MOCK } from '../config.js';
import { getApi } from '../api/index.js';
import { GameShell } from '../shell/GameShell.js';
import type { GameConnection } from '../net/connection.js';
import { WsGameConnection } from '../net/ws.js';
import { bindConnection, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { LoadingScreen, ErrorScreen } from './Loading.js';
import { usePushNotifications } from '../lib/push.js';

/** Crée la connexion à la partie : WebSocket, ou simulée en mode ?mock=1. */
async function connect(gameId: string, spectate: boolean): Promise<GameConnection> {
  if (!IS_MOCK) return new WsGameConnection(gameId, spectate ? { url: spectateUrl(gameId) } : {});
  const [{ MockGameConnection }, mockApi, api] = await Promise.all([
    import('../net/mock.js'),
    import('../api/mock.js'),
    getApi(),
  ]);
  const f = await mockApi.loadFixtures();
  const { me, game } = await api.game(gameId);
  const conn = new MockGameConnection(
    { nations: f.nations, provinces: f.provinces, catalog: f.catalog, geo: f.geo },
    { me, meta: spectate ? { ...game, spectator: true } : undefined },
  );
  mockApi.mockSession.battle = (id) => conn.battleReport(id);
  mockApi.mockSession.grant = (money, resources) => conn.grant(money, resources);
  return conn;
}

function spectateUrl(gameId: string): string {
  const loc = window.location;
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws?gameId=${encodeURIComponent(gameId)}&spectate=1`;
}

export function GameScreen({ id, spectate = false }: { id: string; spectate?: boolean }) {
  const { t } = useTranslation();
  const world = useWorld();
  const meta = useGame((s) => s.meta);
  const [error, setError] = useState<string | null>(null);
  usePushNotifications(id);

  useEffect(() => {
    // Crochets de test (mode démonstration ou rl.debug=1) pour les captures automatisées.
    if (DEBUG_HOOKS)
      (window as unknown as { __rl?: unknown }).__rl = {
        game: useGame,
        ui: useUi,
        world: useWorld,
      };
    void getApi().then((api) => world.load(api));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unbind: (() => void) | null = null;
    let cancelled = false;
    useUi.getState().clearSelection();
    useUi.getState().closeAllWindows();
    connect(id, spectate)
      .then((conn) => {
        if (cancelled) return conn.close();
        unbind = bindConnection(conn);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      unbind?.();
    };
  }, [id, spectate]);

  useEffect(() => {
    if (meta) document.title = `${meta.name} · ${t('app.name')}`;
  }, [meta, t]);

  if (world.status === 'error' || error)
    return <ErrorScreen message={world.error ?? error ?? ''} />;
  if (world.status !== 'ready') return <LoadingScreen text={t('app.loadingMap')} />;

  return (
    <GameShell
      mode="game"
      fog={!spectate}
      tutorial={!spectate}
      badge={
        IS_MOCK ? (
          <Badge tone="amber" variant="outline">
            {t('app.mockBadge')}
          </Badge>
        ) : null
      }
    />
  );
}
