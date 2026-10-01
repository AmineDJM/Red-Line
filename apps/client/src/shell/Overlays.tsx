import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { distanceKm, HOUR, type Order } from '@redline/shared';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  Legend,
  ToastStack,
  UnitMarker,
  pictogramFor,
  type LegendItem,
} from '@redline/ui';
import { fmtClock, fmtDuration, fmtKm } from '../i18n/index.js';
import { unitPosition } from '../map/interpolation.js';
import { nationForms } from '../lib/game.js';
import { navigate } from '../router.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { describeNotification, notificationTone } from './helpers.js';

/** Barre de confirmation de l'ordre en attente (troisième geste : confirmer). */
export function OrderBar() {
  const { t } = useTranslation();
  const pending = useUi((s) => s.pendingOrder);
  const setPending = useUi((s) => s.setPending);
  const view = useGame((s) => s.view);
  const conn = useGame((s) => s.connection);
  const catalog = useWorld((s) => s.catalog);

  const confirm = useCallback(async () => {
    const p = useUi.getState().pendingOrder;
    const c = useGame.getState().connection;
    if (!p || !c) return;
    const order: Order =
      p.kind === 'move'
        ? { kind: 'move', unitIds: p.unitIds, to: p.to }
        : { kind: 'attack', unitIds: p.unitIds, targetId: p.targetId };
    useUi.getState().setPending(null);
    const res = await c.sendOrder(order);
    if (res.ok) useUi.getState().toast(t('game.orders.sent'), 'ok');
    else
      useUi
        .getState()
        .toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  }, [t]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !useUi.getState().paletteOpen) {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, confirm]);

  if (!pending || !view || !conn) return null;
  const now = gameNow();
  const units = pending.unitIds.map((id) => view.units[id]).filter((u) => !!u);
  const first = units[0];
  if (!first) return null;
  const from = unitPosition(first, now);
  const targetUnit = pending.kind === 'attack' ? view.units[pending.targetId] : undefined;
  const target =
    pending.kind === 'move' ? pending.to : targetUnit ? unitPosition(targetUnit, now) : null;
  if (!target) return null;
  const dist = distanceKm(from, target);
  const speeds = units
    .map((u) => (u.systemId ? catalog[u.systemId]?.speedKmh : undefined) ?? 0)
    .filter((s) => s > 0);
  const slowest = speeds.length ? Math.min(...speeds) : 0;
  const sys = first.systemId ? catalog[first.systemId] : undefined;
  const outOfRange =
    pending.kind === 'attack' && sys?.movement === 'static' && dist > sys.weaponRangeKm.max;
  const title = t(pending.kind === 'move' ? 'game.orders.moveTitle' : 'game.orders.attackTitle');
  const tsys = targetUnit?.systemId ? catalog[targetUnit.systemId] : undefined;

  return (
    <div
      className="orderbar"
      data-map-avoid
      role="dialog"
      aria-label={title}
      data-testid="order-bar"
    >
      <div className="orderbar__head">
        <span
          className={
            pending.kind === 'attack' ? 'orderbar__kind orderbar__kind--attack' : 'orderbar__kind'
          }
        >
          <Icon name={pending.kind === 'attack' ? 'target' : 'arrowRight'} size={14} />
          {title}
        </span>
        <span className="orderbar__cmd" aria-hidden>
          {pending.kind === 'move'
            ? `move ${units.length > 1 ? `${units.length}×` : first.id} ${target[1].toFixed(2)},${target[0].toFixed(2)}`
            : `attack ${units.length > 1 ? `${units.length}×` : first.id} ${pending.kind === 'attack' ? pending.targetId : ''}`}
        </span>
      </div>
      <div className="orderbar__body">
        <div className="orderbar__units">
          <UnitMarker
            pictogram={pictogramFor(sys)}
            nationId={first.owner}
            count={first.count}
            tone="own"
            size="sm"
          />
          {units.length > 1 ? <Badge tone="cyan">+{units.length - 1}</Badge> : null}
          {pending.kind === 'attack' ? (
            <>
              <Icon name="arrowRight" size={14} className="orderbar__arrow" />
              <UnitMarker
                pictogram={tsys ? pictogramFor(tsys) : 'unknown'}
                nationId={targetUnit?.level === 'detected' ? undefined : targetUnit?.owner}
                tone={targetUnit?.level === 'detected' ? 'unknown' : 'enemy'}
                size="sm"
              />
            </>
          ) : null}
        </div>
        <dl className="orderbar__stats">
          <div>
            <dt>{t('game.orders.distance')}</dt>
            <dd>{fmtKm(dist)}</dd>
          </div>
          {slowest > 0 && pending.kind === 'move' ? (
            <div>
              <dt>{t('game.orders.eta')}</dt>
              <dd>{fmtDuration((dist / slowest) * HOUR)}</dd>
            </div>
          ) : null}
          {outOfRange ? (
            <div className="orderbar__warn">
              <dt>{t('game.orders.warning')}</dt>
              <dd>{t('game.orders.outOfRange')}</dd>
            </div>
          ) : null}
        </dl>
        <div className="orderbar__actions">
          <Button variant="ghost" onClick={() => setPending(null)} kbd="Échap">
            {t('game.orders.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} autoFocus kbd="Entrée">
            {t('game.orders.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Centre d'alertes : panneau latéral droit, notifications cliquables (carte ou fenêtre). */
export function AlertCenter({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const open = useUi((s) => s.alertsOpen);
  const setOpen = useUi((s) => s.setAlertsOpen);
  const focusOn = useUi((s) => s.focusOn);
  const openWindow = useUi((s) => s.openWindow);
  const notifications = useGame((s) => s.notifications);
  const markAllRead = useGame((s) => s.markAllRead);
  const markRead = useGame((s) => s.markRead);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const [filter, setFilter] = useState<'all' | 'critical'>('all');
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(markAllRead, 4000);
    return () => clearTimeout(id);
  }, [open, markAllRead]);
  if (!open) return null;
  // Les alertes identiques consécutives (ex. contacts radar en rafale) sont regroupées : × N.
  const items: {
    n: (typeof notifications)[number];
    d: ReturnType<typeof describeNotification>;
    count: number;
    unread: boolean;
  }[] = [];
  for (const n of notifications) {
    const d = describeNotification(n.item, view, me);
    if (filter === 'critical' && !d.critical) continue;
    const prev = items[items.length - 1];
    if (prev && prev.d.text === d.text && prev.d.icon === d.icon) {
      prev.count++;
      prev.unread ||= !n.read;
    } else items.push({ n, d, count: 1, unread: !n.read });
  }
  return (
    <aside
      className={mobile ? 'alertcenter alertcenter--mobile' : 'alertcenter'}
      aria-label={t('game.alerts.title')}
      data-map-avoid
      data-testid="alert-center"
    >
      <header className="alertcenter__head">
        <Icon name="bell" size={15} />
        <h2>{t('game.alerts.title')}</h2>
        <span className="alertcenter__count">{notifications.length}</span>
        <span className="alertcenter__spacer" />
        <div
          className="alertcenter__filters"
          role="radiogroup"
          aria-label={t('game.alerts.filter')}
        >
          {(['all', 'critical'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={filter === f ? 'on' : ''}
              onClick={() => setFilter(f)}
            >
              {t(`game.alerts.filters.${f}`)}
            </button>
          ))}
        </div>
        <IconButton
          label={t('app.close')}
          icon={<Icon name="close" size={15} />}
          size="sm"
          onClick={() => setOpen(false)}
        />
      </header>
      <div className="alertcenter__body">
        {items.length === 0 ? (
          <EmptyState icon="bell" title={t('game.alerts.empty')} compact />
        ) : (
          <ol className="alertlist">
            {items.map(({ n, d, count, unread }) => {
              const c = fmtClock(n.item.time);
              const tone = notificationTone(d);
              const actionable = !!(d.at || d.open);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`alertitem alertitem--${tone}${unread ? ' alertitem--unread' : ''}`}
                    disabled={!actionable}
                    onClick={() => {
                      markRead(n.id);
                      if (d.open) openWindow(d.open.id, d.open.params);
                      if (d.at) focusOn(d.at, 5.5);
                      if (mobile) setOpen(false);
                    }}
                  >
                    <span className="alertitem__icon">
                      <Icon name={d.icon} size={14} />
                    </span>
                    <span className="alertitem__text">
                      {d.text}
                      {count > 1 ? <span className="alertitem__count">×{count}</span> : null}
                    </span>
                    <span className="alertitem__time">
                      {c.day} {c.time}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <footer className="alertcenter__foot">
        <Button
          size="sm"
          variant="ghost"
          onClick={markAllRead}
          disabled={!notifications.some((n) => !n.read)}
        >
          {t('game.alerts.markRead')}
        </Button>
      </footer>
    </aside>
  );
}

/** Bandeau de la dernière alerte majeure (sous la barre supérieure). */
export function AlertTicker() {
  const notifications = useGame((s) => s.notifications);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const focusOn = useUi((s) => s.focusOn);
  const openWindow = useUi((s) => s.openWindow);
  const now = gameNow();
  const recent = notifications.find((n) => {
    const d = describeNotification(n.item, view, me);
    return d.critical && !n.read && now - n.item.time < 6 * HOUR;
  });
  if (!recent) return null;
  const d = describeNotification(recent.item, view, me);
  return (
    <button
      type="button"
      className="ticker"
      data-map-avoid
      onClick={() => {
        useGame.getState().markRead(recent.id);
        if (d.open) openWindow(d.open.id, d.open.params);
        if (d.at) focusOn(d.at, 5.5);
      }}
    >
      <span className="ticker__tag">
        <span className="ticker__dot" />
        {fmtClock(recent.item.time).time}
      </span>
      <span className="ticker__text">{d.text}</span>
    </button>
  );
}

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <ToastStack
      items={toasts.map((x) => ({ id: x.id, text: x.text, tone: x.tone, action: x.action }))}
      onDismiss={(id) => dismiss(Number(id))}
      dismissLabel={t('app.close')}
    />
  );
}

export function ConnectionBanner() {
  const { t } = useTranslation();
  const status = useGame((s) => s.status);
  const hasView = useGame((s) => !!s.view);
  const notices = useGame((s) => s.notices);
  const dismiss = useGame((s) => s.dismissNotice);
  const conn =
    status === 'open' || status === 'closed'
      ? null
      : status === 'failed'
        ? t('game.failed')
        : status === 'reconnecting' || hasView
          ? t('game.reconnecting')
          : t('game.connecting');
  if (!conn && !notices.length) return null;
  return (
    <div className="banners" data-map-avoid>
      {conn ? (
        <div className={status === 'failed' ? 'banner banner--red' : 'banner'} role="status">
          <span className="banner__bar" aria-hidden />
          {conn}
        </div>
      ) : null}
      {notices.map((n) => (
        <div
          key={n.id}
          className={n.level === 'warn' ? 'banner banner--amber' : 'banner'}
          role="status"
        >
          <Icon name={n.level === 'warn' ? 'warning' : 'info'} size={14} />
          <span className="banner__text">{n.text}</span>
          <button
            type="button"
            className="banner__close"
            onClick={() => dismiss(n.id)}
            aria-label={t('app.close')}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Légende de la carte (bas droite), repliable. */
export function LegendPanel({ fog }: { fog: boolean }) {
  const { t } = useTranslation();
  const open = useUi((s) => s.legendOpen);
  const setOpen = useUi((s) => s.setLegendOpen);
  if (!open) return null;
  const items: LegendItem[] = [
    { kind: 'unit', label: t('game.legend.ownForces'), pictogram: 'tank', tone: 'own' },
    { kind: 'unit', label: t('game.legend.allyForces'), pictogram: 'fighter', tone: 'ally' },
    { kind: 'unit', label: t('game.legend.neutralForces'), pictogram: 'ship', tone: 'neutral' },
    { kind: 'unit', label: t('game.legend.enemyForces'), pictogram: 'ifv', tone: 'enemy' },
    { kind: 'unit', label: t('game.legend.detected'), pictogram: 'unknown', tone: 'unknown' },
    {
      kind: 'swatch',
      label: t('game.legend.ownTerritory'),
      color: 'rgba(155, 107, 255, 0.7)',
      glow: true,
    },
    { kind: 'ring', label: t('game.legend.range'), color: '#ffb020' },
    { kind: 'line', label: t('game.legend.route'), color: '#ffb020', arrow: true, dashed: true },
    { kind: 'line', label: t('game.legend.border'), color: '#d6dde6', width: 1.4 },
    { kind: 'line', label: t('game.legend.capture'), color: '#ff4d5e', dashed: true, width: 2 },
    { kind: 'hatch', label: t('game.legend.disputed'), color: '#ffb020' },
    ...(fog ? [{ kind: 'hatch' as const, label: t('game.legend.fog'), color: '#56626f' }] : []),
  ];
  return (
    <div className="legend-wrap" data-map-avoid>
      <button
        type="button"
        className="legend-wrap__close"
        onClick={() => setOpen(false)}
        aria-label={t('app.close')}
        title={t('app.close')}
      >
        <Icon name="close" size={13} />
      </button>
      <Legend title={t('game.legend.title')} items={items} />
    </div>
  );
}

/**
 * Victoire, défaite ou fin pour abandon (partie close faute de joueur, `GameMeta.endReason`) :
 * superposition sobre, lien vers l'écran de fin de partie.
 */
export function EndOverlay() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const meta = useGame((s) => s.meta);
  const [dismissed, setDismissed] = useState(false);
  const winner = view?.victory.winner ?? null;
  const defeated = !!(me && view && view.nations[me] && !view.nations[me]!.alive);
  const abandoned = meta?.status === 'ended' && meta.endReason === 'abandoned';
  if (dismissed || (!winner && !defeated && !abandoned) || !view) return null;
  const victory = !abandoned && winner === me;
  const kind = abandoned ? 'abandoned' : victory ? 'victory' : 'defeat';
  return (
    <div
      className={`endov endov--${kind}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="endov-title"
      data-testid="end-overlay"
    >
      <div className="endov__card">
        <div className="endov__kicker">
          {abandoned ? t('game.end.kickerEnded') : view.nations[me ?? '']?.name}
        </div>
        <h2 className="endov__title" id="endov-title">
          {t(`game.end.${kind}`)}
        </h2>
        <p className="endov__text">
          {abandoned
            ? t('game.end.abandonedText')
            : victory
              ? t('game.end.victoryText')
              : winner
                ? t('game.end.defeatText', nationForms(winner))
                : t('game.end.defeatTextAlone')}
        </p>
        <div className="endov__actions">
          <Button onClick={() => setDismissed(true)}>{t('game.end.observe')}</Button>
          <Button onClick={() => navigate('/')}>{t('game.end.home')}</Button>
          <Button
            variant="primary"
            onClick={() => navigate(`/game/${encodeURIComponent(meta?.id ?? 'demo')}/end`)}
          >
            {t('game.end.stats')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Aide-mémoire des raccourcis (touche « ? »). */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const rows: [string[], string][] = [
    [['Ctrl', 'K'], t('shortcuts.console')],
    [[':'], t('shortcuts.console')],
    [[t('keys.space')], t('shortcuts.pause')],
    [['1', '…', '5'], t('shortcuts.speed')],
    [['A', 'P', 'R', 'E', 'I'], t('shortcuts.windows')],
    [['Échap'], t('shortcuts.escape')],
    [['Entrée'], t('shortcuts.confirm')],
    [['L'], t('shortcuts.legend')],
    [['N'], t('shortcuts.news')],
    [['?'], t('shortcuts.help')],
  ];
  return (
    <div className="shortcuts" role="dialog" aria-label={t('shortcuts.title')} data-map-avoid>
      <header>
        <h2>{t('shortcuts.title')}</h2>
        <IconButton
          label={t('app.close')}
          icon={<Icon name="close" size={14} />}
          size="sm"
          onClick={onClose}
        />
      </header>
      <dl>
        {rows.map(([keys, label], i) => (
          <div key={i}>
            <dt>
              {keys.map((k, j) => (
                <Kbd key={j}>{k}</Kbd>
              ))}
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
