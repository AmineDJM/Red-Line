import { useTranslation } from 'react-i18next';
import {
  AIR_THREATS,
  EFFECT_TARGETS,
  airDefenseTable,
  effectLevel,
  systemEffectiveness,
  type AirThreat,
  type EffectLevel,
  type EffectScores,
  type EffectTarget,
  type EffectivenessContext,
  type WeaponSystem,
} from '@redline/shared';
import { Icon, Pictogram, type PictogramId } from '@redline/ui';
import { fmtKmRange } from '../i18n/index.js';

/**
 * Efficacité par catégorie de cible (avions, hélicoptères, drones, missiles, blindés, infanterie,
 * artillerie, navires, sous-marins, bâtiments) : rangée compacte de pastilles (panneau de sélection)
 * et tableau (fiche d'arme). Niveau sur 4 barres : faible, moyen, bon, excellent ; « nul » masqué
 * dans la rangée, grisé dans le tableau. Pour une défense antiaérienne, l'info-bulle des catégories
 * aériennes rappelle les portées d'interception (les détails restent dans la fiche).
 */

const PICTO: Record<Exclude<EffectTarget, 'building'>, PictogramId> = {
  aircraft: 'fighter',
  helicopter: 'helicopter',
  drone: 'drone',
  missile: 'missile',
  armor: 'tank',
  infantry: 'infantry',
  artillery: 'artillery',
  ship: 'ship',
  submarine: 'submarine',
};

/** Menaces aériennes couvertes par une catégorie (portées d'interception dans l'info-bulle). */
const THREATS: Partial<Record<EffectTarget, AirThreat[]>> = {
  aircraft: ['aircraft'],
  helicopter: ['helicopter'],
  drone: ['drone'],
  missile: ['cruise_missile', 'ballistic_missile', 'hypersonic'],
};

export function EffectIcon({ target, size = 14 }: { target: EffectTarget; size?: number }) {
  if (target === 'building') return <Icon name="building" size={size} />;
  return <Pictogram id={PICTO[target]} size={size} />;
}

/** Jauge en 4 barres croissantes (niveau 0 : toutes éteintes). */
export function EffectMeter({ level }: { level: EffectLevel }) {
  return (
    <span className="effmeter" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= level ? 'effmeter__bar effmeter__bar--on' : 'effmeter__bar'} />
      ))}
    </span>
  );
}

/** Portées d'interception d'un système contre les menaces d'une catégorie (texte d'info-bulle). */
function interceptText(
  system: WeaponSystem | undefined,
  target: EffectTarget,
  t: (k: string, o?: Record<string, unknown>) => string,
): string | null {
  const threats = THREATS[target];
  const table = system ? airDefenseTable(system) : null;
  if (!threats || !table) return null;
  const lines = table.lines.filter((l) => threats.includes(l.threat));
  if (lines.length === 0) return null;
  const ranges =
    threats.length === 1
      ? fmtKmRange(lines[0]!.minKm, lines[0]!.maxKm)
      : AIR_THREATS.filter((c) => lines.some((l) => l.threat === c))
          .map((c) => {
            const l = lines.find((x) => x.threat === c)!;
            return `${t(`airDefense.threats.${c}`)} ${fmtKmRange(l.minKm, l.maxKm)}`;
          })
          .join(', ');
  return t('effect.intercept', { ranges });
}

/** Rangée compacte : une pastille par catégorie où le système (ou la pile) agit. */
export function EffectRow({
  scores,
  ctx,
  name,
  system,
  compact = false,
}: {
  scores: EffectScores;
  ctx: EffectivenessContext;
  name: string;
  /** Système unique (pas une pile mixte) : portées d'interception dans les info-bulles. */
  system?: WeaponSystem | undefined;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const levels = EFFECT_TARGETS.map((c) => ({ c, l: effectLevel(scores[c], ctx) }));
  const on = levels.filter((x) => x.l > 0);
  if (on.length === 0) return null;
  const off = levels.filter((x) => x.l === 0).map((x) => t(`effect.targets.${x.c}`));
  const chipTitle = (c: EffectTarget, l: EffectLevel) => {
    const base = t('effect.chip', {
      name,
      level: t(`effect.levels.${l}`),
      against: t(`effect.against.${c}`),
    });
    const ic = interceptText(system, c, t);
    return ic ? `${base} · ${ic}` : base;
  };
  return (
    <div
      className={compact ? 'effrow effrow--compact' : 'effrow'}
      data-testid="effect-row"
      title={off.length ? t('effect.noneList', { list: off.join(', ') }) : undefined}
    >
      {!compact ? <span className="effrow__label">{t('effect.title')}</span> : null}
      <ul className="effrow__list" aria-label={t('effect.title')}>
        {on.map(({ c, l }) => (
          <li
            key={c}
            className={`effchip effchip--l${l}`}
            title={chipTitle(c, l)}
            aria-label={chipTitle(c, l)}
            data-target={c}
            data-level={l}
          >
            <EffectIcon target={c} size={compact ? 13 : 14} />
            <EffectMeter level={l} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tableau complet (fiche d'arme) : les dix catégories, « nul » grisé. */
export function EffectTable({ system, ctx }: { system: WeaponSystem; ctx: EffectivenessContext }) {
  const { t } = useTranslation();
  const scores = systemEffectiveness(system, ctx);
  const levels = EFFECT_TARGETS.map((c) => ({ c, l: effectLevel(scores[c], ctx) }));
  if (levels.every((x) => x.l === 0)) return null;
  return (
    <section className="effcard" aria-label={t('effect.sheetTitle')} data-testid="effect-table">
      <header className="effcard__head">
        <span className="effcard__title">{t('effect.sheetTitle')}</span>
        <span className="effcard__note">{t('effect.note')}</span>
      </header>
      <ul className="effcard__grid">
        {levels.map(({ c, l }) => (
          <li
            key={c}
            className={`effcard__row effchip--l${l}${l === 0 ? ' effcard__row--off' : ''}`}
            title={t('effect.chip', {
              name: system.name,
              level: t(`effect.levels.${l}`),
              against: t(`effect.against.${c}`),
            })}
          >
            <span className="effcard__cat">
              <EffectIcon target={c} />
              {t(`effect.targets.${c}`)}
            </span>
            <EffectMeter level={l} />
            <span className="effcard__level">{t(`effect.levels.${l}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
