/** Sécurité : comptes liés suspects (multi-comptes) et anomalies de cadence d'ordres. */
import { hasRole } from '@redline/shared';
import { useSession } from '../context';
import type { SuspiciousPair } from '../api/types';
import { DataTable } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  ErrorBox,
  Gauge,
  Icon,
  Note,
  PageHead,
  Spinner,
  Stat,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { num } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { href } from '../lib/router';

export function SecurityScreen() {
  const { api, user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () => api.suspicious(),
    [api],
    T.roles.moderator,
  );
  const superadmin = hasRole(user.role, 'superadmin');

  const ban = async (u: SuspiciousPair['users'][number]) => {
    if (
      !(await confirm({
        title: T.users.ban,
        message: fmt(T.users.banConfirm, { name: u.name }),
        danger: true,
        confirm: T.users.ban,
      }))
    )
      return;
    try {
      await api.patchUser(u.id, { banned: true, banReason: 'Multi-comptes (sécurité)' });
      toast(fmt(T.users.banDone, { name: u.name }));
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };

  const tone = (s: number) =>
    s >= 6 ? 'var(--t-red)' : s >= 4 ? 'var(--t-amber)' : 'var(--t-cyan)';
  return (
    <>
      <PageHead
        title={T.security.title}
        sub={T.security.sub}
        actions={
          <Button onClick={() => void reload()}>
            <Icon name="refresh" size={14} /> {T.app.refresh}
          </Button>
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <div className="stats">
            <Stat
              k={T.security.pairs}
              v={data.pairs.length}
              tone={data.pairs.some((p) => p.score >= 6) ? 'var(--t-red)' : undefined}
            />
            <Stat
              k={T.security.anomalies}
              v={data.anomalies.length}
              tone={data.anomalies.length ? 'var(--t-amber)' : undefined}
            />
          </div>
          <Note>{T.security.privacy}</Note>
          <Win
            title={T.security.pairs}
            cmd="Find-LinkedAccount | Sort-Object score -Descending"
            glyph="⚠"
          >
            <DataTable
              rows={data.pairs}
              rowKey={(p) => p.users.map((u) => u.id).join('|')}
              empty={T.security.noPairs}
              initialSort={{ key: 's', dir: -1 }}
              columns={[
                {
                  key: 's',
                  label: T.security.score,
                  sort: (p) => p.score,
                  render: (p) => (
                    <Gauge value={p.score} max={7} color={tone(p.score)} label={p.score} />
                  ),
                },
                {
                  key: 'u',
                  label: T.security.accounts,
                  className: 'wrap',
                  render: (p) => (
                    <span className="stack-sm" style={{ padding: '6px 0', gap: 4 }}>
                      {p.users.map((u) => (
                        <span key={u.id} className="row" style={{ gap: 6 }}>
                          {superadmin ? (
                            <a href={href({ name: 'users', id: u.id })}>{u.name}</a>
                          ) : (
                            <b>{u.name}</b>
                          )}
                          <span className="dim small">{u.email ?? ''}</span>
                          {u.isGuest && <Badge tone="off">{T.security.guest}</Badge>}
                          {u.banned && <Badge tone="crit">{T.security.banned}</Badge>}
                          {superadmin && !u.banned && (
                            <Button small variant="danger" onClick={() => void ban(u)}>
                              <Icon name="ban" size={12} /> {T.security.ban}
                            </Button>
                          )}
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  key: 'r',
                  label: T.security.reasons,
                  className: 'wrap',
                  render: (p) => (
                    <span className="chips" style={{ padding: '6px 0' }}>
                      {p.reasons.map((r) => (
                        <span key={r} className="chip">
                          {r}
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  key: 'g',
                  label: T.security.shared,
                  hideM: true,
                  render: (p) =>
                    p.sharedGames.length ? (
                      p.sharedGames.map((g) => (
                        <a
                          key={g}
                          href={href({ name: 'games', id: g })}
                          className="chip"
                          style={{ marginRight: 4 }}
                        >
                          {g.slice(0, 8)}
                        </a>
                      ))
                    ) : (
                      <span className="dim">—</span>
                    ),
                },
              ]}
            />
          </Win>
          <Win
            title={T.security.anomalies}
            cmd="Get-OrderRate -Last 1h | Where-Object orders -gt 1500"
            glyph="⚡"
          >
            <DataTable
              rows={data.anomalies}
              rowKey={(a) => `${a.userId}:${a.gameId}`}
              empty={T.security.noAnomalies}
              columns={[
                {
                  key: 'k',
                  label: T.security.kind,
                  render: (a) => <Badge tone="warn">{T.security.kinds[a.kind] ?? a.kind}</Badge>,
                },
                {
                  key: 'u',
                  label: T.security.user,
                  render: (a) =>
                    superadmin ? (
                      <a href={href({ name: 'users', id: a.userId })}>{a.userId.slice(0, 8)}</a>
                    ) : (
                      a.userId.slice(0, 8)
                    ),
                },
                {
                  key: 'g',
                  label: T.security.game,
                  render: (a) => (
                    <a href={href({ name: 'games', id: a.gameId })}>{a.gameId.slice(0, 8)}</a>
                  ),
                },
                {
                  key: 'o',
                  label: T.security.orders,
                  align: 'right',
                  sort: (a) => a.orders,
                  render: (a) => <span className="val">{num(a.orders)}</span>,
                },
              ]}
            />
          </Win>
        </>
      )}
    </>
  );
}
