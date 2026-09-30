import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { distanceKm, HOUR, type Order } from '@redline/shared';
import { Button } from '@redline/ui';
import { fmtDuration, fmtKm } from '../i18n/index.js';
import { unitPosition } from '../map/interpolation.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

/** Barre de confirmation de l'ordre en attente (troisième geste : confirmer). */
export function OrderBar() {
  const { t } = useTranslation();
  const pending = useUi((s) => s.pendingOrder);
  const setPending = useUi((s) => s.setPending);
  const toast = useUi((s) => s.toast);
  const view = useGame((s) => s.view);
  const conn = useGame((s) => s.connection);
  const catalog = useWorld((s) => s.catalog);

  const confirm = useCallback(async () => {
    const p = useUi.getState().pendingOrder;
    const c = useGame.getState().connection;
    if (!p || !c) return;
    const order: Order = p.kind === 'move' ? { kind: 'move', unitIds: p.unitIds, to: p.to } : { kind: 'attack', unitIds: p.unitIds, targetId: p.targetId };
    useUi.getState().setPending(null);
    const res = await c.sendOrder(order);
    if (res.ok) useUi.getState().toast(t('game.orders.sent'), 'ok');
    else useUi.getState().toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  }, [t]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
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
  const target = pending.kind === 'move' ? pending.to : view.units[pending.targetId] ? unitPosition(view.units[pending.targetId]!, now) : null;
  if (!target) return null;
  const dist = distanceKm(from, target);
  const speeds = units.map((u) => (u.systemId ? catalog[u.systemId]?.speedKmh : undefined) ?? 0).filter((s) => s > 0);
  const slowest = speeds.length ? Math.min(...speeds) : 0;
  const sys = first.systemId ? catalog[first.systemId] : undefined;
  const outOfRange = pending.kind === 'attack' && sys?.movement === 'static' && dist > sys.weaponRangeKm.max;

  return (
    <div className="order-bar" data-map-avoid role="dialog" aria-label={t(pending.kind === 'move' ? 'game.orders.moveTitle' : 'game.orders.attackTitle')}>
      <div className="order-bar__info">
        <div className="order-bar__title">{t(pending.kind === 'move' ? 'game.orders.moveTitle' : 'game.orders.attackTitle')}</div>
        <div className="order-bar__stats">
          <span>
            {t('game.orders.distance')} <b className="rl-mono">{fmtKm(dist)}</b>
          </span>
          {slowest > 0 && pending.kind === 'move' ? (
            <span>
              {t('game.orders.eta')} <b className="rl-mono">{fmtDuration((dist / slowest) * HOUR)}</b>
            </span>
          ) : null}
          {outOfRange ? <span className="order-bar__warn">{t('game.orders.outOfRange')}</span> : null}
        </div>
      </div>
      <div className="order-bar__actions">
        <Button variant="ghost" onClick={() => setPending(null)}>
          {t('game.orders.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void confirm()} autoFocus>
          {t('game.orders.confirm')}
        </Button>
      </div>
    </div>
  );
}
