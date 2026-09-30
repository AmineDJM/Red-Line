/**
 * Contrôleur de la carte : crée la carte MapLibre, alimente les sources depuis les stores
 * (Zustand, hors React) par mises à jour groupées et différentielles, met à jour les positions
 * interpolées à ~12 Hz (pas à chaque image), regroupe les pions selon le zoom, anime les ordres,
 * gère les gestes « sélectionner → ordonner → confirmer », la sélection par rectangle et les
 * infobulles (survol, appui long).
 */
import {
  Map as MlMap,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { Protocol } from 'pmtiles';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson';
import {
  destination,
  distanceKm,
  type LngLat,
  type NationId,
  type ProvinceView,
  type UnitId,
  type UnitView,
} from '@redline/shared';
import { MAX_CALLOUTS, UNIT_TICK_HZ } from '../config.js';
import { fmtDuration, fmtKm, t } from '../i18n/index.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { dashSequence, pulse } from './animations.js';
import { computeBorders } from './borders.js';
import { buildCallouts } from './calloutContent.js';
import {
  EMPTY,
  VIOLET,
  attackLinkFeatures,
  buildingFeatures,
  circleLine,
  cityClassThresholds,
  cityFeatures,
  fc,
  intelFeatures,
  isRadarSystem,
  missileFeatures,
  nationLabelFeatures,
  orbitFeatures,
  pathFeatures,
  previewFeatures,
  provinceMarkerFeatures,
  radarFeatures,
  rangeRing,
  satelliteFeatures,
  tokenFeatures,
  uncertaintyFeatures,
  unitInfos,
  type UnitInfo,
} from './features.js';
import { flags } from './flagCache.js';
import type { FogRequest, FogResponse } from './fog.worker.js';
import { isMoving, unitPosition } from './interpolation.js';
import { useMapLayers } from './layers.js';
import { OverlayRenderer, type OverlayContent, type RingLabel } from './overlay.js';
import { SPRITE_RATIO, drawPion, parsePionKey, resolveSprite } from './pions.js';
import { SourceSync } from './sourceSync.js';
import { SPRITES_MARK, handleMissingImage, registerSprites } from './sprites.js';
import {
  LAYER_GROUPS,
  buildStyle,
  revealOpacity,
  revealRingOpacity,
  type MapLayerGroup,
} from './style.js';
import { MapTooltip, tipModel, type TipTarget } from './tooltip.js';

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

/** Mesures de performance (diagnostic, `window.__rlMap.stats()`). */
export interface MapStats {
  units: number;
  pions: number;
  ticks: number;
  tickAvgMs: number;
  tickMaxMs: number;
  groupAvgMs: number;
  sprites: number;
  sync: { full: number; diff: number; skipped: number };
}

const TOUCH_RADIUS = 18;
const MOUSE_RADIUS = 6;
const LONG_PRESS_MS = 480;
const HOVER_DELAY_MS = 160;
const UNIT_LAYERS = ['focus-hex', 'units-hex', 'missiles'];
const CITY_LAYERS = ['cities-0', 'cities-1', 'cities-2', 'cities-3'];
/** Au-delà de cet étalement, toucher une pile zoome dessus au lieu de la sélectionner. */
const STACK_SPREAD_KM = 30;

const PATH_DASH = dashSequence(2, 2, 14);
const PREVIEW_DASH = dashSequence(2, 1.5, 14);
const CAPTURE_DASH = dashSequence(2, 1.5, 14);
const ORBIT_DASH = dashSequence(3, 2, 14);

export class GameMap {
  readonly map: MlMap;
  private overlay: OverlayRenderer;
  private tooltip: MapTooltip;
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private tickCount = 0;
  private provState = new Map<
    string,
    {
      color: string;
      mine: boolean;
      cap: number;
      disp: boolean;
      unrest: number;
      blk: boolean;
      nfz: boolean;
      intel: number;
    }
  >();
  private ownersKey = '';
  private units: UnitView[] = [];
  private infos: UnitInfo[] = [];
  private lastRefs: { units: unknown; provinces: unknown; me: NationId | null; sats: unknown } = {
    units: null,
    provinces: null,
    me: null,
    sats: null,
  };
  private unitsDirty = true;
  private groupZoom = -1;
  private positions = new Map<UnitId, LngLat>();
  private overlayContent: OverlayContent = { callouts: [], routes: [], badges: [], rings: [] };
  private fogWorker: Worker | null = null;
  private fogSeq = 0;
  private fogKey = '';
  private lastPointer: 'mouse' | 'touch' | 'pen' = 'mouse';
  private selectedProvince: string | null = null;
  private pickedNation: NationId | null = null;
  private resizeObs: ResizeObserver | null = null;
  private fitted = false;
  private syncs: Record<'units' | 'focus' | 'headings' | 'missiles' | 'buildings', SourceSync>;
  private sprites = new Map<string, number>();
  private usedImages = new Set<string>();
  private gcCounter = 0;
  private knownBuildings = new Map<string, Set<string>>();
  private revealIds: string[] = [];
  private revealStart = 0;
  private animState = { paths: false, preview: false, capture: false, orbits: false, missiles: false };
  private animStep = 0;
  private animationsOn =
    typeof window === 'undefined' ||
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverKey = '';
  private longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  private suppressClickUntil = 0;
  private box: { x0: number; y0: number; el: HTMLDivElement } | null = null;
  private domListeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
  private cityThresholds: [number, number] = [Infinity, Infinity];
  /** Diagnostic : nombre de résolutions demandées par image. */
  readonly resolveCount = new Map<string, number>();
  private perf = { ticks: 0, total: 0, max: 0, group: 0, groups: 0, pions: 0 };

  constructor(
    private readonly container: HTMLElement,
    overlayCanvas: HTMLCanvasElement,
    private readonly opts: GameMapOptions,
  ) {
    setupMapLibre();
    const w = useWorld.getState();
    // Points d'étiquette des pays : fond vectoriel s'il existe, sinon calculés depuis les provinces.
    const labels =
      w.basemap?.countries ??
      nationLabelFeatures(
        Object.values(w.provinces),
        Object.fromEntries(Object.values(w.nations).map((n) => [n.id, n.name])),
      );
    this.cityThresholds = cityClassThresholds(Object.values(w.provinces));
    const hasProvinces = Object.keys(w.provinces).length > 0;
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
        cities: hasProvinces
          ? cityFeatures(w.provinces, null, {
              me: null,
              nations: {},
              thresholds: this.cityThresholds,
            })
          : null,
      }),
      center: [15, 30],
      zoom: 2.2,
      minZoom: 1.2,
      maxZoom: 11,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      boxZoom: false,
      renderWorldCopies: true,
      attributionControl: { compact: true },
      fadeDuration: 150,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    const src = (id: string) => () => this.src(id);
    this.syncs = {
      units: new SourceSync(src('units')),
      focus: new SourceSync(src('units-focus')),
      headings: new SourceSync(src('headings')),
      missiles: new SourceSync(src('missiles')),
      buildings: new SourceSync(src('buildings')),
    };
    // Sprites composites générés à la demande (pions, bâtiments, villes) ; la promesse est attendue
    // par MapLibre (drapeaux chargés avant le premier dessin d'un pion).
    this.map.setMissingStyleImageResolver(async (id) => {
      this.resolveCount.set(id, (this.resolveCount.get(id) ?? 0) + 1);
      if (!this.map.hasImage(SPRITES_MARK)) registerSprites(this.map);
      if (this.map.hasImage(id)) return;
      const ok = await resolveSprite(id, (k, img) => {
        if (!this.map.hasImage(k)) this.map.addImage(k, img, { pixelRatio: SPRITE_RATIO });
        this.sprites.set(k, this.gcCounter);
      });
      if (!ok) handleMissingImage(this.map, id);
    });
    this.unsubs.push(flags.onReady((nation) => this.redrawNation(nation)));
    this.map.on('style.load', () => {
      if (!this.map.hasImage(SPRITES_MARK)) registerSprites(this.map);
    });
    this.map.on('error', (e) => {
      // Tuiles ou fichiers facultatifs absents : jamais bloquant.
      console.warn('[carte]', e.error?.message ?? e);
    });
    this.overlay = new OverlayRenderer(overlayCanvas, this.map);
    this.overlay.maxCallouts = MAX_CALLOUTS;
    this.tooltip = new MapTooltip(container);
    this.map.on('load', () => this.onLoad());
    const drawOverlay = () => this.overlay.draw(this.overlayContent);
    this.map.on('render', drawOverlay);
    // Un saut de caméra programmé (centrage sur une alerte…) ne produit pas toujours d'image :
    // la surcouche est aussi redessinée sur les mouvements, sinon elle resterait figée.
    this.map.on('move', drawOverlay);
    this.map.on('moveend', drawOverlay);
    this.map.on('zoom', () => this.onZoom(false));
    this.map.on('zoomend', () => {
      this.onZoom(true);
      this.refreshCallouts();
    });
    this.map.on('movestart', () => this.tooltip.hide());
    this.resizeObs = new ResizeObserver(() => {
      this.overlay.resize();
      this.map.resize();
    });
    this.resizeObs.observe(container);
    this.pickedNation = opts.pickedNation ?? null;
  }

  // ——— API publique ———

  /** Affiche ou masque un groupe de calques (voir `LAYER_GROUPS`). */
  setLayerGroup(group: MapLayerGroup, visible: boolean) {
    if (!this.ready) return;
    for (const id of LAYER_GROUPS[group]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    if (group === 'intel') this.refreshIntelLayer();
  }

  /**
   * Active ou coupe les animations (tirets qui défilent, pulsations). Coupées d'office si
   * l'utilisateur a demandé moins d'animations (prefers-reduced-motion).
   */
  setAnimations(on: boolean) {
    this.animationsOn = on;
  }

  /** Mesures de performance cumulées depuis le dernier appel à `resetStats`. */
  stats(): MapStats {
    const p = this.perf;
    const sum = (k: 'full' | 'diff' | 'skipped') =>
      Object.values(this.syncs).reduce((a, s) => a + s.stats[k], 0);
    return {
      units: this.units.length,
      pions: p.pions,
      ticks: p.ticks,
      tickAvgMs: p.ticks ? p.total / p.ticks : 0,
      tickMaxMs: p.max,
      groupAvgMs: p.groups ? p.group / p.groups : 0,
      sprites: this.sprites.size,
      sync: { full: sum('full'), diff: sum('diff'), skipped: sum('skipped') },
    };
  }

  resetStats() {
    this.perf = { ticks: 0, total: 0, max: 0, group: 0, groups: 0, pions: this.perf.pions };
  }

  /** Centre la carte sur une unité (et la sélectionne si `select`). */
  focusUnit(id: UnitId, zoom = 6) {
    const u = useGame.getState().view?.units[id];
    if (!u) return;
    this.map.flyTo({ center: this.positions.get(id) ?? u.pos, zoom: Math.max(this.map.getZoom(), zoom) });
  }

  // ——— Initialisation ———

  private onLoad() {
    if (!this.map.hasImage(SPRITES_MARK)) registerSprites(this.map);
    this.ready = true;
    this.map.on('click', (e) => this.onClick(e));
    this.map.on('mousemove', (e) => this.onHover(e));
    this.map.on('mouseout', () => this.clearHover());
    this.listen(this.container, 'pointerdown', (e) => {
      this.lastPointer = (e as PointerEvent).pointerType as 'mouse';
    }, { capture: true });
    this.setupBoxSelect();
    this.setupLongPress();

    const layers = useMapLayers.getState().visible;
    for (const g of Object.keys(layers) as MapLayerGroup[]) this.setLayerGroup(g, layers[g]);
    this.unsubs.push(
      useMapLayers.subscribe((s, prev) => {
        for (const g of Object.keys(s.visible) as MapLayerGroup[])
          if (s.visible[g] !== prev.visible[g]) this.setLayerGroup(g, s.visible[g]);
      }),
    );

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
        if (
          s.selection !== prev.selection ||
          s.pendingOrder !== prev.pendingOrder ||
          s.inspected !== prev.inspected
        ) {
          this.unitsDirty = true;
          this.refreshSelection();
          this.refreshCallouts();
          this.refreshPaths(gameNow());
        }
        if (s.focus !== prev.focus && s.focus) {
          this.map.flyTo({
            center: s.focus.at,
            zoom: Math.max(this.map.getZoom(), s.focus.zoom ?? 5.2),
            speed: 1.4,
          });
        }
        if (s.selectedProvince !== prev.selectedProvince)
          this.highlightProvince(s.selectedProvince);
      }),
    );
    this.onView();
    this.timer = setInterval(() => this.tick(), Math.round(1000 / UNIT_TICK_HZ));
    this.animTimer = setInterval(() => this.animate(), 70);
  }

  private listen(
    target: EventTarget,
    type: string,
    fn: EventListener,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, fn, opts);
    this.domListeners.push([target, type, fn, opts]);
  }

  private src(id: string): GeoJSONSource | undefined {
    return this.map.getSource(id) as GeoJSONSource | undefined;
  }

  private emptySources = new Set<string>();

  /** Remplace les données d'une source (sauf vide → vide, qui ne ferait que recharger). */
  private set(id: string, data: FeatureCollection) {
    const empty = data.features.length === 0;
    if (empty && this.emptySources.has(id)) return;
    if (empty) this.emptySources.add(id);
    else this.emptySources.delete(id);
    void this.src(id)?.setData(data);
  }

  // ——— Sélecteur de nation (nouvelle partie) ———

  private applyPicker() {
    const w = useWorld.getState();
    for (const p of Object.values(w.provinces)) {
      const n = w.nations[p.nationId];
      this.map.setFeatureState(
        { source: 'provinces', id: p.id },
        {
          color: p.nationId === this.pickedNation ? VIOLET : (n?.color ?? '#3a4252'),
          pick: p.nationId === this.pickedNation,
        },
      );
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
    // Ne recalcule que ce qui a changé (les diffs partagent les parties inchangées par référence).
    const unitsChanged = view.units !== this.lastRefs.units || me !== this.lastRefs.me;
    const provincesChanged = view.provinces !== this.lastRefs.provinces || me !== this.lastRefs.me;
    const satsChanged = view.satellites !== this.lastRefs.sats;
    this.lastRefs = { units: view.units, provinces: view.provinces, me, sats: view.satellites };
    const tNow = gameNow();
    if (unitsChanged) {
      this.units = Object.values(view.units);
      this.unitsDirty = true;
      // Drapeaux des nations présentes : chargés en amont (le premier pion attend moins).
      for (const u of this.units) void flags.load(u.owner);
      this.set('uncert', uncertaintyFeatures(this.units, tNow, me));
      this.set(
        'radar',
        radarFeatures(this.units, { me, catalog: useWorld.getState().catalog, t: tNow }),
      );
      this.refreshOrbits();
    }
    if (provincesChanged) {
      this.applyProvinces(view.provinces, me);
      const w = useWorld.getState();
      const provs = Object.values(view.provinces);
      this.detectReveals(view.provinces, me);
      this.syncs.buildings.push(
        buildingFeatures(provs, { me, nations: view.nations, defs: w.provinces, t: tNow }).features,
      );
      this.set(
        'prov-markers',
        provinceMarkerFeatures(provs, w.provinces),
      );
      this.refreshIntelLayer();
    }
    if (satsChanged) this.set('satellites', satelliteFeatures(view.satellites, tNow));
    if (!this.fitted && me) this.fitNation(me);
    this.refreshSelection();
    this.refreshCallouts();
  }

  private refreshIntelLayer() {
    if (!this.ready || !useMapLayers.getState().visible.intel) {
      this.set('intel-badges', EMPTY);
      return;
    }
    const { view } = useGame.getState();
    if (!view) return;
    this.set(
      'intel-badges',
      intelFeatures(Object.values(view.provinces), useWorld.getState().provinces, gameNow()),
    );
  }

  /**
   * Bâtiments nouvellement révélés par le renseignement (province étrangère) : fondu et anneau
   * animés pendant ~1,6 s (feature-state `reveal`).
   */
  private detectReveals(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const fresh: string[] = [];
    const first = this.knownBuildings.size === 0;
    for (const p of Object.values(provinces)) {
      if (p.owner === me) continue;
      const prev = this.knownBuildings.get(p.id);
      const now = new Set(p.buildings);
      if (prev && p.intel) for (const b of now) if (!prev.has(b)) fresh.push(`${p.id}:${b}`);
      this.knownBuildings.set(p.id, now);
    }
    if (first || !fresh.length) return;
    this.revealIds.forEach((id) =>
      this.map.setFeatureState({ source: 'buildings', id }, { reveal: false }),
    );
    this.revealIds = fresh;
    this.revealStart = performance.now();
    fresh.forEach((id) => this.map.setFeatureState({ source: 'buildings', id }, { reveal: true }));
  }

  private applyProvinces(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const { view } = useGame.getState();
    const nations = view?.nations ?? {};
    let ownersChanged = false;
    let anyCapture = false;
    for (const p of Object.values(provinces)) {
      const mine = p.owner === me;
      const color = mine
        ? VIOLET
        : (nations[p.owner]?.color ?? useWorld.getState().nations[p.owner]?.color ?? '#3a4252');
      const cap = p.capture ? (p.owner === me ? 2 : 1) : 0;
      if (cap) anyCapture = true;
      const next = {
        color,
        mine,
        cap,
        disp: !!p.disputedId,
        unrest: Math.round(p.unrest ?? 0),
        blk: !!p.blockaded,
        nfz: !!p.noFlyZone,
        intel: mine || !p.intel ? -1 : p.intel.level,
      };
      const prev = this.provState.get(p.id);
      if (
        !prev ||
        prev.color !== next.color ||
        prev.mine !== next.mine ||
        prev.cap !== next.cap ||
        prev.disp !== next.disp ||
        prev.unrest !== next.unrest ||
        prev.blk !== next.blk ||
        prev.nfz !== next.nfz ||
        prev.intel !== next.intel
      ) {
        this.map.setFeatureState({ source: 'provinces', id: p.id }, next);
        this.provState.set(p.id, next);
        if (!prev || prev.mine !== mine || prev.color !== color) ownersChanged = true;
      }
    }
    this.animState.capture = anyCapture;
    this.set('capture', this.captureFeatures(provinces, me));
    if (ownersChanged) {
      const key = Object.values(provinces)
        .map((p) => p.owner)
        .join(',');
      if (key !== this.ownersKey) {
        this.ownersKey = key;
        this.updateBorders(provinces, me);
        this.postTerritory(provinces, me);
        const w = useWorld.getState();
        this.set(
          'cities',
          cityFeatures(w.provinces, provinces, {
            me,
            nations: useGame.getState().view?.nations ?? {},
            thresholds: this.cityThresholds,
          }),
        );
      }
    }
  }

  private geoIndex: Map<string, Feature> | null = null;

  /** Contours des provinces en cours de capture (source dédiée, animée). */
  private captureFeatures(provinces: Record<string, ProvinceView>, me: NationId | null): FeatureCollection {
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return EMPTY;
    if (!this.geoIndex)
      this.geoIndex = new Map(geo.features.map((f) => [String(f.properties?.id ?? f.id ?? ''), f]));
    const out: Feature[] = [];
    for (const p of Object.values(provinces)) {
      if (!p.capture) continue;
      const f = this.geoIndex.get(p.id);
      if (f) out.push({ type: 'Feature', properties: { id: p.id, cap: p.owner === me ? 2 : 1 }, geometry: f.geometry });
    }
    return { type: 'FeatureCollection', features: out };
  }

  private updateBorders(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return;
    const b = computeBorders(
      geo,
      (id) => provinces[id]?.owner ?? useWorld.getState().provinces[id]?.nationId,
      me,
    );
    this.set('borders', b.nations);
    this.set('my-border', b.mine);
  }

  private highlightProvince(id: string | null) {
    if (!this.ready) return;
    if (this.selectedProvince)
      this.map.setFeatureState({ source: 'provinces', id: this.selectedProvince }, { sel: false });
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
            ? [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'MultiPolygon', coordinates: e.data.coordinates },
                },
              ]
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
      else if (g.type === 'MultiPolygon')
        polygons.push(...(g.coordinates as [number, number][][][]));
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
      const sys = u.systemId ? catalog[u.systemId] : undefined;
      const r = sys?.sensor?.rangeKm ?? sys?.detectionRangeKm ?? 0;
      if (r <= 0) continue;
      const p = this.positions.get(u.id) ?? u.pos;
      circles.push({
        c: [Math.round(p[0] * 20) / 20, Math.round(p[1] * 20) / 20],
        r: Math.round(Math.min(r, 3000)),
      });
    }
    const key = circles.map((c) => `${c.c[0]},${c.c[1]},${c.r}`).join(';');
    if (key === this.fogKey) return;
    this.fogKey = key;
    const msg: FogRequest = { type: 'sensors', seq: ++this.fogSeq, circles: circles.slice(0, 400) };
    this.fogWorker.postMessage(msg);
  }

  // ——— Boucle à ~12 Hz ———

  private quantZoom() {
    return Math.round(this.map.getZoom() * 4) / 4;
  }

  private onZoom(end: boolean) {
    if (!this.ready || this.opts.mode === 'picker') return;
    const z = this.quantZoom();
    if (z !== this.groupZoom && (end || Math.abs(z - this.groupZoom) >= 0.5)) {
      this.unitsDirty = true;
      if (end) this.updateUnits(gameNow());
    }
  }

  private tick() {
    if (!this.ready) return;
    const t0 = performance.now();
    this.tickCount++;
    const tNow = gameNow();
    const anyMoving = this.units.some((u) => u.move && isMoving(u, tNow));
    if (this.unitsDirty || anyMoving) this.updateUnits(tNow);
    // Trajectoires, portée et aperçu : ~4 Hz.
    if (this.tickCount % 3 === 0) {
      if (anyMoving) {
        this.refreshPaths(tNow);
        this.refreshSelection();
      }
      this.refreshCallouts();
    }
    if (this.tickCount % Math.round(UNIT_TICK_HZ * 2) === 1) {
      this.postSensors();
      this.updateObstacles();
    }
    if (this.tickCount % (UNIT_TICK_HZ * 20) === 0) this.collectSprites();
    const dt = performance.now() - t0;
    this.perf.ticks++;
    this.perf.total += dt;
    this.perf.max = Math.max(this.perf.max, dt);
  }

  private updateUnits(tNow: number) {
    this.unitsDirty = false;
    const { view, me } = useGame.getState();
    const ui = useUi.getState();
    const catalog = useWorld.getState().catalog;
    const nations = view?.nations ?? {};
    this.infos = unitInfos(this.units, {
      me,
      nations,
      catalog,
      selection: new Set(ui.selection),
      target: ui.pendingOrder?.kind === 'attack' ? ui.pendingOrder.targetId : ui.inspected,
      t: tNow,
    });
    for (const i of this.infos) this.positions.set(i.id, i.pos);
    this.groupZoom = this.quantZoom();
    const g0 = performance.now();
    const r = tokenFeatures(this.infos, {
      nations,
      zoom: this.groupZoom,
      group: this.opts.mode === 'game',
    });
    this.perf.group += performance.now() - g0;
    this.perf.groups++;
    this.perf.pions = r.tokens.length + r.focus.length;
    this.syncs.units.push(r.tokens);
    this.syncs.focus.push(r.focus);
    this.syncs.headings.push(r.headings);
    this.syncs.missiles.push(r.missiles);
    for (const f of r.tokens) this.usedImages.add(String(f.properties!.img));
    for (const f of r.focus) this.usedImages.add(String(f.properties!.img));
    // Traînées des aéronefs et missiles en vol.
    const m = missileFeatures(this.units, tNow, me);
    this.set('trails', m.trails);
    this.set('missile-ahead', m.ahead);
    this.set('impacts', m.impacts);
    this.animState.missiles = m.ahead.features.length > 0;
  }

  /** Pions d'une nation dessinés avant l'arrivée de son drapeau : redessinés en place. */
  private redrawNation(nation: string) {
    if (!this.ready) return;
    const prefix = `pion|${nation}|`;
    for (const id of this.sprites.keys()) {
      if (!id.startsWith(prefix) || !this.map.hasImage(id)) continue;
      const spec = parsePionKey(id);
      if (spec) this.map.updateImage(id, drawPion(spec));
    }
  }

  /** Libère les images de pions inutilisées depuis deux cycles (≈ 40 s). */
  private collectSprites() {
    this.gcCounter++;
    for (const id of this.usedImages) if (this.sprites.has(id)) this.sprites.set(id, this.gcCounter);
    this.usedImages.clear();
    for (const [id, seen] of this.sprites) {
      if (!id.startsWith('pion|') || this.gcCounter - seen < 2) continue;
      if (this.map.hasImage(id)) this.map.removeImage(id);
      this.sprites.delete(id);
    }
  }

  private refreshPaths(tNow: number) {
    const { me, view } = useGame.getState();
    const sel = new Set(useUi.getState().selection);
    const p = pathFeatures(this.units, tNow, me, sel);
    this.set('paths', p.lines);
    this.set('path-heads', p.heads);
    this.animState.paths = p.lines.features.length > 0;
    this.set(
      'attack-links',
      view ? attackLinkFeatures(view.units, this.positions, me) : EMPTY,
    );
  }

  private refreshOrbits() {
    const { me } = useGame.getState();
    const o = orbitFeatures(this.units, me, new Set(useUi.getState().selection));
    this.set('orbits', o.lines);
    this.set('orbit-pts', o.points);
    this.animState.orbits = o.lines.features.length > 0;
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
    const rings: RingLabel[] = [];
    if (u && sys && u.level !== 'detected') {
      const at = this.positions.get(u.id) ?? unitPosition(u, gameNow());
      const max = sys.weaponRangeKm.max;
      this.set('range', rangeRing(at, sys.weaponRangeKm.min, max));
      const lines: Feature<LineString>[] = [];
      if (max > 0.5) {
        lines.push(circleLine(at, max, 'max'));
        rings.push({ at: destination(at, 0, max), text: t('map.ring.max', { value: fmtKm(max) }) });
      }
      if (sys.weaponRangeKm.min > 0.5) {
        lines.push(circleLine(at, sys.weaponRangeKm.min, 'min'));
        rings.push({
          at: destination(at, 180, sys.weaponRangeKm.min),
          text: t('map.ring.min', { value: fmtKm(sys.weaponRangeKm.min) }),
        });
      }
      if (sys.operationalRadiusKm && sys.operationalRadiusKm > max) {
        lines.push(circleLine(at, sys.operationalRadiusKm, 'radius'));
        rings.push({
          at: destination(at, 0, sys.operationalRadiusKm),
          text: t('map.ring.radius', { value: fmtKm(sys.operationalRadiusKm) }),
        });
      }
      this.set('range-lines', fc(lines));
      // Zone de détection (radar, sonar…), plus large que la portée des armes.
      const det = sys.sensor?.rangeKm ?? sys.detectionRangeKm;
      if (det > max * 1.05 && det > 1) {
        this.set('detect', fc([circleLine(at, det, 'detect')]));
        const kind = sys.sensor?.kind;
        const key =
          kind === 'sonar' ? 'sonar' : isRadarSystem(sys) ? 'radar' : 'sensor';
        rings.push({
          at: destination(at, 0, det),
          text: t(`map.ring.${key}`, { value: fmtKm(det) }),
          tone: 'cyan',
        });
      } else this.set('detect', EMPTY);
    } else {
      this.set('range', EMPTY);
      this.set('range-lines', EMPTY);
      this.set('detect', EMPTY);
    }

    const pending = ui.pendingOrder;
    if (pending && view) {
      const from = pending.unitIds
        .map(
          (id) =>
            this.positions.get(id) ??
            (view.units[id] ? unitPosition(view.units[id], gameNow()) : undefined),
        )
        .filter((p): p is LngLat => !!p);
      const target =
        pending.kind === 'move'
          ? pending.to
          : (this.positions.get(pending.targetId) ?? view.units[pending.targetId]?.pos);
      if (from.length && target) {
        const pv = previewFeatures({ kind: pending.kind, from, to: target });
        this.set('preview', pv.lines);
        this.set('preview-pts', pv.points);
        this.animState.preview = true;
        const main = pv.lines.features[0];
        let text = fmtKm(pv.distanceKm);
        const speeds = pending.unitIds
          .map((id) => view.units[id]?.systemId)
          .map((s) => (s ? catalog[s]?.speedKmh : undefined))
          .filter((v): v is number => !!v && v > 0);
        if (pending.kind === 'move' && speeds.length) {
          const eta = (pv.distanceKm / Math.min(...speeds)) * 3600_000;
          text = t('map.order.eta', { distance: text, eta: fmtDuration(eta) });
        }
        if (main)
          routes.push({
            id: 'preview',
            coords: main.geometry.coordinates as LngLat[],
            text,
            tone: pending.kind === 'attack' ? 'amber' : 'cyan',
          });
        if (pending.kind === 'attack') from.forEach((f, i) => badges.push({ at: f, n: i + 1 }));
      }
    } else {
      this.set('preview', EMPTY);
      this.set('preview-pts', EMPTY);
      this.animState.preview = false;
    }
    // Distance restante le long de la trajectoire de l'unité sélectionnée.
    if (!pending && u && u.owner === useGame.getState().me && u.move && isMoving(u, gameNow())) {
      const p = pathFeatures([u], gameNow(), u.owner, new Set([u.id])).lines.features[0];
      if (p) {
        const coords = p.geometry.coordinates as LngLat[];
        let km = 0;
        for (let i = 1; i < coords.length; i++) km += distanceKm(coords[i - 1]!, coords[i]!);
        const end = u.move.legs[u.move.legs.length - 1]!.t1;
        routes.push({
          id: `path:${u.id}`,
          coords,
          text: `${fmtKm(km)} · ${fmtDuration(Math.max(0, end - gameNow()))}`,
          tone: 'cyan',
        });
      }
    }
    this.overlayContent = { ...this.overlayContent, routes, badges, rings };
    this.map.triggerRepaint();
  }

  private refreshCallouts() {
    if (!this.ready || this.opts.mode === 'picker') return;
    const { view, me } = useGame.getState();
    if (!view) return;
    const ui = useUi.getState();
    const w = useWorld.getState();
    const icons: LngLat[] = [];
    for (const u of this.infos) icons.push(u.pos);
    const b = this.map.getBounds();
    this.overlayContent = {
      ...this.overlayContent,
      icons,
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
        inView: (p: LngLat) => b.contains(p as [number, number]),
      }),
    };
    this.map.triggerRepaint();
  }

  // ——— Animations (tirets qui défilent, pulsations, révélations) ———

  private animate() {
    if (!this.ready || document.hidden || !this.animationsOn) return;
    const a = this.animState;
    const reveal = this.revealIds.length > 0;
    if (!a.paths && !a.preview && !a.capture && !a.orbits && !a.missiles && !reveal) return;
    const k = this.animStep++;
    const set = (id: string, prop: string, v: unknown) => {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, prop as never, v as never);
    };
    if (a.paths) set('paths', 'line-dasharray', PATH_DASH[k % PATH_DASH.length]);
    if (a.preview) set('preview', 'line-dasharray', PREVIEW_DASH[k % PREVIEW_DASH.length]);
    if (a.orbits) set('orbits', 'line-dasharray', ORBIT_DASH[(k >> 1) % ORBIT_DASH.length]);
    if (a.missiles) set('missile-ahead', 'line-dasharray', PATH_DASH[k % PATH_DASH.length]);
    if (a.capture) {
      const now = performance.now();
      set('capture', 'line-dasharray', CAPTURE_DASH[k % CAPTURE_DASH.length]);
      set('capture-fill', 'fill-opacity', pulse(now, 1800, 0.05, 0.16));
    }
    if (reveal) {
      const f = (performance.now() - this.revealStart) / 1600;
      if (f >= 1) {
        this.revealIds.forEach((id) =>
          this.map.setFeatureState({ source: 'buildings', id }, { reveal: false }),
        );
        this.revealIds = [];
        set('bld', 'icon-opacity', revealOpacity(1));
        set('bld-reveal', 'icon-opacity', revealRingOpacity(0));
      } else {
        set('bld', 'icon-opacity', revealOpacity(Math.min(1, f * 1.6)));
        set('bld-reveal', 'icon-opacity', revealRingOpacity(Math.sin(f * Math.PI)));
      }
    }
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

  private hitAt(
    x: number,
    y: number,
    layers: string[],
    radius = this.lastPointer === 'mouse' ? MOUSE_RADIUS : TOUCH_RADIUS,
  ): MapGeoJSONFeature[] {
    const existing = layers.filter((l) => this.map.getLayer(l));
    if (!existing.length) return [];
    const feats = this.map.queryRenderedFeatures(
      [
        [x - radius, y - radius],
        [x + radius, y + radius],
      ],
      { layers: existing },
    );
    // Le plus proche du point touché d'abord (centre visuel du pion, écartement compris).
    return feats
      .map((f) => {
        const g = f.geometry as Geometry;
        const c = g.type === 'Point' ? (g.coordinates as [number, number]) : null;
        const p = c ? this.map.project(c) : { x, y };
        const off = f.properties?.off;
        const o = typeof off === 'string' ? (JSON.parse(off) as number[]) : (off as number[] | undefined);
        const s = f.layer.id === 'missiles' ? 0 : 1;
        const px = p.x + (o?.[0] ?? 0) * s;
        const py = p.y + (o?.[1] ?? 0) * s;
        const focus = f.layer.id === 'focus-hex' ? -2 : 0;
        return { f, d: Math.hypot(px - x, py - y) + focus };
      })
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  }

  private tipTargetAt(x: number, y: number, radius?: number): { key: string; target: TipTarget } | null {
    const u = this.hitAt(x, y, UNIT_LAYERS, radius)[0];
    if (u) {
      const ids = String(u.properties?.members ?? u.properties?.id ?? '')
        .split(',')
        .filter(Boolean);
      return { key: `u:${ids.join(',')}`, target: { kind: 'units', ids } };
    }
    const b = this.hitAt(x, y, ['bld'], radius ?? 4)[0];
    if (b && this.map.getZoom() >= 5.8) {
      const prov = String(b.properties?.prov ?? '');
      const type = String(b.properties?.type ?? '');
      return { key: `b:${prov}:${type}`, target: { kind: 'building', provinceId: prov, type } };
    }
    const c = this.hitAt(x, y, CITY_LAYERS, radius ?? 5)[0];
    if (c && c.properties?.cls !== undefined) {
      const id = String(c.properties?.id ?? '');
      return { key: `c:${id}`, target: { kind: 'city', provinceId: id } };
    }
    return null;
  }

  private showTip(target: TipTarget, x: number, y: number) {
    const { view, me } = useGame.getState();
    if (!view) return;
    const w = useWorld.getState();
    const m = tipModel(target, { view, me, catalog: w.catalog, defs: w.provinces, t: gameNow() });
    if (m) this.tooltip.show(m, x, y);
    else this.tooltip.hide();
  }

  private clearHover() {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverKey = '';
    this.tooltip.hide();
  }

  private onHover(e: MapMouseEvent) {
    if (!this.ready || this.box) return;
    if (this.opts.mode === 'picker') {
      const hit = this.hitAt(e.point.x, e.point.y, ['prov-fill']).length > 0;
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
      return;
    }
    const hit = this.tipTargetAt(e.point.x, e.point.y);
    const onUnit = hit?.key.startsWith('u:');
    this.map.getCanvas().style.cursor = onUnit
      ? 'pointer'
      : useUi.getState().selection.length
        ? 'crosshair'
        : '';
    if (!hit) {
      this.clearHover();
      return;
    }
    if (hit.key === this.hoverKey) {
      this.tooltip.place(e.point.x, e.point.y);
      return;
    }
    this.hoverKey = hit.key;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    const { x, y } = e.point;
    if (this.tooltip.shown) this.showTip(hit.target, x, y);
    else this.hoverTimer = setTimeout(() => this.showTip(hit.target, x, y), HOVER_DELAY_MS);
  }

  /** Appui long (mobile) : infobulle de l'élément touché. */
  private setupLongPress() {
    const cancel = () => {
      if (this.longPress) clearTimeout(this.longPress.timer);
      this.longPress = null;
    };
    this.listen(
      this.container,
      'touchstart',
      (ev) => {
        const e = ev as TouchEvent;
        this.tooltip.hide();
        cancel();
        if (e.touches.length !== 1) return;
        const r = this.container.getBoundingClientRect();
        const x = e.touches[0]!.clientX - r.left;
        const y = e.touches[0]!.clientY - r.top;
        this.longPress = {
          x,
          y,
          timer: setTimeout(() => {
            this.longPress = null;
            const hit = this.tipTargetAt(x, y, TOUCH_RADIUS);
            if (!hit) return;
            this.suppressClickUntil = performance.now() + 700;
            this.showTip(hit.target, x, y);
            if (navigator.vibrate) navigator.vibrate(8);
          }, LONG_PRESS_MS),
        };
      },
      { passive: true },
    );
    this.listen(
      this.container,
      'touchmove',
      (ev) => {
        const e = ev as TouchEvent;
        if (!this.longPress) return;
        const r = this.container.getBoundingClientRect();
        const t0 = e.touches[0];
        if (
          !t0 ||
          Math.hypot(t0.clientX - r.left - this.longPress.x, t0.clientY - r.top - this.longPress.y) > 10
        )
          cancel();
      },
      { passive: true },
    );
    this.listen(this.container, 'touchend', cancel, { passive: true });
    this.listen(this.container, 'touchcancel', cancel, { passive: true });
  }

  /** Maj + glisser (ordinateur) : sélection de ses unités par rectangle. */
  private setupBoxSelect() {
    if (this.opts.mode === 'picker') return;
    const onDown = (ev: Event) => {
      const e = ev as MouseEvent;
      if (!e.shiftKey || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const r = this.container.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'rlm-box';
      this.container.appendChild(el);
      this.box = { x0: e.clientX - r.left, y0: e.clientY - r.top, el };
      this.tooltip.hide();
      const move = (me: MouseEvent) => {
        if (!this.box) return;
        const x = me.clientX - r.left;
        const y = me.clientY - r.top;
        const b = this.box;
        Object.assign(b.el.style, {
          left: `${Math.min(b.x0, x)}px`,
          top: `${Math.min(b.y0, y)}px`,
          width: `${Math.abs(x - b.x0)}px`,
          height: `${Math.abs(y - b.y0)}px`,
        });
      };
      const up = (ue: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (!this.box) return;
        const b = this.box;
        this.box = null;
        b.el.remove();
        const x1 = ue.clientX - r.left;
        const y1 = ue.clientY - r.top;
        if (Math.abs(x1 - b.x0) < 4 && Math.abs(y1 - b.y0) < 4) return;
        this.suppressClickUntil = performance.now() + 300;
        this.selectInRect(Math.min(b.x0, x1), Math.min(b.y0, y1), Math.max(b.x0, x1), Math.max(b.y0, y1), ue.ctrlKey || ue.metaKey);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
    this.listen(this.container, 'mousedown', onDown, { capture: true });
  }

  /** Sélectionne les unités commandables du joueur dont la position est dans le rectangle écran. */
  selectInRect(x0: number, y0: number, x1: number, y1: number, add = false) {
    const ui = useUi.getState();
    const ids: string[] = [];
    for (const i of this.infos) {
      if (i.u.level !== 'own' || i.missile) continue;
      const p = this.map.project(i.pos as [number, number]);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) ids.push(i.id);
    }
    if (!ids.length && !add) return;
    ui.select(add ? [...new Set([...ui.selection, ...ids])] : ids);
  }

  private onClick(e: MapMouseEvent) {
    if (performance.now() < this.suppressClickUntil) return;
    this.tooltip.hide();
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
    const { view, me } = useGame.getState();
    const first = this.hitAt(e.point.x, e.point.y, UNIT_LAYERS)[0];
    const multi = e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    if (first) {
      const ids = String(first.properties?.members ?? first.properties?.id ?? '')
        .split(',')
        .filter((id) => !!view?.units[id]);
      const u = ids[0] ? view?.units[ids[0]] : undefined;
      if (!u) return;
      // Pile étalée (regroupement à petite échelle) : on zoome dessus pour la dégrouper.
      if (ids.length > 1) {
        const pts = ids.map((id) => this.positions.get(id) ?? view!.units[id]!.pos);
        let spread = 0;
        for (const p of pts) spread = Math.max(spread, distanceKm(pts[0]!, p));
        if (spread > STACK_SPREAD_KM) {
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          this.map.fitBounds(
            [
              [Math.min(...xs), Math.min(...ys)],
              [Math.max(...xs), Math.max(...ys)],
            ],
            { padding: 90, maxZoom: Math.max(this.map.getZoom() + 1.5, 6), duration: 600 },
          );
          return;
        }
      }
      const own = ids.filter((id) => view!.units[id]!.level === 'own');
      if (own.length && u.level === 'own') {
        if (multi) {
          const has = own.every((id) => ui.selection.includes(id));
          ui.select(
            has
              ? ui.selection.filter((x) => !own.includes(x))
              : [...new Set([...ui.selection, ...own])],
          );
        } else if (ui.selection.length && !ui.selection.includes(u.id) && u.owner !== me) {
          // Bac à sable : unité d'une autre nation commandable → attaque si une sélection existe.
          ui.setPending({ kind: 'attack', unitIds: ui.selection, targetId: u.id });
        } else {
          ui.select(own);
        }
      } else if (ui.selection.length) {
        ui.setPending({ kind: 'attack', unitIds: ui.selection, targetId: u.id });
      } else {
        ui.inspect(u.id);
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
    if (this.animTimer) clearInterval(this.animTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.unsubs.forEach((u) => u());
    for (const [target, type, fn, opts] of this.domListeners)
      target.removeEventListener(type, fn, opts);
    this.fogWorker?.terminate();
    this.resizeObs?.disconnect();
    this.tooltip.destroy();
    this.map.remove();
  }
}
