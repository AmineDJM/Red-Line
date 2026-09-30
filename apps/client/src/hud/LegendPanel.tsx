import { useTranslation } from 'react-i18next';
import { Legend, type LegendItem } from '@redline/ui';
import { useUi } from '../store/ui.js';
import { Icons } from './icons.js';

/** Légende en bas à droite (panneau gris clair translucide), repliable. */
export function LegendPanel({ fog }: { fog: boolean }) {
  const { t } = useTranslation();
  const open = useUi((s) => s.legendOpen);
  const setOpen = useUi((s) => s.setLegendOpen);
  const items: LegendItem[] = [
    { kind: 'hex', label: t('game.legend.ownForces'), color: '#7b4cf0', pictogram: 'tank' },
    { kind: 'hex', label: t('game.legend.enemyForces'), color: '#4a7fb5', pictogram: 'fighter' },
    { kind: 'hex', label: t('game.legend.detected'), color: '#5b6477', pictogram: 'unknown' },
    { kind: 'hex', label: t('game.legend.building'), color: '#7b4cf0', pictogram: 'refinery' },
    {
      kind: 'swatch',
      label: t('game.legend.ownTerritory'),
      color: 'rgba(139, 92, 246, 0.75)',
      glow: true,
    },
    { kind: 'ring', label: t('game.legend.range'), color: '#f39a2b' },
    { kind: 'line', label: t('game.legend.route'), color: '#f39a2b', arrow: true },
    { kind: 'triangle', label: t('game.legend.launch'), color: '#f39a2b', badge: '1' },
    { kind: 'line', label: t('game.legend.border'), color: '#e9eef5', width: 1.4 },
    { kind: 'line', label: t('game.legend.capture'), color: '#f39a2b', dashed: true, width: 2 },
    { kind: 'hatch', label: t('game.legend.disputed'), color: '#c98a3c' },
    ...(fog ? [{ kind: 'hatch' as const, label: t('game.legend.fog'), color: '#6c7890' }] : []),
  ];
  if (!open) return null;
  return (
    <div className="legend-wrap" data-map-avoid>
      <button
        type="button"
        className="legend-wrap__close"
        onClick={() => setOpen(false)}
        aria-label={t('app.close')}
        title={t('app.close')}
      >
        {Icons.close(14)}
      </button>
      <Legend title={t('game.legend.title')} items={items} />
    </div>
  );
}
