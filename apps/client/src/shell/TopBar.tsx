import { useTranslation } from 'react-i18next';
import { RESOURCES, type AlertLevel, type Resource } from '@redline/shared';
import {
  Flag,
  Icon,
  IconButton,
  Kbd,
  formatCompact,
  formatMoney,
  type IconName,
} from '@redline/ui';
import { fmtClock } from '../i18n/index.js';
import { netPerDay, resourceFlows } from '../lib/economy.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useGameTime } from './helpers.js';

export const RESOURCE_ICON: Record<Resource, IconName> = {
  oil: 'oil',
  metals: 'metals',
  electronics: 'electronics',
  food: 'food',
};

/** Logo compact : trait rouge + nom du jeu. */
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className={compact ? 'logo logo--compact' : 'logo'} aria-label="Red Line">
      <span className="logo__mark" aria-hidden />
      {compact ? null : (
        <span className="logo__text" aria-hidden>
          RED<b>LINE</b>
        </span>
      )}
    </span>
  );
}

/** Niveau d'alerte mondial : 5 cellules, 5 = calme (vert) → 1 = crise (rouge). */
export function AlertLevelPill({ level, compact }: { level: AlertLevel; compact?: boolean }) {
  const { t } = useTranslation();
  const tone = level <= 1 ? 'red' : level === 2 ? 'red' : level === 3 ? 'amber' : 'green';
  return (
    <span
      className={`alertlvl alertlvl--${tone}${compact ? ' alertlvl--compact' : ''}`}
      title={t('game.alertLevel.tooltip', { level, label: t(`game.alertLevel.labels.${level}`) })}
    >
      <span className="alertlvl__label">
        {compact ? t('game.alertLevel.short') : t('game.alertLevel.title')}
      </span>
      <span className="alertlvl__cells" aria-hidden>
        {[5, 4, 3, 2, 1].map((l) => (
          <i key={l} className={l >= level ? 'on' : ''} />
        ))}
      </span>
      <span className="alertlvl__value">{level}</span>
    </span>
  );
}

