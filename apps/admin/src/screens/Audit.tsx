/** Journal d'audit : toutes les actions d'administration, filtrables, avec l'état avant et après. */
import { useMemo, useState } from 'react';
import { useSession } from '../context';
import type { AuditEntry } from '../api/types';
import { DataTable } from '../components/DataTable';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  Spinner,
  Win,
} from '../components/term';
import { DiffTable } from '../components/versioning';
import { T } from '../i18n';
import { diffObjects } from '../lib/diff';
import { ago, dateLong } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { href, type Route } from '../lib/router';
import { matches } from '../lib/search';
import { O } from '../i18n/fr-ops';
import { downloadCsv } from '../lib/csv';
import { errorMessage } from '../lib/errors';
import { useToast } from '../components/overlay';

const FAMILY_TONE: Record<string, 'info' | 'blue' | 'warn' | 'violet' | 'ok' | 'crit' | 'off'> = {
  system: 'info',
  catalog: 'info',
  data: 'blue',
  game: 'ok',
  chat: 'warn',
  user: 'violet',
  shop: 'crit',
  costs: 'warn',
  announcement: 'info',
  server: 'blue',
};

/** Familles connues (le filtre interroge le serveur : tout l'historique, pas seulement les 500 derniers). */
const KNOWN_FAMILIES = [
  'system',
  'catalog',
  'data',
  'game',
  'chat',
  'user',
  'shop',
  'costs',
  'announcement',
  'server',
];
const PAGE = 500;

/** Lien vers l'objet visé par une entrée (« system:us.f-16 » → fiche). */
export function targetRoute(target: string | null): Route | null {
  if (!target) return null;
  const [kind, ...rest] = target.split(':');
  const id = rest.join(':');
  switch (kind) {
    case 'system':
      return { name: 'system', id };
    case 'game':
      return { name: 'games', id };
    case 'user':
      return { name: 'users', id };
    case 'rules':
      return { name: 'rules' };
    case 'research':
      return { name: 'research', id };
    case 'nation':
      return { name: 'map', tab: 'nations', id };
    case 'province':
      return { name: 'map', tab: 'provinces', id };
    case 'disputed':
      return { name: 'map', tab: 'disputed', id };
    case 'scenario':
      return { name: 'scenarios', id };
    case 'announcement':
      return { name: 'announcements' };
    case 'cost':
      return { name: 'economy', tab: 'entries' };
    case 'costs':
      return { name: 'economy', tab: 'settings' };
    case 'server':
      return { name: 'settings' };
    case 'orbat': {
      const [set, nation] = id.split('/');
      return { name: 'orbat', set, nation };
    }
    default:
      return null;
  }
}

