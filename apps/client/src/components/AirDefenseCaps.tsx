import { useTranslation } from 'react-i18next';
import {
  AIR_THREATS,
  airDefenseTable,
  type AirDefenseLine,
  type AirThreat,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { Gauge, Pictogram, formatInt, type PictogramId } from '@redline/ui';
import { fmtDuration, fmtKm, fmtKmRange } from '../i18n/index.js';

/**
 * Défense antiaérienne : ce qu'un système intercepte (une ligne par catégorie de menace : avions,
 * hélicoptères, drones, missiles de croisière, balistiques, hypersoniques), avec portées, plafond,
 * probabilité et doctrine de tir ; magasin d'intercepteurs restant pour une pile à soi. Les catégories
 * non interceptées restent visibles, grisées (le joueur voit aussi ce qui passe).
 */

const PICTO: Partial<Record<AirThreat, PictogramId>> = {
  aircraft: 'fighter',
  helicopter: 'helicopter',
  drone: 'drone',
  cruise_missile: 'missile',
};

/** Icône d'une catégorie de menace (pictogramme du jeu, ou tracé propre pour les balistiques). */
export function ThreatIcon({ threat, size = 16 }: { threat: AirThreat; size?: number }) {
  const id = PICTO[threat];
  if (id) return <Pictogram id={id} size={size} />;
  // Balistique : trajectoire en cloche ; hypersonique : flèche et traits de vitesse.
  const paths =
    threat === 'ballistic_missile'
      ? ['M3 20 C6 4 16 2 21 18', 'M21 18 L18.6 15.6 M21 18 L21.6 14.8', 'M2 21 L22 21']
      : ['M4 12 L20 12', 'M20 12 L15 8.6 M20 12 L15 15.4', 'M2 7.6 L8 7.6 M2 16.4 L8 16.4'];
  return (
    <svg
      className="rl-picto"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const range = (l: AirDefenseLine) => fmtKmRange(l.minKm, l.maxKm);

/** Magasin d'une pile à soi : intercepteurs restants, jauge, rechargement complet. */
export function AirDefenseAmmo({ unit, now }: { unit: UnitView; now: number }) {
  const { t } = useTranslation();
  const ad = unit.airDefense;
  if (!ad) return null;
  const ratio = ad.max > 0 ? ad.ammo / ad.max : 0;
  return (
    <div className="adcaps__ammo" data-testid="ad-ammo">
      <span className="adcaps__label">{t('airDefense.interceptors')}</span>
      <Gauge
        value={ratio}
        tone={ratio < 0.25 ? 'red' : ratio < 0.5 ? 'amber' : 'cyan'}
        cells={12}
        label={t('airDefense.interceptors')}
        valueText={`${formatInt(ad.ammo)}/${formatInt(ad.max)}`}
      />
      {ad.fullAt && ad.fullAt > now ? (
        <span className="adcaps__reload">
          {t('airDefense.fullIn', { value: fmtDuration(ad.fullAt - now) })}
        </span>
      ) : null}
    </div>
  );
}

/** Pastilles compactes (panneau de sélection) : catégories interceptées et portée maximale. */
export function AirDefenseChips({ system }: { system: WeaponSystem }) {
  const { t } = useTranslation();
  const table = airDefenseTable(system);
  if (!table || table.lines.length === 0) return null;
  const by = new Map(table.lines.map((l) => [l.threat, l]));
  return (
    <ul className="adcaps__chips" aria-label={t('airDefense.title')} data-testid="ad-chips">
      {AIR_THREATS.map((c) => {
        const l = by.get(c);
        return (
          <li
            key={c}
            className={l ? 'adcaps__chip' : 'adcaps__chip adcaps__chip--off'}
            title={
              l
                ? t('airDefense.chipTitle', { cat: t(`airDefense.threats.${c}`), range: range(l) })
                : t('airDefense.chipNone', { cat: t(`airDefense.threats.${c}`) })
            }
          >
            <ThreatIcon threat={c} size={14} />
            <span>{l ? fmtKm(l.maxKm) : '—'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Tableau complet (fiche d'arme). */
export function AirDefenseCaps({
  system,
  unit,
  now,
}: {
  system: WeaponSystem;
  unit?: UnitView | undefined;
  now?: number;
}) {
  const { t } = useTranslation();
  const table = airDefenseTable(system);
  if (!table || table.lines.length === 0) return null;
  const by = new Map(table.lines.map((l) => [l.threat, l]));
  return (
    <section className="adcaps" aria-label={t('airDefense.title')} data-testid="ad-caps">
      <header className="adcaps__head">
        <span className="adcaps__title">{t('airDefense.title')}</span>
        {!table.explicit ? <span className="adcaps__note">{t('airDefense.legacy')}</span> : null}
      </header>
      {unit?.airDefense ? <AirDefenseAmmo unit={unit} now={now ?? 0} /> : null}
      <table className="rl-table rl-table--dense adcaps__table">
        <thead>
          <tr>
            <th scope="col">{t('airDefense.cols.threat')}</th>
            <th scope="col">{t('airDefense.cols.range')}</th>
            <th scope="col">{t('airDefense.cols.ceiling')}</th>
            <th scope="col">{t('airDefense.cols.pk')}</th>
            <th scope="col">{t('airDefense.cols.shots')}</th>
          </tr>
        </thead>
        <tbody>
          {AIR_THREATS.map((c) => {
            const l = by.get(c);
            return (
              <tr key={c} className={l ? undefined : 'adcaps__off'}>
                <th scope="row">
                  <span className="adcaps__cat">
                    <ThreatIcon threat={c} />
                    {t(`airDefense.threats.${c}`)}
                  </span>
                </th>
                <td>{l ? range(l) : t('airDefense.no')}</td>
                <td>{l?.ceilingKm ? fmtKm(l.ceilingKm) : '—'}</td>
                <td>{l ? `${Math.round(l.pk * 100)} %` : '—'}</td>
                <td>{l?.shots ? `×${l.shots}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl className="adcaps__facts">
        <div>
          <dt>{t('airDefense.magazine')}</dt>
          <dd>{formatInt(table.magazine)}</dd>
        </div>
        {table.channels ? (
          <div>
            <dt>{t('airDefense.channels')}</dt>
            <dd>{formatInt(table.channels)}</dd>
          </div>
        ) : null}
        {table.reactionS !== undefined ? (
          <div>
            <dt>{t('airDefense.reaction')}</dt>
            <dd>{t('airDefense.seconds', { value: table.reactionS })}</dd>
          </div>
        ) : null}
        {table.reloadH !== undefined ? (
          <div>
            <dt>{t('airDefense.reload')}</dt>
            <dd>{fmtDuration(table.reloadH * 3_600_000)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