function ClockControl({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const meta = useGame((s) => s.meta);
  const clock = useGame((s) => s.clock);
  const conn = useGame((s) => s.connection);
  const view = useGame((s) => s.view);
  const now = useGameTime(500);
  const c = fmtClock(now);
  const controllable = meta?.mode === 'solo' && !view?.spectator;
  const paused = !!clock?.paused;
  const speeds = (meta?.speeds ?? []).slice(0, 5);
  const speed = clock?.speed ?? 1;
  return (
    <div className="clock" data-testid="clock">
      <span className="clock__time" aria-live="off">
        <span className="clock__day">{c.day}</span>
        <span className="clock__hm">{c.time}</span>
        {paused ? <span className="clock__paused">{t('game.clock.paused')}</span> : null}
      </span>
      {controllable ? (
        <span className="clock__ctl" role="group" aria-label={t('game.clock.speed', { speed })}>
          <button
            type="button"
            className={paused ? 'clock__btn clock__btn--on' : 'clock__btn'}
            onClick={() => conn?.setPaused(!paused)}
            aria-label={paused ? t('game.clock.play') : t('game.clock.pause')}
            title={`${paused ? t('game.clock.play') : t('game.clock.pause')} · ${t('keys.space')}`}
          >
            <Icon name={paused ? 'play' : 'pause'} size={13} />
          </button>
          {compact ? (
            <button
              type="button"
              className="clock__btn clock__btn--speed clock__btn--on"
              onClick={() => {
                const all = meta?.speeds ?? [1];
                const i = all.indexOf(speed);
                conn?.setSpeed(all[(i + 1) % all.length] ?? 1);
                if (paused) conn?.setPaused(false);
              }}
              aria-label={t('game.clock.nextSpeed', { speed })}
            >
              ×{speed}
            </button>
          ) : (
            speeds.map((s, i) => (
              <button
                key={s}
                type="button"
                className={!paused && speed === s ? 'clock__btn clock__btn--on' : 'clock__btn'}
                onClick={() => {
                  conn?.setSpeed(s);
                  if (paused) conn?.setPaused(false);
                }}
                aria-label={t('game.clock.speed', { speed: s })}
                title={`${t('game.clock.speed', { speed: s })} · ${i + 1}`}
              >
                ×{s}
              </button>
            ))
          )}
        </span>
      ) : (
        <span className="clock__rate">×{speed}</span>
      )}
    </div>
  );
}

function Budget({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const openWindow = useUi((s) => s.openWindow);
  const eco = view?.economy;
  if (!eco) return null;
  const net = netPerDay(view);
  // Mode illimité : « ∞ », sans solde journalier ni alerte de déficit.
  if (eco.unlimited)
    return (
      <button
        type="button"
        className="topstat topstat--money topstat--inf"
        onClick={() => openWindow('economy')}
        title={t('game.unlimited.budgetTip')}
        data-testid="treasury"
      >
        <span className="topstat__label">{t('game.topbar.treasury')}</span>
        <span className="topstat__value">{t('game.unlimited.value')}</span>
      </button>
    );
  return (
    <button
      type="button"
      className="topstat topstat--money"
      onClick={() => openWindow('economy')}
      title={t('game.topbar.budgetTip')}
      data-testid="treasury"
    >
      <span className="topstat__label">{t('game.topbar.treasury')}</span>
      <span className="topstat__value">{formatMoney(eco.money)}</span>
      {!compact ? (
        <span className={net < 0 ? 'topstat__delta topstat__delta--neg' : 'topstat__delta'}>
          {formatMoney(net, { signed: true })}
          <span className="topstat__unit">{t('game.topbar.perDay')}</span>
        </span>
      ) : null}
    </button>
  );
}

function Resources() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const openWindow = useUi((s) => s.openWindow);
  if (!view) return null;
  const flows = resourceFlows(view);
  const unlimited = !!view.economy.unlimited;
  return (
    <div className="topres" role="group" aria-label={t('game.topbar.resources')}>
      {RESOURCES.map((r) => {
        const f = flows[r];
        const net = f.net;
        if (unlimited)
          return (
            <button
              key={r}
              type="button"
              className="topres__item topres__item--inf"
              onClick={() => openWindow('economy', { tab: 'resources' })}
              title={t('game.unlimited.stockTip', { name: t(`game.resources.${r}`) })}
            >
              <Icon name={RESOURCE_ICON[r]} size={14} />
              <span className="topres__value">{t('game.unlimited.value')}</span>
            </button>
          );
        return (
          <button
            key={r}
            type="button"
            className={f.shortage ? 'topres__item topres__item--short' : 'topres__item'}
            onClick={() => openWindow('economy', { tab: 'resources' })}
            title={t('game.topbar.resourceTip', {
              name: t(`game.resources.${r}`),
              stock: formatCompact(f.stock),
              net: `${net >= 0 ? '+' : '−'}${formatCompact(Math.abs(net))}`,
            })}
          >
            <Icon name={RESOURCE_ICON[r]} size={14} />
            <span className="topres__value">{formatCompact(f.stock)}</span>
            <span
              className={net < 0 ? 'topres__trend topres__trend--down' : 'topres__trend'}
              aria-hidden
            >
              {net < 0 ? '▼' : '▲'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Badge discret du mode illimité (compte administrateur). */
function UnlimitedBadge() {
  const { t } = useTranslation();
  return (
    <span className="topbar__unl" title={t('game.unlimited.tip')} data-testid="unlimited-badge">
      {t('game.unlimited.badge')}
    </span>
  );
}

/** Barre supérieure : nation, horloge et vitesse, trésorerie, ressources, alerte, outils. */
export function TopBar({ mobile, onExit }: { mobile: boolean; onExit: () => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const notifications = useGame((s) => s.notifications);
  const chat = useGame((s) => s.chat);
  const chatRead = useGame((s) => s.chatRead);
  const alertsOpen = useUi((s) => s.alertsOpen);
  const setAlertsOpen = useUi((s) => s.setAlertsOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const toggleWindow = useUi((s) => s.toggleWindow);
  const windows = useUi((s) => s.windows);
  const unread = notifications.filter((n) => !n.read).length;
  const critical = notifications.some(
    (n) => !n.read && n.item.kind === 'generic' && n.item.severity === 'critical',
  );
  const unreadChat = chat.filter(
    (m) => m.from.nationId !== me && m.id > (chatRead[m.channel] ?? 0),
  ).length;
  const nation = me ? view?.nations[me] : null;
  const alliance = view?.diplomacy?.alliances.find((a) => a.id === view.diplomacy?.myAllianceId);
  const level = view?.alertLevel;
  // Centre de commandement : demandes des généraux en attente (autorisation, renforts).
  const requests = view?.command?.armies.filter((a) => !!a.request).length ?? 0;
  const command = !view?.spectator ? (
    <IconButton
      label={t('sections.command')}
      icon={<Icon name="star" size={mobile ? 18 : 17} />}
      badge={requests}
      badgeTone="amber"
      active={windows.some((w) => w.id === 'command')}
      onClick={() => toggleWindow('command')}
      data-testid="command-button"
    />
  ) : null;

  const bell = (
    <IconButton
      label={t('game.toolbar.alerts')}
      icon={<Icon name="bell" size={18} />}
      badge={unread > 99 ? '99+' : unread}
      badgeTone={critical ? 'red' : 'cyan'}
      active={alertsOpen}
      onClick={() => setAlertsOpen(!alertsOpen)}
      data-testid="alerts-button"
    />
  );

  if (mobile)
    return (
      <header className="topbar topbar--mobile" data-map-avoid>
        <div className="topbar__row">
          <span className="topbar__nation">
            {me ? <Flag nationId={me} size={14} title={nation?.name} /> : null}
            <span className="topbar__nation-name">{nation?.name ?? t('app.name')}</span>
            {view?.economy.unlimited ? <UnlimitedBadge /> : null}
            {view?.spectator ? <span className="topbar__spect">{t('game.spectator')}</span> : null}
          </span>
          <ClockControl compact />
          {command}
          {bell}
        </div>
        <div className="topbar__row topbar__row--sub">
          {!view?.spectator ? <Budget compact /> : null}
          {level ? <AlertLevelPill level={level} compact /> : null}
          {!view?.spectator ? <Resources /> : null}
        </div>
      </header>
    );

  return (
    <header className="topbar" data-map-avoid>
      <Logo />
      <span className="topbar__sep" aria-hidden />
      <span className="topbar__nation">
        {me ? <Flag nationId={me} size={16} title={nation?.name} /> : null}
        <span className="topbar__nation-name">{nation?.name ?? t('app.name')}</span>
        {view?.economy.unlimited ? <UnlimitedBadge /> : null}
        {alliance ? (
          <span className="topbar__alliance" title={alliance.name}>
            [{alliance.flag}]
          </span>
        ) : null}
        {view?.spectator ? <span className="topbar__spect">{t('game.spectator')}</span> : null}
      </span>
      <span className="topbar__sep" aria-hidden />
      <ClockControl compact={false} />
      <span className="topbar__sep" aria-hidden />
      {!view?.spectator ? (
        <>
          <Budget compact={false} />
          <Resources />
        </>
      ) : null}
      <span className="topbar__spacer" />
      {level ? <AlertLevelPill level={level} /> : null}
      <button
        type="button"
        className="topbar__console"
        onClick={() => setPaletteOpen(true)}
        data-testid="console-button"
      >
        <Icon name="terminal" size={14} />
        <span>{t('console.open')}</span>
        <Kbd keys={['Ctrl', 'K']} />
      </button>
      {command}
      <IconButton
        label={t('sections.chat')}
        icon={<Icon name="chat" size={18} />}
        badge={unreadChat}
        onClick={() => toggleWindow('chat')}
      />
      {bell}
      <IconButton label={t('game.exit')} icon={<Icon name="logout" size={17} />} onClick={onExit} />
    </header>
  );
}
