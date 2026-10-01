/** Archives : parties terminées, taille stockée, suppression définitive (superadmin, confirmée). */
import { useEffect, useState } from 'react';
import { useSession } from '../context';
import type { ArchivedGame } from '../api/ops';
import { DataTable } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  ErrorBox,
  Icon,
  PageHead,
  SearchBox,
  Spinner,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { O } from '../i18n/fr-ops';
import { downloadCsv } from '../lib/csv';
import { errorMessage } from '../lib/errors';
import { ago, bytes, date } from '../lib/format';
import { useLoad } from '../lib/hooks';
import './ops.css';

const R = O.archive;
const TONE = { victory: 'ok', abandoned: 'off', admin: 'crit' } as const;

export function ArchiveScreen() {
  const { api, user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useLoad(
    () => api.archivedGames({ q: debounced || undefined, limit: 500 }).then((r) => r.games),
    [api, debounced],
    T.roles.moderator,
  );
  const remove = async (g: ArchivedGame) => {
    if (
      !(await confirm({
        title: O.game.delete,
        message: fmt(O.game.deleteConfirm, { name: g.name }),
        danger: true,
        confirm: O.game.delete,
        typeToConfirm: g.id.slice(0, 8),
      }))
    )
      return;
    try {
      await api.deleteGame(g.id, g.id.slice(0, 8));
      toast(O.game.deleteDone);
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };
  const rows = data ?? [];
  return (
    <>
      <PageHead
        title={R.title}
        sub={R.sub}
        actions={
          <Button
            onClick={() =>
              downloadCsv('redline-archives.csv', rows, [
                ['id', (g) => g.id],
                ['nom', (g) => g.name],
                ['mode', (g) => g.mode],
                ['fin', (g) => R.reasons[g.endReason]],
                ['vainqueur', (g) => g.winner],
                ['joueurs', (g) => g.humans],
                ['creee', (g) => g.createdAt],
                ['terminee', (g) => g.endedAt],
                ['instantane_octets', (g) => g.stateBytes],
              ])
            }
          >
            <Icon name="download" size={14} /> CSV
          </Button>
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      <Win title={R.title} flush cmd="Get-Game -Status ended">
        <div style={{ padding: 10 }}>
          <SearchBox value={q} onChange={setQ} autoFocusKey />
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(g) => g.id}
            bare
            empty={R.none}
            columns={[
              {
                key: 'n',
                label: T.games.name,
                className: 'two',
                sort: (g) => g.name,
                render: (g) => (
                  <>
                    <b className="bright">{g.name}</b>
                    <span className="sub">
                      {g.id.slice(0, 8)} · {g.scenarioId} · {T.games.modes[g.mode]}
                    </span>
                  </>
                ),
              },
              {
                key: 'r',
                label: R.reason,
                sort: (g) => g.endReason,
                render: (g) => (
                  <>
                    <Badge tone={TONE[g.endReason]}>{R.reasons[g.endReason]}</Badge>
                    {g.unranked && (
                      <>
                        {' '}
                        <Badge tone="warn">{T.games.unranked}</Badge>
                      </>
                    )}
                  </>
                ),
              },
              {
                key: 'p',
                label: T.games.players,
                align: 'right',
                sort: (g) => g.humans,
                render: (g) => g.humans,
              },
              {
                key: 'e',
                label: R.ended,
                sort: (g) => g.endedAt ?? '',
                render: (g) => <span title={date(g.endedAt)}>{ago(g.endedAt)}</span>,
              },
              {
                key: 's',
                label: R.size,
                align: 'right',
                hideM: true,
                sort: (g) => g.stateBytes,
                render: (g) => bytes(g.stateBytes),
              },
              {
                key: 'x',
                label: '',
                align: 'right',
                render: (g) => (
                  <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <a
                      className="btn btn-sm"
                      href={`/game/${encodeURIComponent(g.id)}/end`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external" size={12} />
                    </a>
                    {user.role === 'superadmin' && (
                      <Button
                        small
                        variant="danger"
                        aria-label={O.game.delete}
                        onClick={() => void remove(g)}
                      >
                        <Icon name="close" size={12} />
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Win>
    </>
  );
}
