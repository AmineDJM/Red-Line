/** Utilisateurs : recherche, rôles, bannissement, sourdine, empreintes, parties et achats. */
import { useEffect, useState, type CSSProperties } from 'react';
import { ROLES, type Role } from '@redline/shared';
import { useSession } from '../context';
import type { AdminUser, UserDetail } from '../api/types';
import { DataTable } from '../components/DataTable';
import { Nation } from '../components/Flag';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  SectionTitle,
  Spinner,
  Stat,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { ago, date, num, price } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { fromLocalInput, toLocalInput } from '../lib/dates';
import { useNationMap } from '../lib/refs';
import { href, navigate } from '../lib/router';
import { UserOpsPanel } from '../components/UserOps';
import { O } from '../i18n/fr-ops';
import type { UserFilter } from '../api/ops';
import { downloadCsv } from '../lib/csv';

const ROLE_TONE: Record<Role, 'off' | 'info' | 'blue' | 'violet'> = {
  player: 'off',
  moderator: 'info',
  balance: 'blue',
  superadmin: 'violet',
};

function statusBadges(u: AdminUser) {
  return (
    <>
      {u.bannedAt && <Badge tone="crit">{T.users.banned}</Badge>}
      {u.chatMutedUntil && new Date(u.chatMutedUntil) > new Date() && (
        <Badge tone="warn">{T.users.muted}</Badge>
      )}
      {u.isGuest && <Badge tone="off">{T.users.guest}</Badge>}
      {u.deletedAt && <Badge tone="crit">{O.user.deleted}</Badge>}
      {u.unlimited && (
        <Badge tone="warn" title={T.users.unlimitedTitle}>
          ∞ {T.users.unlimited}
        </Badge>
      )}
    </>
  );
}

export function UsersScreen({ id }: { id?: string }) {
  const { api } = useSession();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [filter, setFilter] = useState<UserFilter | ''>('');
  const list = useLoad(
    () =>
      api
        .searchUsers({ q: debounced || undefined, filter: filter || undefined, limit: 500 })
        .then((r) => r.users),
    [api, debounced, filter],
    T.roles.superadmin,
  );
  return (
    <>
      <PageHead title={T.users.title} sub={T.users.sub} />
      <div
        className={`split-list ${id ? 'has-sel' : ''}`}
        style={{ '--split-cols': 'minmax(0, 1fr) minmax(0, 1.1fr)' } as CSSProperties}
      >
        <Win
          title={T.users.title}
          className="list-pane"
          cmd={`Get-User${debounced ? ` -Filter "${debounced}"` : ''}`}
          flush
        >
          <div className="toolbar" style={{ padding: 10, marginBottom: 0 }}>
            <SearchBox value={q} onChange={setQ} placeholder={T.users.search} autoFocusKey />
            <select
              className="input"
              aria-label={O.user.filter}
              value={filter}
              onChange={(e) => setFilter(e.target.value as UserFilter | '')}
            >
              {(Object.keys(O.user.filters) as (UserFilter | '')[]).map((f) => (
                <option key={f} value={f}>
                  {O.user.filters[f]}
                </option>
              ))}
            </select>
            <Button
              small
              title="CSV"
              onClick={() =>
                downloadCsv('redline-utilisateurs.csv', list.data ?? [], [
                  ['id', (u) => u.id],
                  ['nom', (u) => u.displayName],
                  ['email', (u) => u.email],
                  ['role', (u) => u.role],
                  ['invite', (u) => u.isGuest],
                  ['illimite', (u) => !!u.unlimited],
                  ['monnaie_premium', (u) => u.premiumBalance],
                  ['cree', (u) => u.createdAt],
                  ['vu', (u) => u.lastSeenAt],
                  ['banni', (u) => u.bannedAt],
                  ['suspendu_jusqu_au', (u) => u.bannedUntil],
                  ['supprime', (u) => u.deletedAt],
                ])
              }
            >
              <Icon name="download" size={12} /> CSV
            </Button>
          </div>
          {list.error && <ErrorBox message={list.error} onRetry={() => void list.reload()} />}
          <DataTable
            rows={list.data ?? []}
            rowKey={(u) => u.id}
            selected={id}
            bare
            onRowClick={(u) => navigate({ name: 'users', id: u.id })}
            empty={list.loading ? T.app.loading : T.app.noResults}
            columns={[
              {
                key: 'n',
                label: T.users.name,
                className: 'two',
                sort: (u) => u.displayName,
                render: (u) => (
                  <>
                    <span className="row" style={{ gap: 6 }}>
                      <b className="bright">{u.displayName}</b>
                      {statusBadges(u)}
                    </span>
                    <span className="sub">{u.email ?? '—'}</span>
                  </>
                ),
              },
              {
                key: 'r',
                label: T.users.role,
                sort: (u) => ROLES.indexOf(u.role),
                render: (u) => <Badge tone={ROLE_TONE[u.role]}>{T.roles[u.role]}</Badge>,
              },
              {
                key: 'p',
                label: T.users.premium,
                align: 'right',
                hideM: true,
                sort: (u) => u.premiumBalance,
                render: (u) => (
                  <span className="val">{u.unlimited ? '∞' : num(u.premiumBalance)}</span>
                ),
              },
              {
                key: 's',
                label: T.users.lastSeen,
                sort: (u) => u.lastSeenAt,
                hideM: true,
                render: (u) => <span className="dim">{ago(u.lastSeenAt)}</span>,
              },
            ]}
          />
        </Win>
        <div className="detail-pane stack">
          {id ? (
            <UserDetailPane key={id} id={id} onChanged={() => void list.reload(true)} />
          ) : (
            <Win title={T.users.title} glyph="?">
              <Empty glyph="☺">{T.users.select}</Empty>
            </Win>
          )}
        </div>
      </div>
    </>
  );
}

