/**
 * Contrôleur de la carte : crée la carte MapLibre, alimente les sources depuis les stores
 * (Zustand, hors React), met à jour les positions interpolées à ~12 Hz (pas à chaque image),
 * gère les gestes « sélectionner → ordonner → confirmer ».
 */
import {
  Map as MlMap,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type LngLatBoundsLike,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson';
import { distanceKm, type LngLat, type NationId, type ProvinceView, type UnitId, type UnitView } from '@redline/shared';
import { MAX_CALLOUTS, UNIT_TICK_HZ } from '../config.js';
import { fmtKm, t } from '../i18n/index.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { computeBorders } from './borders.js';
import { buildCallouts } from './calloutContent.js';
import {
  EMPTY,
  VIOLET,
  buildingFeatures,
  circleLine,
  fc,
  nationLabelFeatures,
  pathFeatures,
  previewFeatures,
  rangeRing,
  uncertaintyFeatures,
  unitFeatures,
} from './features.js';
import type { FogRequest, FogResponse } from './fog.worker.js';
import { isMoving, unitPosition } from './interpolation.js';
import { OverlayRenderer, type OverlayContent } from './overlay.js';
import { handleMissingImage, registerSprites } from './sprites.js';
import { buildStyle } from './style.js';

let protocolReady = false;
function setupMapLibre() {
  if (protocolReady) return;
  protocolReady = true;
  setWorkerUrl(workerUrl);
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile);
}

export type MapMode = 'game' | 'sandbox' | 'picker';

export interface GameMapOptions {
  mode: MapMode;
  fog: boolean;
  /** Mode sélection de nation (écran nouvelle partie). */
  onPickNation?: (id: NationId) => void;
  /** Bac à sable : si renvoie vrai, un tap sur la carte place une unité. */
  placing?: () => boolean;
  onPlace?: (at: LngLat) => void;
  pickedNation?: NationId | null;
}

const TOUCH_RADIUS = 16;
const MOUSE_RADIUS = 7;

export class GameMap {
  readonly map: MlMap;
  private overlay: OverlayRenderer;
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private tickCount = 0;
  private provState = new Map<string, { color: string; mine: boolean; cap: number }>();
  private ownersKey = '';
  private units: UnitView[] = [];
  private unitsDirty = true;
  private positions = new Map<UnitId, LngLat>();
  private overlayContent: OverlayContent = { callouts: [], routes: [], badges: [] };
  private fogWorker: Worker | null = null;
  private fogSeq = 0;
  private fogKey = '';
  private lastPointer: 'mouse' | 'touch' | 'pen' = 'mouse';
  private selectedProvince: string | null = null;
  private pickedNation: NationId | null = null;
  private resizeObs: ResizeObserver | null = null;
  private fitted = false;

