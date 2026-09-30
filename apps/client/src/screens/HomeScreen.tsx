import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicUser } from '@redline/shared';
import { Badge, Button, Field, Icon, Input, Kbd, Prompt, type IconName } from '@redline/ui';
import { IS_MOCK } from '../config.js';
import { ApiError, getApi } from '../api/index.js';
import { navigate } from '../router.js';

type Mode = 'menu' | 'login' | 'register';

function authError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'auth.errors.network';
    if (e.status === 401 || e.code === 'invalid_credentials') return 'auth.errors.invalid';
    if (e.status === 409 || e.code === 'email_taken') return 'auth.errors.exists';
    if (e.status === 400) return 'auth.errors.weak';
  }
  return 'auth.errors.generic';
}

const BOOT_KEY = 'rl.boot.seen';

/** Séquence de démarrage sobre (< 1 s, jamais bloquante, rejouée brièvement ensuite). */
function Boot() {
  const { t } = useTranslation();
  const [quick] = useState(() => {
    try {
      const seen = sessionStorage.getItem(BOOT_KEY) === '1';
      sessionStorage.setItem(BOOT_KEY, '1');
      return seen;
    } catch {
      return true;
    }
  });
  const lines = ['link', 'map', 'catalog', 'engine', 'ready'] as const;
  return (
    <ol className={quick ? 'boot boot--quick' : 'boot'} aria-hidden>
      {lines.map((l, i) => (
        <li key={l} style={{ animationDelay: `${quick ? 0 : 80 + i * 140}ms` }}>
          <span className={l === 'ready' ? 'boot__ok boot__ok--ready' : 'boot__ok'}>
            {l === 'ready' ? '>>' : '[ OK ]'}
          </span>
          {t(`home.boot.${l}`)}
        </li>
      ))}
    </ol>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
  primary,
  disabled,
  kbd,
  testId,
}: {
  icon: IconName;
  label: string;
  hint?: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  kbd?: string;
  testId?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className={primary ? 'menuitem menuitem--primary' : 'menuitem'}
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
      >
        <span className="menuitem__caret" aria-hidden>
          &gt;
        </span>
        <Icon name={icon} size={16} />
        <span className="menuitem__text">
          <span className="menuitem__label">{label}</span>
          {hint ? <span className="menuitem__hint">{hint}</span> : null}
        </span>
        {kbd ? <Kbd>{kbd}</Kbd> : <Icon name="chevronRight" size={14} className="menuitem__chev" />}
      </button>
    </li>
  );
}

