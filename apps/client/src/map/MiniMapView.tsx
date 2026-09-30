import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';
import { MiniMap, type MiniMapOptions } from './MiniMap.js';
import './map.css';

export interface MiniMapViewProps extends MiniMapOptions {
  /** Taille CSS du cadre (défaut : 100 % × 180 px). */
  width?: number | string;
  height?: number | string;
  className?: string;
  /** Clic sur la mini-carte : position géographique du point touché. */
  onPick?: (at: [number, number]) => void;
  /** Texte alternatif (accessibilité). */
  label?: string;
}

/**
 * Mini-carte en composant React (voir MiniMap.ts) : rapports de renseignement, replay de bataille,
 * timelapse. Chaque changement de propriété redessine le cadre (Canvas 2D, sans WebGL).
 */
export function MiniMapView({
  width = '100%',
  height = 180,
  className,
  onPick,
  label,
  ...opts
}: MiniMapViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mm = useRef<MiniMap | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    mm.current = new MiniMap(ref.current, opts);
    return () => {
      mm.current?.destroy();
      mm.current = null;
    };
    // Instance créée une fois ; les options suivent via update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mm.current?.update(opts);
  });

  return (
    <div
      className={className ? `rlm-minimap ${className}` : 'rlm-minimap'}
      style={{ width, height }}
    >
      <canvas
        ref={ref}
        role="img"
        aria-label={label ?? t('map.minimap.label')}
        onClick={(e) => {
          if (!onPick || !mm.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          onPick(mm.current.lngLatAt(e.clientX - r.left, e.clientY - r.top));
        }}
      />
    </div>
  );
}
