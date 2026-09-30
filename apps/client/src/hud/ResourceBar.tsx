import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@redline/shared';
import { fmtCompact, fmtInt } from '../i18n/index.js';
import { useGame } from '../store/game.js';
import { Icons } from './icons.js';

/** Barre de ressources : argent, pétrole, métaux, électronique, nourriture (chiffres en chasse fixe). */
export function ResourceBar() {
  const { t } = useTranslation();
  const eco = useGame((s) => s.view?.economy);
  if (!eco) return null;
  const items = [
    { key: 'money', icon: Icons.money(16), value: eco.money, perDay: eco.incomePerDay.money },
    ...RESOURCES.map((r) => ({ key: r, icon: Icons[r](16), value: eco.resources[r] ?? 0, perDay: eco.incomePerDay[r] ?? 0 })),
  ];
  return (
    <div className="resources" data-map-avoid role="list" aria-label={t('game.resources.money')}>
      {items.map((it) => (
        <div
          key={it.key}
          className="resources__item"
          role="listitem"
          title={`${t(`game.resources.${it.key}`)} — ${t('game.resources.perDay', { value: fmtInt(it.perDay) })}`}
        >
          <span className={`resources__icon resources__icon--${it.key}`}>{it.icon}</span>
          <span className="resources__value rl-mono">{fmtCompact(it.value)}</span>
          <span className="visually-hidden">{t(`game.resources.${it.key}`)}</span>
        </div>
      ))}
    </div>
  );
}
