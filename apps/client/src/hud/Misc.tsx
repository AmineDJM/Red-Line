import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '@redline/ui';
import { STORAGE } from '../config.js';
import { navigate } from '../router.js';
import { useGame } from '../store/game.js';
import { useUi, type DrawerId } from '../store/ui.js';
import { Icons } from './icons.js';

/** Barre d'outils : colonne à gauche sur ordinateur, rangée en bas sur mobile. */
export function Toolbar({ mobile, extra }: { mobile: boolean; extra?: { id: Exclude<DrawerId, null>; label: string; icon: React.ReactNode }[] }) {
  const { t } = useTranslation();
  const drawer = useUi((s) => s.drawer);
  const toggle = useUi((s) => s.toggleDrawer);
  const legendOpen = useUi((s) => s.legendOpen);
  const setLegend = useUi((s) => s.setLegendOpen);
  const notifications = useGame((s) => s.notifications);
  const unread = notifications.filter((n) => !n.read).length;
  const markAllRead = useGame((s) => s.markAllRead);
  const items: { id: Exclude<DrawerId, null>; label: string; icon: React.ReactNode; badge?: number }[] = [
    ...(extra ?? []),
    { id: 'army', label: t('game.toolbar.army'), icon: Icons.army() },
    { id: 'production', label: t('game.toolbar.production'), icon: Icons.factory() },
    { id: 'alerts', label: t('game.toolbar.alerts'), icon: Icons.bell(), badge: unread },
    { id: 'layers', label: t('game.toolbar.layers'), icon: Icons.layers() },
  ];
  return (
    <nav className={mobile ? 'toolbar toolbar--bottom' : 'toolbar toolbar--side'} data-map-avoid aria-label={t('game.toolbar.menu')}>
      {items.map((it) => (
        <IconButton
          key={it.id}
          label={it.label}
          icon={it.icon}
          badge={it.badge && it.badge > 99 ? '99+' : it.badge}
          active={drawer === it.id}
          showLabel={mobile}
          onClick={() => {
            toggle(it.id);
            if (it.id === 'alerts' && drawer !== 'alerts') setTimeout(markAllRead, 2500);
          }}
        />
      ))}
      <IconButton label={t('game.toolbar.legend')} icon={Icons.legend()} active={legendOpen} showLabel={mobile} onClick={() => setLegend(!legendOpen)} />
    </nav>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function ConnectionBanner() {
  const { t } = useTranslation();
  const status = useGame((s) => s.status);
  const hasView = useGame((s) => !!s.view);
  if (status === 'open' || status === 'closed') return null;
  const text = status === 'failed' ? t('game.failed') : status === 'reconnecting' ? t('game.reconnecting') : hasView ? t('game.reconnecting') : t('game.connecting');
  return (
    <div className={status === 'failed' ? 'conn-banner conn-banner--failed' : 'conn-banner'} role="status">
      {text}
    </div>
  );
}

/** Tutoriel très court (4 bulles) à la première partie. */
export function Tutorial({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const step = useUi((s) => s.tutorialStep);
  const setStep = useUi((s) => s.setTutorialStep);
  const selection = useUi((s) => s.selection);
  const pending = useUi((s) => s.pendingOrder);
  const hasView = useGame((s) => !!s.view);

  useEffect(() => {
    if (!enabled || !hasView) return;
    let done = false;
    try {
      done = localStorage.getItem(STORAGE.tutorialDone) === '1';
    } catch {
      done = true;
    }
    if (!done && useUi.getState().tutorialStep === null) setStep(0);
  }, [enabled, hasView, setStep]);

  // Avance automatiquement quand le joueur fait le geste demandé.
  useEffect(() => {
    if (step === 0 && selection.length) setStep(1);
  }, [step, selection, setStep]);
  useEffect(() => {
    if (step === 1 && pending) setStep(2);
  }, [step, pending, setStep]);

  if (step === null) return null;
  const total = 4;
  const finish = () => {
    try {
      localStorage.setItem(STORAGE.tutorialDone, '1');
    } catch {
      /* stockage indisponible */
    }
    setStep(null);
  };
  return (
    <div className={`tutorial tutorial--step${step}`} role="dialog" aria-live="polite" data-map-avoid>
      <div className="tutorial__count rl-mono">{t('game.tutorial.counter', { index: step + 1, total })}</div>
      <p className="tutorial__text">{t(`game.tutorial.step${step + 1}`)}</p>
      <div className="tutorial__actions">
        <Button variant="ghost" onClick={finish}>
          {t('app.skip')}
        </Button>
        <Button variant="primary" onClick={() => (step + 1 >= total ? finish() : setStep(step + 1))}>
          {step + 1 >= total ? t('app.done') : t('app.next')}
        </Button>
      </div>
    </div>
  );
}

/** Écran de victoire ou de défaite. */
export function EndScreen() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const [dismissed, setDismissed] = useState(false);
  const winner = view?.victory.winner ?? null;
  const defeated = !!(me && view && view.nations[me] && !view.nations[me]!.alive);
  if (dismissed || (!winner && !defeated) || !view) return null;
  const victory = winner === me;
  const winnerName = winner ? (view.nations[winner]?.name ?? winner) : '';
  return (
    <div className={victory ? 'end end--victory' : 'end end--defeat'} role="dialog" aria-modal="true">
      <div className="end__card">
        <div className="end__kicker">{view.nations[me ?? '']?.name}</div>
        <h2 className="end__title">{victory ? t('game.end.victory') : t('game.end.defeat')}</h2>
        <p className="end__text">{victory ? t('game.end.victoryText', { nation: winnerName }) : t('game.end.defeatText', { nation: winnerName || '—' })}</p>
        <div className="end__actions">
          <Button onClick={() => setDismissed(true)}>{t('game.end.observe')}</Button>
          <Button onClick={() => navigate('/')}>{t('game.end.home')}</Button>
          <Button variant="primary" onClick={() => navigate('/new')}>
            {t('game.end.newGame')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Raccourcis clavier (ordinateur) : Espace = pause, 1 à 4 = vitesses, Échap = désélection. */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { connection, clock, meta } = useGame.getState();
      const ui = useUi.getState();
      if (e.key === ' ' || e.code === 'Space') {
        if (meta?.mode !== 'solo' || !connection) return;
        e.preventDefault();
        connection.setPaused(!clock?.paused);
      } else if (/^[1-4]$/.test(e.key)) {
        const s = meta?.speeds[Number(e.key) - 1];
        if (meta?.mode !== 'solo' || !connection || s === undefined) return;
        connection.setSpeed(s);
        if (clock?.paused) connection.setPaused(false);
      } else if (e.key === 'Escape') {
        if (ui.pendingOrder) ui.setPending(null);
        else if (ui.drawer) ui.openDrawer(null);
        else ui.clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
