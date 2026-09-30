import { useState, type CSSProperties } from 'react';
import { PICTOGRAMS, PICTOGRAM_STROKE, type PictogramId } from '../pictograms.js';
import { flagUrl } from '../flags.js';

/** Pictogramme d'unité ou de bâtiment au trait (mêmes tracés que les sprites de la carte). */
export function Pictogram({
  id,
  size = 20,
  color = 'currentColor',
  strokeWidth = PICTOGRAM_STROKE,
  className,
  title,
}: {
  id: PictogramId;
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={className ? `rl-picto ${className}` : 'rl-picto'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PICTOGRAMS[id].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export interface FlagProps {
  /** Identifiant de nation (`fra`, `dza`, `gaza`…). */
  nationId?: string;
  /** Ou code pays ISO alpha-2 (`FR`, `US`, `EU`) : origine d'un système d'armes. */
  iso2?: string;
  /** Hauteur en px (largeur 4:3). Défaut 14. */
  size?: number;
  /** Couleur de repli si aucun drapeau n'existe (couleur de la nation). */
  color?: string;
  /** Nom de la nation (texte alternatif). Sans lui, le drapeau est décoratif. */
  title?: string;
  /** Préfixe d'URL si l'application n'est pas servie à la racine. */
  base?: string;
  className?: string;
  /** Chargement immédiat (drapeau principal d'un écran) au lieu du chargement différé. */
  eager?: boolean;
}

/** Drapeau 4:3 (flag-icons, MIT) avec repli sur la couleur de la nation. */
export function Flag({
  nationId,
  iso2,
  size = 14,
  color,
  title,
  base = '',
  className,
  eager,
}: FlagProps) {
  const url = iso2 ? `${base}/flags/${iso2.toLowerCase()}.svg` : flagUrl(nationId ?? '', base);
  const code = (nationId ?? iso2 ?? '').slice(0, 3).toUpperCase();
  const [failed, setFailed] = useState(false);
  const style: CSSProperties = { width: Math.round((size * 4) / 3), height: size };
  if (!url || failed)
    return (
      <span
        className={['rl-flag', 'rl-flag--none', className ?? ''].join(' ')}
        style={{ ...style, background: color ?? 'var(--rl-panel-3)' }}
        role={title ? 'img' : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        title={title}
      >
        {size >= 14 ? code : null}
      </span>
    );
  return (
    <img
      className={['rl-flag', className ?? ''].join(' ')}
      src={url}
      style={style}
      alt={title ?? ''}
      title={title}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export interface UnitMarkerProps {
  /** Pictogramme du type d'unité. */
  pictogram: PictogramId;
  /** Nation propriétaire (drapeau). */
  nationId?: string;
  /** Effectif affiché à droite. */
  count?: number | string;
  /** Couleur du cadre : violet (joueur), vert (allié), rouge (ennemi), gris (inconnu). */
  tone?: 'own' | 'ally' | 'enemy' | 'neutral' | 'unknown';
  /** État 0..1 (barre sous le pion). */
  health?: number;
  selected?: boolean;
  size?: 'sm' | 'md';
  title?: string;
}

/**
 * Pion d'unité façon Conflict of Nations : rectangle arrondi, drapeau, pictogramme, effectif,
 * barre d'état. Même langage que les pions de la carte (listes, légende, rapports).
 */
export function UnitMarker({
  pictogram,
  nationId,
  count,
  tone = 'own',
  health,
  selected,
  size = 'md',
  title,
}: UnitMarkerProps) {
  const h = health === undefined ? null : Math.max(0, Math.min(1, health));
  return (
    <span
      className={[
        'rl-unit',
        `rl-unit--${tone}`,
        `rl-unit--${size}`,
        selected ? 'rl-unit--sel' : '',
      ].join(' ')}
      title={title}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {nationId ? <Flag nationId={nationId} size={size === 'sm' ? 9 : 11} /> : null}
      <Pictogram id={pictogram} size={size === 'sm' ? 14 : 17} />
      {count !== undefined ? <span className="rl-unit__count">{count}</span> : null}
      {h !== null ? (
        <span className="rl-unit__hp">
          <span
            style={{ width: `${h * 100}%` }}
            className={h < 0.3 ? 'rl-unit__hp--low' : h < 0.6 ? 'rl-unit__hp--mid' : undefined}
          />
        </span>
      ) : null}
    </span>
  );
}
