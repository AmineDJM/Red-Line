import { useTranslation } from 'react-i18next';
import { TitleBanner } from '@redline/ui';
import { fmtClock } from '../i18n/index.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { describeNotification, useGameTime } from './helpers.js';
import { Icons } from './icons.js';

/** Bandeau titre + horloge et vitesse (solo). */
export function TopBar({
  title,
  subtitle,
  compact,
}: {
  title: string;
  subtitle: string;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const notifications = useGame((s) => s.notifications);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const focusOn = useUi((s) => s.focusOn);
  const now = useGameTime(1000);

  // Alerte majeure la plus récente (moins de 6 h de jeu).
  const recent = notifications.find((n) => {
    const d = describeNotification(n.item, view, me);
    return d.major && now - n.item.time < 6 * 3_600_000;
  });
  const info = recent ? describeNotification(recent.item, view, me) : null;

  return (
    <TitleBanner
      compact={compact}
      title={title}
      subtitle={subtitle}
      alert={
        info
          ? {
              text: info.text,
              critical: info.critical,
              onClick: info.at ? () => focusOn(info.at!, 5.5) : undefined,
            }
          : null
      }
      right={<ClockControl compact={compact} label={t('game.clock.pause')} />}
    />
  );
}

export function ClockControl({ compact }: { compact: boolean; label?: string }) {
  const { t } = useTranslation();
  const meta = useGame((s) => s.meta);
  const clock = useGame((s) => s.clock);
  const conn = useGame((s) => s.connection);
  const now = useGameTime(500);
  const c = fmtClock(now);
  const solo = meta?.mode === 'solo';
  const paused = !!clock?.paused;
  const speeds = (meta?.speeds ?? []).slice(0, compact ? 4 : 5);

  return (
    <div className={compact ? 'clock clock--compact' : 'clock'} data-map-avoid>
      <div className="clock__time" aria-live="off">
        {compact ? null : <span className="clock__day rl-mono">{c.day}</span>}
        <span className="clock__hm rl-mono">{c.time}</span>
        {paused ? <span className="clock__paused">{t('game.clock.paused')}</span> : null}
      </div>
      {solo ? (
        <div
          className="clock__controls"
          role="group"
          aria-label={t('game.clock.speed', { speed: clock?.speed ?? 1 })}
        >
          <button
            type="button"
            className={paused ? 'clock__btn clock__btn--on' : 'clock__btn'}
            onClick={() => conn?.setPaused(!paused)}
            aria-label={paused ? t('game.clock.play') : t('game.clock.pause')}
            title={paused ? t('game.clock.play') : t('game.clock.pause')}
          >
            {paused ? Icons.play(16) : Icons.pause(16)}
          </button>
          {compact ? (
            <button
              type="button"
              className="clock__btn clock__btn--on rl-mono"
              onClick={() => {
                const all = meta?.speeds ?? [1];
                const i = all.indexOf(clock?.speed ?? 1);
                conn?.setSpeed(all[(i + 1) % all.length] ?? 1);
                if (paused) conn?.setPaused(false);
              }}
              aria-label={t('game.clock.nextSpeed', { speed: clock?.speed ?? 1 })}
              title={t('game.clock.nextSpeed', { speed: clock?.speed ?? 1 })}
            >
              {t('game.clock.speedShort', { speed: clock?.speed ?? 1 })}
            </button>
          ) : null}
          {(compact ? [] : speeds).map((s) => (
            <button
              key={s}
              type="button"
              className={
                !paused && clock?.speed === s
                  ? 'clock__btn clock__btn--on rl-mono'
                  : 'clock__btn rl-mono'
              }
              onClick={() => {
                conn?.setSpeed(s);
                if (paused) conn?.setPaused(false);
              }}
              aria-label={t('game.clock.speed', { speed: s })}
              title={t('game.clock.speed', { speed: s })}
            >
              {t('game.clock.speedShort', { speed: s })}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
