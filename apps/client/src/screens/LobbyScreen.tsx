import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LobbyGame, NationId, ScenarioSummary } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Panel,
  ProgressBar,
  Segmented,
  Select,
  Slider,
  Spinner,
  Table,
  Toggle,
  formatPct,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { NationPicker } from '../components/NationPicker.js';
import { Page } from '../components/Page.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';
import { ErrorScreen, LoadingScreen } from './Loading.js';

function policyTone(mode: string) {
  return mode === 'disabled' ? 'green' : mode === 'limited' ? 'amber' : 'neutral';
}

/** Lobby multijoueur : parties ouvertes, création, reprise, spectateur. */
export function LobbyScreen() {
  const { t } = useTranslation();
  const [games, setGames] = useState<LobbyGame[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  useEffect(() => {
    void getApi()
      .then((api) => api.lobby())
      .then(setGames)
      .catch(() => setError(true));
  }, []);
  const list = (games ?? []).filter(
    (g) => filter === 'all' || (g.game.playerCount ?? 0) < (g.game.maxPlayers ?? 64),
  );
  return (
    <Page
      path={[t('lobby.path')]}
      title={t('lobby.title')}
      subtitle={t('lobby.subtitle')}
      actions={
        <>
          <Button
            variant="subtle"
            icon={<Icon name="refresh" size={13} />}
            onClick={() => navigate('/games')}
          >
            {t('home.resume')}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => navigate('/lobby/new')}
            data-testid="lobby-create"
          >
            {t('lobby.create')}
          </Button>
        </>
      }
    >
      <div className="row row--between">
        <Segmented
          size="sm"
          label={t('lobby.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: t('lobby.openOnly') },
            { value: 'all', label: t('app.all') },
          ]}
        />
        <span className="muted small">{t('lobby.aiNote')}</span>
      </div>
      {error ? (
        <EmptyState icon="warning" title={t('lobby.error')} />
      ) : !games ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <Table
          label={t('lobby.title')}
          rows={list}
          rowKey={(g) => g.game.id}
          empty={<EmptyState icon="users" title={t('lobby.empty')} />}
          columns={[
            {
              key: 'name',
              header: t('lobby.cols.game'),
              render: (g) => (
                <span className="lobbyname">
                  <b>{g.game.name}</b>
                  <span>
                    {g.scenarioName} · {t('lobby.by', { name: g.creator })}
                  </span>
                </span>
              ),
            },
            {
              key: 'players',
              header: t('lobby.cols.players'),
              width: '200px',
              render: (g) => (
                <ProgressBar
                  value={(g.game.playerCount ?? 0) / (g.game.maxPlayers ?? 64)}
                  tone={(g.game.playerCount ?? 0) >= (g.game.maxPlayers ?? 64) ? 'red' : 'cyan'}
                  trailing={`${g.game.playerCount ?? 0}/${g.game.maxPlayers ?? 64}`}
                />
              ),
              sort: (a, b) => (a.game.playerCount ?? 0) - (b.game.playerCount ?? 0),
            },
            {
              key: 'speed',
              header: t('lobby.cols.speed'),
              align: 'right',
              render: (g) => `×${g.speed}`,
              hideOnMobile: true,
            },
            {
              key: 'victory',
              header: t('lobby.cols.victory'),
              hideOnMobile: true,
              render: (g) =>
                g.game.victory ? (
                  <span className="muted small">
                    {formatPct(g.game.victory.provinceShare)}
                    {g.game.victory.allEnemyCapitals ? ` · ${t('lobby.capitals')}` : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'shop',
              header: t('lobby.cols.shop'),
              hideOnMobile: true,
              render: (g) => (
                <Badge tone={policyTone(g.game.shopPolicy?.mode ?? 'open')}>
                  {t(`shop.policies.${g.game.shopPolicy?.mode ?? 'open'}`)}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (g) => (
                <span className="rowactions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="eye" size={12} />}
                    onClick={() => navigate(`/spectate/${encodeURIComponent(g.game.id)}`)}
                  >
                    {t('lobby.spectate')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={(g.game.playerCount ?? 0) >= (g.game.maxPlayers ?? 64)}
                    onClick={() => navigate(`/lobby/${encodeURIComponent(g.game.id)}`)}
                  >
                    {t('lobby.join')}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
    </Page>
  );
}

/** Création d'une partie multijoueur : réglages puis choix de la nation. */
export function LobbyCreateScreen() {
  const { t } = useTranslation();
  const world = useWorld();
  const [step, setStep] = useState<'settings' | 'nation'>('settings');
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [form, setForm] = useState({
    name: t('lobby.defaultName'),
    scenarioId: 'world-today',
    speed: 1,
    maxPlayers: 64,
    provinceShare: 0.6,
    allEnemyCapitals: false,
    shop: 'open' as 'open' | 'limited' | 'disabled',
    cap: 500,
    inactiveAiAfterH: 24,
    private: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getApi().then((api) => {
      void world.load(api);
      api
        .scenarios()
        .then(setScenarios)
        .catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (step === 'nation') {
    if (world.status === 'error') return <ErrorScreen message={world.error ?? ''} />;
    if (world.status !== 'ready') return <LoadingScreen />;
    return (
      <NationPicker
        path={[t('lobby.path'), t('lobby.createPath')]}
        title={t('lobby.pickNation')}
        subtitle={form.name}
        confirmLabel={busy ? t('newGame.creating') : t('lobby.createConfirm')}
        busy={busy}
        error={error}
        onBack={() => setStep('settings')}
        onConfirm={async (nationId: NationId) => {
          setBusy(true);
          setError(null);
          try {
            const api = await getApi();
            if (!(await api.me())) await api.guest();
            const game = await api.createLobby({
              scenarioId: form.scenarioId,
              name: form.name,
              speed: form.speed,
              maxPlayers: form.maxPlayers,
              aiLevel: 'normal',
              nationId,
              victory: {
                provinceShare: form.provinceShare,
                allEnemyCapitals: form.allEnemyCapitals,
              },
              shopPolicy: {
                mode: form.shop,
                ...(form.shop === 'limited' ? { capPerPlayer: form.cap } : {}),
              },
              inactiveAiAfterH: form.inactiveAiAfterH,
              private: form.private,
            });
            navigate(game.status === 'running' ? `/game/${encodeURIComponent(game.id)}` : '/lobby');
          } catch {
            setError(t('lobby.createError'));
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <Page
      path={[t('lobby.path'), t('lobby.createPath')]}
      title={t('lobby.create')}
      subtitle={t('lobby.createSubtitle')}
      back="/lobby"
    >
      <div className="cols2">
        <Panel title={t('lobby.sections.game')}>
          <div className="stack">
            <Field label={t('lobby.name')}>
              <Input
                value={form.name}
                maxLength={60}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field label={t('newGame.scenario')}>
              <Select
                value={form.scenarioId}
                onChange={(v) => set('scenarioId', v)}
                options={(scenarios.length
                  ? scenarios
                  : [{ id: 'world-today', name: t('lobby.worldToday') }]
                ).map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
            <Field label={t('newGame.speed')}>
              <Segmented
                label={t('newGame.speed')}
                value={form.speed}
                onChange={(v) => set('speed', v)}
                options={[1, 2, 4].map((s) => ({ value: s, label: `×${s}` }))}
              />
            </Field>
            <Field label={t('lobby.maxPlayers')} hint={t('lobby.maxPlayersHint')}>
              <Slider
                value={form.maxPlayers}
                onChange={(v) => set('maxPlayers', v)}
                min={2}
                max={64}
                label={t('lobby.maxPlayers')}
                format={(v) => `${v} / 64`}
              />
            </Field>
            <Toggle
              checked={form.private}
              onChange={(v) => set('private', v)}
              label={t('lobby.private')}
              description={t('lobby.privateHint')}
            />
          </div>
        </Panel>
        <div className="vstack">
          <Panel title={t('lobby.sections.victory')}>
            <div className="stack">
              <Field label={t('lobby.provinceShare')}>
                <Slider
                  value={Math.round(form.provinceShare * 100)}
                  onChange={(v) => set('provinceShare', v / 100)}
                  min={30}
                  max={100}
                  step={5}
                  label={t('lobby.provinceShare')}
                  format={(v) => `${v} %`}
                />
              </Field>
              <Toggle
                checked={form.allEnemyCapitals}
                onChange={(v) => set('allEnemyCapitals', v)}
                label={t('lobby.capitalsToggle')}
              />
            </div>
          </Panel>
          <Panel title={t('lobby.sections.rules')}>
            <div className="stack">
              <Field label={t('lobby.shopPolicy')} hint={t('lobby.shopHint')}>
                <Segmented
                  label={t('lobby.shopPolicy')}
                  value={form.shop}
                  onChange={(v) => set('shop', v)}
                  options={(['open', 'limited', 'disabled'] as const).map((m) => ({
                    value: m,
                    label: t(`shop.policies.${m}`),
                  }))}
                />
              </Field>
              {form.shop === 'limited' ? (
                <Field label={t('lobby.cap')}>
                  <Slider
                    value={form.cap}
                    onChange={(v) => set('cap', v)}
                    min={0}
                    max={5000}
                    step={100}
                    label={t('lobby.cap')}
                    format={(v) => String(v)}
                  />
                </Field>
              ) : null}
              <Field label={t('lobby.inactive')}>
                <Slider
                  value={form.inactiveAiAfterH}
                  onChange={(v) => set('inactiveAiAfterH', v)}
                  min={6}
                  max={96}
                  step={6}
                  label={t('lobby.inactive')}
                  format={(v) => `${v} h`}
                />
              </Field>
            </div>
          </Panel>
        </div>
      </div>
      <div className="page__footer">
        <Button variant="ghost" onClick={() => navigate('/lobby')}>
          {t('app.cancel')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={form.name.trim().length < 2}
          icon={<Icon name="flag" size={14} />}
          onClick={() => setStep('nation')}
        >
          {t('lobby.next')}
        </Button>
      </div>
    </Page>
  );
}

/** Rejoindre une partie : choix de la nation (nations prises : pseudo du joueur). */
export function LobbyJoinScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const world = useWorld();
  const [game, setGame] = useState<LobbyGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getApi().then((api) => {
      void world.load(api);
      api
        .lobby()
        .then((l) => setGame(l.find((g) => g.game.id === id) ?? null))
        .catch(() => setError(t('lobby.error')));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const takenBy = useMemo(
    () => game?.takenBy ?? Object.fromEntries((game?.takenNations ?? []).map((n) => [n, '?'])),
    [game],
  );
  if (world.status === 'error') return <ErrorScreen message={world.error ?? ''} />;
  if (world.status !== 'ready' || (!game && !error)) return <LoadingScreen />;
  return (
    <NationPicker
      path={[t('lobby.path'), id]}
      title={t('lobby.join')}
      subtitle={game ? `${game.game.name} · ${game.scenarioName}` : ''}
      takenBy={takenBy}
      headerExtra={
        game ? (
          <span className="picker__players">
            <Icon name="users" size={13} /> {game.game.playerCount ?? 0}/
            {game.game.maxPlayers ?? 64} {t('lobby.humans')} · {t('lobby.aiRest')}
          </span>
        ) : null
      }
      confirmLabel={busy ? t('lobby.joining') : t('lobby.joinConfirm')}
      busy={busy}
      error={error}
      onBack={() => navigate('/lobby')}
      onConfirm={async (nationId) => {
        setBusy(true);
        try {
          const api = await getApi();
          if (!(await api.me())) await api.guest();
          const g = await api.joinLobby(id, nationId);
          navigate(`/game/${encodeURIComponent(g.id)}`);
        } catch {
          setError(t('lobby.joinError'));
          setBusy(false);
        }
      }}
    />
  );
}
