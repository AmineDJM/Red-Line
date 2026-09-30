import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameStatsView, LngLat, NationId, TimelapseView } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Flag,
  Icon,
  Panel,
  Slider,
  Spinner,
  Stat,
  Table,
  WeaponPhoto,
  formatInt,
  formatMoney,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { drawMiniMap, shapesOf, tint } from '../components/MiniMap.js';
import { Page } from '../components/Page.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { navigate } from '../router.js';
import { useWorld } from '../store/world.js';

/** Chronologie des frontières jour par jour (mini-carte canvas animée). */
function Timelapse({ data, me }: { data: TimelapseView; me: NationId | null }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useWorld((s) => s.provincesGeo);
  const nations = useWorld((s) => s.nations);
  const provinces = useWorld((s) => s.provinces);
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(true);
  const last = data.frames.length - 1;

  // Cadrage : provinces qui ont changé de mains (sinon celles du joueur).
  const frame = useMemo(() => {
    const first = data.frames[0]?.owners ?? {};
    const end = data.frames[last]?.owners ?? {};
    const ids = Object.keys(end).filter((p) => first[p] !== end[p]);
    const pts = (ids.length ? ids : Object.keys(first).filter((p) => first[p] === me))
      .map((p) => provinces[p]?.cityPoint)
      .filter((x): x is LngLat => !!x);
    if (!pts.length) return { center: [10, 30] as LngLat, span: 2500 };
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const dx = (Math.max(...xs) - Math.min(...xs)) * 111 * Math.cos((cy * Math.PI) / 180);
    const dy = (Math.max(...ys) - Math.min(...ys)) * 111 * 1.6;
    const span = Math.max(900, Math.max(dx, dy) * 0.7 + 450);
    return { center: [cx, cy] as LngLat, span };
  }, [data, last, me, provinces]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setDay((d) => (d >= last ? 0 : d + 1)), 450);
    return () => clearInterval(id);
  }, [playing, last]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !geo) return;
    const owners = data.frames[day]?.owners ?? {};
    drawMiniMap(
      c,
      shapesOf(geo),
      (pid) => {
        const o = owners[pid];
        if (!o) return '#151c24';
        return o === me ? '#6b48c8' : tint(nations[o]?.color ?? '#3a4252', 0.5);
      },
      { center: frame.center, spanKm: frame.span },
    );
  }, [day, geo, data, me, nations, frame]);

  const owned = Object.values(data.frames[day]?.owners ?? {}).filter((o) => o === me).length;
  return (
    <div className="timelapse">
      <canvas ref={ref} className="minimap timelapse__canvas" role="img" aria-label={t('endgame.timelapse')} />
      <div className="timelapse__hud">
        <span className="replay__rec">{t('endgame.day', { day })}</span>
        <span>{t('endgame.provincesHeld', { count: owned })}</span>
      </div>
      <div className="replay__controls">
        <button type="button" className="replay__play" onClick={() => setPlaying(!playing)} aria-label={playing ? t('game.clock.pause') : t('game.clock.play')}>
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <Slider value={day} min={0} max={last} onChange={(v) => { setPlaying(false); setDay(v); }} label={t('endgame.day', { day })} format={(v) => `J+${v}`} />
        <span className="muted small">{t('endgame.days', { count: last })}</span>
      </div>
    </div>
  );
}