  constructor(
    private readonly container: HTMLElement,
    overlayCanvas: HTMLCanvasElement,
    private readonly opts: GameMapOptions,
  ) {
    setupMapLibre();
    const w = useWorld.getState();
    const labels = nationLabelFeatures(
      Object.values(w.provinces),
      Object.fromEntries(Object.values(w.nations).map((n) => [n.id, n.name])),
    );
    this.map = new MlMap({
      container,
      style: buildStyle({
        tiles: w.tiles,
        glyphs: w.glyphs,
        basemap: w.basemap,
        provinces: w.provincesGeo,
        nationLabels: labels,
        attribution: t('map.attribution'),
        mode: opts.mode,
        clusterUnits: opts.mode === 'game',
      }),
      center: [15, 30],
      zoom: 2.2,
      minZoom: 1.2,
      maxZoom: 11,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: true,
      attributionControl: { compact: true },
      fadeDuration: 150,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.on('styleimagemissing', (e: { id: string }) => handleMissingImage(this.map, e.id));
    this.map.on('error', (e) => {
      // Tuiles ou fichiers facultatifs absents : jamais bloquant.
      console.warn('[carte]', e.error?.message ?? e);
    });
    this.overlay = new OverlayRenderer(overlayCanvas, this.map);
    this.overlay.maxCallouts = MAX_CALLOUTS;
    this.map.on('load', () => this.onLoad());
    this.map.on('render', () => this.overlay.draw(this.overlayContent));
    this.map.on('zoomend', () => this.refreshCallouts());
    this.resizeObs = new ResizeObserver(() => {
      this.overlay.resize();
      this.map.resize();
    });
    this.resizeObs.observe(container);
    this.pickedNation = opts.pickedNation ?? null;
  }

  // ——— Initialisation ———

  private onLoad() {
    registerSprites(this.map);
    this.ready = true;
    this.map.on('click', (e) => this.onClick(e));
    this.map.on('mousemove', (e) => this.onHover(e));
    this.container.addEventListener('pointerdown', (e) => (this.lastPointer = e.pointerType as 'mouse'), { capture: true });

    if (this.opts.mode === 'picker') {
      this.applyPicker();
      return;
    }
    if (this.opts.fog) this.startFog();

    this.unsubs.push(
      useGame.subscribe((s, prev) => {
        if (s.view !== prev.view || s.me !== prev.me) this.onView();
      }),
      useUi.subscribe((s, prev) => {
        if (s.selection !== prev.selection || s.pendingOrder !== prev.pendingOrder || s.inspected !== prev.inspected) {
          this.unitsDirty = true;
          this.refreshSelection();
          this.refreshCallouts();
        }
        if (s.focus !== prev.focus && s.focus) {
          this.map.flyTo({ center: s.focus.at, zoom: Math.max(this.map.getZoom(), s.focus.zoom ?? 5.2), speed: 1.4 });
        }
        if (s.selectedProvince !== prev.selectedProvince) this.highlightProvince(s.selectedProvince);
      }),
    );
    this.onView();
    this.timer = setInterval(() => this.tick(), Math.round(1000 / UNIT_TICK_HZ));
  }

  private src(id: string): GeoJSONSource | undefined {
    return this.map.getSource(id) as GeoJSONSource | undefined;
  }

  private set(id: string, data: FeatureCollection) {
    void this.src(id)?.setData(data);
  }

  // ——— Sélecteur de nation (nouvelle partie) ———

  private applyPicker() {
    const w = useWorld.getState();
    for (const p of Object.values(w.provinces)) {
      const n = w.nations[p.nationId];
      this.map.setFeatureState({ source: 'provinces', id: p.id }, { color: p.nationId === this.pickedNation ? VIOLET : (n?.color ?? '#3a4252'), pick: p.nationId === this.pickedNation });
    }
    const geo = w.provincesGeo;
    if (geo) {
      const b = computeBorders(geo, (id) => w.provinces[id]?.nationId, this.pickedNation);
      this.set('borders', b.nations);
      this.set('my-border', b.mine);
    }
  }

  setPickedNation(id: NationId | null) {
    this.pickedNation = id;
    if (this.ready && this.opts.mode === 'picker') this.applyPicker();
    if (id && this.ready) this.fitNation(id);
  }

  private fitNation(id: NationId) {
    const pts = Object.values(useWorld.getState().provinces)
      .filter((p) => p.nationId === id)
      .map((p) => p.centroid);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 4;
    const bounds: LngLatBoundsLike = [
      [Math.min(...xs) - pad, Math.min(...ys) - pad],
      [Math.max(...xs) + pad, Math.max(...ys) + pad],
    ];
    this.map.fitBounds(bounds, { padding: 40, maxZoom: 5, duration: this.fitted ? 800 : 0 });
    this.fitted = true;
  }

  // ——— État de la partie ———

  private onView() {
    if (!this.ready) return;
    const { view, me } = useGame.getState();
    if (!view) {
      this.units = [];
      this.unitsDirty = true;
      return;
    }
    this.units = Object.values(view.units);
    this.unitsDirty = true;
    this.applyProvinces(view.provinces, me);
    const w = useWorld.getState();
    this.set('buildings', buildingFeatures(Object.values(view.provinces), { me, nations: view.nations, defs: w.provinces }));
    this.set('uncert', uncertaintyFeatures(this.units, gameNow(), me));
    if (!this.fitted && me) this.fitNation(me);
    this.refreshSelection();
    this.refreshCallouts();
  }

  private applyProvinces(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const { view } = useGame.getState();
    const nations = view?.nations ?? {};
    let ownersChanged = false;
    for (const p of Object.values(provinces)) {
      const mine = p.owner === me;
      const color = mine ? VIOLET : (nations[p.owner]?.color ?? useWorld.getState().nations[p.owner]?.color ?? '#3a4252');
      const cap = p.capture ? (p.owner === me ? 2 : 1) : 0;
      const prev = this.provState.get(p.id);
      if (!prev || prev.color !== color || prev.mine !== mine || prev.cap !== cap) {
        this.map.setFeatureState({ source: 'provinces', id: p.id }, { color, mine, cap });
        this.provState.set(p.id, { color, mine, cap });
        if (!prev || prev.mine !== mine || prev.color !== color) ownersChanged = true;
      }
    }
    if (ownersChanged) {
      const key = Object.values(provinces)
        .map((p) => p.owner)
        .join(',');
      if (key !== this.ownersKey) {
        this.ownersKey = key;
        this.updateBorders(provinces, me);
        this.postTerritory(provinces, me);
      }
    }
  }

  private updateBorders(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return;
    const b = computeBorders(geo, (id) => provinces[id]?.owner ?? useWorld.getState().provinces[id]?.nationId, me);
    this.set('borders', b.nations);
    this.set('my-border', b.mine);
  }

  private highlightProvince(id: string | null) {
    if (!this.ready) return;
    if (this.selectedProvince) this.map.setFeatureState({ source: 'provinces', id: this.selectedProvince }, { sel: false });
    this.selectedProvince = id;
    if (id) this.map.setFeatureState({ source: 'provinces', id }, { sel: true });
  }

  // ——— Brouillard (Web Worker) ———

  private startFog() {
    try {
      this.fogWorker = new Worker(new URL('./fog.worker.ts', import.meta.url), { type: 'module' });
      this.fogWorker.onmessage = (e: MessageEvent<FogResponse>) => {
        if (e.data.seq < this.fogSeq - 1) return;
        this.set('fog', {
          type: 'FeatureCollection',
          features: e.data.coordinates.length
            ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: e.data.coordinates } }]
            : [],
        });
      };
    } catch (e) {
      console.warn('Brouillard indisponible', e);
      this.fogWorker = null;
    }
  }

  private postTerritory(provinces: Record<string, ProvinceView>, me: NationId | null) {
    if (!this.fogWorker || !me) return;
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return;
    const polygons: [number, number][][][] = [];
    for (const f of geo.features) {
      const id = String(f.properties?.id ?? '');
      if (provinces[id]?.owner !== me) continue;
      const g = f.geometry;
      if (g.type === 'Polygon') polygons.push(g.coordinates as [number, number][][]);
      else if (g.type === 'MultiPolygon') polygons.push(...(g.coordinates as [number, number][][][]));
    }
    const msg: FogRequest = { type: 'territory', key: this.ownersKey, polygons };
    this.fogWorker.postMessage(msg);
  }

  private postSensors() {
    if (!this.fogWorker) return;
    const { me } = useGame.getState();
    const catalog = useWorld.getState().catalog;
    const circles: { c: LngLat; r: number }[] = [];
    for (const u of this.units) {
      if (u.owner !== me) continue;
      const r = (u.systemId && catalog[u.systemId]?.detectionRangeKm) || 0;
      if (r <= 0) continue;
      const p = this.positions.get(u.id) ?? u.pos;
      circles.push({ c: [Math.round(p[0] * 20) / 20, Math.round(p[1] * 20) / 20], r: Math.round(r) });
    }
    const key = circles.map((c) => `${c.c[0]},${c.c[1]},${c.r}`).join(';');
    if (key === this.fogKey) return;
    this.fogKey = key;
    const msg: FogRequest = { type: 'sensors', seq: ++this.fogSeq, circles: circles.slice(0, 400) };
    this.fogWorker.postMessage(msg);
  }

  // ——— Boucle à ~12 Hz ———

  private tick() {
    if (!this.ready) return;
    this.tickCount++;
    const tNow = gameNow();
    const anyMoving = this.units.some((u) => u.move && isMoving(u, tNow));
    if (this.unitsDirty || anyMoving) {
      this.unitsDirty = false;
      const { view, me } = useGame.getState();
      const ui = useUi.getState();
      const catalog = useWorld.getState().catalog;
      for (const u of this.units) this.positions.set(u.id, unitPosition(u, tNow));
      this.set(
        'units',
        unitFeatures(this.units, {
          me,
          nations: view?.nations ?? {},
          catalog,
          selection: new Set(ui.selection),
          target: ui.pendingOrder?.kind === 'attack' ? ui.pendingOrder.targetId : ui.inspected,
          t: tNow,
        }),
      );
    }
    // Trajectoires, portée et aperçu : ~4 Hz.
    if (this.tickCount % 3 === 0) {
      this.refreshPaths(tNow);
      if (anyMoving) this.refreshSelection();
      this.refreshCallouts();
    }
    if (this.tickCount % Math.round(UNIT_TICK_HZ * 2) === 1) {
      this.postSensors();
      this.updateObstacles();
    }
  }

  private refreshPaths(tNow: number) {
    const { me } = useGame.getState();
    const p = pathFeatures(this.units, tNow, me, new Set(useUi.getState().selection));
    this.set('paths', p.lines);
    this.set('path-heads', p.heads);
  }

  private refreshSelection() {
    if (!this.ready) return;
    const { view } = useGame.getState();
    const ui = useUi.getState();
    const catalog = useWorld.getState().catalog;
    const first = ui.selection[0] ?? ui.inspected;
    const u = first ? view?.units[first] : undefined;
    const sys = u?.systemId ? catalog[u.systemId] : undefined;
    const routes: OverlayContent['routes'] = [];
    const badges: OverlayContent['badges'] = [];
    if (u && sys && u.level !== 'detected') {
      const at = this.positions.get(u.id) ?? unitPosition(u, gameNow());
      this.set('range', rangeRing(at, sys.weaponRangeKm.min, sys.weaponRangeKm.max));
      const lines: Feature<LineString>[] = [circleLine(at, sys.weaponRangeKm.max, 'max')];
      if (sys.weaponRangeKm.min > 0.5) lines.push(circleLine(at, sys.weaponRangeKm.min, 'min'));
      if (sys.operationalRadiusKm && sys.operationalRadiusKm > sys.weaponRangeKm.max) {
        lines.push(circleLine(at, sys.operationalRadiusKm, 'radius'));
      }
      this.set('range-lines', fc(lines));
    } else {
      this.set('range', EMPTY);
      this.set('range-lines', EMPTY);
    }

    const pending = ui.pendingOrder;
    if (pending && view) {
      const from = pending.unitIds
        .map((id) => this.positions.get(id) ?? (view.units[id] ? unitPosition(view.units[id], gameNow()) : undefined))
        .filter((p): p is LngLat => !!p);
      const target = pending.kind === 'move' ? pending.to : (this.positions.get(pending.targetId) ?? view.units[pending.targetId]?.pos);
      if (from.length && target) {
        const pv = previewFeatures({ kind: pending.kind, from, to: target });
        this.set('preview', pv.lines);
        this.set('preview-pts', pv.points);
        const main = pv.lines.features[0];
        if (main) routes.push({ id: 'preview', coords: main.geometry.coordinates as LngLat[], text: fmtKm(pv.distanceKm) });
        if (pending.kind === 'attack') from.forEach((f, i) => badges.push({ at: f, n: i + 1 }));
      }
    } else {
      this.set('preview', EMPTY);
      this.set('preview-pts', EMPTY);
    }
    // Distance restante le long de la trajectoire de l'unité sélectionnée.
    if (!pending && u && u.owner === useGame.getState().me && u.move && isMoving(u, gameNow())) {
      const p = pathFeatures([u], gameNow(), u.owner, new Set([u.id])).lines.features[0];
      if (p) {
        const coords = p.geometry.coordinates as LngLat[];
        let km = 0;
        for (let i = 1; i < coords.length; i++) km += distanceKm(coords[i - 1]!, coords[i]!);
        routes.push({ id: `path:${u.id}`, coords, text: fmtKm(km) });
      }
    }
    this.overlayContent = { ...this.overlayContent, routes, badges };
    this.map.triggerRepaint();
  }

  private refreshCallouts() {
    if (!this.ready || this.opts.mode === 'picker') return;
    const { view, me } = useGame.getState();
    if (!view) return;
    const ui = useUi.getState();
    const w = useWorld.getState();
    this.overlayContent = {
      ...this.overlayContent,
      callouts: buildCallouts({
        view,
        me,
        catalog: w.catalog,
        defs: w.provinces,
        selection: ui.selection,
        inspected: ui.inspected,
        pending: ui.pendingOrder,
        positions: this.positions,
        zoom: this.map.getZoom(),
        t: gameNow(),
      }),
    };
    this.map.triggerRepaint();
  }

  /** Les panneaux d'interface marqués `data-map-avoid` sont évités par les étiquettes. */
  private updateObstacles() {
    const base = this.container.getBoundingClientRect();
    const rects = [...document.querySelectorAll<HTMLElement>('[data-map-avoid]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }));
    this.overlay.obstacles = rects;
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }) {
    this.overlay.insets = insets;
    this.map.triggerRepaint();
  }

  // ——— Interactions ———

  private hitFeatures(e: MapMouseEvent, layers: string[]): MapGeoJSONFeature[] {
    const r = this.lastPointer === 'mouse' ? MOUSE_RADIUS : TOUCH_RADIUS;
    const existing = layers.filter((l) => this.map.getLayer(l));
    if (!existing.length) return [];
    const feats = this.map.queryRenderedFeatures(
      [
        [e.point.x - r, e.point.y - r],
        [e.point.x + r, e.point.y + r],
      ],
      { layers: existing },
    );
    // Le plus proche du point touché d'abord.
    return feats
      .map((f) => {
        const g = f.geometry as Geometry;
        const c = g.type === 'Point' ? (g.coordinates as [number, number]) : null;
        const p = c ? this.map.project(c) : e.point;
        return { f, d: Math.hypot(p.x - e.point.x, p.y - e.point.y) };
      })
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  }

  private onHover(e: MapMouseEvent) {
    if (!this.ready) return;
    const layers = this.opts.mode === 'picker' ? ['prov-fill'] : ['units-hex', 'cluster-hex'];
    const hit = this.hitFeatures(e, layers).length > 0;
    this.map.getCanvas().style.cursor = hit ? 'pointer' : this.opts.mode === 'picker' ? '' : useUi.getState().selection.length ? 'crosshair' : '';
  }

  private onClick(e: MapMouseEvent) {
    const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
    if (this.opts.mode === 'picker') {
      const f = this.map.queryRenderedFeatures(e.point, { layers: ['prov-fill'] })[0];
      const id = f ? String(f.properties?.id ?? f.id ?? '') : '';
      const nation = useWorld.getState().provinces[id]?.nationId;
      if (nation) this.opts.onPickNation?.(nation);
      return;
    }
    if (this.opts.placing?.()) {
      this.opts.onPlace?.(at);
      return;
    }
    const ui = useUi.getState();
    const { view } = useGame.getState();
    const hits = this.hitFeatures(e, ['units-hex', 'cluster-hex']);
    const first = hits[0];
    if (first && first.properties?.cluster) {
      const src = this.src('units');
      const clusterId = Number(first.properties.cluster_id);
      void src?.getClusterExpansionZoom(clusterId).then((z) => {
        const g = first.geometry as Geometry;
        if (g.type === 'Point') this.map.easeTo({ center: g.coordinates as [number, number], zoom: z + 0.3 });
      });
      return;
    }
    if (first) {
      const id = String(first.properties?.id);
      const u = view?.units[id];
      if (!u) return;
      if (u.level === 'own') {
        const multi = e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        if (multi) {
          const has = ui.selection.includes(id);
          ui.select(has ? ui.selection.filter((x) => x !== id) : [...ui.selection, id]);
        } else if (ui.selection.length && ui.selection[0] !== id && u.owner !== useGame.getState().me) {
          // Bac à sable : unité d'une autre nation commandable → attaque si une sélection existe.
          ui.setPending({ kind: 'attack', unitIds: ui.selection, targetId: id });
        } else {
          ui.select([id]);
        }
      } else if (ui.selection.length) {
        ui.setPending({ kind: 'attack', unitIds: ui.selection, targetId: id });
      } else {
        ui.inspect(id);
      }
      return;
    }
    if (ui.selection.length) {
      ui.setPending({ kind: 'move', unitIds: ui.selection, to: at });
      return;
    }
    // Aucune sélection : sélection de la province (production), fin d'inspection.
    const pf = this.map.queryRenderedFeatures(e.point, { layers: ['prov-fill'] })[0];
    ui.inspect(null);
    ui.selectProvince(pf ? String(pf.properties?.id ?? pf.id ?? '') || null : null);
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.unsubs.forEach((u) => u());
    this.fogWorker?.terminate();
    this.resizeObs?.disconnect();
    this.map.remove();
  }
}

