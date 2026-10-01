import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MyGame } from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Flag,
  Icon,
  IconButton,
  Spinner,
  Table,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { ApiError } from '../api/types.js';
import { Page } from '../components/Page.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';
import { fmtDate } from '../i18n/index.js';

/** Mes parties : reprendre, bilan, spectateur. */
export function GamesScreen() {
  const { t } = useTranslation();
  const nations = useWorld((s) => s.nations);
  const load = useWorld((s) => s.load);
  const [games, setGames] = useState<MyGame[] | null>(null);
  const [error, setError] = useState(false);
  const [toDelete, setToDelete] = useState<MyGame | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const refresh = () =>
    getApi().then((api) =>
      api
        .myGames()
        .then(setGames)
        .catch(() => setError(true)),
    );
  useEffect(() => {
    void getApi().then((api) => load(api));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await (await getApi()).deleteGame(toDelete.game.id);
      setToDelete(null);
      await refresh();
    } catch (e) {
      setDeleteError(
        e instanceof ApiError && e.code === 'game_busy'
          ? t('games.delete.busy')
          : e instanceof ApiError && e.message && e.message !== e.code
            ? e.message
            : t('games.delete.error'),
      );
    } finally {
      setDeleting(false);
    }
  };
  const statusLabel = (g: MyGame) =>
    g.game.status === 'ended' && g.game.endReason === 'abandoned'
      ? t('games.status.abandoned')
      : t(`games.status.${g.game.status}`);
  return (
    <Page
      path={[t('games.path')]}
      title={t('games.title')}
      subtitle={t('games.subtitle')}
      actions={
        <>
          <Button
            variant="subtle"
            icon={<Icon name="users" size={13} />}
            onClick={() => navigate('/lobby')}
          >
            {t('home.multi')}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => navigate('/new')}
          >
            {t('home.continue')}
          </Button>
        </>
      }
    >
      {error ? (
        <EmptyState icon="warning" title={t('games.error')} />
      ) : !games ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <Table
          label={t('games.title')}
          className="games-table"
          rows={games}
          rowKey={(g) => g.game.id}
          empty={
            <EmptyState
              icon="refresh"
              title={t('games.empty')}
              action={
                <Button variant="primary" onClick={() => navigate('/new')}>
                  {t('home.continue')}
                </Button>
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: t('games.cols.game'),
              render: (g) => (
                <span className="lobbyname">
                  <b title={g.game.name}>
                    <Flag nationId={g.nationId} size={11} className="rl-only-mobile" />
                    <span className="lobbyname__title">{g.game.name}</span>
                  </b>
                  <span>
                    {t(`games.mode.${g.game.mode}`)} ·{' '}
                    {fmtDate(g.createdAt)}
                    <span className="rl-only-mobile"> · {statusLabel(g)}</span>
                  </span>
                </span>
              ),
            },
            {
              key: 'nation',
              header: t('games.cols.nation'),
              hideOnMobile: true,
              render: (g) => (
                <span className="nat">
                  <Flag nationId={g.nationId} size={12} />
                  <span className="nat__name">
                    {nations[g.nationId]?.name ?? g.nationId.toUpperCase()}
                  </span>
                </span>
              ),
            },
            {
              key: 'players',
              header: t('games.cols.players'),
              align: 'right',
              hideOnMobile: true,
              render: (g) => `${g.game.playerCount ?? 1}/${g.game.maxPlayers ?? 1}`,
            },
            {
              key: 'status',
              header: t('games.cols.status'),
              hideOnMobile: true,
              render: (g) => (
                <Badge
                  tone={
                    g.game.status === 'running'
                      ? 'green'
                      : g.game.status === 'ended'
                        ? 'neutral'
                        : 'amber'
                  }
                  dot
                  pulse={g.game.status === 'running'}
                >
                  {statusLabel(g)}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (g) => (
                <span className="rowactions">
                  {g.game.status === 'ended' ? (
                    <Button
                      size="sm"
                      variant="subtle"
                      icon={<Icon name="economy" size={12} />}
                      onClick={() => navigate(`/game/${encodeURIComponent(g.game.id)}/end`)}
                    >
                      {t('games.stats')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="play" size={11} />}
                      onClick={() => navigate(`/game/${encodeURIComponent(g.game.id)}`)}
                    >
                      {t('games.resume')}
                    </Button>
                  )}
                  {g.game.mode === 'solo' ? (
                    <IconButton
                      size="sm"
                      label={t('games.delete.action')}
                      icon={<Icon name="trash" size={14} />}
                      onClick={() => {
                        setDeleteError(null);
                        setToDelete(g);
                      }}
                      data-testid="game-delete"
                    />
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      )}
      <Dialog
        open={!!toDelete}
        tone="red"
        title={t('games.delete.title')}
        path={[t('games.path'), 'suppression']}
        onClose={() => setToDelete(null)}
        closeLabel={t('app.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)} disabled={deleting}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="trash" size={13} />}
              disabled={deleting}
              onClick={() => void confirmDelete()}
              data-testid="game-delete-confirm"
            >
              {t('games.delete.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('games.delete.text', { name: toDelete?.game.name ?? '' })}</p>
        {deleteError ? <p className="hint hint--warn">{deleteError}</p> : null}
      </Dialog>
    </Page>
  );
}