function UserDetailPane({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { api, user: me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const nations = useNationMap();
  const { data, setData, error, loading, reload } = useLoad<UserDetail>(
    () => api.getUser(id),
    [api, id],
    T.roles.superadmin,
  );
  const [role, setRole] = useState<Role>('player');
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const [muteUntil, setMuteUntil] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setRole(data.user.role);
    setName(data.user.displayName);
    setMuteUntil(toLocalInput(data.user.chatMutedUntil));
  }, [data]);

  if (error) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const u = data.user;
  const self = u.id === me.id;

  const patch = async (p: Parameters<typeof api.patchUser>[1], msg: string) => {
    setBusy(true);
    try {
      const r = await api.patchUser(u.id, p);
      setData({ ...data, user: r.user });
      toast(msg);
      onChanged();
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  const maxAct = Math.max(1, ...data.activityHours);

  return (
    <>
      <div className="show-m">
        <Button small onClick={() => navigate({ name: 'users' })}>
          <Icon name="back" size={12} /> {T.app.back}
        </Button>
      </div>
      <Win
        title={u.displayName}
        path={`Utilisateurs\\${u.id.slice(0, 8)}`}
        glyph="☺"
        actions={
          <>
            {statusBadges(u)}
            <Badge tone={ROLE_TONE[u.role]}>{T.roles[u.role]}</Badge>
          </>
        }
      >
        <dl className="kv" style={{ marginBottom: 12 }}>
          <dt>ID</dt>
          <dd>{u.id}</dd>
          <dt>{T.users.email}</dt>
          <dd>{u.email ?? '—'}</dd>
          <dt>{T.users.created}</dt>
          <dd>{date(u.createdAt)}</dd>
          <dt>{T.users.lastSeen}</dt>
          <dd>{ago(u.lastSeenAt)}</dd>
          <dt>{T.users.premium}</dt>
          <dd className="c-amber">{u.unlimited ? '∞' : num(u.premiumBalance)}</dd>
          <dt>{T.users.unlimitedTitle}</dt>
          <dd className={u.unlimited ? 'c-amber' : 'dim'}>
            {u.unlimited ? T.users.unlimitedState : T.users.unlimitedNone}
          </dd>
          {u.bannedAt && (
            <>
              <dt>{T.users.banned}</dt>
              <dd className="c-red">
                {date(u.bannedAt)} · {u.banReason ?? '—'}
              </dd>
            </>
          )}
        </dl>
        {self && (
          <p className="note warn small" style={{ marginBottom: 12 }}>
            {T.users.selfLock}
          </p>
        )}
        <div className="grid g2">
          <div className="field">
            <label htmlFor="u-role">{T.users.changeRole}</label>
            <div className="row">
              <select
                id="u-role"
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={self}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {T.roles[r]}
                  </option>
                ))}
              </select>
              <Button
                disabled={busy || role === u.role || self}
                onClick={async () => {
                  if (
                    await confirm({
                      title: T.users.changeRole,
                      message: fmt(T.users.roleConfirm, {
                        role: T.roles[role],
                        name: u.displayName,
                      }),
                      danger: role === 'superadmin',
                    })
                  )
                    void patch(
                      { role },
                      fmt(T.users.roleDone, { name: u.displayName, role: T.roles[role] }),
                    );
                }}
              >
                {T.app.save}
              </Button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="u-name">{T.users.rename}</label>
            <div className="row">
              <input
                id="u-name"
                className="input"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                disabled={busy || name.trim().length < 2 || name === u.displayName}
                onClick={() => void patch({ displayName: name.trim() }, T.users.renameDone)}
              >
                {T.app.save}
              </Button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="u-mute">{T.users.mute}</label>
            <div className="row">
              <input
                id="u-mute"
                className="input"
                type="datetime-local"
                value={muteUntil}
                onChange={(e) => setMuteUntil(e.target.value)}
              />
              <Button
                disabled={busy || !muteUntil}
                onClick={() =>
                  void patch({ chatMutedUntil: fromLocalInput(muteUntil) }, T.users.muteDone)
                }
              >
                {T.app.save}
              </Button>
              {u.chatMutedUntil && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void patch({ chatMutedUntil: null }, T.users.muteDone)}
                >
                  {T.users.unmute}
                </Button>
              )}
            </div>
          </div>
          <div className="field">
            <label htmlFor="u-ban">{u.bannedAt ? T.users.unban : T.users.banReason}</label>
            {u.bannedAt ? (
              <div>
                <Button
                  variant="success"
                  disabled={busy}
                  onClick={() =>
                    void patch({ banned: false }, fmt(T.users.unbanDone, { name: u.displayName }))
                  }
                >
                  {T.users.unban}
                </Button>
              </div>
            ) : (
              <div className="row">
                <input
                  id="u-ban"
                  className="input"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={self}
                />
                <Button
                  variant="danger"
                  disabled={busy || self}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: T.users.ban,
                        message: fmt(T.users.banConfirm, { name: u.displayName }),
                        danger: true,
                        confirm: T.users.ban,
                        typeToConfirm: u.displayName,
                      })
                    )
                      void patch(
                        { banned: true, ...(reason.trim() ? { banReason: reason.trim() } : {}) },
                        fmt(T.users.banDone, { name: u.displayName }),
                      );
                  }}
                >
                  <Icon name="ban" size={13} /> {T.users.ban}
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>{T.users.unlimitedTitle}</label>
          <p className="dim small" style={{ margin: '0 0 8px' }}>
            {T.users.unlimitedHelp}
          </p>
          <div>
            <Button
              variant={u.unlimited ? 'ghost' : undefined}
              disabled={busy || me.role !== 'superadmin'}
              onClick={async () => {
                const on = !u.unlimited;
                if (
                  await confirm({
                    title: T.users.unlimitedTitle,
                    message: fmt(on ? T.users.unlimitedOnConfirm : T.users.unlimitedOffConfirm, {
                      name: u.displayName,
                    }),
                    confirm: on ? T.users.unlimitedOn : T.users.unlimitedOff,
                    danger: on,
                  })
                )
                  void patch(
                    { unlimited: on },
                    fmt(on ? T.users.unlimitedOnDone : T.users.unlimitedOffDone, {
                      name: u.displayName,
                    }),
                  );
              }}
            >
              ∞ {u.unlimited ? T.users.unlimitedOff : T.users.unlimitedOn}
            </Button>
          </div>
        </div>
        {data.activityHours.length === 24 && (
          <>
            <SectionTitle>{T.users.activity}</SectionTitle>
            <div className="heat" aria-label={T.users.activity}>
              {data.activityHours.map((v, h) => (
                <span
                  key={h}
                  title={`${h} h : ${v}`}
                  style={{ opacity: 0.08 + (0.92 * v) / maxAct }}
                />
              ))}
            </div>
            <div className="heat-ax">
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h}>{h % 6 === 0 ? h : ''}</span>
              ))}
            </div>
          </>
        )}
      </Win>
      <UserOpsPanel
        user={u}
        onChanged={() => {
          void reload(true);
          onChanged();
        }}
      />
      <Win title={T.users.games} glyph="▶">
        {data.games.length === 0 ? (
          <p className="dim small">{T.users.none}</p>
        ) : (
          <div className="stack-sm">
            {data.games.map((g) => (
              <a key={g.gameId} href={href({ name: 'games', id: g.gameId })} className="row small">
                <Nation
                  id={g.nationId}
                  name={nations.get(g.nationId)?.name}
                  color={nations.get(g.nationId)?.color}
                />
                <span className="dim">·</span>
                <span>{g.name}</span>
              </a>
            ))}
          </div>
        )}
      </Win>
      <Win title={T.users.purchases} glyph="$">
        <div className="stats" style={{ marginBottom: 10 }}>
          <Stat k={T.shop.count} v={data.purchases.length} />
          <Stat
            k={T.shop.revenue}
            v={price(
              data.purchases
                .filter((p) => p.status === 'paid')
                .reduce((a, p) => a + p.priceCents, 0),
              'eur',
            )}
            tone="var(--t-amber)"
          />
        </div>
        {data.purchases.length > 0 && (
          <DataTable
            rows={data.purchases}
            rowKey={(p) => p.id}
            maxHeight={220}
            columns={[
              { key: 'd', label: T.shop.date, render: (p) => date(p.createdAt) },
              { key: 'p', label: T.shop.pack, render: (p) => p.packId },
              {
                key: 'm',
                label: T.shop.price,
                align: 'right',
                render: (p) => price(p.priceCents, p.currency),
              },
              {
                key: 's',
                label: T.shop.status,
                render: (p) => (
                  <Badge
                    tone={
                      p.status === 'paid'
                        ? 'ok'
                        : p.status === 'refunded'
                          ? 'blue'
                          : p.status === 'failed'
                            ? 'crit'
                            : 'warn'
                    }
                  >
                    {T.shop.statuses[p.status]}
                  </Badge>
                ),
              },
            ]}
          />
        )}
      </Win>
      <Win title={T.users.fingerprints} glyph="#">
        {data.fingerprints.length === 0 ? (
          <p className="dim small">{T.users.none}</p>
        ) : (
          <DataTable
            rows={data.fingerprints}
            rowKey={(f) => `${f.ipHash}:${f.uaHash}`}
            maxHeight={220}
            columns={[
              { key: 'ip', label: 'IP (hachée)', render: (f) => <code>{f.ipHash}</code> },
              {
                key: 'ua',
                label: 'Navigateur',
                className: 'wrap',
                render: (f) => <span className="small muted">{f.userAgent ?? f.uaHash}</span>,
              },
              { key: 'h', label: T.users.hits, align: 'right', render: (f) => num(f.hits) },
              {
                key: 'l',
                label: T.users.lastSeen,
                render: (f) => <span className="dim">{ago(f.lastSeen)}</span>,
              },
            ]}
          />
        )}
      </Win>
    </>
  );
}