export function HomeScreen() {
  const { t } = useTranslation();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });

  useEffect(() => {
    void getApi()
      .then((api) => api.me())
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  const run = async (fn: () => Promise<PublicUser>, to = '/new') => {
    setBusy(true);
    setError(null);
    try {
      const u = await fn();
      setUser(u);
      navigate(to);
    } catch (e) {
      setError(authError(e));
    } finally {
      setBusy(false);
    }
  };

  const ensure = async (to: string) => {
    if (user) return navigate(to);
    await run(async () => (await getApi()).guest(), to);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const api = await getApi();
      return mode === 'register'
        ? api.register(form)
        : api.login({ email: form.email, password: form.password });
    });
  };

  return (
    <div className="screen home">
      <div className="home__grid" aria-hidden />
      <main className="home__card">
        <header className="home__bar">
          <span className="rl-win__lights" aria-hidden>
            <i />
          </span>
          <Prompt path={[t('home.path')]} />
          <span className="home__version">v0.6</span>
        </header>
        <div className="home__cols">
          <section className="home__brand">
            <h1 className="home__title">
              RED<span>LINE</span>
            </h1>
            <p className="home__subtitle">{t('home.subtitle')}</p>
            <Boot />
            <p className="home__footer-note">{t('home.footer')}</p>
          </section>
          <section className="home__menu" aria-label={t('home.menu')}>
            {mode === 'menu' ? (
              <>
                <div className="home__who">
                  {user ? (
                    <>
                      <Icon name="user" size={14} />
                      <span>{t('home.welcome', { name: user.displayName })}</span>
                      {user.isGuest ? <Badge tone="neutral">{t('home.guest')}</Badge> : null}
                    </>
                  ) : (
                    <span className="muted">{t('home.notConnected')}</span>
                  )}
                </div>
                <ul className="menu">
                  {user ? (
                    <MenuItem primary icon="play" label={t('home.continue')} hint={t('home.hints.solo')} onClick={() => navigate('/new')} testId="menu-new" />
                  ) : (
                    <MenuItem
                      primary
                      icon="play"
                      label={t('home.playGuest')}
                      hint={t('home.hints.guest')}
                      disabled={busy}
                      onClick={() => void run(async () => (await getApi()).guest())}
                      testId="menu-guest"
                    />
                  )}
                  <MenuItem icon="users" label={t('home.multi')} hint={t('home.hints.multi')} onClick={() => void ensure('/lobby')} />
                  <MenuItem icon="refresh" label={t('home.resume')} hint={t('home.hints.resume')} onClick={() => void ensure('/games')} />
                  <MenuItem icon="trophy" label={t('home.rankings')} hint={t('home.hints.rankings')} onClick={() => navigate('/rankings')} />
                  <MenuItem icon="shop" label={t('home.shop')} hint={t('home.hints.shop')} onClick={() => void ensure('/shop')} />
                  <MenuItem icon="sandbox" label={t('home.sandbox')} hint={t('home.hints.sandbox')} onClick={() => navigate('/sandbox')} />
                </ul>
                <div className="home__auth">
                  {!user || user.isGuest ? (
                    <>
                      <Button size="sm" variant="subtle" onClick={() => setMode('login')}>
                        {t('home.login')}
                      </Button>
                      <Button size="sm" variant="subtle" onClick={() => setMode('register')}>
                        {t('home.register')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Icon name="logout" size={13} />}
                      onClick={() =>
                        void getApi()
                          .then((api) => api.logout())
                          .then(() => setUser(null))
                      }
                    >
                      {t('home.logout')}
                    </Button>
                  )}
                </div>
                {!user ? <p className="muted small">{t('home.guestNote')}</p> : null}
                {error ? <p className="error-text">{t(error)}</p> : null}
              </>
            ) : (
              <form className="stack" onSubmit={submit}>
                <h2 className="home__formtitle">
                  {mode === 'register' ? t('home.register') : t('home.login')}
                </h2>
                {mode === 'register' ? (
                  <Field label={t('auth.displayName')} htmlFor="f-name">
                    <Input
                      id="f-name"
                      prompt
                      required
                      minLength={2}
                      maxLength={40}
                      autoComplete="nickname"
                      value={form.displayName}
                      onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    />
                  </Field>
                ) : null}
                <Field label={t('auth.email')} htmlFor="f-mail">
                  <Input
                    id="f-mail"
                    prompt
                    type="email"
                    required
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </Field>
                <Field label={t('auth.password')} htmlFor="f-pass">
                  <Input
                    id="f-pass"
                    prompt
                    type="password"
                    required
                    minLength={mode === 'register' ? 8 : 1}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </Field>
                {error ? <p className="error-text">{t(error)}</p> : null}
                <Button variant="primary" size="lg" block type="submit" disabled={busy}>
                  {mode === 'register' ? t('auth.submitRegister') : t('auth.submitLogin')}
                </Button>
                <div className="row row--between">
                  <Button variant="ghost" size="sm" onClick={() => setMode('menu')}>
                    ← {t('app.back')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
                  >
                    {mode === 'register' ? t('auth.switchToLogin') : t('auth.switchToRegister')}
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>
        <footer className="home__foot">
          {IS_MOCK ? (
            <Badge tone="amber" variant="outline">
              {t('app.mockBadge')}
            </Badge>
          ) : null}
          <nav className="home__legal" aria-label={t('legal.title')}>
            <a href="/legal/cgu" onClick={(e) => (e.preventDefault(), navigate('/legal/cgu'))}>
              {t('legal.docs.cgu')}
            </a>
            <a href="/legal/cgv" onClick={(e) => (e.preventDefault(), navigate('/legal/cgv'))}>
              {t('legal.docs.cgv')}
            </a>
            <a href="/legal/privacy" onClick={(e) => (e.preventDefault(), navigate('/legal/privacy'))}>
              {t('legal.docs.privacy')}
            </a>
          </nav>
        </footer>
      </main>
    </div>
  );
}
