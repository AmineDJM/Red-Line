import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LngLat,
  NationId,
  NationView,
  PlayerView,
  ProvinceView,
  UnitView,
} from '@redline/shared';
import {
  Button,
  Field,
  Icon,
  List,
  ListItem,
  Select,
  UnitMarker,
  Window,
  pictogramFor,
  type WindowRect,
} from '@redline/ui';
import { DEBUG_HOOKS, IS_MOCK } from '../config.js';
import { getApi } from '../api/index.js';
import { GameShell } from '../shell/GameShell.js';
import { useIsMobile } from '../shell/useMedia.js';
import { loadEngine, LocalGameConnection } from '../net/local.js';
import { loadSimulationData } from '../sandbox/simulationData.js';
import { bindConnection, useGame } from '../store/game.js';
import { useUi, windowBounds } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { ErrorScreen, LoadingScreen } from './Loading.js';

/** Vitesses de l'outil de développement (observation accélérée du combat), pas de l'équilibrage. */
const SANDBOX_SPEEDS = [1, 16, 60, 360, 1440];

interface Placement {
  owner: NationId;
  systemId: string;
  pos: [number, number];
  count?: number;
}

/** Vue synthétique avant lancement : les unités placées apparaissent sur la carte. */
function previewView(placements: Placement[], observer: NationId): PlayerView {
  const w = useWorld.getState();
  const nations: Record<string, NationView> = {};
  for (const n of Object.values(w.nations)) {
    nations[n.id] = {
      id: n.id,
      name: n.name,
      color: n.color,
      isAi: false,
      isPlayer: n.id === observer,
      alive: true,
      provinceCount: 0,
    };
  }
  const provinces: Record<string, ProvinceView> = {};
  for (const p of Object.values(w.provinces))
    provinces[p.id] = { id: p.id, owner: p.nationId, capture: null, buildings: p.buildings };
  const units: Record<string, UnitView> = {};
  placements.forEach((p, i) => {
    const id = `ghost${i}`;
    units[id] = {
      id,
      owner: p.owner,
      level: 'own',
      pos: p.pos,
      lastSeen: 0,
      uncertaintyKm: 0,
      systemId: p.systemId,
      count: p.count ?? w.catalog[p.systemId]?.unitSize,
      status: 'idle',
    };
  });
  return {
    time: 0,
    me: observer,
    nations,
    provinces,
    units,
    economy: {
      money: 0,
      resources: { oil: 0, metals: 0, electronics: 0, food: 0 },
      incomePerDay: { money: 0 },
      production: [],
    },
    victory: { provinceShareTarget: 1, leader: null, winner: null },
  };
}

