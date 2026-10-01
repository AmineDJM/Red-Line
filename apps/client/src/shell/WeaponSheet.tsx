import { useTranslation } from 'react-i18next';
import { Badge, Button, Dialog, Gauge, Icon, formatInt } from '@redline/ui';
import { WeaponDetail } from '../components/WeaponDetail.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useIsMobile } from './useMedia.js';

/**
 * Fiche d'arme seule : fenêtre modale légère (feuille sur mobile) ouverte depuis une armée, une
 * pile ou la sélection. Elle se superpose à la fenêtre en cours sans la fermer ni ouvrir le
 * catalogue complet (Arsenal de guerre).
 */
export function WeaponSheet() {
  const { t } = useTranslation();
  const sheet = useUi((s) => s.sheet);
  const closeSheet = useUi((s) => s.closeSheet);
  const openWindow = useUi((s) => s.openWindow);
  const catalog = useWorld((s) => s.catalog);
  const spectator = useGame((s) => !!s.view?.spectator);
  const unit = useGame((s) => (sheet?.unitId ? s.view?.units[sheet.unitId] : undefined));
  const mobile = useIsMobile();
  const sys = sheet ? catalog[sheet.systemId] : undefined;
  if (!sheet || !sys) return null;
  const own = unit?.level === 'own';
  return (
    <Dialog
      open
      title={sys.name}
      path={[t('sheet.path'), sys.name]}
      onClose={closeSheet}
      closeLabel={t('app.close')}
      width={mobile ? 640 : 720}
      className={mobile ? 'wsheet wsheet--mobile' : 'wsheet'}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="encyclopedia" size={13} />}
            onClick={() => openWindow('army', { tab: 'catalog', systemId: sys.id })}
          >
            {t('sheet.catalog')}
          </Button>
          <span className="grow" />
          <Button size="sm" onClick={closeSheet} data-testid="weapon-sheet-close">
            {t('app.close')}
          </Button>
        </>
      }
    >
      <div className="wsheet__body" data-testid="weapon-sheet">
        <WeaponDetail
          system={sys}
          mode={spectator ? 'encyclopedia' : 'production'}
          compact={mobile}
          extra={
            own && unit ? (
              <div className="wsheet__unit">
                <Badge tone="green" variant="outline">
                  {t('sheet.pile', { id: unit.id })}
                </Badge>
                <span>
                  {formatInt(unit.count ?? 1)} {sys.unitLabel ?? t('arsenal.elements')}
                </span>
                <span className="muted">{t(`game.status.${unit.status ?? 'idle'}`)}</span>
                {unit.hpRatio !== undefined ? (
                  <Gauge value={unit.hpRatio} tone="auto" cells={10} label={t('armies.cols.hp')} />
                ) : null}
              </div>
            ) : undefined
          }
        />
      </div>
    </Dialog>
  );
}
