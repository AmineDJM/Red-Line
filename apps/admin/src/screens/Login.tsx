import { useState, type FormEvent } from 'react';
import { hasRole, type PublicUser } from '@redline/shared';
import { ApiError, type Api } from '../api/client';
import { Button, ErrorBox, Win } from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';

const BANNER = String.raw`
 ____  _____ ____    _     ___ _   _ _____
|  _ \| ____|  _ \  | |   |_ _| \ | | ____|
| |_) |  _| | | | | | |    | ||  \| |  _|
|  _ <| |___| |_| | | |___ | || |\  | |___
|_| \_\_____|____/  |_____|___|_| \_|_____|`;

export function LoginScreen(props: {
  api: Api;
  mock: boolean;
  deniedUser: PublicUser | null;
  onLogin: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.api.login({ email: email.trim(), password });
      // Le rôle fait foi côté serveur : on le relit via /api/me.
      const { user } = await props.api.me();
      if (!hasRole(user.role, 'moderator')) {
        setError(fmt(T.login.forbidden, { role: T.roles[user.role] }));
        await props.api.logout().catch(() => undefined);
      } else {
        props.onLogin(user);
      }
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 400)
          ? T.login.invalid
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <pre className="login-banner" aria-hidden>
          {BANNER}
        </pre>
        <Win title={T.login.title} cmd="Connect-RedLineAdmin" accent>
          <div className="login-lines">
            <div>
              <span className="ok">[ OK ]</span> {T.login.boot1}
            </div>
            <div>
              <span className="ok">[ OK ]</span> {T.login.boot2}
            </div>
            <div className="dim">{T.login.subtitle}</div>
          </div>
          {props.deniedUser && (
            <ErrorBox message={fmt(T.login.forbidden, { role: T.roles[props.deniedUser.role] })} />
          )}
          <form onSubmit={submit} className="login-form">
            <div className="field">
              <label htmlFor="email">{T.login.email}</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{T.login.password}</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <ErrorBox message={error} />}
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? T.login.submitting : T.login.submit}
            </Button>
            {props.mock && <p className="c-amber small">● {T.login.mockHint}</p>}
          </form>
        </Win>
      </div>
    </div>
  );
}
