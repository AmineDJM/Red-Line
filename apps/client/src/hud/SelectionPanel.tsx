import { useTranslation } from 'react-i18next';
import {
  BracketFrame,
  Button,
  HexIcon,
  Meter,
  StatLine,
  WeaponCard,
  pictogramFor,
} from '@redline/ui';
import { fmtDuration, fmtInt, fmtKm } from '../i18n/index.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { nationColor } from '../map/features.js';
import { useGameTime, weaponLabels, weaponSubtitle } from './helpers.js';
import { Icons } from './icons.js';

/** Fiche de l'unité sélectionnée (ou du contact inspecté), en bas à gauche. */
export function SelectionPanel({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const selection = useUi((s) => s.selection);
  const inspected = useUi((s) => s.inspected);
  const clear = useUi((s) => s.clearSelection);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const conn = useGame((s) => s.connection);
  const catalog = useWorld((s) => s.catalog);
  const now = useGameTime(2000);

  const id = selection[0] ?? inspected;
  const u = id ? view?.units[id] : undefined;
  if (!u || !view) return null;
  const sys = u.systemId ? catalog[u.systemId] : undefined;
  const own = u.level === 'own';

  const extra = (
    <div className="sel-extra">
      {selection.length > 1 ? (
        <div className="sel-extra__multi">
          {t('game.selection.multi', { count: selection.length })}
        </div>
      ) : null}
      {!own ? (
        <StatLine
          label={t('game.selection.owner')}
          value={view.nations[u.owner]?.name ?? u.owner}
          tone="plain"
          mono={false}
        />
      ) : null}
      {u.count !== undefined ? (
        <StatLine label={t('game.selection.count')} value={fmtInt(u.count)} />
      ) : null}
      {u.status ? (
        <StatLine
          label={t('game.selection.status')}
          value={t(`game.status.${u.status}`)}
          tone={u.status === 'combat' ? 'critical' : 'plain'}
          mono={false}
        />
      ) : null}
      {u.hpRatio !== undefined ? (
        <div className="sel-extra__hp">
          <span>{t('game.selection.hp')}</span>
          <Meter
            value={u.hpRatio}
            tone={u.hpRatio < 0.3 ? 'critical' : u.hpRatio < 0.6 ? 'accent' : 'ok'}
            label={t('game.selection.hp')}
          />
          <span className="rl-mono">{Math.round(u.hpRatio * 100)} %</span>
        </div>
      ) : null}
      {!own && u.level !== 'precise' ? (
        <div className="sel-extra__intel">
          <span className="sel-extra__lvl">{t(`game.level.${u.level}`)}</span>
          {now - u.lastSeen > 60_000 ? (
            <span>{t('game.selection.lastSeen', { value: fmtDuration(now - u.lastSeen) })}</span>
          ) : null}
          {u.uncertaintyKm > 0 ? (
            <span>{t('game.selection.uncertainty', { value: fmtKm(u.uncertaintyKm) })}</span>
          ) : null}
        </div>
      ) : null}
      {own ? (
        <div className="sel-extra__actions">
          {u.status === 'moving' ? (
            <Button
              icon={Icons.stop(14)}
              onClick={() =>
                void conn?.sendOrder({
                  kind: 'stop',
                  unitIds: selection.length ? selection : [u.id],
                })
              }
            >
              {t('game.selection.stop')}
            </Button>
          ) : null}
          {!compact ? <span className="sel-extra__hint">{t('game.selection.hint')}</span> : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={compact ? 'sel-panel sel-panel--compact' : 'sel-panel'} data-map-avoid>
      {sys && u.level !== 'detected' ? (
        <WeaponCard
          system={sys}
          labels={weaponLabels()}
          subtitle={weaponSubtitle(sys)}
          accent={own && u.owner === me ? 'var(--rl-orange)' : 'var(--rl-orange)'}
          extra={extra}
          compact={compact}
          maxRows={compact ? 3 : undefined}
          onClose={clear}
          closeLabel={t('game.selection.deselect')}
        />
      ) : (
        <BracketFrame className="rl-weapon">
          <div className="rl-weapon__head">
            <HexIcon
              pictogram={sys ? pictogramFor(sys) : 'unknown'}
              color={
                u.level === 'detected'
                  ? '#5b6477'
                  : nationColor(u.owner, { me, nations: view.nations })
              }
              size={compact ? 46 : 56}
            />
            <div className="rl-weapon__titles">
              <div className="rl-weapon__name">{t('game.legend.detected')}</div>
              <div className="rl-weapon__sub">{view.nations[u.owner]?.name ?? ''}</div>
            </div>
            <button
              type="button"
              className="rl-weapon__close"
              onClick={clear}
              aria-label={t('game.selection.deselect')}
            >
              {Icons.close(16)}
            </button>
          </div>
          {extra}
        </BracketFrame>
      )}
    </div>
  );
}
