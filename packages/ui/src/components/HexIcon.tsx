import type { CSSProperties } from 'react';
import { PICTOGRAMS, PICTOGRAM_STROKE, hexPath, type PictogramId } from '../pictograms.js';

export interface HexIconProps {
  /** Pictogramme blanc au trait (absent = hexagone seul). */
  pictogram?: PictogramId | undefined;
  /** Couleur de remplissage (couleur de la nation). */
  color?: string;
  /** Taille en px (largeur de l'hexagone). */
  size?: number;
  /** Contour clair autour de l'hexagone. */
  outline?: string | null;
  /** Hexagone vide (contour seulement). */
  hollow?: boolean;
  /** Couleur du pictogramme. */
  glyphColor?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Icône hexagonale pleine aux couleurs d'une nation, avec pictogramme blanc au trait.
 * @deprecated Style « infographie » de la phase 1 ; préférer <UnitMarker> ou <Pictogram>.
 */
export function HexIcon({
  pictogram,
  color = '#8b5cf6',
  size = 32,
  outline = 'rgba(255,255,255,0.85)',
  hollow = false,
  glyphColor = '#fff',
  title,
  className,
  style,
}: HexIconProps) {
  const paths = pictogram ? PICTOGRAMS[pictogram] : [];
  return (
    <svg
      className={className ? `rl-hex ${className}` : 'rl-hex'}
      width={size}
      height={size * 0.9}
      viewBox="0 1.2 24 21.6"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      <path
        d={hexPath(12, 12, 11.2)}
        fill={hollow ? 'none' : color}
        stroke={hollow ? color : (outline ?? 'none')}
        strokeWidth={hollow ? 1.6 : 0.9}
        strokeLinejoin="round"
      />
      {paths.length ? (
        <g
          transform="translate(12 12) scale(0.6) translate(-12 -12)"
          fill="none"
          stroke={glyphColor}
          strokeWidth={PICTOGRAM_STROKE / 0.6 / 1.3}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
