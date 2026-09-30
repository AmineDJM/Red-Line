import type { ReactNode } from 'react';
import type { WeaponSystem } from '@redline/shared';
import { BracketFrame } from './BracketFrame.js';
import { HexIcon } from './HexIcon.js';
import { StatLine } from './StatLine.js';
import { pictogramFor } from '../pictograms.js';

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
  const num = (v: number, unit: string) => `${nf.format(v)} ${unit}`;
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

export interface WeaponCardProps {
  system: WeaponSystem;
  labels: WeaponCardLabels;
  /** Sous-titre : type et pays (ex. « Chasseur multirôle · États-Unis »). */
  subtitle: string;
  /** Contenu additionnel (état de l'unité, boutons). */
  extra?: ReactNode;
  /** Couleur de l'hexagone d'illustration (orange par défaut). */
  accent?: string;
  onClose?: () => void;
  closeLabel?: string;
  locale?: string;
  compact?: boolean;
  /** Nombre maximal de lignes affichées (mobile). */
  maxRows?: number;
}

/** Fiche d'arme : cadre sombre à crochets, illustration dans un hexagone orange, valeurs en orange. */
export function WeaponCard({
  system,
  labels,
  subtitle,
  extra,
  accent = 'var(--rl-orange)',
  onClose,
  closeLabel,
  locale,
  compact,
  maxRows,
}: WeaponCardProps) {
  const all = weaponSheetRows(system, labels, locale);
  const rows = maxRows !== undefined ? all.slice(0, maxRows) : all;
  return (
    <BracketFrame className={compact ? 'rl-weapon rl-weapon--compact' : 'rl-weapon'}>
      <div className="rl-weapon__head">
        <HexIcon
          pictogram={pictogramFor(system)}
          color={accent}
          size={compact ? 46 : 60}
          outline={null}
        />
        <div className="rl-weapon__titles">
          <div className="rl-weapon__name">{system.name}</div>
          <div className="rl-weapon__sub">{subtitle}</div>
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
              <path
                d="M5 5 L19 19 M19 5 L5 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="rl-weapon__rows">
        {rows.map((r) => (
          <StatLine key={r.key} label={r.label} value={r.value} />
        ))}
      </div>
      {extra ? <div className="rl-weapon__extra">{extra}</div> : null}
    </BracketFrame>
  );
}
