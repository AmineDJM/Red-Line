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
import type { Feature, FeatureCollection, Geometry, LineString, Point } from 'geojson';
import {
  destination,
  distanceKm,
  type LngLat,
  type NationId,
  type ProvinceView,
  type UnitId,
  type UnitView,
} from '@redline/shared';
import { battleFeatures, battleMarkers, ShotScheduler, type BattleMarker } from './battles.js';
import { emitMapEvent } from './events.js';
import { FxRenderer, FxSystem, queueBlast, queueIntercept, queueLaunch, queueShot } from './fx.js';
import { useMapSel } from './mapSel.js';
import { useMapPrefs } from './prefs.js';
import { useStackMenu } from './stackMenu.js';
import { CityIndex } from './unitCat.js';
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
  cityClass,
  cityClassThresholds,
  cityFeatures,
  fc,
  intelFeatures,
  isRadarSystem,
  missileFeatures,
  nationLabelFeatures,
  orbitFeatures,
  pathFeatures,
  popLabel,
  previewFeatures,
  provinceLabelFeatures,
  shiftPionProps,
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
import {
  PION_H,
  PION_ICON_OFFSET,
  PION_W,
  SPRITE_RATIO,
  drawPion,
  parsePionKey,
  resolveSprite,
} from './pions.js';
import { pionScale } from './grouping.js';
import { SourceSync } from './sourceSync.js';
import { SPRITES_MARK, handleMissingImage, registerSprites } from './sprites.js';
import {
  LAYER_GROUPS,
  buildStyle,
  revealOpacity,
  revealRingOpacity,
  type MapLayerGroup,
} from './style.js';
import { MapTooltip, battleTipModel, tipModel, type TipTarget } from './tooltip.js';

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
  /** Mises à jour effectives des pions (regroupement + envoi). */
  regroups: number;
  /** Ticks sans changement visible (rien envoyé). */
  unchangedTicks: number;
  sprites: number;
  sync: { full: number; diff: number; skipped: number };
  /** Effets de combat actifs, refusés (budget) et images dessinées. */
  fx: { active: number; dropped: number; frames: number };
  battles: number;
}

