import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NationId, ScenarioSummary } from '@redline/shared';
import { Button, HexIcon, TitleBanner } from '@redline/ui';
import { getApi } from '../api/index.js';
import { MapView } from '../map/MapView.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';
import { Icons } from '../hud/icons.js';
import { useIsMobile } from '../hud/useMedia.js';
import { ErrorScreen, LoadingScreen } from './Loading.js';

/** Vitesses proposées avant que la partie n'existe (la partie impose ensuite GameMeta.speeds). */
const DEFAULT_SPEEDS = [1, 2, 4, 8];
const LEVELS = ['easy', 'normal', 'hard'] as const;

export function NewGameScreen() {
  const { t } = useTranslation();
  const world = useWorld();
  const mobile = useIsMobile();
  const [query, setQuery] = useState('');
  const [nation, setNation] = useState<NationId | null>(null);
  const [speed, setSpeed] = useState(1);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('normal');
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scenarioId, setScenarioId] = useState('world-today');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getApi().then((api) => {
      void world.load(api);
      api
        .scenarios()
        .then((s) => {
          setScenarios(s);
          if (s[0]) setScenarioId(s[0].id);
        })
        .catch(() => setScenarios([]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Object.values(world.provinces)) m.set(p.nationId, (m.get(p.nationId) ?? 0) + 1);
    return m;
  }, [world.provinces]);

  const scenario = scenarios.find((s) => s.id === scenarioId);
  const playable = (id: string) => !scenario || scenario.playableNations === 'all' || scenario.playableNations.includes(id);
  const list = useMemo(() => {
    const q = query
      .trim()
      .toLocaleLowerCase('fr')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    return Object.values(world.nations)
      .filter((n) => playable(n.id) && (counts.get(n.id) ?? 0) > 0)
      .filter((n) => !q || n.name.toLocaleLowerCase('fr').normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(q) || n.id.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.nations, query, counts, scenario]);

  if (world.status === 'error') return <ErrorScreen message={world.error ?? ''} />;
  if (world.status !== 'ready') return <LoadingScreen />;

  const start = async () => {
    if (!nation) return;
    setBusy(true);
    setError(null);
    try {
      const api = await getApi();
      if (!(await api.me())) await api.guest();
      const game = await api.createGame({ scenarioId, nationId: nation, mode: 'solo', speed, aiLevel: level });
      navigate(`/game/${encodeURIComponent(game.id)}`);
    } catch {
      setError(t('newGame.error'));
      setBusy(false);
    }
  };

  const picked = nation ? world.nations[nation] : null;

  return (
    <div className={mobile ? 'newgame newgame--mobile' : 'newgame'}>
      <div className="newgame__map">
        <MapView mode="picker" pickedNation={nation} onPickNation={setNation} />
      </div>
      <div className="newgame__top">
        <TitleBanner compact={mobile} title={t('newGame.title')} subtitle={t('newGame.subtitle')} right={<Button variant="ghost" onClick={() => navigate('/')}>{t('app.back')}</Button>} />
      </div>
      <aside className="newgame__panel">
        <div className="newgame__search">
          <span className="newgame__search-icon">{Icons.search(18)}</span>
          <input
            className="input"
            type="search"
            placeholder={t('newGame.searchPlaceholder')}
            aria-label={t('app.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p className="muted small">{t('newGame.pickOnMap')}</p>
        <ul className="nation-list" role="listbox" aria-label={t('newGame.nation')}>
          {list.map((n) => (
            <li key={n.id}>
              <button type="button" role="option" aria-selected={nation === n.id} className={nation === n.id ? 'nation-row nation-row--sel' : 'nation-row'} onClick={() => setNation(n.id)}>
                <HexIcon color={nation === n.id ? 'var(--rl-violet)' : n.color} size={24} />
                <span className="nation-row__name">{n.name}</span>
                <span className="nation-row__sub rl-mono">{t('newGame.provinces', { count: counts.get(n.id) ?? 0 })}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="newgame__options">
          <div className="newgame__picked">
            <span className="field__label">{t('newGame.selected')}</span>
            <strong>{picked?.name ?? t('newGame.none')}</strong>
          </div>
          {scenarios.length > 1 ? (
            <label className="field">
              <span className="field__label">{t('newGame.scenario')}</span>
              <select className="select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="field">
            <span className="field__label">{t('newGame.speed')}</span>
            <div className="seg" role="radiogroup" aria-label={t('newGame.speed')}>
              {DEFAULT_SPEEDS.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={speed === s} className={speed === s ? 'seg__btn seg__btn--on rl-mono' : 'seg__btn rl-mono'} onClick={() => setSpeed(s)}>
                  {t('game.clock.speedShort', { speed: s })}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field__label">{t('newGame.difficulty')}</span>
            <div className="seg" role="radiogroup" aria-label={t('newGame.difficulty')}>
              {LEVELS.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? 'seg__btn seg__btn--on' : 'seg__btn'} onClick={() => setLevel(l)}>
                  {t(`newGame.levels.${l}`)}
                </button>
              ))}
            </div>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <Button variant="primary" size="lg" block disabled={!nation || busy} onClick={() => void start()}>
            {busy ? t('newGame.creating') : t('newGame.start')}
          </Button>
        </div>
      </aside>
    </div>
  );
}