/** Fin de partie : résultat, chronologie des frontières, statistiques par nation. */
export function EndGameScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const world = useWorld();
  const photos = usePhotos();
  const [stats, setStats] = useState<GameStatsView | null>(null);
  const [lapse, setLapse] = useState<TimelapseView | null>(null);
  const [me, setMe] = useState<NationId | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void getApi().then((api) => {
      void world.load(api);
      Promise.all([api.stats(id), api.timelapse(id), api.game(id).catch(() => null)])
        .then(([s, l, g]) => {
          setStats(s);
          setLapse(l);
          setMe(g?.me ?? null);
        })
        .catch(() => setError(true));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const mine = stats?.nations.find((n) => n.nationId === me);
  const victory = !!stats?.winner && stats.winner === me;
  return (
    <Page
      path={[t('endgame.path'), id]}
      title={t('endgame.title')}
      wide
      actions={
        <>
          <Button variant="subtle" onClick={() => navigate('/')}>
            {t('game.end.home')}
          </Button>
          <Button variant="primary" icon={<Icon name="play" size={11} />} onClick={() => navigate('/new')}>
            {t('game.end.newGame')}
          </Button>
        </>
      }
    >
      {error ? (
        <EmptyState icon="warning" title={t('endgame.error')} />
      ) : !stats || !lapse || world.status !== 'ready' ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="vstack">
          <div className={victory ? 'endbanner endbanner--victory' : 'endbanner endbanner--defeat'}>
            {me ? <Flag nationId={me} size={40} /> : null}
            <div>
              <span className="endbanner__kicker">{me ? world.nations[me]?.name : ''}</span>
              <h2>{victory ? t('game.end.victory') : t('game.end.defeat')}</h2>
              <span className="muted">
                {stats.winner ? t('endgame.winner', { nation: world.nations[stats.winner]?.name ?? stats.winner }) : t('endgame.noWinner')} · {t('endgame.days', { count: stats.durationDays })}
              </span>
            </div>
          </div>
          {mine ? (
            <div className="kpis">
              <Stat label={t('endgame.provinces')} value={`${mine.provincesStart} → ${mine.provincesEnd}`} tone={mine.provincesEnd >= mine.provincesStart ? 'green' : 'red'} />
              <Stat label={t('endgame.conquered')} value={mine.conquered} tone="violet" />
              <Stat label={t('endgame.kills')} value={formatInt(mine.kills)} tone="amber" />
              <Stat label={t('endgame.losses')} value={formatInt(mine.losses)} tone="red" />
              <Stat label={t('endgame.spent')} value={formatMoney(mine.spentUsd)} />
            </div>
          ) : null}
          <div className="endgrid">
            <Panel title={t('endgame.timelapse')}>
              <Timelapse data={lapse} me={me} />
            </Panel>
            {mine?.bestUnits.length ? (
              <Panel title={t('endgame.bestUnits')}>
                <ul className="bestunits">
                  {mine.bestUnits.map((b) => {
                    const s = world.catalog[b.systemId];
                    return (
                      <li key={b.systemId}>
                        {s ? <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="thumb" /> : null}
                        <span>
                          <b>{s?.name ?? b.systemId}</b>
                          <span className="rl-tone-amber">{t('endgame.killsCount', { count: b.kills })}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ) : null}
          </div>
          <Table
            label={t('endgame.table')}
            rows={stats.nations}
            rowKey={(n) => n.nationId}
            defaultSort={{ key: 'end', dir: 'desc' }}
            columns={[
              {
                key: 'n',
                header: t('endgame.cols.nation'),
                render: (n) => (
                  <span className="nat nat--strong">
                    <Flag nationId={n.nationId} size={12} />
                    <span className="nat__name">{world.nations[n.nationId]?.name ?? n.nationId}</span>
                    {n.nationId === stats.winner ? <Icon name="crown" size={13} className="rl-tone-amber" /> : null}
                  </span>
                ),
              },
              { key: 'p', header: t('endgame.cols.player'), render: (n) => n.player ?? <Badge tone="neutral">IA</Badge>, hideOnMobile: true },
              { key: 'end', header: t('endgame.cols.provinces'), align: 'right', render: (n) => `${n.provincesStart} → ${n.provincesEnd}`, sort: (a, b) => a.provincesEnd - b.provincesEnd },
              { key: 'c', header: t('endgame.cols.conquered'), align: 'right', render: (n) => n.conquered, sort: (a, b) => a.conquered - b.conquered },
              { key: 'k', header: t('endgame.cols.kills'), align: 'right', render: (n) => formatInt(n.kills), hideOnMobile: true },
              { key: 'l', header: t('endgame.cols.losses'), align: 'right', render: (n) => formatInt(n.losses), hideOnMobile: true },
              { key: 's', header: t('endgame.cols.spent'), align: 'right', render: (n) => <span className="rl-money">{formatMoney(n.spentUsd)}</span>, hideOnMobile: true },
            ]}
          />
        </div>
      )}
    </Page>
  );
}
