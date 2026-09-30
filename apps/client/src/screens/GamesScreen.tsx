import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MyGame } from '@redline/shared';
import { Badge, Button, EmptyState, Flag, Icon, Spinner, Table } from '@redline/ui';
import { getApi } from '../api/index.js';
import { Page } from '../components/Page.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';

/** Mes parties : reprendre, bilan, spectateur. */
export function GamesScreen() {
  const { t } = useTranslation();
  const nations = useWorld((s) => s.nations);
  const load = useWorld((s) => s.load);
  const [games, setGames] = useState<MyGame[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void getApi().then((api) => {
      void load(api);
      api.myGames().then(setGames).catch(() => setError(true));
    });
  }, [load]);
  return (
    <Page
      path={[t('games.path')]}
      title={t('games.title')}
      subtitle={t('games.subtitle')}
      actions={
        <>
          <Button variant="subtle" icon={<Icon name="users" size={13} />} onClick={() => navigate('/lobby')}>
            {t('home.multi')}
          </Button>
          <Button variant="primary" icon={<Icon name="plus" size={13} />} onClick={() => navigate('/new')}>
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
          rows={games}
          rowKey={(g) => g.game.id}
          empty={<EmptyState icon="refresh" title={t('games.empty')} action={<Button variant="primary" onClick={() => navigate('/new')}>{t('home.continue')}</Button>} />}
          columns={[
            {
              key: 'name',
              header: t('games.cols.game'),
              render: (g) => (
                <span className="lobbyname">
                  <b>{g.game.name}</b>
                  <span>{t(`games.mode.${g.game.mode}`)} · {new Date(g.createdAt).toLocaleDateString('fr-FR')}</span>
                </span>
              ),
            },
            {
              key: 'nation',
              header: t('games.cols.nation'),
              render: (g) => (
                <span className="nat">
                  <Flag nationId={g.nationId} size={12} />
                  <span className="nat__name">{nations[g.nationId]?.name ?? g.nationId.toUpperCase()}</span>
                </span>
              ),
            },
            { key: 'players', header: t('games.cols.players'), align: 'right', hideOnMobile: true, render: (g) => `${g.game.playerCount ?? 1}/${g.game.maxPlayers ?? 1}` },
            {
              key: 'status',
              header: t('games.cols.status'),
              render: (g) => (
                <Badge tone={g.game.status === 'running' ? 'green' : g.game.status === 'ended' ? 'neutral' : 'amber'} dot pulse={g.game.status === 'running'}>
                  {t(`games.status.${g.game.status}`)}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (g) =>
                g.game.status === 'ended' ? (
                  <Button size="sm" variant="subtle" icon={<Icon name="economy" size={12} />} onClick={() => navigate(`/game/${encodeURIComponent(g.game.id)}/end`)}>
                    {t('games.stats')}
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" icon={<Icon name="play" size={11} />} onClick={() => navigate(`/game/${encodeURIComponent(g.game.id)}`)}>
                    {t('games.resume')}
                  </Button>
                ),
            },
          ]}
        />
      )}
    </Page>
  );
}
