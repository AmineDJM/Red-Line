import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { UnitView } from '@redline/shared';
import { Icon, Kbd, type IconName } from '@redline/ui';
import { directOrder, unitActions, type UnitAction } from '../lib/unitActions.js';
import { orderError, orderOk } from '../lib/loc.js';
import { useGame } from '../store/game.js';
import { useUi, type TargetingAction } from '../store/ui.js';
import { useWorld } from '../store/world.js';

/**
 * Barre d'ordres de la sélection : Déplacer, Attaquer, Frapper, Intercepter, Patrouiller,
 * Reconnaissance, Blocus, Retour / Ravitailler, Arrêter. Seules les actions valides sont actives ; les
 * autres restent visibles, grisées, avec la raison en info-bulle. Raccourcis clavier (lettre affichée)
 * quand une sélection existe ; les actions ciblées passent en mode ciblage (curseur en croix, bandeau
 * d'aide, Échap pour annuler), puis la barre de confirmation (aperçu, distance, portée).
 */

/** Gestionnaire de raccourcis des actions (appelé par shell/shortcuts.ts avant les fenêtres). */
let keyHandler: ((key: string) => boolean) | null = null;
export function unitActionKey(key: string): boolean {
  return keyHandler?.(key) ?? false;
}

export function useRunAction(onTarget?: () => void) {
  const { t } = useTranslation();
  return async (a: UnitAction) => {
    const ui = useUi.getState();
    if (!a.enabled) {
      if (a.reason) ui.toast(t(`game.actions.reasons.${a.reason}`), 'warn');
      return;
    }
    const order = directOrder(a);
    if (order) {
      const res = await useGame.getState().connection?.sendOrder(order);
      if (res?.ok) ui.toast(orderOk(res), res.reason === 'partial' ? 'warn' : 'ok');
      else if (res) ui.toast(orderError(res), 'error');
      return;
    }
    // Depuis une fenêtre : sélection et carte d'abord (la sélection annule un ciblage en cours).
    onTarget?.();
    useUi.getState().setTargeting({ action: a.id as TargetingAction, unitIds: a.unitIds });
  };
}

export function UnitOrders({
  units,
  compact,
  keys = true,
  onTarget,
}: {
  units: UnitView[];
  compact: boolean;
  /** Raccourcis clavier actifs (un seul jeu à la fois : celui du panneau de sélection). */
  keys?: boolean;
  /** Avant le ciblage sur la carte (fenêtre « Mes armées » : sélection, recentrage, fermeture). */
  onTarget?: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const targeting = useUi((s) => s.targeting);
  const actions = useMemo(() => unitActions(units, catalog), [units, catalog]);
  const run = useRunAction(onTarget);

  useEffect(() => {
    if (!keys) return;
    keyHandler = (key) => {
      const a = actions.find((x) => x.key.toLowerCase() === key.toLowerCase());
      if (!a) return false;
      void run(a);
      return true;
    };
    return () => {
      keyHandler = null;
    };
  });

  return (
    <div
      className={compact ? 'unitorders unitorders--compact' : 'unitorders'}
      role="toolbar"
      aria-label={t('game.actions.title')}
      data-testid="unit-orders"
    >
      {actions.map((a) => {
        const label = t(`game.actions.${a.label ?? a.id}`);
        const on = targeting?.action === a.id;
        return (
          <button
            key={a.id}
            type="button"
            className={`unitorders__btn${on ? ' unitorders__btn--on' : ''}`}
            data-action={a.id}
            aria-disabled={!a.enabled}
            aria-pressed={on}
            title={
              a.enabled
                ? `${label} · ${a.key}`
                : `${label} — ${t(`game.actions.reasons.${a.reason ?? 'none'}`)}`
            }
            onClick={() => void run(a)}
          >
            <Icon name={a.icon as IconName} size={14} />
            <span className="unitorders__label">{label}</span>
            {!compact ? (
              <span className="unitorders__key" aria-hidden>
                {a.key}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Bandeau du mode ciblage : consigne, unités concernées, annulation. */
export function TargetingBanner() {
  const { t } = useTranslation();
  const targeting = useUi((s) => s.targeting);
  const setTargeting = useUi((s) => s.setTargeting);
  useEffect(() => {
    document.body.classList.toggle('rl-targeting', !!targeting);
    return () => document.body.classList.remove('rl-targeting');
  }, [targeting]);
  if (!targeting) return null;
  return (
    <div className="targeting" data-map-avoid role="status" data-testid="targeting-banner">
      <Icon name="target" size={14} />
      <span className="targeting__text">
        <b>{t(`game.actions.${targeting.action}`)}</b> ·{' '}
        {t(`game.actions.pick.${targeting.action}`)}
      </span>
      <button type="button" className="targeting__cancel" onClick={() => setTargeting(null)}>
        {t('game.orders.cancel')} <Kbd>{t('keys.escape')}</Kbd>
      </button>
    </div>
  );
}
