import { useEffect, useRef } from 'react';
import type { LngLat, NationId } from '@redline/shared';
import { DEBUG_HOOKS, IS_MOCK } from '../config.js';
import { GameMap, type MapMode } from './GameMap.js';

export interface MapViewProps {
  mode: MapMode;
  fog?: boolean;
  pickedNation?: NationId | null;
  onPickNation?: (id: NationId) => void;
  /** Bac à sable : placement actif ? */
  placing?: boolean;
  onPlace?: (at: LngLat) => void;
  insets?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

const FONTS_TO_LOAD = [
  '700 16px "Barlow Condensed"',
  '400 12px "IBM Plex Sans"',
  'italic 400 12px "IBM Plex Sans"',
  '600 12px "IBM Plex Mono"',
];

/** Conteneur React de la carte : crée le contrôleur une fois les polices prêtes (images d'étiquettes). */
export function MapView({
  mode,
  fog = false,
  pickedNation,
  onPickNation,
  placing,
  onPlace,
  insets,
  className,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<GameMap | null>(null);
  const cb = useRef({ onPickNation, placing, onPlace });
  cb.current = { onPickNation, placing, onPlace };
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const pickedRef = useRef(pickedNation);
  pickedRef.current = pickedNation;

  useEffect(() => {
    let disposed = false;
    const fonts =
      typeof document !== 'undefined' && document.fonts
        ? Promise.all(FONTS_TO_LOAD.map((f) => document.fonts.load(f)))
        : Promise.resolve();
    const timeout = new Promise((r) => setTimeout(r, 2500));
    void Promise.race([fonts, timeout]).finally(() => {
      if (disposed || !ref.current || !canvasRef.current) return;
      const gm = new GameMap(ref.current, canvasRef.current, {
        mode,
        fog,
        pickedNation: pickedRef.current ?? null,
        onPickNation: (id) => cb.current.onPickNation?.(id),
        placing: () => !!cb.current.placing,
        onPlace: (at) => cb.current.onPlace?.(at),
      });
      mapRef.current = gm;
      if (insetsRef.current) gm.setInsets(insetsRef.current);
      if (pickedRef.current)
        gm.map.once('load', () => gm.setPickedNation(pickedRef.current ?? null));
      if (DEBUG_HOOKS) (window as unknown as { __rlMap?: GameMap }).__rlMap = gm;
    });
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // Le contrôleur est créé une seule fois par montage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setPickedNation(pickedNation ?? null);
  }, [pickedNation]);

  useEffect(() => {
    if (insets) mapRef.current?.setInsets(insets);
  }, [insets?.top, insets?.right, insets?.bottom, insets?.left]);

  return (
    <div className={className ? `map-root ${className}` : 'map-root'}>
      <div ref={ref} className="map-canvas" />
      <canvas ref={canvasRef} className="map-overlay" aria-hidden />
    </div>
  );
}