export function AuditScreen() {
  const { api } = useSession();
  const toast = useToast();
  const [family, setFamily] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters = useMemo(
    () => ({
      action: family ? `${family}.` : undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    }),
    [family, from, to],
  );
  const { data, setData, error, loading, reload } = useLoad(
    () => api.auditQuery({ limit: PAGE, ...filters }).then((r) => r.entries),
    [api, filters],
    T.roles.superadmin,
  );
  const [more, setMore] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const families = useMemo(
    () =>
      [...new Set([...KNOWN_FAMILIES, ...(data ?? []).map((e) => e.action.split('.')[0]!)])].sort(),
    [data],
  );
  const loadMore = async () => {
    const last = data?.at(-1);
    if (!last) return;
    try {
      const r = await api.auditQuery({ limit: PAGE, ...filters, before: last.id });
      setData([...(data ?? []), ...r.entries]);
      setMore(r.entries.length === PAGE);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };
  const rows = useMemo(
    () =>
      (data ?? []).filter((e) => matches(`${e.action} ${e.target ?? ''} ${e.adminName ?? ''}`, q)),
    [data, q, family],
  );
  const cur: AuditEntry | null = rows.find((e) => e.id === sel) ?? null;
  const diff = cur ? diffObjects(cur.before ?? {}, cur.after ?? {}) : [];
  const link = cur ? targetRoute(cur.target) : null;

  return (
    <>
      <PageHead
        title={T.audit.title}
        sub={T.audit.sub}
        actions={
          <>
            <Button
              onClick={() =>
                downloadCsv('redline-journal.csv', rows, [
                  ['id', (e) => e.id],
                  ['date', (e) => e.createdAt],
                  ['administrateur', (e) => e.adminName],
                  ['action', (e) => e.action],
                  ['cible', (e) => e.target],
                  ['avant', (e) => (e.before == null ? '' : JSON.stringify(e.before))],
                  ['apres', (e) => (e.after == null ? '' : JSON.stringify(e.after))],
                ])
              }
            >
              <Icon name="download" size={14} /> {O.audit.exportCsv}
            </Button>
            <Button onClick={() => void reload()}>
              <Icon name="refresh" size={14} /> {T.app.refresh}
            </Button>
          </>
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      <div className="split-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 420px' }}>
        <Win title={T.audit.title} cmd="Get-AdminAudit -Last 500" flush>
          <div className="toolbar" style={{ padding: 10, marginBottom: 0 }}>
            <SearchBox value={q} onChange={setQ} placeholder={T.audit.search} autoFocusKey />
            <select
              className="input"
              aria-label={T.audit.action}
              value={family}
              onChange={(e) => setFamily(e.target.value)}
            >
              <option value="">{T.audit.allActions}</option>
              {families.map((f) => (
                <option key={f} value={f}>
                  {T.audit.families[f] ?? f}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input"
              aria-label={O.audit.from}
              title={O.audit.from}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <input
              type="date"
              className="input"
              aria-label={O.audit.to}
              title={O.audit.to}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <span className="meta">{rows.length}</span>
          </div>
          {loading && !data ? (
            <Spinner />
          ) : (
            <DataTable
              rows={rows}
              rowKey={(e) => String(e.id)}
              selected={sel !== null ? String(sel) : null}
              onRowClick={(e) => setSel(e.id)}
              bare
              maxHeight="calc(100vh - 250px)"
              columns={[
                {
                  key: 'd',
                  label: T.audit.date,
                  sort: (e) => e.createdAt,
                  render: (e) => (
                    <span className="dim" title={dateLong(e.createdAt)}>
                      {ago(e.createdAt)}
                    </span>
                  ),
                },
                {
                  key: 'a',
                  label: T.audit.admin,
                  sort: (e) => e.adminName ?? '',
                  render: (e) => e.adminName ?? <span className="dim">—</span>,
                },
                {
                  key: 'x',
                  label: T.audit.action,
                  sort: (e) => e.action,
                  render: (e) => (
                    <Badge tone={FAMILY_TONE[e.action.split('.')[0]!] ?? 'off'}>{e.action}</Badge>
                  ),
                },
                {
                  key: 't',
                  label: T.audit.target,
                  render: (e) => <code className="small">{e.target ?? '—'}</code>,
                },
              ]}
            />
          )}
          {data && data.length >= PAGE && more && (
            <div style={{ padding: 10 }}>
              <Button small onClick={() => void loadMore()}>
                {O.audit.more}
              </Button>
            </div>
          )}
        </Win>
        <Win
          title={cur ? cur.action : T.audit.title}
          glyph="Δ"
          className="sticky-col"
          actions={
            link ? (
              <a className="btn btn-sm" href={href(link)}>
                <Icon name="external" size={12} /> {T.app.open}
              </a>
            ) : null
          }
        >
          {!cur ? (
            <Empty glyph="≡">{T.audit.select}</Empty>
          ) : (
            <div className="stack">
              <dl className="kv">
                <dt>{T.audit.date}</dt>
                <dd>{dateLong(cur.createdAt)}</dd>
                <dt>{T.audit.admin}</dt>
                <dd>{cur.adminName ?? '—'}</dd>
                <dt>{T.audit.target}</dt>
                <dd>
                  <code>{cur.target ?? '—'}</code>
                </dd>
              </dl>
              {cur.before == null && cur.after == null ? (
                <p className="dim small">{T.audit.noPayload}</p>
              ) : cur.before == null || typeof cur.before !== 'object' ? (
                <pre className="json-view">{JSON.stringify(cur.after, null, 2)}</pre>
              ) : (
                <DiffTable changes={diff} />
              )}
            </div>
          )}
        </Win>
      </div>
    </>
  );
}
