/**
 * Mini-carte MapLibre des provinces (géométrie publique /api/map/provinces.geojson) : couleur par province,
 * contour des provinces sélectionnées, survol, clic pour sélectionner. Chargée à la demande.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  GeoJSONSourceSpecification,
  Map as MlMap,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
} from 'maplibre-gl';

type Geo = GeoJSONSourceSpecification['data'];
import type { ProvinceDef } from '@redline/shared';
import { T, fmt } from '../i18n';
import { Button, Icon } from './term';

let geoPromise: Promise<Geo> | null = null;
function loadGeo(): Promise<Geo> {
  geoPromise ??= fetch('/api/map/provinces.geojson', { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<Geo>;
  });
  geoPromise.catch(() => (geoPromise = null));
  return geoPromise;
}

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

export interface MiniMapProps {
  provinces: readonly ProvinceDef[];
  colorOf: (provinceId: string) => string;
  selected?: readonly string[];
  /** Provinces mises en avant (couleur pleine), les autres atténuées. */
  highlight?: readonly string[] | null;
  onPick?: (provinceId: string) => void;
  /** Provinces à cadrer (au changement). */
  focus?: readonly string[];
  label?: (provinceId: string) => string;
  height?: number;
}

export function MiniMap(p: MiniMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'nogl'>('loading');
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const props = useRef(p);
  props.current = p;

  useEffect(() => {
    if (!webglOk()) {
      setStatus('nogl');
      return;
    }
    let dead = false;
    let m: MlMap | null = null;
    (async () => {
      try {
        const [ml, geo, worker] = await Promise.all([
          import('maplibre-gl'),
          loadGeo(),
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (dead || !el.current) return;
        ml.setWorkerUrl(worker.default);
        const mm = new ml.Map({
          container: el.current,
          style: {
            version: 8,
            sources: { p: { type: 'geojson', data: geo, promoteId: 'id' } },
            layers: [
              { id: 'bg', type: 'background', paint: { 'background-color': '#070a0e' } },
              {
                id: 'p-fill',
                type: 'fill',
                source: 'p',
                paint: {
                  'fill-color': ['coalesce', ['feature-state', 'color'], '#1e2a36'],
                  'fill-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'dim'], false],
                    0.22,
                    ['boolean', ['feature-state', 'hover'], false],
                    1,
                    0.78,
                  ],
                },
              },
              {
                id: 'p-line',
                type: 'line',
                source: 'p',
                paint: { 'line-color': '#05080b', 'line-width': 0.45 },
              },
              {
                id: 'p-sel',
                type: 'line',
                source: 'p',
                filter: ['in', ['get', 'id'], ['literal', []]],
                paint: { 'line-color': '#4cc9f0', 'line-width': 2 },
              },
            ],
          },
          center: [15, 25],
          zoom: 0.6,
          minZoom: 0,
          maxZoom: 8,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          renderWorldCopies: false,
        });
        m = mm;
        mm.touchZoomRotate.disableRotation();
        map.current = mm;
        mm.on('load', () => {
          if (dead) return;
          setStatus('ready');
          paint();
          frame(true);
        });
        mm.on('mousemove', 'p-fill', (e: MapLayerMouseEvent) => {
          const f = e.features?.[0] as MapGeoJSONFeature | undefined;
          const id = f ? String(f.properties?.id ?? f.id) : null;
          setHover((prev) => {
            if (prev && prev !== id)
              mm.setFeatureState({ source: 'p', id: prev }, { hover: false });
            if (id) mm.setFeatureState({ source: 'p', id }, { hover: true });
            return id;
          });
          mm.getCanvas().style.cursor = props.current.onPick ? 'pointer' : '';
        });
        mm.on('mouseleave', 'p-fill', () => {
          setHover((prev) => {
            if (prev) mm.setFeatureState({ source: 'p', id: prev }, { hover: false });
            return null;
          });
          mm.getCanvas().style.cursor = '';
        });
        mm.on('click', 'p-fill', (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (f) props.current.onPick?.(String(f.properties?.id ?? f.id));
        });
      } catch (e) {
        if (!dead) {
          setErr(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();
    return () => {
      dead = true;
      m?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Couleurs et atténuation (états de chaque entité). */
  const paint = () => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    const { provinces, colorOf, highlight } = props.current;
    const hl = highlight ? new Set(highlight) : null;
    for (const pr of provinces)
      m.setFeatureState(
        { source: 'p', id: pr.id },
        { color: colorOf(pr.id), dim: hl ? !hl.has(pr.id) : false },
      );
  };
  const frame = (instant = false) => {
    const m = map.current;
    const focus = props.current.focus;
    if (!m || !focus?.length) return;
    let pts = props.current.provinces.filter((x) => focus.includes(x.id)).map((x) => x.centroid);
    if (!pts.length) return;
    // Territoires lointains (outre-mer) exclus du cadrage : on garde le cœur autour de la médiane.
    if (pts.length > 3) {
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
      const mx = med(pts.map((q) => q[0]));
      const my = med(pts.map((q) => q[1]));
      const core = pts.filter(([x, y]) => Math.abs(x - mx) < 25 && Math.abs(y - my) < 18);
      if (core.length) pts = core;
    }
    let [w, s, e, n] = [180, 90, -180, -90];
    for (const [x, y] of pts) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    const pad = Math.max(3, (e - w) * 0.35, (n - s) * 0.35);
    m.fitBounds(
      [
        [Math.max(-180, w - pad), Math.max(-85, s - pad)],
        [Math.min(180, e + pad), Math.min(85, n + pad)],
      ],
      { maxZoom: 5.2, padding: 24, duration: instant ? 0 : 450 },
    );
  };

  useEffect(paint, [p.provinces, p.colorOf, p.highlight, status]);
  useEffect(() => {
    const m = map.current;
    if (!m || status !== 'ready') return;
    m.setFilter('p-sel', ['in', ['get', 'id'], ['literal', [...(p.selected ?? [])]]]);
  }, [p.selected, status]);
  const focusKey = (p.focus ?? []).join(',');
  useEffect(() => frame(), [focusKey, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const lbl = hover ? (p.label?.(hover) ?? hover) : null;
  return (
    <div className="minimap" style={p.height ? { height: p.height } : undefined}>
      <div
        ref={el}
        style={{ position: 'absolute', inset: 0 }}
        aria-label={T.map.title}
        role="application"
      />
      {status !== 'ready' && (
        <div className="map-status">
          {status === 'loading'
            ? T.map.mapLoading
            : status === 'nogl'
              ? T.map.mapNoGl
              : fmt(T.map.mapError, { msg: err })}
        </div>
      )}
      {status === 'ready' && (
        <div className="map-tools">
          <Button
            small
            icon
            title={T.map.reset}
            aria-label={T.map.reset}
            onClick={() =>
              p.focus?.length ? frame() : map.current?.flyTo({ center: [15, 25], zoom: 0.6 })
            }
          >
            <Icon name="target" size={13} />
          </Button>
          <Button small icon aria-label="+" onClick={() => map.current?.zoomIn()}>
            +
          </Button>
          <Button small icon aria-label="−" onClick={() => map.current?.zoomOut()}>
            −
          </Button>
        </div>
      )}
      {lbl && <div className="map-hud">{lbl}</div>}
    </div>
  );
}
