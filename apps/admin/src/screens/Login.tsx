import { useState, type FormEvent } from 'react';
import { hasRole, type PublicUser } from '@redline/shared';
import { ApiError, type Api } from '../api/client';
import { Button, ErrorBox, Frame } from '../components/ui';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';

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
      <div className="login-brand">
        <svg viewBox="0 0 32 32" width="56" height="56" aria-hidden>
          <polygon
            points="16,2 29,9 29,23 16,30 3,23 3,9"
            fill="var(--rl-panel-solid)"
            stroke="var(--rl-orange)"
            strokeWidth="1.6"
          />
          <rect x="8" y="14.5" width="16" height="3" fill="var(--rl-red)" />
        </svg>
        <div>
          <div className="login-name">{T.app.name}</div>
          <div className="login-section">{T.app.section}</div>
        </div>
      </div>
      <Frame title={T.login.title} accent className="login-frame">
        <p className="muted">{T.login.subtitle}</p>
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
          {props.mock && <p className="muted small">{T.login.mockHint}</p>}
        </form>
      </Frame>
    </div>
  );
}
