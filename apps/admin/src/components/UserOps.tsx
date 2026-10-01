/**
 * Fiche utilisateur, gestion complète : type de compte, coût du mois, résultats, portefeuille (crédit /
 * débit), suspension temporaire, sessions, mot de passe provisoire, export et suppression RGPD.
 */
import { useState } from 'react';
import { useSession } from '../context';
import type { AdminUser } from '../api/types';
import type { UserOverview } from '../api/ops';
import { DataTable } from './DataTable';
import { Nation } from './Flag';
import { Dialog, useConfirm, useToast } from './overlay';
import { Badge, Button, ErrorBox, Icon, Note, SectionTitle, Spinner, Stat, Win } from './term';
import { T, fmt } from '../i18n';
import { O } from '../i18n/fr-ops';
import { downloadJson } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { ago, bytes, date, num } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useNationMap } from '../lib/refs';
import { href } from '../lib/router';
import { money } from '../lib/money';
import '../screens/ops.css';

const U = O.user;
const KIND_TONE = { free: 'info', paying: 'ok', guest: 'off', staff: 'violet' } as const;

export function UserOpsPanel({ user: u, onChanged }: { user: AdminUser; onChanged: () => void }) {
  const { api, user: me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const nations = useNationMap();
  const { data, error, loading, reload } = useLoad<UserOverview>(
    () => api.userOverview(u.id),
    [api, u.id],
    T.roles.superadmin,
  );
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [hours, setHours] = useState<number>(24);
  const [reason, setReason] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const self = u.id === me.id;
  const deleted = !!u.deletedAt;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast(msg);
      onChanged();
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const d = Number(delta);
  const cost = data.costMonth;
  const durationLabel = U.durations.find(([h]) => h === hours)?.[1] ?? `${hours} h`;

  return (
    <>
      <Win
        title={U.manage}
        glyph="⚙"
        actions={<Badge tone={KIND_TONE[data.kind]}>{O.kinds[data.kind]}</Badge>}
      >
        {deleted && <Note tone="crit">{U.deleted}</Note>}
        {u.bannedUntil && new Date(u.bannedUntil) > new Date() && (
          <Note tone="warn">{fmt(U.suspendedUntil, { d: date(u.bannedUntil) })}</Note>
        )}
        <div className="stats" style={{ marginBottom: 12 }}>
          <Stat
            k={U.costMonth}
            v={cost ? money(cost.cost.total) : '—'}
            d={
              cost
                ? `${fmt(U.marginal, { v: money(cost.marginalUsd) })} · ${fmt(U.playHours, { h: num(cost.playHours, 1) })}`
                : U.costNone
            }
          />
          <Stat
            k={O.economy.net}
            v={cost ? money(cost.revenueNetUsd) : '—'}
            tone="var(--t-amber)"
            d={cost ? `${O.economy.margin} ${money(cost.marginUsd)}` : undefined}
          />
          <Stat
            k={U.wallet}
            v={num(data.wallet.balance)}
            d={fmt(U.walletLine, {
              b: num(data.wallet.balance),
              in: num(data.wallet.bought),
              out: num(data.wallet.spent),
              adm: num(data.wallet.admin),
            })}
          />
        </div>
        <p className="dim small" style={{ marginTop: 0 }}>
          {fmt(U.results, { w: data.results.wins, g: data.results.games, p: data.results.points })}
        </p>
        <div className="ops-actions">
          <div className="field">
            <label htmlFor="uo-delta">{U.wallet}</label>
            <div className="ops-row">
              <input
                id="uo-delta"
                className="input"
                inputMode="numeric"
                placeholder={U.walletDelta}
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                disabled={deleted}
              />
              <input
                className="input"
                aria-label={U.walletNote}
                placeholder={U.walletNote}
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={deleted}
              />
              <Button
                disabled={busy || deleted || !Number.isInteger(d) || d === 0 || !note.trim()}
                onClick={async () => {
                  if (
                    await confirm({
                      title: U.wallet,
                      message: fmt(U.walletConfirm, {
                        d: d > 0 ? `+${d}` : String(d),
                        name: u.displayName,
                      }),
                      danger: d < 0,
                    })
                  )
                    void run(async () => {
                      const r = await api.adjustWallet(u.id, d, note.trim());
                      setDelta('');
                      setNote('');
                      return fmt(U.walletDone, { b: num(r.balance) });
                    });
                }}
              >
                {U.walletApply}
              </Button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="uo-hours">{U.suspend}</label>
            <div className="ops-row">
              <select
                id="uo-hours"
                className="input"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                disabled={self || deleted}
              >
                {U.durations.map(([h, l]) => (
                  <option key={h} value={h}>
                    {l}
                  </option>
                ))}
              </select>
              <input
                className="input"
                aria-label={U.suspendReason}
                placeholder={U.suspendReason}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={self || deleted}
              />
              <Button
                variant="danger"
                disabled={busy || self || deleted}
                onClick={async () => {
                  if (
                    await confirm({
                      title: U.suspend,
                      message: fmt(U.suspendConfirm, { name: u.displayName, h: durationLabel }),
                      danger: true,
                      confirm: U.suspend,
                    })
                  )
                    void run(async () => {
                      const r = await api.suspendUser(u.id, hours, reason.trim() || undefined);
                      return fmt(U.suspendDone, { d: date(r.bannedUntil) });
                    });
                }}
              >
                <Icon name="ban" size={13} /> {U.suspend}
              </Button>
            </div>
          </div>
        </div>

        <SectionTitle n={data.sessions.length}>{U.sessions}</SectionTitle>
        {data.sessions.length === 0 ? (
          <p className="dim small">{U.sessionsNone}</p>
        ) : (
          <DataTable
            rows={data.sessions}
            rowKey={(s) => String(s.n)}
            maxHeight={160}
            columns={[
              {
                key: 'c',
                label: T.users.created,
                render: (s) => <span title={date(s.createdAt)}>{ago(s.createdAt)}</span>,
              },
              {
                key: 'e',
                label: 'Expire',
                hideM: true,
                render: (s) => <span className="dim">{date(s.expiresAt)}</span>,
              },
              {
                key: 'u',
                label: 'Navigateur',
                className: 'wrap',
                render: (s) => <span className="small muted">{s.userAgent ?? '—'}</span>,
              },
            ]}
          />
        )}
        <div className="ops-row" style={{ marginTop: 8 }}>
          <Button
            small
            disabled={busy || self || data.sessions.length === 0}
            onClick={async () => {
              if (
                await confirm({
                  title: U.revoke,
                  message: fmt(U.revokeConfirm, { name: u.displayName }),
                })
              )
                void run(async () => {
                  const r = await api.revokeSessions(u.id);
                  return fmt(U.revokeDone, { n: r.revoked });
                });
            }}
          >
            <Icon name="logout" size={12} /> {U.revoke}
          </Button>
          <Button
            small
            disabled={busy || self || !u.email || deleted}
            title={U.passwordHelp}
            onClick={async () => {
              if (
                await confirm({
                  title: U.password,
                  message: fmt(U.passwordConfirm, { name: u.displayName }),
                  danger: true,
                })
              )
                void run(async () => {
                  const r = await api.resetPassword(u.id);
                  setSecret(r.password);
                });
            }}
          >
            <Icon name="security" size={12} /> {U.password}
          </Button>
        </div>

        <SectionTitle>{U.gdpr}</SectionTitle>
        <p className="dim small" style={{ marginTop: 0 }}>
          {U.deleteHelp}
        </p>
        <div className="ops-row">
          <Button
            small
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const data = await api.exportUser(u.id);
                downloadJson(`redline-utilisateur-${u.id.slice(0, 8)}.json`, data);
                return U.exportDone;
              })
            }
          >
            <Icon name="download" size={12} /> {U.export}
          </Button>
          <Button
            small
            variant="danger"
            disabled={busy || self || deleted || u.role === 'superadmin'}
            onClick={async () => {
              if (
                await confirm({
                  title: U.delete,
                  message: fmt(U.deleteConfirm, { name: u.displayName }),
                  danger: true,
                  confirm: U.delete,
                  typeToConfirm: u.displayName,
                })
              )
                void run(async () => {
                  const r = await api.deleteUser(u.id, u.displayName);
                  return fmt(U.deleteDone, { n: r.deletedGames });
                });
            }}
          >
            <Icon name="close" size={12} /> {U.delete}
          </Button>
        </div>
      </Win>

      <Win title={U.gamesTitle} glyph="▶" flush>
        <DataTable
          rows={data.games}
          rowKey={(g) => g.gameId}
          bare
          maxHeight={260}
          empty={T.users.none}
          columns={[
            {
              key: 'n',
              label: T.games.name,
              className: 'two',
              render: (g) => (
                <>
                  <a href={href({ name: 'games', id: g.gameId })} className="bright">
                    {g.name}
                  </a>
                  <span className="sub">
                    {T.games.modes[g.mode]} ·{' '}
                    {T.games.statuses[g.status as keyof typeof T.games.statuses] ?? g.status}
                    {g.owner ? ` · ${U.owner}` : ''}
                    {g.loaded ? ` · ${U.loaded}` : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'na',
              label: 'Nation',
              render: (g) => (
                <Nation
                  id={g.nationId}
                  name={nations.get(g.nationId)?.name}
                  color={nations.get(g.nationId)?.color}
                />
              ),
            },
            {
              key: 'a',
              label: U.lastActive,
              hideM: true,
              render: (g) => <span className="dim">{ago(g.lastActiveAt)}</span>,
            },
            {
              key: 's',
              label: O.economy.storage,
              align: 'right',
              hideM: true,
              render: (g) => bytes(g.stateBytes),
            },
          ]}
        />
      </Win>

      {secret && (
        <Dialog
          title={fmt(U.passwordShown, { name: u.displayName })}
          onClose={() => setSecret(null)}
          actions={
            <>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(secret).catch(() => {});
                }}
              >
                <Icon name="copy" size={12} /> Copier
              </Button>
              <Button variant="primary" onClick={() => setSecret(null)}>
                {T.app.close}
              </Button>
            </>
          }
        >
          <p className="small">{U.passwordCopy}</p>
          <div className="secret-box" data-autofocus tabIndex={-1}>
            {secret}
          </div>
        </Dialog>
      )}
    </>
  );
}
