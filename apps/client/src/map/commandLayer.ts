/**
 * Armées du centre de commandement sur la carte : étiquette discrète au barycentre de chaque armée
 * (nom · mission), zone de mission (cercle tireté légèrement teinté) et flèches d'offensive vers les
 * objectifs en cours. L'armée affichée dans la fenêtre, ou celle de la pile sélectionnée, est
 * accentuée ; les autres restent en retrait.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { destination, type ArmyView, type LngLat, type PlayerView } from '@redline/shared';
import { FONTS } from '../config.js';
import { t } from '../i18n/index.js';
import { armyOfUnit, centroidOf } from '../lib/command.js';
import { useCommandUi } from '../store/command.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { unitPosition } from './interpolation.js';
import { C } from './palette.js';

const SRC = 'cmd-armies';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function circle(at: LngLat, km: number, steps = 72): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) out.push(destination(at, (360 * i) / steps, km));
  return out;
}

/** Ligne de l'armée vers l'objectif, dépliée pour ne pas traverser l'antiméridien à rebours. */
function arrow(a: LngLat, b: LngLat): LngLat[] {
  let x = b[0];
  if (x - a[0] > 180) x -= 360;
  else if (a[0] - x > 180) x += 360;
  return [a, [x, b[1]]];
}

export function commandFeatures(
  view: PlayerView | null,
  focus: string | null,
  now: number,
): FeatureCollection {
  const cmd = view?.command;
  if (!view || !cmd?.armies.length) return EMPTY;
  const out: Feature[] = [];
  for (const a of cmd.armies as ArmyView[]) {
    const pts = a.unitIds
      .map((id) => view.units[id])
      .filter((u) => !!u && u.status !== 'embarked')
      .map((u) => unitPosition(u!, now));
    const at = centroidOf(pts);
    const sel = a.id === focus ? 1 : 0;
    const m = a.mission;
    const live = !!m && a.status !== 'success' && a.status !== 'failed' && a.status !== 'idle';
    if (
      m &&
      live &&
      m.at &&
      m.radiusKm &&
      ['defend', 'air_superiority', 'air_defense', 'sea_control', 'reserve'].includes(m.brain)
    ) {
      out.push({
        type: 'Feature',
        properties: { kind: 'zone', sel, brain: m.brain },
        geometry: { type: 'Polygon', coordinates: [circle(m.at, m.radiusKm)] },
      });
    }
    if (
      m &&
      live &&
      at &&
      (m.brain === 'conquer' || m.brain === 'landing' || m.brain === 'deep_strike')
    ) {
      for (const aim of a.aims.slice(0, 4)) {
        out.push({
          type: 'Feature',
          properties: { kind: 'arrow', sel },
          geometry: { type: 'LineString', coordinates: arrow(at, aim) },
        });
        out.push({
          type: 'Feature',
          properties: { kind: 'aim', sel },
          geometry: { type: 'Point', coordinates: aim },
        });
      }
    }
    if (at) {
      const mission = m ? t(`command.missions.${m.type}.short`, { defaultValue: m.type }) : '';
      out.push({
        type: 'Feature',
        properties: {
          kind: 'label',
          sel,
          text: mission ? `${a.name} · ${mission}` : a.name,
          warn: a.request ? 1 : 0,
        },
        geometry: { type: 'Point', coordinates: at },
      });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

export class CommandLayer {
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private key = '';

  constructor(
    private readonly map: MlMap,
    private readonly beforeId?: string,
  ) {
    this.install();
    this.unsubs.push(
      useGame.subscribe((s, p) => {
        if (s.view !== p.view) this.refresh();
      }),
      useCommandUi.subscribe((s, p) => {
        if (s.selected !== p.selected) this.refresh();
      }),
      useUi.subscribe((s, p) => {
        if (s.selection !== p.selection || s.windows !== p.windows) this.refresh();
      }),
    );
    // Les armées en route se déplacent : étiquettes recalées toutes les 2 s.
    this.timer = setInterval(() => this.refresh(), 2000);
    this.refresh();
  }

  private install(): void {
    const m = this.map;
    if (m.getSource(SRC)) return;
    const before = this.beforeId && m.getLayer(this.beforeId) ? this.beforeId : undefined;
    m.addSource(SRC, { type: 'geojson', data: EMPTY });
    const sel = (on: number, off: number) => ['case', ['==', ['get', 'sel'], 1], on, off];
    m.addLayer(
      {
        id: 'cmd-zone-fill',
        type: 'fill',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'zone'],
        paint: { 'fill-color': C.cyan, 'fill-opacity': sel(0.1, 0.035) as never },
      },
      before,
    );
    m.addLayer(
      {
        id: 'cmd-zone-line',
        type: 'line',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'zone'],
        paint: {
          'line-color': C.cyan,
          'line-width': sel(1.6, 1) as never,
          'line-opacity': sel(0.9, 0.4) as never,
          'line-dasharray': [3, 2],
        },
      },
      before,
    );
    m.addLayer(
      {
        id: 'cmd-arrow',
        type: 'line',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'arrow'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': C.amber,
          'line-width': sel(2.2, 1.2) as never,
          'line-opacity': sel(0.95, 0.45) as never,
          'line-dasharray': [2, 1.5],
        },
      },
      before,
    );
    m.addLayer(
      {
        id: 'cmd-aim',
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'aim'],
        paint: {
          'circle-radius': sel(6, 4) as never,
          'circle-color': 'rgba(255,176,32,0.15)',
          'circle-stroke-color': C.amber,
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': sel(1, 0.5) as never,
        },
      },
      before,
    );
    m.addLayer({
      id: 'cmd-label',
      type: 'symbol',
      source: SRC,
      filter: ['==', ['get', 'kind'], 'label'],
      minzoom: 3,
      layout: {
        'text-field': ['get', 'text'],
        'text-font': [FONTS.semibold],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 7, 12],
        'text-offset': [0, 2.4],
        'text-anchor': 'top',
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': [
          'case',
          ['==', ['get', 'warn'], 1],
          C.amber,
          ['==', ['get', 'sel'], 1],
          C.cyan,
          C.text,
        ],
        'text-opacity': sel(1, 0.75) as never,
        'text-halo-color': 'rgba(10,14,19,0.92)',
        'text-halo-width': 1.6,
      },
    });
  }

  /** Armée accentuée : celle de la fenêtre, sinon celle de la pile sélectionnée. */
  private focus(view: PlayerView | null): string | null {
    const open = useUi.getState().windows.some((w) => w.id === 'command');
    const s = useCommandUi.getState().selected;
    if (open && s) return s;
    const first = useUi.getState().selection[0];
    if (first) return armyOfUnit(view?.command, first)?.id ?? null;
    return null;
  }

  refresh(): void {
    const view = useGame.getState().view;
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const fc = commandFeatures(view, this.focus(view), gameNow());
    const key = JSON.stringify(fc);
    if (key === this.key) return;
    this.key = key;
    src.setData(fc);
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
