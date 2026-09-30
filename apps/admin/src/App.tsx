import { useCallback, useEffect, useMemo, useState } from 'react';
import { hasRole, type PublicUser } from '@redline/shared';
import { ApiError, createApi, REQUIRED_ROLE, type Transport } from './api/client';
import { SessionCtx, useSession } from './context';
import { T } from './i18n';
import { href, useRoute, type Route } from './lib/router';
import { Button, ErrorBox, Spinner, ToastProvider } from './components/ui';
import { errorMessage } from './lib/errors';
import { LoginScreen } from './screens/Login';
import { CatalogScreen } from './screens/Catalog';
import { EditorScreen } from './screens/Editor';
import { HistoryScreen } from './screens/History';
import { ImportExportScreen } from './screens/ImportExport';
import { GamesScreen } from './screens/Games';
import { MetricsScreen } from './screens/Metrics';

export function App({ transport, mock }: { transport: Transport; mock: boolean }) {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const api = useMemo(() => createApi(transport, () => setUser(null)), [transport]);

  const checkMe = useCallback(async () => {
    setBootError(null);
    try {
      const { user } = await api.me();
      setUser(user);
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) setUser(null);
      else setBootError(errorMessage(e));
    }
  }, [api]);
  useEffect(() => {
    void checkMe();
  }, [checkMe]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  };

  let body;
  if (bootError)
    body = (
      <div className="center-page">
        <ErrorBox message={bootError} onRetry={checkMe} />
      </div>
    );
  else if (user === undefined)
    body = (
      <div className="center-page">
        <Spinner />
      </div>
    );
  else if (user === null || !hasRole(user.role, 'moderator'))
    body = (
      <LoginScreen
        api={api}
        mock={mock}
        deniedUser={user ?? null}
        onLogin={setUser}
        onLogout={logout}
      />
    );
  else
    body = (
      <SessionCtx.Provider value={{ api, user, mock }}>
        <Shell onLogout={logout} />
      </SessionCtx.Provider>
    );

  return (
    <ToastProvider>
      {mock && <div className="mock-banner">{T.app.mockBanner}</div>}
      {body}
    </ToastProvider>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const hashRoute = useRoute();
  const { user } = useSession();
  const canCatalog = hasRole(user.role, REQUIRED_ROLE.catalog);
  const canGames = hasRole(user.role, REQUIRED_ROLE.games);
  const tabs: { route: Route; label: string; allowed: boolean; match: Route['name'][] }[] = [
    {
      route: { name: 'catalog' },
      label: T.nav.catalog,
      allowed: canCatalog,
      match: ['catalog', 'system', 'new', 'history'],
    },
    {
      route: { name: 'import' },
      label: T.nav.importExport,
      allowed: canCatalog,
      match: ['import'],
    },
    { route: { name: 'games' }, label: T.nav.games, allowed: canGames, match: ['games'] },
    { route: { name: 'metrics' }, label: T.nav.metrics, allowed: canGames, match: ['metrics'] },
  ];
  const allowedTabs = tabs.filter((t) => t.allowed);
  const requested = tabs.find((t) => t.match.includes(hashRoute.name));
  // Rôle insuffisant pour la section demandée : on affiche la première section permise.
  const route =
    requested && !requested.allowed && allowedTabs[0] ? allowedTabs[0].route : hashRoute;
  const current = tabs.find((t) => t.match.includes(route.name));
  useEffect(() => {
    if (route !== hashRoute) window.history.replaceState(null, '', href(route));
  }, [route, hashRoute]);

  let screen = null;
  if (current?.allowed) {
    switch (route.name) {
      case 'catalog':
        screen = <CatalogScreen />;
        break;
      case 'new':
        screen = <EditorScreen key="new" id={null} />;
        break;
      case 'system':
        screen = <EditorScreen key={route.id} id={route.id} />;
        break;
      case 'history':
        screen = <HistoryScreen key={route.id} id={route.id} />;
        break;
      case 'import':
        screen = <ImportExportScreen />;
        break;
      case 'games':
        screen = <GamesScreen />;
        break;
      case 'metrics':
        screen = <MetricsScreen />;
        break;
    }
  }
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={href(allowedTabs[0]?.route ?? { name: 'catalog' })}>
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
            <polygon
              points="16,2 29,9 29,23 16,30 3,23 3,9"
              fill="var(--rl-panel-solid)"
              stroke="var(--rl-orange)"
              strokeWidth="2"
            />
            <rect x="8" y="14.5" width="16" height="3" fill="var(--rl-red)" />
          </svg>
          <span className="brand-name">{T.app.name}</span>
          <span className="brand-sep" />
          <span className="brand-section">{T.app.section}</span>
        </a>
        <div className="user-chip">
          <span className="user-name">{user.displayName}</span>
          <span className="user-role">{T.roles[user.role]}</span>
          <Button
            small
            variant="ghost"
            onClick={onLogout}
            aria-label={T.nav.logout}
            title={T.nav.logout}
          >
            <svg className="logout-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                d="M12 3v8M7.1 6.3a7 7 0 109.8 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span className="logout-label">{T.nav.logout}</span>
          </Button>
        </div>
      </header>
      <nav className="tabs" aria-label="Sections">
        {allowedTabs.map((t) => (
          <a
            key={t.label}
            href={href(t.route)}
            className={`tab ${t === current ? 'tab-active' : ''}`}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <main className="content">
        {screen ?? (allowedTabs.length === 0 && <ErrorBox message={T.errors.noAccess} />)}
      </main>
    </div>
  );
}
