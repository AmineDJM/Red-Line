import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRoute, type Route } from './router.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LoadingScreen } from './screens/Loading.js';
import { LegalGate } from './screens/LegalScreen.js';

// Les écrans avec carte chargent MapLibre dans un morceau séparé.
const NewGameScreen = lazy(() =>
  import('./screens/NewGameScreen.js').then((m) => ({ default: m.NewGameScreen })),
);
const GameScreen = lazy(() =>
  import('./screens/GameScreen.js').then((m) => ({ default: m.GameScreen })),
);
const SandboxScreen = lazy(() =>
  import('./screens/SandboxScreen.js').then((m) => ({ default: m.SandboxScreen })),
);
const LobbyScreen = lazy(() =>
  import('./screens/LobbyScreen.js').then((m) => ({ default: m.LobbyScreen })),
);
const LobbyCreateScreen = lazy(() =>
  import('./screens/LobbyScreen.js').then((m) => ({ default: m.LobbyCreateScreen })),
);
const LobbyJoinScreen = lazy(() =>
  import('./screens/LobbyScreen.js').then((m) => ({ default: m.LobbyJoinScreen })),
);
const GamesScreen = lazy(() =>
  import('./screens/GamesScreen.js').then((m) => ({ default: m.GamesScreen })),
);
const ShopScreen = lazy(() =>
  import('./screens/ShopScreen.js').then((m) => ({ default: m.ShopScreen })),
);
const RankingsScreen = lazy(() =>
  import('./screens/RankingsScreen.js').then((m) => ({ default: m.RankingsScreen })),
);
const LegalScreen = lazy(() =>
  import('./screens/LegalScreen.js').then((m) => ({ default: m.LegalScreen })),
);
const EndGameScreen = lazy(() =>
  import('./screens/EndGameScreen.js').then((m) => ({ default: m.EndGameScreen })),
);

const TITLES: Partial<Record<Route['name'], string>> = {
  new: 'newGame.title',
  sandbox: 'sandbox.title',
  lobby: 'lobby.title',
  lobbyCreate: 'lobby.create',
  lobbyJoin: 'lobby.join',
  games: 'games.title',
  shop: 'shop.title',
  rankings: 'rankings.title',
  end: 'endgame.title',
  spectate: 'game.spectator',
};

export function App() {
  const route = useRoute();
  const { t } = useTranslation();

  useEffect(() => {
    const base = t('app.name');
    const key = TITLES[route.name];
    if (route.name !== 'game') document.title = key ? `${base} · ${t(key)}` : base;
  }, [route, t]);

  return (
    <Suspense fallback={<LoadingScreen />}>
      {route.name === 'home' ? <HomeScreen /> : null}
      {route.name === 'new' ? <NewGameScreen /> : null}
      {route.name === 'game' ? <GameScreen key={route.id} id={route.id} /> : null}
      {route.name === 'spectate' ? <GameScreen key={`s-${route.id}`} id={route.id} spectate /> : null}
      {route.name === 'end' ? <EndGameScreen id={route.id} /> : null}
      {route.name === 'lobby' ? <LobbyScreen /> : null}
      {route.name === 'lobbyCreate' ? <LobbyCreateScreen /> : null}
      {route.name === 'lobbyJoin' ? <LobbyJoinScreen id={route.id} /> : null}
      {route.name === 'games' ? <GamesScreen /> : null}
      {route.name === 'shop' ? <ShopScreen /> : null}
      {route.name === 'rankings' ? <RankingsScreen /> : null}
      {route.name === 'legal' ? <LegalScreen doc={route.doc} /> : null}
      {route.name === 'sandbox' ? <SandboxScreen /> : null}
      {route.name === 'notFound' ? <NotFound /> : null}
      <LegalGate />
    </Suspense>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center">
      <div className="notfound">
        <code>404</code>
        <p>{t('app.notFound')}</p>
        <a href="/">{t('app.back')}</a>
      </div>
    </div>
  );
}
