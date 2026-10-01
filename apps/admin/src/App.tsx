import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { hasRole, type PublicUser } from '@redline/shared';
import { ApiError, createApi, type Transport } from './api/client';
import { DataCache, SessionCtx, useSession } from './context';
import { T } from './i18n';
import { href, navigate, useRoute, type Route } from './lib/router';
import { GROUPS, SCREENS, promptPath, screenOf } from './lib/screens';
import { errorMessage } from './lib/errors';
import { downloadJson } from './lib/download';
import { ConfirmProvider, ToastProvider, useToast } from './components/overlay';
import { Button, ErrorBox, Icon, Kbd, Logo, Spinner } from './components/term';
import { CommandPalette } from './components/CommandPalette';
import { LoginScreen } from './screens/Login';
import { CatalogScreen } from './screens/Catalog';
import { EditorScreen } from './screens/Editor';
import { HistoryScreen } from './screens/History';
import { ImportExportScreen } from './screens/ImportExport';
import { RulesScreen } from './screens/Rules';
import { ResearchScreen } from './screens/Research';
import { OrbatScreen } from './screens/Orbat';
import { ScenariosScreen } from './screens/Scenarios';
import { GamesScreen } from './screens/Games';
import { ChatScreen } from './screens/Chat';
import { SecurityScreen } from './screens/Security';
import { UsersScreen } from './screens/Users';
import { ShopScreen } from './screens/Shop';
import { AuditScreen } from './screens/Audit';
import { MetricsScreen } from './screens/Metrics';
import { DataStatusScreen } from './screens/DataStatus';
import { EconomyScreen } from './screens/Economy';
import { AnnouncementsScreen } from './screens/Announcements';
import { ServerSettingsScreen } from './screens/ServerSettings';
import { ArchiveScreen } from './screens/Archive';

// La carte embarque MapLibre (≈ 1 Mo) : chargée seulement quand on ouvre l'écran.
const MapScreen = lazy(() => import('./screens/MapScreen').then((m) => ({ default: m.MapScreen })));

