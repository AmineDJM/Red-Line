import { useState, type ReactNode } from 'react';
import type { WeaponSystem } from '@redline/shared';
import { Pictogram, Flag } from './Pictogram.js';
import { pictogramFor } from '../pictograms.js';
import { KeyValue } from './Panel.js';

/** Libellés de la fiche (fournis par l'application, via i18n). */
export interface WeaponCardLabels {
  engine: string;
  length: string;
  wingspan: string;
  mtow: string;
  warhead: string;
  speed: string;
  range: string;
  weaponRange: string;
  units: { m: string; kg: string; km: string };
  /** Préfixe du crédit photo (« Photo »). */
  photo?: string;
  /** Texte si aucune photo n'est disponible. */
  noPhoto?: string;
  /** Abréviation de génération (« Gén. »). */
  generation?: string;
  /** Fiche technique (titre de section). */
  sheet?: string;
}

export interface WeaponRow {
  key: string;
  label: string;
  value: string;
}

/** Lignes « caractéristique : valeur » tirées de WeaponSystem.sheet (les valeurs nulles sont omises). */
export function weaponSheetRows(
  system: WeaponSystem,
  labels: WeaponCardLabels,
  locale = 'fr-FR',
): WeaponRow[] {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const num = (v: number, unit: string) => `${nf.format(v)} ${unit}`.replace(/ /g, ' ');
  const s = system.sheet;
  const rows: WeaponRow[] = [];
  if (s.engine) rows.push({ key: 'engine', label: labels.engine, value: s.engine });
  if (s.lengthM != null)
    rows.push({ key: 'length', label: labels.length, value: num(s.lengthM, labels.units.m) });
  if (s.wingspanM != null)
    rows.push({ key: 'wingspan', label: labels.wingspan, value: num(s.wingspanM, labels.units.m) });
  if (s.mtowKg != null)
    rows.push({ key: 'mtow', label: labels.mtow, value: num(s.mtowKg, labels.units.kg) });
  if (s.warheadKg != null)
    rows.push({ key: 'warhead', label: labels.warhead, value: num(s.warheadKg, labels.units.kg) });
  if (s.speedLabel) rows.push({ key: 'speed', label: labels.speed, value: s.speedLabel });
  if (s.rangeKm != null)
    rows.push({ key: 'range', label: labels.range, value: num(s.rangeKm, labels.units.km) });
  const wr = system.weaponRangeKm;
  if (wr.max > 0) {
    rows.push({
      key: 'weaponRange',
      label: labels.weaponRange,
      value:
        wr.min > 0
          ? `${nf.format(wr.min)} – ${num(wr.max, labels.units.km)}`
          : num(wr.max, labels.units.km),
    });
  }
  return rows;
}

/** Photo réelle d'un système (manifeste `data/art/photos.json` ou champ `system.photo`). */
export interface WeaponPhotoInfo {
  /** URL de l'image pleine taille (webp). */
  src: string;
  /** Vignette (facultative, repli sur `src`). */
  thumb?: string;
  credit: string;
  license: string;
  sourceUrl?: string;
}

/**
 * Photo d'un système, cadrée proprement (object-fit: cover), avec crédit et licence.
 * Sans photo (ou en cas d'erreur de chargement) : pictogramme au trait sur fond quadrillé.
 */
export function WeaponPhoto({
  system,
  photo,
  variant = 'hero',
  labels,
  showCredit = variant === 'hero',
  overlay,
}: {
  system: Pick<WeaponSystem, 'name' | 'category' | 'icon'>;
  photo?: WeaponPhotoInfo | null;
  variant?: 'hero' | 'thumb' | 'mini';
  labels?: Pick<WeaponCardLabels, 'photo' | 'noPhoto'>;
  showCredit?: boolean;
  /** Contenu superposé en haut (badges). */
  overlay?: ReactNode;
}) {
  const [stage, setStage] = useState<'thumb' | 'full' | 'failed'>(
    variant === 'hero' ? 'full' : 'thumb',
  );
  const src = photo
    ? stage === 'thumb'
      ? (photo.thumb ?? photo.src)
      : stage === 'full'
        ? photo.src
        : null
    : null;
  return (
    <figure className={`rl-photo rl-photo--${variant}`}>
      <div className="rl-photo__frame">
        {src ? (
          <img
            src={src}
            alt={system.name}
            loading="lazy"
            decoding="async"
            onError={() => setStage(stage === 'thumb' && photo?.thumb ? 'full' : 'failed')}
          />
        ) : (
          <div className="rl-photo__none" aria-label={labels?.noPhoto} role="img">
            <Pictogram id={pictogramFor(system)} size={variant === 'mini' ? 20 : variant === 'thumb' ? 40 : 64} strokeWidth={1.2} />
          </div>
        )}
        {overlay ? <div className="rl-photo__overlay">{overlay}</div> : null}
      </div>
      {showCredit && photo && src ? (
        <figcaption className="rl-photo__credit">
          {labels?.photo ?? 'Photo'} : {photo.credit} ·{' '}
          {photo.sourceUrl ? (
            <a href={photo.sourceUrl} target="_blank" rel="noreferrer noopener">
              {photo.license}
            </a>
          ) : (
            photo.license
          )}
        </figcaption>
      ) : null}
    </figure>
  );
}

