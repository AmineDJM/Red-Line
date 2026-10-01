import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { WeaponSystem } from '@redline/shared';
import { Badge, WeaponCard, formatHours, formatMoney, type WeaponFact } from '@redline/ui';
import { ownedCounts, productionStatus, researchName, systemPrice } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { weaponLabels, weaponSubtitle } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

export interface WeaponDetailProps {
  system: WeaponSystem;
  /** `production` : faits de jeu (possédé, productible, import, licence) ; `encyclopedia` : fiche seule. */
  mode: 'production' | 'encyclopedia';
  actions?: ReactNode;
  /** Bloc additionnel (état de la pile d'origine). */
  extra?: ReactNode;
  compact?: boolean;
}

/**
 * Fiche d'arme complète (photo réelle, faits de jeu en dollars, fiche technique) : partagée par
 * l'arsenal (Production, catalogue de l'Arsenal de guerre) et la fiche seule ouverte depuis une
 * armée.
 */
export function WeaponDetail({ system: cur, mode, actions, extra, compact }: WeaponDetailProps) {
  const { t } = useTranslation();
  const research = useWorld((s) => s.research);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const photos = usePhotos();
  const owned = ownedCounts(view, me);

  const facts = (s: WeaponSystem): WeaponFact[] => {
    const st = productionStatus(s, view, me);
    const out: WeaponFact[] = [
      {
        label: t('arsenal.price'),
        value: `${formatMoney(systemPrice(s))}${s.unitSize > 1 ? ` · ${s.unitSize} ${s.unitLabel ?? t('arsenal.elements')}` : ''}`,
        tone: 'amber',
      },
      {
        label: t('arsenal.unitPrice'),
        value: s.unitPriceUsd ? formatMoney(s.unitPriceUsd) : '—',
        tone: 'amber',
      },
      {
        label: t('arsenal.upkeep'),
        value: `${formatMoney(s.upkeepPerDay)} ${t('arsenal.perDay')}`,
        tone: 'dim',
      },
      { label: t('arsenal.buildTime'), value: formatHours(s.buildTimeH, t('time.dayUnit')) },
    ];
    if (mode === 'production') {
      out.unshift({
        label: t('arsenal.owned'),
        value: String(owned[s.id] ?? 0),
        tone: (owned[s.id] ?? 0) > 0 ? 'green' : 'dim',
      });
      out.push({
        label: t('arsenal.producibleLabel'),
        value: st.producible
          ? st.licensed && !st.researched
            ? t('arsenal.yesLicence')
            : t('app.yes')
          : t('arsenal.noResearch', {
              nodes: st.missing.map((m) => researchName(m, research)).join(', '),
            }),
        tone: st.producible ? 'green' : 'red',
      });
      out.push({
        label: t('arsenal.importLabel'),
        value: st.embargoed
          ? t('arsenal.embargo')
          : s.exportable
            ? t('arsenal.importPossible')
            : t('arsenal.notExportable'),
        tone: st.embargoed ? 'red' : s.exportable ? 'cyan' : 'dim',
      });
      out.push({
        label: t('arsenal.licenceLabel'),
        value: st.licensed
          ? t('arsenal.licenceOwned')
          : s.licensable
            ? t('arsenal.licenceAvailable')
            : t('arsenal.licenceNone'),
        tone: st.licensed ? 'green' : 'dim',
      });
    }
    return out;
  };

  return (
    <WeaponCard
      system={cur}
      labels={weaponLabels()}
      subtitle={weaponSubtitle(cur)}
      photo={photoFor(cur, photos)}
      facts={facts(cur)}
      compact={compact}
      extra={extra}
      badges={
        <>
          <Badge tone="neutral">{t(`doctrines.${cur.doctrine}`)}</Badge>
          <Badge tone="neutral">{t(`categories.${cur.category}`)}</Badge>
          {cur.stealth > 0.3 ? (
            <Badge tone="violet" variant="outline">
              {t('arsenal.stealth')}
            </Badge>
          ) : null}
          {cur.requires.map((r) => (
            <Badge
              key={r}
              tone={view?.research?.done.includes(r) ? 'green' : 'amber'}
              variant="outline"
              title={researchName(r, research)}
            >
              {r.replace(/^research\./, '')}
            </Badge>
          ))}
        </>
      }
      actions={actions}
    />
  );
}