export function App({ transport, mock }: { transport: Transport; mock: boolean }) {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const api = useMemo(() => createApi(transport, () => setUser(null)), [transport]);
  const cache = useMemo(() => new DataCache(), []);

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
      cache.invalidate('systems', 'nations', 'nations-public', 'research', 'provinces', 'photos');
    }
  };

  let body;
  if (bootError)
    body = (
      <div className="login-page">
        <div className="login-box">
          <ErrorBox message={bootError} onRetry={checkMe} />
        </div>
      </div>
    );
  else if (user === undefined)
    body = (
      <div className="login-page">
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
      <SessionCtx.Provider value={{ api, user, mock, cache }}>
        <Shell onLogout={logout} />
      </SessionCtx.Provider>
    );

  return (
    <ToastProvider>
      <ConfirmProvider>{body}</ConfirmProvider>
    </ToastProvider>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const hashRoute = useRoute();
  const { user, mock, api } = useSession();
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const allowed = SCREENS.filter((s) => hasRole(user.role, s.role));
  const requested = screenOf(hashRoute);
  // Rôle insuffisant pour la section demandée : première section permise.
  const route: Route =
    requested && hasRole(user.role, requested.role) ? hashRoute : (allowed[0]?.route ?? hashRoute);
  const current = screenOf(route);
  useEffect(() => {
    if (route !== hashRoute) navigate(route, true);
  }, [route, hashRoute]);
  useEffect(() => {
    setNavOpen(false);
    document.title = `${current?.label ?? T.app.section} · Red Line`;
  }, [route, current]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === ':' && !typing) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const exportCatalog = async () => {
    try {
      const { systems } = await api.exportCatalog();
      downloadJson('redline-catalog.json', { systems });
      toast(`${systems.length} fiches exportées.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  let screen = null;
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
    case 'rules':
      screen = <RulesScreen section={route.section} />;
      break;
    case 'research':
      screen = <ResearchScreen id={route.id} />;
      break;
    case 'orbat':
      screen = <OrbatScreen set={route.set} nation={route.nation} />;
      break;
    case 'scenarios':
      screen = <ScenariosScreen id={route.id} />;
      break;
    case 'map':
      screen = <MapScreen tab={route.tab} id={route.id} />;
      break;
    case 'games':
      screen = <GamesScreen id={route.id} />;
      break;
    case 'chat':
      screen = <ChatScreen gameId={route.gameId} />;
      break;
    case 'security':
      screen = <SecurityScreen />;
      break;
    case 'users':
      screen = <UsersScreen id={route.id} />;
      break;
    case 'shop':
      screen = <ShopScreen tab={route.tab} />;
      break;
    case 'audit':
      screen = <AuditScreen />;
      break;
    case 'metrics':
      screen = <MetricsScreen />;
      break;
    case 'data':
      screen = <DataStatusScreen />;
      break;
    case 'economy':
      screen = <EconomyScreen tab={route.tab} />;
      break;
    case 'announcements':
      screen = <AnnouncementsScreen />;
      break;
    case 'settings':
      screen = <ServerSettingsScreen />;
      break;
    case 'archive':
      screen = <ArchiveScreen />;
      break;
  }

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="side" aria-label={T.app.menu}>
        <a className="side-brand" href={href(allowed[0]?.route ?? { name: 'catalog' })}>
          <Logo />
          <span>
            <b>RED LINE</b>
            <small>{T.app.section}</small>
          </span>
        </a>
        <nav className="side-nav">
          {GROUPS.map((g) => {
            const items = allowed.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="side-group">
                <div className="side-group-title">{T.nav.groups[g]}</div>
                {items.map((s) => (
                  <a
                    key={s.id}
                    href={href(s.route)}
                    className={`side-link ${s === current ? 'on' : ''}`}
                    aria-current={s === current ? 'page' : undefined}
                  >
                    <Icon name={s.icon} />
                    {s.label}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <span className="avatar" aria-hidden>
            {user.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="who">
            <b className="ellipsis">{user.displayName}</b>
            <span>{T.roles[user.role]}</span>
          </span>
          <Button
            small
            icon
            variant="ghost"
            onClick={onLogout}
            aria-label={T.nav.logout}
            title={T.nav.logout}
          >
            <Icon name="logout" size={14} />
          </Button>
        </div>
      </aside>
      <div className="side-scrim" onClick={() => setNavOpen(false)} />
      <div className="main">
        <header className="topbar">
          <Button
            icon
            variant="ghost"
            className="burger"
            aria-label={T.app.menu}
            onClick={() => setNavOpen((v) => !v)}
          >
            <Icon name="menu" />
          </Button>
          <div className="prompt-line" aria-label={promptPath(route)}>
            <span className="ps">PS&nbsp;</span>
            <span className="path">RED-LINE:\Admin\{promptPath(route)}</span>
            <span className="gt">&gt;</span>
            <span className="cursor" aria-hidden />
          </div>
          <button
            type="button"
            className="cmd-trigger"
            onClick={() => setPalette(true)}
            aria-label={T.app.commandHint}
          >
            <Icon name="search" size={14} />
            <span className="grow">{T.app.commandHint}</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <span
            className={`env-pill ${mock ? 'mock' : ''}`}
            title={mock ? T.app.mockBanner : undefined}
          >
            <span className="dot" />
            <span className="lbl">{mock ? T.app.mock : T.app.live}</span>
          </span>
        </header>
        <main className="content">
          <Suspense fallback={<Spinner />}>
            {screen ?? <ErrorBox message={T.errors.noAccess} />}
          </Suspense>
        </main>
      </div>
      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onLogout={onLogout}
          onExport={() => void exportCatalog()}
        />
      )}
    </div>
  );
}