export function SandboxScreen() {
  const { t } = useTranslation();
  const world = useWorld();
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [nation, setNation] = useState<NationId>('');
  const [systemId, setSystemId] = useState('');
  const [placing, setPlacing] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unbind = useRef<(() => void) | null>(null);
  const mobile = useIsMobile();
  const [panel, setPanel] = useState(true);
  const [rect, setRect] = useState<WindowRect>(() => {
    const b = windowBounds();
    return { x: b.right - 372, y: b.top + 12, w: 360, h: Math.min(620, b.bottom - b.top - 24) };
  });

  useEffect(() => {
    if (DEBUG_HOOKS)
      (window as unknown as { __rl?: unknown }).__rl = {
        game: useGame,
        ui: useUi,
        world: useWorld,
      };
    void getApi().then((api) => world.load(api));
    useGame.getState().reset();
    return () => {
      unbind.current?.();
      useGame.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nations = useMemo(
    () => Object.values(world.nations).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [world.nations],
  );
  const systems = useMemo(
    () =>
      Object.values(world.catalog).sort(
        (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      ),
    [world.catalog],
  );

  useEffect(() => {
    if (!nation && nations[0]) setNation(nations.find((n) => n.id === 'fra')?.id ?? nations[0].id);
    if (!systemId && systems[0]) setSystemId(systems[0].id);
  }, [nations, systems, nation, systemId]);

  // Aperçu avant lancement.
  useEffect(() => {
    if (running || world.status !== 'ready' || !nation) return;
    const observer = placements[0]?.owner ?? nation;
    useGame.setState((s) => ({
      view: previewView(placements, observer),
      me: observer,
      meta: {
        id: 'sandbox',
        name: t('sandbox.title'),
        mode: 'solo',
        scenarioId: 'sandbox',
        status: 'lobby',
        speeds: SANDBOX_SPEEDS,
      },
      clock: { anchorGame: 0, anchorReal: Date.now(), speed: 1, paused: true },
      viewVersion: s.viewVersion + 1,
    }));
  }, [placements, running, world.status, nation, t]);

  if (world.status === 'error') return <ErrorScreen message={world.error ?? ''} />;
  if (world.status !== 'ready') return <LoadingScreen />;

  const place = (at: LngLat) => {
    if (running || !nation || !systemId) return;
    setPlacements((p) => [...p, { owner: nation, systemId, pos: [at[0], at[1]] }]);
  };

  const launch = async () => {
    setMessage(t('sandbox.engineLoading'));
    const { engine, missing } = await loadEngine();
    if (!engine) {
      setMessage(t('sandbox.engineMissing', { list: missing.join(', ') }));
      return;
    }
    const sim = await loadSimulationData();
    if (!sim.cells || !sim.balance) {
      setMessage(t('sandbox.dataMissing', { list: sim.missing.join(', ') }));
      return;
    }
    try {
      const w = useWorld.getState();
      const built = engine.buildWorld(
        {
          nations: Object.values(w.nations),
          provinces: Object.values(w.provinces),
          cells: sim.cells,
          straits: sim.straits,
          disputed: sim.disputed,
        },
        Object.values(w.catalog),
        sim.balance,
      );
      const involved = [...new Set(placements.map((p) => p.owner))];
      const observer = involved[0] ?? nation;
      const conn = new LocalGameConnection(
        engine,
        built,
        {
          seed: 1,
          players: involved.map((n) => ({ nationId: n, isAi: false })),
          units: placements,
        },
        { observer, godView: true, name: t('sandbox.title'), speeds: SANDBOX_SPEEDS },
      );
      unbind.current?.();
      unbind.current = bindConnection(conn);
      setRunning(true);
      setPlacing(false);
      setMessage(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const reset = () => {
    unbind.current?.();
    unbind.current = null;
    setRunning(false);
    setPlacing(true);
    useUi.getState().clearSelection();
  };

  return (
    <GameShell
      mode="sandbox"
      fog={false}
      tutorial={false}
      placing={placing && !running}
      onPlace={place}
    >
      {panel ? (
        <Window
          title={t('sandbox.title')}
          path={[t('sandbox.path')]}
          mode={mobile ? 'sheet' : 'floating'}
          rect={rect}
          onRectChange={setRect}
          bounds={windowBounds()}
          minSize={{ w: 300, h: 320 }}
          zIndex={15}
          onClose={() => setPanel(false)}
          closeLabel={t('app.close')}
          className="sandbox-win"
          footer={
            running ? (
              <Button block onClick={reset}>
                {t('sandbox.reset')}
              </Button>
            ) : (
              <>
                <Button disabled={!placements.length} onClick={() => setPlacements([])}>
                  {t('sandbox.clear')}
                </Button>
                <Button
                  variant="primary"
                  block
                  disabled={!placements.length}
                  onClick={() => void launch()}
                >
                  {t('sandbox.launch')}
                </Button>
              </>
            )
          }
        >
          <div className="stack">
            <Field label={t('sandbox.nation')}>
              <Select
                value={nation}
                disabled={running}
                onChange={setNation}
                options={nations.map((n) => ({ value: n.id, label: n.name }))}
              />
            </Field>
            <Field label={t('sandbox.system')}>
              <Select
                value={systemId}
                disabled={running}
                onChange={setSystemId}
                options={systems.map((s) => ({
                  value: s.id,
                  label: `${t(`categories.${s.category}`)} — ${s.name}`,
                }))}
              />
            </Field>
            {!running ? <p className="muted small">{t('sandbox.placeHint')}</p> : null}
            <List>
              {placements.map((p, i) => {
                const s = world.catalog[p.systemId];
                return (
                  <ListItem
                    key={i}
                    leading={<UnitMarker pictogram={pictogramFor(s)} nationId={p.owner} tone="neutral" size="sm" />}
                    title={s?.name ?? p.systemId}
                    subtitle={world.nations[p.owner]?.name}
                  />
                );
              })}
            </List>
            <p className="muted small">{t('sandbox.placed', { count: placements.length })}</p>
            {message ? <p className="error-text">{message}</p> : null}
          </div>
        </Window>
      ) : (
        <button type="button" className="sandbox-reopen" onClick={() => setPanel(true)} data-map-avoid>
          <Icon name="sandbox" size={16} /> {t('sandbox.title')}
        </button>
      )}
    </GameShell>
  );
}
