import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicUser } from '@redline/shared';
import { BracketFrame, Button, HexIcon } from '@redline/ui';
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

  const run = async (fn: () => Promise<PublicUser>) => {
    setBusy(true);
    setError(null);
    try {
      const u = await fn();
      setUser(u);
      navigate('/new');
    } catch (e) {
      setError(authError(e));
    } finally {
      setBusy(false);
    }
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
      <div className="home__bg" aria-hidden>
        <HexIcon
          color="rgba(139,92,246,0.18)"
          size={420}
          outline="rgba(183,148,255,0.35)"
          className="home__hex home__hex--a"
        />
        <HexIcon
          color="rgba(243,154,43,0.10)"
          size={260}
          outline="rgba(243,154,43,0.35)"
          className="home__hex home__hex--b"
        />
      </div>
      <header className="home__banner">
        <h1 className="home__title">{t('home.title')}</h1>
        <p className="home__subtitle">{t('home.subtitle')}</p>
      </header>

      <BracketFrame className="home__card">
        {mode === 'menu' ? (
          <div className="stack">
            {user ? <p className="muted">{t('home.welcome', { name: user.displayName })}</p> : null}
            {user ? (
              <Button variant="primary" size="lg" block onClick={() => navigate('/new')}>
                {t('home.continue')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                block
                disabled={busy}
                onClick={() => void run(async () => (await getApi()).guest())}
              >
                {t('home.playGuest')}
              </Button>
            )}
            {!user || user.isGuest ? (
              <div className="row">
                <Button block onClick={() => setMode('login')}>
                  {t('home.login')}
                </Button>
                <Button block onClick={() => setMode('register')}>
                  {t('home.register')}
                </Button>
              </div>
            ) : (
              <Button
                block
                onClick={() =>
                  void getApi()
                    .then((api) => api.logout())
                    .then(() => setUser(null))
                }
              >
                {t('home.logout')}
              </Button>
            )}
            <Button variant="ghost" block onClick={() => navigate('/sandbox')}>
              {t('home.sandbox')}
            </Button>
            {!user ? <p className="muted small">{t('home.guestNote')}</p> : null}
            {error ? <p className="error-text">{t(error)}</p> : null}
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            {mode === 'register' ? (
              <label className="field">
                <span className="field__label">{t('auth.displayName')}</span>
                <input
                  className="input"
                  required
                  minLength={2}
                  maxLength={40}
                  autoComplete="nickname"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </label>
            ) : null}
            <label className="field">
              <span className="field__label">{t('auth.email')}</span>
              <input
                className="input"
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t('auth.password')}</span>
              <input
                className="input"
                type="password"
                required
                minLength={mode === 'register' ? 8 : 1}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            {error ? <p className="error-text">{t(error)}</p> : null}
            <Button variant="primary" size="lg" block type="submit" disabled={busy}>
              {mode === 'register' ? t('auth.submitRegister') : t('auth.submitLogin')}
            </Button>
            <Button
              variant="ghost"
              block
              onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
            >
              {mode === 'register' ? t('auth.switchToLogin') : t('auth.switchToRegister')}
            </Button>
            <Button variant="ghost" block onClick={() => setMode('menu')}>
              {t('app.back')}
            </Button>
          </form>
        )}
      </BracketFrame>
      <footer className="home__footer">
        {IS_MOCK ? <span className="mock-badge">{t('app.mockBadge')}</span> : null}
        <span>{t('home.footer')}</span>
      </footer>
    </div>
  );
}
