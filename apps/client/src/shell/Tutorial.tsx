import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Kbd, Prompt } from '@redline/ui';
import { STORAGE } from '../config.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';

interface Step {
  id: string;
  /** Élément mis en évidence (sélecteur CSS). */
  target?: string;
  /** Avance automatiquement quand le joueur fait le geste. */
  done?: () => boolean;
}

const STEPS: Step[] = [
  { id: 'welcome' },
  { id: 'select', done: () => useUi.getState().selection.length > 0 },
  { id: 'order', done: () => !!useUi.getState().pendingOrder },
  { id: 'confirm', target: '[data-testid="order-bar"]', done: () => !useUi.getState().pendingOrder },
  {
    id: 'production',
    target: '[data-testid="nav-production"]',
    done: () => useUi.getState().windows.some((w) => w.id === 'production'),
  },
  {
    id: 'research',
    target: '[data-testid="nav-research"], [data-testid="nav-more"]',
    done: () => useUi.getState().windows.some((w) => w.id === 'research'),
  },
  { id: 'console', target: '[data-testid="console-button"]', done: () => useUi.getState().paletteOpen },
  { id: 'time', target: '[data-testid="clock"]' },
  { id: 'alerts', target: '[data-testid="alerts-button"]' },
  { id: 'end' },
];

function useTargetRect(selector: string | undefined) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!selector) return setRect(null);
    const update = () => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (e) => e.getBoundingClientRect().width > 0,
      );
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    const id = setInterval(update, 400);
    return () => clearInterval(id);
  }, [selector]);
  return rect;
}

/** Tutoriel interactif : dix étapes, qui avancent quand le joueur fait le geste demandé. */
export function Tutorial({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const step = useUi((s) => s.tutorialStep);
  const setStep = useUi((s) => s.setTutorialStep);
  const hasView = useGame((s) => !!s.view);
  const [, force] = useState(0);
  const cur = step !== null ? STEPS[step] : undefined;
  const rect = useTargetRect(cur?.target);

  useEffect(() => {
    if (!enabled || !hasView) return;
    let done = false;
    try {
      done = localStorage.getItem(STORAGE.tutorialDone) === '1';
    } catch {
      done = true;
    }
    const forced = new URLSearchParams(window.location.search).get('tutorial') === '1';
    if ((forced || !done) && useUi.getState().tutorialStep === null) setStep(0);
  }, [enabled, hasView, setStep]);

  // Avance automatique : on observe les stores.
  useEffect(() => {
    if (!cur?.done) return;
    const check = () => {
      if (cur.done!()) setStep((step ?? 0) + 1);
      else force((x) => x + 1);
    };
    const u1 = useUi.subscribe(check);
    return () => u1();
  }, [cur, step, setStep]);

  if (step === null || !cur) return null;
  const finish = () => {
    try {
      localStorage.setItem(STORAGE.tutorialDone, '1');
    } catch {
      /* stockage indisponible */
    }
    setStep(null);
  };
  const last = step >= STEPS.length - 1;
  return (
    <>
      {rect ? (
        <div
          className="tuto-ring"
          aria-hidden
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : null}
      <div className="tuto" role="dialog" aria-live="polite" aria-label={t('tutorial.title')} data-map-avoid>
        <div className="tuto__head">
          <Prompt path={[t('tutorial.path'), `${step + 1}-${STEPS.length}`]} />
          <span className="tuto__progress" aria-hidden>
            {STEPS.map((s, i) => (
              <i key={s.id} className={i < step ? 'done' : i === step ? 'on' : ''} />
            ))}
          </span>
        </div>
        <h3 className="tuto__title">{t(`tutorial.steps.${cur.id}.title`)}</h3>
        <p className="tuto__text">
          {t(`tutorial.steps.${cur.id}.text`)}
          {cur.id === 'console' ? (
            <>
              {' '}
              <Kbd keys={['Ctrl', 'K']} />
            </>
          ) : null}
        </p>
        {cur.done ? <p className="tuto__wait">{t('tutorial.waiting')}</p> : null}
        <div className="tuto__actions">
          <Button variant="ghost" size="sm" onClick={finish}>
            {t('tutorial.skip')}
          </Button>
          {step > 0 ? (
            <Button size="sm" onClick={() => setStep(step - 1)}>
              {t('app.previous')}
            </Button>
          ) : null}
          <Button variant="primary" size="sm" onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? t('app.done') : cur.done ? t('tutorial.skipStep') : t('app.next')}
          </Button>
        </div>
      </div>
    </>
  );
}
