import { useTranslation } from 'react-i18next';
import type { ProvinceDef } from '@redline/shared';
import { Icon } from '@redline/ui';
import { servicesBonusPct } from '../lib/resources.js';
import { RESOURCE_ICON } from '../shell/TopBar.js';
import { useWorld } from '../store/world.js';

/**
 * Ressources d'une province (donnée géographique publique) : principale et secondaire avec leur
 * richesse, ou « argent seulement » (services, finances). Rien pour une carte sans ressources.
 */
export function ProvinceResources({ def }: { def: ProvinceDef }) {
  const { t } = useTranslation();
  const balance = useWorld((s) => s.balance);
  const ds = def.resources;
  if (!ds) return null;
  return (
    <div className="provres" data-testid="province-resources">
      <span className="selpanel__label">{t('province.resources')}</span>
      {ds.length === 0 ? (
        <span className="provres__none" title={t('province.resourceNoneTip')}>
          <Icon name="economy" size={13} />
          {t('province.resourceNone', { pct: servicesBonusPct(balance) })}
        </span>
      ) : (
        <ul className="provres__list">
          {ds.map((d, i) => (
            <li
              key={d.type}
              className={`provres__item provres__item--r${d.richness}`}
              data-resource={d.type}
              title={t(`province.richnessTip.${d.richness}`)}
            >
              <Icon name={RESOURCE_ICON[d.type]} size={14} />
              <b>{t(`game.resources.${d.type}`)}</b>
              <span className="provres__rich" aria-label={t(`province.richness.${d.richness}`)}>
                {'●'.repeat(d.richness)}
                <span className="provres__dim">{'●'.repeat(3 - d.richness)}</span>
              </span>
              <span className="provres__rank">
                {t(i === 0 ? 'province.primary' : 'province.secondary')} ·{' '}
                {t(`province.richness.${d.richness}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
