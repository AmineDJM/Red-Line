import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NationId, ScenarioSummary } from '@redline/shared';
import { Button, Segmented, Select } from '@redline/ui';
import { getApi } from '../api/index.js';
import { ApiError } from '../api/types.js';
import { NationPicker } from '../components/NationPicker.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';
import { ErrorScreen, LoadingScreen } from './Loading.js';

/** Vitesses proposées avant que la partie n'existe (la partie impose ensuite GameMeta.speeds). */
const DEFAULT_SPEEDS = [1, 2, 4, 8];
const LEVELS = ['easy', 'normal', 'hard'] as const;

/** Nouvelle partie solo : réglages et choix de la nation. */
export function NewGameScreen() {
  const { t } = useTranslation();
  const world = useWorld();
  const [speed, setSpeed] = useState(1);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('normal');
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scenarioId, setScenarioId] = useState('world-today');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  useEffect(() => {
    void getApi().then((api) => {
      void world.load(api);
      api
        .scenarios()
        .then((s) => {
          setScenarios(s);
          // Par défaut : le monde actuel (arsenaux 2025), sinon le premier scénario disponible.
          setScenarioId((cur) => (s.some((x) => x.id === cur) ? cur : (s[0]?.id ?? cur)));
        })
        .catch(() => setScenarios([]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (world.status === 'error') return <ErrorScreen message={world.error ?? ''} />;
  if (world.status !== 'ready') return <LoadingScreen />;

  const scenario = scenarios.find((s) => s.id === scenarioId);
  const playable = (id: string) =>
    !scenario || scenario.playableNations === 'all' || scenario.playableNations.includes(id);

  const start = async (nation: NationId) => {
    setBusy(true);
    setError(null);
    try {
      const api = await getApi();
      if (!(await api.me())) await api.guest();
      const game = await api.createGame({
        scenarioId,
        nationId: nation,
        mode: 'solo',
        speed,
        aiLevel: level,
      });
      navigate(`/game/${encodeURIComponent(game.id)}`);
    } catch (e) {
      // Quota de parties solo atteint : message du serveur et accès direct à « Mes parties ».
      if (e instanceof ApiError && e.code === 'too_many_games')
        setError(
          <>
            {e.message !== e.code ? e.message : t('newGame.tooMany')}{' '}
            <Button size="sm" variant="ghost" onClick={() => navigate('/games')}>
              {t('newGame.manageGames')}
            </Button>
          </>,
        );
      else setError(t('newGame.error'));
      setBusy(false);
    }
  };

  return (
    <NationPicker
      path={[t('newGame.path')]}
      title={t('newGame.title')}
      subtitle={scenario?.name ?? t('newGame.subtitle')}
      playable={playable}
      confirmLabel={busy ? t('newGame.creating') : t('newGame.start')}
      busy={busy}
      error={error}
      onBack={() => navigate('/')}
      onConfirm={(n) => void start(n)}
      options={
        <div className="gameopts">
          {scenarios.length > 1 ? (
            <label className="gameopts__row">
              <span>{t('newGame.scenario')}</span>
              <Select
                value={scenarioId}
                onChange={setScenarioId}
                options={scenarios.map((s) => ({ value: s.id, label: s.name }))}
              />
            </label>
          ) : null}
          <div className="gameopts__row">
            <span>{t('newGame.speed')}</span>
            <Segmented
              size="sm"
              label={t('newGame.speed')}
              value={speed}
              onChange={setSpeed}
              options={DEFAULT_SPEEDS.map((s) => ({ value: s, label: `×${s}` }))}
            />
          </div>
          <div className="gameopts__row">
            <span>{t('newGame.difficulty')}</span>
            <Segmented
              size="sm"
              label={t('newGame.difficulty')}
              value={level}
              onChange={setLevel}
              options={LEVELS.map((l) => ({ value: l, label: t(`newGame.levels.${l}`) }))}
            />
          </div>
        </div>
      }
    />
  );
}