const TILE_PX = 512;
const TOUCH_RADIUS = 18;
const MOUSE_RADIUS = 6;
const LONG_PRESS_MS = 480;
const HOVER_DELAY_MS = 160;
const CITY_LAYERS = ['cities-0', 'cities-1', 'cities-2', 'cities-3'];

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
  private syncs: Record<
    'units' | 'moving' | 'focus' | 'headings' | 'missiles' | 'buildings' | 'shadows',
    SourceSync
  >;
  private fx: FxRenderer;
  private fxCanvas: HTMLCanvasElement;
  private shots = new ShotScheduler();
  private battles: BattleMarker[] = [];
  private battlesKey = '';
  private cities: CityIndex;
  /** Missiles en vol vus à la dernière vue : interception ou impact à leur disparition. */
  private flying = new Map<UnitId, { impactAt: number; dest: LngLat | null; pos: LngLat }>();
  private lastNotif = -1;
  private hoverProv: string | null = null;
  private hoverToken: string | null = null;
  private hoverCallout: OverlayContent['callouts'][number] | null = null;
  private recentFx: { at: LngLat; t: number }[] = [];
  private sprites = new Map<string, number>();
  private usedImages = new Set<string>();
  private gcCounter = 0;
  private knownBuildings = new Map<string, Set<string>>();
  private revealIds: string[] = [];
  private revealStart = 0;
  private animState = {
    paths: false,
    preview: false,
    capture: false,
    orbits: false,
    missiles: false,
  };
  private animStep = 0;
  private groupVisible: Partial<Record<MapLayerGroup, boolean>> = {};
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
  private perf = { ticks: 0, total: 0, max: 0, group: 0, groups: 0, pions: 0, skipped: 0 };
  private unitsSig = '';
  private lastTokens: {
    tokens: Feature<Point>[];
    focus: Feature<Point>[];
    missiles: Feature<Point>[];
  } = { tokens: [], focus: [], missiles: [] };

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
        provinceLabels: hasProvinces ? provinceLabelFeatures(Object.values(w.provinces)) : null,
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
      moving: new SourceSync(src('units-moving')),
      focus: new SourceSync(src('units-focus')),
      headings: new SourceSync(src('headings')),
      missiles: new SourceSync(src('missiles')),
      buildings: new SourceSync(src('buildings')),
      shadows: new SourceSync(src('shadows')),
    };
    this.cities = new CityIndex(Object.values(w.provinces));
    // Canevas des effets de combat : sous la surcouche d'étiquettes, au-dessus de la carte.
    this.fxCanvas = document.createElement('canvas');
    this.fxCanvas.className = 'map-fx';
    this.fxCanvas.setAttribute('aria-hidden', 'true');
    overlayCanvas.parentElement?.insertBefore(this.fxCanvas, overlayCanvas);
    const mobile = typeof window !== 'undefined' && window.innerWidth < 768;
    this.fx = new FxRenderer(this.fxCanvas, this.map, new FxSystem(mobile ? 90 : 160));
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
    // Ondes de bataille entrant dans le champ : relance de la boucle des effets (sans coût sinon).
    this.map.on('moveend', () => this.fx.wake());
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
    this.map.on('movestart', (e) => {
      this.tooltip.hide();
      // Déplacement de la carte par l'utilisateur : le menu de pile ancré n'a plus de sens.
      if ((e as { originalEvent?: unknown }).originalEvent && useStackMenu.getState().open)
        useStackMenu.getState().close();
    });
    this.resizeObs = new ResizeObserver(() => {
      this.overlay.resize();
      this.fx.resize();
      this.map.resize();
    });
    this.resizeObs.observe(container);
    this.pickedNation = opts.pickedNation ?? null;
  }

  // ——— API publique ———

  /** Affiche ou masque un groupe de calques (voir `LAYER_GROUPS`). */
  setLayerGroup(group: MapLayerGroup, visible: boolean) {
    this.groupVisible[group] = visible;
    if (!this.ready) return;
    for (const id of LAYER_GROUPS[group]) {
      if (this.map.getLayer(id))
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    if (group === 'intel') this.refreshIntelLayer();
    if (group === 'units') this.syncPulses();
  }

  /**
   * Active ou coupe les animations (tirets qui défilent, pulsations). Coupées d'office si
   * l'utilisateur a demandé moins d'animations (prefers-reduced-motion).
   */
  setAnimations(on: boolean) {
    this.animationsOn = on;
    if (!on) this.fx.system.clear();
    if (this.ready) this.syncPulses();
  }

  /** Anime les effets (combats) : animations actives et carte prête. */
  private get fxOn() {
    return this.animationsOn && this.ready && !document.hidden;
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
      regroups: p.groups,
      unchangedTicks: p.skipped,
      sprites: this.sprites.size,
      sync: { full: sum('full'), diff: sum('diff'), skipped: sum('skipped') },
      fx: {
        active: this.fx.system.size,
        dropped: this.fx.system.dropped,
        frames: this.fx.frames,
      },
      battles: this.battles.length,
    };
  }

  resetStats() {
    this.perf = {
      ticks: 0,
      total: 0,
      max: 0,
      group: 0,
      groups: 0,
      pions: this.perf.pions,
      skipped: 0,
    };
  }

  /** Centre la carte sur une unité (et la sélectionne si `select`). */
  focusUnit(id: UnitId, zoom = 6) {
    const u = useGame.getState().view?.units[id];
    if (!u) return;
    this.map.flyTo({
      center: this.positions.get(id) ?? u.pos,
      zoom: Math.max(this.map.getZoom(), zoom),
    });
  }

  // ——— Initialisation ———

  private onLoad() {
    if (!this.map.hasImage(SPRITES_MARK)) registerSprites(this.map);
    this.ready = true;
    this.map.on('click', (e) => this.onClick(e));
    this.map.on('mousemove', (e) => this.onHover(e));
    this.map.on('mouseout', () => {
      this.clearHover();
      this.setHoverToken(null);
      this.setHoverProvince(null);
    });
    this.listen(
      this.container,
      'pointerdown',
      (e) => {
        this.lastPointer = (e as PointerEvent).pointerType as 'mouse';
      },
      { capture: true },
    );
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
    // « Réduire les animations » (réglages) et préférence système.
    const applyMotion = () => {
      const sys =
        typeof window !== 'undefined' &&
        !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      this.setAnimations(!useMapPrefs.getState().reduceMotion && !sys);
    };
    applyMotion();
    this.unsubs.push(
      useMapPrefs.subscribe(applyMotion),
      useGame.subscribe((s, prev) => {
        if (s.notifications !== prev.notifications) this.onNotifications();
      }),
    );
    this.lastNotif = useGame.getState().notifications[0]?.id ?? -1;
    this.listen(document, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') {
        if (useStackMenu.getState().open) useStackMenu.getState().close();
        else if (useMapSel.getState().battle) useMapSel.getState().selectBattle(null);
      }
    });
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
    const mine = Object.values(useWorld.getState().provinces).filter((p) => p.nationId === id);
    // Territoire métropolitain : provinces à moins de 2 000 km de la capitale (les outre-mer de la
    // France ou des Pays-Bas feraient sinon cadrer le monde entier).
    const cap = mine.find((p) => p.isCapital);
    const pts = mine
      .filter((p) => !cap || distanceKm(p.centroid, cap.cityPoint) < 2000)
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
      this.trackMissiles(view.units, tNow);
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
      this.set('prov-markers', provinceMarkerFeatures(provs, w.provinces));
      this.refreshIntelLayer();
    }
    if (satsChanged) this.set('satellites', satelliteFeatures(view.satellites, tNow));
    if (view.battleReports !== this.lastBattleRefs) {
      this.lastBattleRefs = view.battleReports;
      this.playShots();
    }
    if (unitsChanged || provincesChanged) this.refreshBattles();
    if (!this.fitted && me) this.fitNation(me);
    this.refreshSelection();
    this.refreshCallouts();
  }

  private refreshIntelLayer() {
    if (!this.ready || !this.groupVisible.intel) {
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
    this.captureIds = [];
    for (const p of Object.values(provinces)) {
      const mine = p.owner === me;
      const color = mine
        ? VIOLET
        : (nations[p.owner]?.color ?? useWorld.getState().nations[p.owner]?.color ?? '#3a4252');
      const cap = p.capture ? (p.owner === me ? 2 : 1) : 0;
      if (cap) {
        anyCapture = true;
        this.captureIds.push(p.id);
      }
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
    this.refreshOverlays(provinces, me);
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

  private lastBattleRefs: unknown = null;

  // ——— Combats : marqueurs, tirs récents, missiles, destructions ———

  /** Marqueurs de bataille (renvoyés seulement s'ils changent). */
  private refreshBattles() {
    if (!this.ready || this.opts.mode === 'picker') return;
    const { view, me } = useGame.getState();
    if (!view) return;
    this.battles = battleMarkers(view, me, gameNow(), this.infos);
    const f = battleFeatures(this.battles);
    const key = f.features
      .map(
        (x) =>
          `${x.properties!.id}:${x.properties!.heat}:${x.properties!.label}:${x.geometry.coordinates.join(',')}`,
      )
      .join(';');
    if (key === this.battlesKey) return;
    this.battlesKey = key;
    this.set('battles', f);
    this.syncPulses();
    // Bataille inspectée terminée : le panneau se ferme de lui-même.
    const sel = useMapSel.getState().battle;
    if (
      sel &&
      !this.battles.some((b) => b.id === sel.id || (sel.reportId && b.reportId === sel.reportId))
    ) {
      const rep = sel.reportId && view.battleReports?.some((r) => r.id === sel.reportId);
      if (!rep) useMapSel.getState().selectBattle(null);
    }
  }

  /**
   * Ondes des batailles actives : animées sur le canevas des effets (animations actives), sinon
   * cercles fixes de la carte (calques battle-pulse).
   */
  private syncPulses() {
    const on = this.animationsOn && !!this.groupVisible.units;
    this.fx.setPulses(
      on ? this.battles.filter((b) => b.heat >= 0.5).map((b) => ({ at: b.at, heat: b.heat })) : [],
    );
    for (const id of ['battle-pulse', 'battle-pulse-2'])
      if (this.map.getLayer(id))
        this.map.setLayoutProperty(
          id,
          'visibility',
          !on && this.groupVisible.units !== false ? 'visible' : 'none',
        );
  }

  /** Le point est-il à l'écran (marge en px) ? */
  private onScreen(p: LngLat, margin = 80): boolean {
    const c = this.map.getCanvas();
    const q = this.map.project(p as [number, number]);
    return (
      q.x > -margin &&
      q.y > -margin &&
      q.x < c.clientWidth + margin &&
      q.y < c.clientHeight + margin
    );
  }

  /** Le tireur à cette position est-il une force du joueur ou d'un allié (unité la plus proche) ? */
  private friendlyAt(p: LngLat): boolean {
    let best = Infinity;
    let rel = 'enemy';
    for (const i of this.infos) {
      const d = Math.abs(i.pos[0] - p[0]) + Math.abs(i.pos[1] - p[1]);
      if (d < best) {
        best = d;
        rel = i.rel;
      }
    }
    return best < 0.25 && (rel === 'own' || rel === 'ally');
  }

  /** Tirs récents des batailles en cours (vue) → traceurs, obus, interceptions. */
  private playShots() {
    const { view } = useGame.getState();
    const list = this.shots.next(view?.battleReports, gameNow(), (p) => this.friendlyAt(p));
    if (!list.length || !this.fxOn || this.map.getZoom() < 3.4) return;
    const now = performance.now();
    let n = 0;
    for (const s of list) {
      if (!this.onScreen(s.shot.to) && !this.onScreen(s.shot.from)) continue;
      queueShot(this.fx.system, now, s.shot, s.own, s.delay);
      this.recentFx.push({ at: s.shot.to, t: now + s.delay });
      if (n++ < 6)
        setTimeout(
          () =>
            emitMapEvent({
              kind: s.shot.cls === 'missile' ? 'intercept' : 'shot',
              at: s.shot.from,
              own: s.own,
              heavy: distanceKm(s.shot.from, s.shot.to) > 18,
            } as Parameters<typeof emitMapEvent>[0]),
          s.delay,
        );
    }
    this.fx.wake();
  }

  /**
   * Feu d'ambiance : unités visibles au combat qui ne figurent dans aucun tir récent (vue sans
   * rapports, combats alliés) échangent des tirs avec l'adversaire visible le plus proche.
   */
  private ambientFire() {
    if (!this.fxOn || this.map.getZoom() < 4.2) return;
    const now = performance.now();
    this.recentFx = this.recentFx.filter((r) => now - r.t < 2500);
    const fighting = this.infos.filter(
      (i) =>
        i.flags.includes('c') && !i.missile && i.u.level !== 'detected' && this.onScreen(i.pos, 0),
    );
    if (!fighting.length) return;
    let spawned = 0;
    for (const a of fighting) {
      if (spawned >= 4) break;
      if (Math.random() > 0.55) continue;
      if (this.recentFx.some((r) => distanceKm(r.at, a.pos) < 25)) continue;
      // Adversaire visible le plus proche (autre camp), à portée raisonnable.
      let foe: (typeof fighting)[number] | null = null;
      let best = Infinity;
      const friendly = a.rel === 'own' || a.rel === 'ally';
      for (const b of this.infos) {
        if (b.missile || b.u.level === 'detected' || b.u.owner === a.u.owner) continue;
        const bf = b.rel === 'own' || b.rel === 'ally';
        if (bf === friendly) continue;
        const d = distanceKm(a.pos, b.pos);
        if (d < best) {
          best = d;
          foe = b;
        }
      }
      const reach = Math.max(25, Math.min(160, (a.sys?.weaponRangeKm.max ?? 20) * 1.3));
      if (!foe || best > reach) continue;
      const cls = foe.sys?.targetClass ?? 'armor';
      queueShot(
        this.fx.system,
        now,
        { from: a.pos, to: foe.pos, cls, hit: Math.random() < 0.6 },
        friendly,
        Math.round(Math.random() * 400),
      );
      this.recentFx.push({ at: a.pos, t: now });
      spawned++;
      emitMapEvent({ kind: 'shot', at: a.pos, own: friendly, heavy: best > 18 });
    }
    if (spawned) this.fx.wake();
  }

  /** Missiles disparus : interceptés (avant l'impact prévu) ou arrivés (explosion au but). */
  private trackMissiles(units: Record<UnitId, UnitView>, tNow: number) {
    const next = new Map<UnitId, { impactAt: number; dest: LngLat | null; pos: LngLat }>();
    const now = performance.now();
    let woke = false;
    for (const u of Object.values(units)) {
      if (!u.missile || !u.move) continue;
      const legs = u.move.legs;
      const dest = legs.length ? legs[legs.length - 1]!.to : null;
      const pos = this.positions.get(u.id) ?? unitPosition(u, tNow);
      if (!this.flying.has(u.id) && this.flying.size + next.size < 400) {
        // Lancement récent (moins de 2 min de jeu) : éclair et panache au départ.
        const start = legs[0];
        if (start && tNow - start.t0 < 120_000 && this.fxOn && this.onScreen(start.from)) {
          queueLaunch(this.fx.system, now, start.from);
          emitMapEvent({ kind: 'launch', at: start.from });
          woke = true;
        }
      }
      next.set(u.id, { impactAt: u.missile.impactAt, dest, pos });
    }
    for (const [id, m] of this.flying) {
      if (next.has(id) || !this.fxOn) continue;
      const early = tNow < m.impactAt - 60_000;
      const at = early ? (this.positions.get(id) ?? m.pos) : (m.dest ?? m.pos);
      if (!this.onScreen(at)) continue;
      if (early) {
        queueIntercept(this.fx.system, now, at);
        emitMapEvent({ kind: 'intercept', at });
      } else {
        queueBlast(this.fx.system, now, at, true);
        emitMapEvent({ kind: 'blast', at, big: true });
      }
      woke = true;
    }
    this.flying = next;
    if (woke) this.fx.wake();
  }

  /** Notifications de destruction et de frappes : explosions à l'endroit indiqué. */
  private onNotifications() {
    const list = useGame.getState().notifications;
    const fresh = list.filter((n) => n.id > this.lastNotif);
    if (list[0]) this.lastNotif = Math.max(this.lastNotif, list[0].id);
    if (!fresh.length || !this.fxOn || this.map.getZoom() < 3.4) return;
    const now = performance.now();
    let woke = false;
    for (const { item } of fresh.slice(0, 12)) {
      if (item.kind !== 'unit_destroyed' && item.kind !== 'building_hit') continue;
      if (!this.onScreen(item.at)) continue;
      const big = item.kind === 'unit_destroyed';
      queueBlast(this.fx.system, now, item.at, big, Math.round(Math.random() * 300));
      emitMapEvent({ kind: 'blast', at: item.at, big });
      woke = true;
    }
    if (woke) this.fx.wake();
  }

  private geoIndex: Map<string, Feature> | null = null;
  private overlayKeys = { veil: '', flags: '' };
  private captureIds: string[] = [];

  private geoFeature(id: string): Feature | undefined {
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return undefined;
    if (!this.geoIndex)
      this.geoIndex = new Map(geo.features.map((f) => [String(f.properties?.id ?? f.id ?? ''), f]));
    return this.geoIndex.get(id);
  }

  /**
   * Voile du renseignement et marques de province (disputé, révolte, blocus, exclusion aérienne) :
   * sources ne contenant que les provinces concernées, renvoyées seulement si elles changent.
   */
  private refreshOverlays(provinces: Record<string, ProvinceView>, me: NationId | null) {
    const veil: Feature[] = [];
    const flags: Feature[] = [];
    const vk: string[] = [];
    const fk: string[] = [];
    for (const p of Object.values(provinces)) {
      if (p.owner !== me && p.intel && p.intel.level <= 1) {
        const f = this.geoFeature(p.id);
        if (f) {
          veil.push({
            type: 'Feature',
            properties: { id: p.id, lvl: p.intel.level },
            geometry: f.geometry,
          });
          vk.push(`${p.id}:${p.intel.level}`);
        }
      }
      const unrest = Math.round(p.unrest ?? 0);
      if (p.disputedId || unrest > 30 || p.noFlyZone || p.blockaded) {
        const f = this.geoFeature(p.id);
        if (!f) continue;
        const props = {
          id: p.id,
          disp: p.disputedId ? 1 : 0,
          unrest,
          nfz: p.noFlyZone ? 1 : 0,
          blk: p.blockaded ? 1 : 0,
        };
        flags.push({ type: 'Feature', properties: props, geometry: f.geometry });
        fk.push(`${p.id}:${props.disp}${props.unrest}${props.nfz}${props.blk}`);
      }
    }
    const v = vk.join(',');
    const k = fk.join(',');
    if (v !== this.overlayKeys.veil) {
      this.overlayKeys.veil = v;
      this.set('veil', { type: 'FeatureCollection', features: veil });
    }
    if (k !== this.overlayKeys.flags) {
      this.overlayKeys.flags = k;
      this.set('prov-flags', { type: 'FeatureCollection', features: flags });
    }
  }

  /** Contours des provinces en cours de capture (source dédiée, animée). */
  private captureFeatures(
    provinces: Record<string, ProvinceView>,
    me: NationId | null,
  ): FeatureCollection {
    const geo = useWorld.getState().provincesGeo;
    if (!geo) return EMPTY;
    if (!this.geoIndex)
      this.geoIndex = new Map(geo.features.map((f) => [String(f.properties?.id ?? f.id ?? ''), f]));
    const out: Feature[] = [];
    for (const p of Object.values(provinces)) {
      if (!p.capture) continue;
      const f = this.geoIndex.get(p.id);
      if (f)
        out.push({
          type: 'Feature',
          properties: { id: p.id, cap: p.owner === me ? 2 : 1 },
          geometry: f.geometry,
        });
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
    this.selectedProvince = id;
    const f = id ? this.geoFeature(id) : undefined;
    this.set(
      'prov-sel',
      f ? { type: 'FeatureCollection', features: [{ ...f, properties: { id } }] } : EMPTY,
    );
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
      this.refreshBattles();
    }
    if (this.tickCount % 11 === 5) this.ambientFire();
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
      cities: this.cities,
      provinces: view?.provinces,
      contactKm: useWorld.getState().balance?.combat.groundContactKm ?? 5,
    });
    for (const i of this.infos) this.positions.set(i.id, i.pos);
    this.groupZoom = this.quantZoom();
    // Rien n'a bougé d'au moins un demi-pixel à l'écran (cas courant : unités lentes, vitesse ×1) :
    // pas de regroupement ni d'envoi au worker de MapLibre.
    const q = 180 / (TILE_PX * Math.pow(2, this.map.getZoom()));
    let missiles = false;
    const sig: string[] = [String(this.groupZoom)];
    for (const i of this.infos) {
      if (i.missile) missiles = true;
      sig.push(
        `${i.id}:${Math.round(i.pos[0] / q)},${Math.round(i.pos[1] / q)},${i.flags},${i.sel},${i.count ?? ''},${
          i.hp === undefined ? '' : Math.round(i.hp * 10)
        },${i.heading === null ? '' : Math.round(i.heading / 3)},${Math.round(i.op * 10)}`,
      );
    }
    const key = sig.join(';');
    if (key === this.unitsSig && !this.smoothing) {
      this.perf.skipped++;
      // Missiles en vol : seuls leur marqueur et leur traînée avancent.
      if (missiles) this.updateMissiles(tNow, me);
      return;
    }
    this.unitsSig = key;
    const g0 = performance.now();
    const r = tokenFeatures(this.infos, {
      nations,
      zoom: this.groupZoom,
      group: this.opts.mode === 'game',
      prev: this.groupOf,
    });
    this.groupOf = new Map();
    for (const g of r.groups) for (const m of g.members) this.groupOf.set(m.id, g.id);
    this.smoothTokens(r.tokens);
    this.perf.group += performance.now() - g0;
    this.perf.groups++;
    this.perf.pions = r.tokens.length + r.focus.length;
    this.syncs.units.push(r.tokens.filter((f) => !f.properties!.mv));
    this.syncs.moving.push(r.tokens.filter((f) => f.properties!.mv));
    this.syncs.focus.push(r.focus);
    this.lastTokens = { tokens: r.tokens, focus: r.focus, missiles: r.missiles };
    this.syncs.headings.push(r.headings);
    this.syncs.missiles.push(r.missiles);
    this.syncs.shadows.push(r.shadows);
    if (this.hoverToken) this.refreshHoverFrame();
    for (const f of r.tokens) this.usedImages.add(String(f.properties!.img));
    for (const f of r.focus) this.usedImages.add(String(f.properties!.img));
    this.updateMissiles(tNow, me);
  }

  private trailsTick = -10;
  /** Pile d'appartenance de chaque unité au dernier regroupement (hystérésis). */
  private groupOf = new Map<string, string>();
  /** Décalage affiché de chaque pion (glissement vers l'écartement voulu). */
  private dispOff = new Map<string, [number, number]>();
  private smoothing = false;

  /**
   * Piles écartées côte à côte : quand l'écartement change (une pile arrive ou part), les pions
   * glissent vers leur nouvelle place en quelques images au lieu de sauter.
   */
  private smoothTokens(tokens: Feature<Point>[]) {
    const next = new Map<string, [number, number]>();
    let moving = false;
    const on = this.animationsOn;
    for (const f of tokens) {
      const p = f.properties!;
      const id = String(p.id);
      const target = p.off as number[];
      const prev = this.dispOff.get(id);
      if (on && prev) {
        const dx = target[0]! - prev[0];
        const dy = target[1]! - prev[1];
        if ((Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) && Math.hypot(dx, dy) < 260) {
          const nx = prev[0] + dx * 0.42;
          const ny = prev[1] + dy * 0.42;
          shiftPionProps(p, nx - target[0]!, ny - target[1]!);
          next.set(id, [nx, ny]);
          moving = true;
          continue;
        }
      }
      next.set(id, [target[0]!, target[1]!]);
    }
    this.dispOff = next;
    this.smoothing = moving;
    if (moving) this.unitsDirty = true;
  }

  /** Traînées des aéronefs et missiles en vol, trajectoire prévue, impacts. */
  private updateMissiles(tNow: number, me: NationId | null) {
    // Sans missile en vol, traînées, sillages et traces suivent à ~4 Hz : moins de travail pour le
    // worker de la carte, écart imperceptible (quelques pixels au plus).
    if (!this.animState.missiles && this.tickCount - this.trailsTick < 3) return;
    this.trailsTick = this.tickCount;
    const z = this.map.getZoom();
    const b = this.map.getBounds();
    const m = missileFeatures(this.units, tNow, me, {
      zoom: z,
      bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    });
    this.set('trails', m.trails);
    this.set('missile-ahead', m.ahead);
    this.set('impacts', m.impacts);
    this.animState.missiles = m.ahead.features.length > 0;
    if (m.ahead.features.length) {
      const feats = this.infos
        .filter((i) => i.missile)
        .map((i) => ({
          type: 'Feature' as const,
          properties: { id: i.id, rot: i.heading ?? 0, rel: i.rel, sel: i.sel, op: i.op },
          geometry: { type: 'Point' as const, coordinates: [i.pos[0], i.pos[1]] },
        }));
      this.syncs.missiles.push(feats);
    }
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
    for (const id of this.usedImages)
      if (this.sprites.has(id)) this.sprites.set(id, this.gcCounter);
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
    const zoom = this.map.getZoom();
    // Trajets des unités étrangères visibles à partir de l'échelle régionale (lisibilité).
    const p = pathFeatures(this.units, tNow, me, sel, {
      foreign: zoom >= 3.6,
      nations: view?.nations ?? {},
    });
    this.set('paths', p.lines);
    this.set('path-heads', p.heads);
    this.animState.paths = p.lines.features.length > 0;
    this.set('attack-links', view ? attackLinkFeatures(view.units, this.positions, me) : EMPTY);
    // ETA près des flèches de destination de ses unités (de près, les plus proches du centre).
    const etas: NonNullable<OverlayContent['etas']> = [];
    if (zoom >= 4.6) {
      const b = this.map.getBounds();
      const c = this.map.getCenter();
      const heads = p.heads.features
        .filter((f) => f.properties!.rel === 'own' && !f.properties!.sel)
        .map((f) => ({ f, at: f.geometry.coordinates as LngLat }))
        .filter((h) => b.contains(h.at as [number, number]))
        .sort(
          (a, b2) =>
            Math.hypot(a.at[0] - c.lng, a.at[1] - c.lat) -
            Math.hypot(b2.at[0] - c.lng, b2.at[1] - c.lat),
        )
        .slice(0, 8);
      for (const h of heads)
        etas.push({
          at: h.at,
          text: t('map.eta', {
            value: fmtDuration(Math.max(0, Number(h.f.properties!.end) - tNow)),
          }),
          tone: 'green',
        });
    }
    this.overlayContent = { ...this.overlayContent, etas };
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
        rings.push({
          at: destination(at, 0, max),
          center: at,
          text: t('map.ring.max', { value: fmtKm(max) }),
        });
      }
      if (sys.weaponRangeKm.min > 0.5) {
        lines.push(circleLine(at, sys.weaponRangeKm.min, 'min'));
        rings.push({
          at: destination(at, 180, sys.weaponRangeKm.min),
          center: at,
          text: t('map.ring.min', { value: fmtKm(sys.weaponRangeKm.min) }),
        });
      }
      if (sys.operationalRadiusKm && sys.operationalRadiusKm > max) {
        lines.push(circleLine(at, sys.operationalRadiusKm, 'radius'));
        rings.push({
          at: destination(at, 0, sys.operationalRadiusKm),
          center: at,
          text: t('map.ring.radius', { value: fmtKm(sys.operationalRadiusKm) }),
        });
      }
      this.set('range-lines', fc(lines));
      // Zone de détection (radar, sonar…), plus large que la portée des armes.
      const det = sys.sensor?.rangeKm ?? sys.detectionRangeKm;
      if (det > max * 1.05 && det > 1) {
        this.set('detect', fc([circleLine(at, det, 'detect')]));
        const kind = sys.sensor?.kind;
        const key = kind === 'sonar' ? 'sonar' : isRadarSystem(sys) ? 'radar' : 'sensor';
        rings.push({
          at: destination(at, 0, det),
          center: at,
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
    // Passages de satellites imminents : heure de passage au centre de la fauchée.
    const tNow = gameNow();
    for (const sat of view?.satellites ?? []) {
      const dt = sat.nextPassAt - tNow;
      if (dt < 0 || dt > 6 * 3600_000 || !sat.footprint.length) continue;
      const c: LngLat = [
        sat.footprint.reduce((a, q) => a + q[0], 0) / sat.footprint.length,
        sat.footprint.reduce((a, q) => a + q[1], 0) / sat.footprint.length,
      ];
      rings.push({ at: c, text: t('map.ring.sat', { value: fmtDuration(dt) }), tone: 'cyan' });
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
        captures: this.captureIds,
      }).concat(this.hoverCallout ? [this.hoverCallout] : []),
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
        const o =
          typeof off === 'string' ? (JSON.parse(off) as number[]) : (off as number[] | undefined);
        const s = f.layer.id === 'missiles' ? 0 : 1;
        const px = p.x + (o?.[0] ?? 0) * s;
        const py = p.y + (o?.[1] ?? 0) * s;
        const focus = f.layer.id === 'focus-hex' ? -2 : 0;
        return { f, d: Math.hypot(px - x, py - y) + focus };
      })
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  }

  /**
   * Test d'atteinte des pions par leur géométrie connue (position, écartement, taille à l'échelle
   * du zoom), sans dépendre du rendu des tuiles : fiable même juste après un saut de caméra.
   * Renvoie les identifiants des unités du pion touché (sélection d'abord, puis le plus proche).
   */
  private hitPion(x: number, y: number, radius: number): string[] | null {
    return this.hitToken(x, y, radius)?.ids ?? null;
  }

  /** Pion touché (identifiants, groupe d'écartement, entité) : voir `hitPion`. */
  private hitToken(
    x: number,
    y: number,
    radius: number,
  ): { ids: string[]; cluster: string; f: Feature<Point> } | null {
    const s = pionScale(this.map.getZoom());
    const hw = (PION_W / 2) * s + radius;
    const hh = (PION_H / 2) * s + radius;
    let best: { ids: string; d: number; f: Feature<Point> } | null = null;
    const test = (f: Feature<Point>, bonus: number, box: boolean) => {
      const c = f.geometry.coordinates as [number, number];
      const p = this.map.project(c);
      const off = (f.properties?.foff ?? (box ? f.properties?.off : [0, 0])) as
        number[] | undefined;
      const base: [number, number] = f.properties?.foff ? [0, 0] : PION_ICON_OFFSET;
      const cx = p.x + ((off?.[0] ?? 0) - (box ? base[0] : 0)) * s;
      const cy = p.y + ((off?.[1] ?? 0) - (box ? base[1] : 0)) * s;
      const dx = Math.abs(cx - x);
      const dy = Math.abs(cy - y);
      const inside = box ? dx <= hw && dy <= hh : Math.hypot(dx, dy) <= 12 + radius;
      if (!inside) return;
      const d = Math.hypot(dx, dy) + bonus;
      if (!best || d < best.d)
        best = { ids: String(f.properties?.members ?? f.properties?.id), d, f };
    };
    for (const f of this.lastTokens.focus) test(f, -1000, true);
    for (const f of this.lastTokens.tokens) test(f, 0, true);
    for (const f of this.lastTokens.missiles) test(f, -5, false);
    const b = best as { ids: string; d: number; f: Feature<Point> } | null;
    return b
      ? { ids: b.ids.split(',').filter(Boolean), cluster: String(b.f.properties?.cl ?? ''), f: b.f }
      : null;
  }

  /** Marqueur de bataille touché (icône décalée au-dessus du point de combat). */
  private hitBattle(x: number, y: number): BattleMarker | null {
    if (!this.battles.length || !this.groupVisible.units) return null;
    const z = this.map.getZoom();
    const size =
      z <= 2
        ? 0.75
        : z >= 9
          ? 1.12
          : z <= 6
            ? 0.75 + ((z - 2) / 4) * 0.25
            : 1 + ((z - 6) / 3) * 0.12;
    const r = 13 * size + (this.lastPointer === 'mouse' ? 2 : 8);
    let best: BattleMarker | null = null;
    let bd = Infinity;
    for (const b of this.battles) {
      const p = this.map.project(b.at as [number, number]);
      const d = Math.hypot(p.x - x, p.y - 30 * size - y);
      if (d <= r && d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  /** Cadre de survol : suit le pion survolé (position et écartement courants). */
  private refreshHoverFrame() {
    const id = this.hoverToken;
    const f = id
      ? (this.lastTokens.focus.find((x) => x.properties?.id === id) ??
        this.lastTokens.tokens.find((x) => x.properties?.id === id))
      : undefined;
    if (!f || f.properties?.sel) {
      this.set('hover', EMPTY);
      return;
    }
    const off = (f.properties?.off as number[] | undefined) ?? [0, 0];
    const foff = (f.properties?.foff as number[] | undefined) ?? [
      off[0]! - PION_ICON_OFFSET[0],
      off[1]! - PION_ICON_OFFSET[1],
    ];
    this.set('hover', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { foff }, geometry: f.geometry }],
    });
  }

  private setHoverToken(id: string | null) {
    if (id === this.hoverToken) return;
    this.hoverToken = id;
    this.refreshHoverFrame();
  }

  /** Survol d'une province (ordinateur) : contour net et cartouche de la ville après un temps. */
  private hoverProvTimer: ReturnType<typeof setTimeout> | null = null;
  private provQueryAt = 0;
  private setHoverProvince(id: string | null) {
    if (id === this.hoverProv) return;
    this.hoverProv = id;
    if (this.hoverProvTimer) clearTimeout(this.hoverProvTimer);
    this.hoverProvTimer = null;
    const f = id ? this.geoFeature(id) : undefined;
    const me = useGame.getState().me;
    const owner = id ? useGame.getState().view?.provinces[id]?.owner : undefined;
    this.set(
      'prov-hover',
      f
        ? {
            type: 'FeatureCollection',
            features: [{ ...f, properties: { id, mine: owner && owner === me ? 1 : 0 } }],
          }
        : EMPTY,
    );
    if (this.hoverCallout) {
      this.hoverCallout = null;
      this.refreshCallouts();
    }
    if (id && this.map.getZoom() >= 3.8)
      this.hoverProvTimer = setTimeout(() => {
        this.hoverCallout = this.provinceCallout(id);
        this.refreshCallouts();
      }, 420);
  }

  /** Cartouche de survol d'une province : ville, rang, population, contrôle, moral, capture. */
  private provinceCallout(id: string): OverlayContent['callouts'][number] | null {
    const { view, me } = useGame.getState();
    const def = useWorld.getState().provinces[id];
    const p = view?.provinces[id];
    if (!def || !p || !view) return null;
    const cls = cityClass(def, this.cityThresholds);
    const lines: string[] = [];
    const nation = view.nations[p.owner]?.name ?? p.owner;
    lines.push(`${nation} · ${t(`map.city.rank${cls}`)}`);
    const pop = def.population ? popLabel(def.population) : '';
    const eco =
      p.owner === me ? view.economy.detail?.provinces.find((x) => x.id === id) : undefined;
    const extra = [pop, eco ? t('map.prov.morale', { value: Math.round(eco.morale) }) : '']
      .filter(Boolean)
      .join(' · ');
    if (extra) lines.push(extra);
    if (p.buildings.length) lines.push(t('map.prov.buildings', { count: p.buildings.length }));
    let progress: number | undefined;
    if (p.capture) {
      const span = Math.max(1, p.capture.completesAt - p.capture.startedAt);
      progress = Math.max(0, Math.min(1, (gameNow() - p.capture.startedAt) / span));
      lines.push(`${t('map.tip.capture')} ${Math.round(progress * 100)} %`);
    }
    return {
      id: `hover:${id}`,
      at: def.cityPoint,
      title: def.cityName ?? def.name,
      lines,
      priority: 110,
      tone: p.capture ? (p.owner === me ? 'red' : 'amber') : p.owner === me ? 'green' : 'cyan',
      ...(progress !== undefined ? { progress } : {}),
    };
  }

  private tipTargetAt(
    x: number,
    y: number,
    radius?: number,
  ): { key: string; target: TipTarget } | null {
    const ids = this.hitPion(
      x,
      y,
      radius ?? (this.lastPointer === 'mouse' ? MOUSE_RADIUS : TOUCH_RADIUS) - 4,
    );
    if (ids?.length) return { key: `u:${ids.join(',')}`, target: { kind: 'units', ids } };
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

  private showBattleTip(b: BattleMarker, x: number, y: number) {
    const { view, me } = useGame.getState();
    if (!view) return;
    const w = useWorld.getState();
    const m = battleTipModel(b, { view, me, catalog: w.catalog, defs: w.provinces, t: gameNow() });
    if (m) this.tooltip.show(m, x, y);
  }

  private onHover(e: MapMouseEvent) {
    if (!this.ready || this.box) return;
    if (this.opts.mode === 'picker') {
      const hit = this.hitAt(e.point.x, e.point.y, ['prov-fill']).length > 0;
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
      return;
    }
    // Menu de pile ouvert : pas d'infobulle par-dessus (le menu dit déjà tout).
    if (useStackMenu.getState().open) {
      this.clearHover();
      return;
    }
    const battle = this.hitBattle(e.point.x, e.point.y);
    const hit = battle ? null : this.tipTargetAt(e.point.x, e.point.y);
    const onUnit = hit?.key.startsWith('u:');
    this.map.getCanvas().style.cursor =
      onUnit || battle ? 'pointer' : useUi.getState().selection.length ? 'crosshair' : '';
    if (onUnit) {
      const tok = this.hitToken(e.point.x, e.point.y, MOUSE_RADIUS - 4);
      this.setHoverToken(tok ? String(tok.f.properties?.id ?? '') : null);
    } else this.setHoverToken(null);
    // Contour de la province survolée (hors pions et marqueurs).
    if (!onUnit && !battle) {
      // Requête de rendu limitée (~20 par seconde) : les grandes provinces sont coûteuses à tester.
      const now = performance.now();
      if (now - this.provQueryAt > 50) {
        this.provQueryAt = now;
        const pf = this.map.queryRenderedFeatures(e.point, { layers: ['prov-fill'] })[0];
        this.setHoverProvince(pf ? String(pf.properties?.id ?? pf.id ?? '') || null : null);
      }
    } else this.setHoverProvince(null);
    if (battle) {
      const key = `bt:${battle.id}`;
      if (key !== this.hoverKey) {
        this.hoverKey = key;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        const { x, y } = e.point;
        this.hoverTimer = setTimeout(() => this.showBattleTip(battle, x, y), HOVER_DELAY_MS);
      } else this.tooltip.place(e.point.x, e.point.y);
      return;
    }
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
          Math.hypot(
            t0.clientX - r.left - this.longPress.x,
            t0.clientY - r.top - this.longPress.y,
          ) > 10
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
        this.selectInRect(
          Math.min(b.x0, x1),
          Math.min(b.y0, y1),
          Math.max(b.x0, x1),
          Math.max(b.y0, y1),
          ue.ctrlKey || ue.metaKey,
        );
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
    // Annule aussi une infobulle en attente (survol juste avant le clic).
    this.clearHover();
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
    const menu = useStackMenu.getState();
    if (menu.open) menu.close();
    const multi = e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    // Marqueur de bataille : panneau de détail des combats.
    const battle = this.hitBattle(e.point.x, e.point.y);
    if (battle && !multi) {
      ui.inspect(null);
      ui.selectProvince(null);
      if (ui.selection.length) ui.clearSelection();
      useMapSel.getState().selectBattle({
        id: battle.id,
        reportId: battle.reportId,
        at: battle.at,
        unitIds: battle.unitIds,
      });
      return;
    }
    const tok = this.hitToken(
      e.point.x,
      e.point.y,
      (this.lastPointer === 'mouse' ? MOUSE_RADIUS : TOUCH_RADIUS) - 4,
    );
    const hitIds = tok?.ids;
    if (hitIds?.length) {
      if (useMapSel.getState().battle) useMapSel.getState().selectBattle(null);
      const ids = hitIds.filter((id) => !!view?.units[id]);
      const u = ids[0] ? view?.units[ids[0]] : undefined;
      if (!u) return;
      // Plusieurs unités au même endroit : menu de pile (choix précis de l'armée à commander).
      if (ids.length > 1 && !multi) {
        this.openStackMenu(ids, tok!.cluster, String(tok!.f.properties?.id ?? ''), e);
        return;
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
    if (useMapSel.getState().battle) useMapSel.getState().selectBattle(null);
    ui.inspect(null);
    ui.selectProvince(pf ? String(pf.properties?.id ?? pf.id ?? '') || null : null);
  }

  /**
   * Ouvre le menu de pile ancré au point touché : unités de la pile, et unités des autres nations
   * écartées au même endroit (« à proximité »). Les unités du joueur sont pré-cochées.
   */
  private openStackMenu(ids: string[], cluster: string, tokenId: string, e: MapMouseEvent) {
    const { view } = useGame.getState();
    if (!view) return;
    const near: string[] = [];
    if (cluster)
      for (const f of this.lastTokens.tokens) {
        if (f.properties?.cl !== cluster || f.properties?.id === tokenId) continue;
        for (const id of String(f.properties?.members ?? '').split(','))
          if (id && view.units[id] && !ids.includes(id)) near.push(id);
      }
    const pts = ids.map((id) => this.positions.get(id) ?? view.units[id]!.pos);
    let spread = 0;
    for (const p of pts) spread = Math.max(spread, distanceKm(pts[0]!, p));
    const picked = ids.filter((id) => view.units[id]!.level === 'own' && !view.units[id]!.missile);
    this.clearHover();
    useStackMenu.getState().show(
      {
        ids,
        near: near.slice(0, 60),
        x: e.point.x,
        y: e.point.y,
        at: [e.lngLat.lng, e.lngLat.lat],
        spreadKm: Math.round(spread),
        touch: this.lastPointer !== 'mouse',
      },
      picked,
    );
    emitMapEvent({ kind: 'stack-menu', open: true });
  }

  /** Cadre la carte sur des unités (bouton « zoomer » du menu de pile). */
  fitUnits(ids: string[]) {
    const { view } = useGame.getState();
    const pts = ids
      .map((id) => this.positions.get(id) ?? view?.units[id]?.pos)
      .filter((p): p is LngLat => !!p);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    this.map.fitBounds(
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
      { padding: 110, maxZoom: Math.max(this.map.getZoom() + 1.5, 6), duration: 600 },
    );
  }

  /** Position écran (px, repère du conteneur) d'un point : ancrage des menus. */
  project(p: LngLat): { x: number; y: number } {
    const q = this.map.project(p as [number, number]);
    return { x: q.x, y: q.y };
  }

  destroy() {
    if (this.hoverProvTimer) clearTimeout(this.hoverProvTimer);
    this.fx.destroy();
    this.fxCanvas.remove();
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
