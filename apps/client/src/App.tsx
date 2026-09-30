import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRoute } from './router.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LoadingScreen } from './screens/Loading.js';

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

export function App() {
  const route = useRoute();
  const { t } = useTranslation();

  useEffect(() => {
    const base = t('app.name');
    const sub =
      route.name === 'new'
        ? t('newGame.title')
        : route.name === 'sandbox'
          ? t('sandbox.title')
          : route.name === 'game'
            ? t('game.layers.military')
            : null;
    document.title = sub ? `${base} · ${sub}` : base;
  }, [route, t]);

  return (
    <Suspense fallback={<LoadingScreen />}>
      {route.name === 'home' ? <HomeScreen /> : null}
      {route.name === 'new' ? <NewGameScreen /> : null}
      {route.name === 'game' ? <GameScreen key={route.id} id={route.id} /> : null}
      {route.name === 'sandbox' ? <SandboxScreen /> : null}
      {route.name === 'notFound' ? <NotFound /> : null}
    </Suspense>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center">
      <p>{t('app.notFound')}</p>
      <a href="/">{t('app.back')}</a>
    </div>
  );
}