export interface WeaponFact {
  label: ReactNode;
  value: ReactNode;
  tone?: 'amber' | 'green' | 'red' | 'cyan' | 'dim';
}

export interface WeaponCardProps {
  system: WeaponSystem;
  labels: WeaponCardLabels;
  /** Sous-titre : type et pays (ex. « Chasseur multirôle · États-Unis »). */
  subtitle: string;
  photo?: WeaponPhotoInfo | null;
  /** Faits de jeu (prix, possédé, productible…) affichés avant la fiche technique. */
  facts?: WeaponFact[];
  /** Badges sous le titre (génération, licence…). */
  badges?: ReactNode;
  /** Boutons d'action (produire, importer, licence). */
  actions?: ReactNode;
  /** Contenu additionnel (état de l'unité sélectionnée). */
  extra?: ReactNode;
  /** Couleur d'accent (conservé pour compatibilité). */
  accent?: string;
  onClose?: () => void;
  closeLabel?: string;
  locale?: string;
  /** Photo réduite, lignes limitées (mobile, fiche de sélection). */
  compact?: boolean;
  /** Nombre maximal de lignes de la fiche technique. */
  maxRows?: number;
  /** Masque la photo (fiche très compacte). */
  hidePhoto?: boolean;
}

/**
 * Fiche d'arme : photo réelle (crédit, licence), nom, sous-titre, faits de jeu, fiche technique
 * alignée en chasse fixe, actions.
 */
export function WeaponCard({
  system,
  labels,
  subtitle,
  photo,
  facts,
  badges,
  actions,
  extra,
  onClose,
  closeLabel,
  locale,
  compact,
  maxRows,
  hidePhoto,
}: WeaponCardProps) {
  const all = weaponSheetRows(system, labels, locale);
  const rows = maxRows !== undefined ? all.slice(0, maxRows) : all;
  return (
    <article className={compact ? 'rl-weapon rl-weapon--compact' : 'rl-weapon'}>
      {!hidePhoto ? (
        <WeaponPhoto
          system={system}
          photo={photo}
          variant={compact ? 'thumb' : 'hero'}
          showCredit
          labels={labels}
          overlay={
            <span className="rl-weapon__gen">
              {labels.generation ?? 'Gén.'} {system.generation}
            </span>
          }
        />
      ) : null}
      <header className="rl-weapon__head">
        <div className="rl-weapon__titles">
          <h3 className="rl-weapon__name">
            <Flag iso2={system.origin} size={12} />
            {system.name}
          </h3>
          <div className="rl-weapon__sub">{subtitle}</div>
          {badges ? <div className="rl-weapon__badges">{badges}</div> : null}
        </div>
        {onClose ? (
          <button
            type="button"
            className="rl-weapon__close"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </header>
      {extra ? <div className="rl-weapon__extra">{extra}</div> : null}
      {facts?.length ? <KeyValue className="rl-weapon__facts" items={facts} /> : null}
      {rows.length ? (
        <div className="rl-weapon__sheet">
          {labels.sheet ? <div className="rl-weapon__sheet-title">{labels.sheet}</div> : null}
          <KeyValue items={rows.map((r) => ({ label: r.label, value: r.value, tone: 'amber' }))} />
        </div>
      ) : null}
      {actions ? <div className="rl-weapon__actions">{actions}</div> : null}
    </article>
  );
}

export interface WeaponTileProps {
  system: WeaponSystem;
  photo?: WeaponPhotoInfo | null;
  subtitle: string;
  /** Prix (texte déjà formaté, ex. « $78 M »). */
  price?: ReactNode;
  /** Badges d'état (Productible, Import, Licence, R&D requise). */
  badges?: ReactNode;
  /** Ligne de pied (« Possédé : 14 »). */
  footer?: ReactNode;
  generationLabel?: string;
  selected?: boolean;
  onSelect?: () => void;
  /** Grise la tuile (non disponible). */
  dimmed?: boolean;
}

/** Tuile d'arsenal : vignette photo, nom, prix en ambre, badges d'état. */
export function WeaponTile({
  system,
  photo,
  subtitle,
  price,
  badges,
  footer,
  generationLabel = 'Gén.',
  selected,
  onSelect,
  dimmed,
}: WeaponTileProps) {
  return (
    <button
      type="button"
      className={[
        'rl-wtile',
        selected ? 'rl-wtile--sel' : '',
        dimmed ? 'rl-wtile--dim' : '',
      ].join(' ')}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <WeaponPhoto
        system={system}
        photo={photo}
        variant="thumb"
        showCredit={false}
        overlay={
          <>
            <span className="rl-wtile__gen">
              {generationLabel} {system.generation}
            </span>
            <Flag iso2={system.origin} size={11} />
          </>
        }
      />
      <span className="rl-wtile__body">
        <span className="rl-wtile__name">{system.name}</span>
        <span className="rl-wtile__sub">{subtitle}</span>
        <span className="rl-wtile__row">
          {price ? <span className="rl-wtile__price">{price}</span> : null}
          {footer ? <span className="rl-wtile__foot">{footer}</span> : null}
        </span>
        {badges ? <span className="rl-wtile__badges">{badges}</span> : null}
      </span>
    </button>
  );
}
