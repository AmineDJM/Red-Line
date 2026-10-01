/**
 * Combats sur la carte (fonctions pures, sans MapLibre) :
 *
 * - marqueurs de bataille : batailles en cours de la vue (`battleReports`, outcome « ongoing ») et,
 *   à défaut de rapport, accrochages déduits des unités au combat (regroupées par proximité) ;
 * - ordonnancement des tirs récents (`BattleReportSummary.live.shots`) en effets visuels : seuls les
 *   tirs nouveaux depuis la dernière vue sont joués, étalés dans le temps réel, en nombre borné.
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import {
  distanceKm,
  type BattleReportSummary,
  type BattleShotView,
  type GameTime,
  type LngLat,
  type NationId,
  type PlayerView,
  type UnitId,
} from '@redline/shared';
import type { UnitInfo } from './features.js';

/** Au-delà de ce délai sans tir (temps de jeu), une bataille en cours n'est plus « chaude ». */
export const HOT_MS = 30 * 60_000;
/** Rayon de rattachement d'un accrochage à une bataille connue (km). */
const BATTLE_RADIUS_KM = 150;
/** Rayon de regroupement des unités au combat en un accrochage (km). */
const SKIRMISH_KM = 45;

export interface BattleMarker {
  id: string;
  at: LngLat;
  /** Rapport de bataille (si connu). */
  reportId: string | null;
  title: string;
  /** Camp du joueur : attaquant, défenseur, ou non engagé (spectateur, accrochage d'alliés). */
  side: 'att' | 'def' | null;
  /** Pertes du joueur (son camp) et de l'adversaire (effectifs). */
  lossOwn: number;
  lossFoe: number;
  /** Activité récente 0..1 (tirs des dernières minutes). */
  heat: number;
  /** Unités au combat rattachées (accrochage). */
  unitIds: UnitId[];
}

const sum = (l: { count: number }[]) => l.reduce((n, x) => n + x.count, 0);

function sideOf(b: BattleReportSummary, me: NationId | null): 'att' | 'def' | null {
  if (!me) return null;
  if (b.attacker.nations.includes(me)) return 'att';
  if (b.defender.nations.includes(me)) return 'def';
  return null;
}

/** Activité d'une bataille : récence du dernier tir et nombre de tirs récents. */
export function battleHeat(b: BattleReportSummary, t: GameTime): number {
  if (b.outcome !== 'ongoing') return 0;
  const last = b.live?.lastAt ?? b.startedAt;
  const age = Math.max(0, t - last);
  if (age > HOT_MS * 3) return 0.15;
  const recency = 1 - Math.min(1, age / HOT_MS);
  const shots = b.live?.shots.filter((s) => t - s.t < HOT_MS).length ?? 0;
  return Math.max(0.15, Math.min(1, 0.35 + 0.45 * recency + 0.04 * shots));
}

/**
 * Marqueurs de combat : batailles en cours (rapports) puis accrochages des unités au combat qui ne
 * se rattachent à aucune bataille connue (vue sans rapports, alliés, premières secondes).
 */
export function battleMarkers(
  view: PlayerView,
  me: NationId | null,
  t: GameTime,
  infos: readonly UnitInfo[],
): BattleMarker[] {
  const out: BattleMarker[] = [];
  for (const b of view.battleReports ?? []) {
    if (b.outcome !== 'ongoing') continue;
    const side = sideOf(b, me);
    const mine = side === 'att' ? b.attacker : side === 'def' ? b.defender : b.attacker;
    const foe = side === 'att' ? b.defender : side === 'def' ? b.attacker : b.defender;
    out.push({
      id: `b:${b.id}`,
      at: b.at,
      reportId: b.id,
      title: b.title,
      side,
      lossOwn: sum(mine.losses),
      lossFoe: sum(foe.losses),
      heat: battleHeat(b, t),
      unitIds: [],
    });
  }
  // Accrochages : unités au combat (connues) hors des batailles déjà marquées.
  const fighting = infos.filter(
    (i) => i.flags.includes('c') && !i.missile && i.u.level !== 'detected',
  );
  const clusters: { at: LngLat; ids: UnitId[]; n: number }[] = [];
  for (const i of fighting) {
    if (out.some((m) => m.reportId && distanceKm(m.at, i.pos) < BATTLE_RADIUS_KM)) continue;
    const c = clusters.find((x) => distanceKm(x.at, i.pos) < SKIRMISH_KM);
    if (c) {
      c.ids.push(i.id);
      c.at = [(c.at[0] * c.n + i.pos[0]) / (c.n + 1), (c.at[1] * c.n + i.pos[1]) / (c.n + 1)];
      c.n++;
    } else clusters.push({ at: [i.pos[0], i.pos[1]], ids: [i.id], n: 1 });
  }
  for (const c of clusters) {
    const ids = [...c.ids].sort();
    out.push({
      id: `s:${ids[0]}`,
      at: c.at,
      reportId: null,
      title: '',
      side: null,
      lossOwn: 0,
      lossFoe: 0,
      heat: 0.7,
      unitIds: ids,
    });
  }
  return out;
}

export function battleFeatures(markers: readonly BattleMarker[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      id: m.id,
      rid: m.reportId ?? '',
      heat: Math.round(m.heat * 100) / 100,
      side: m.side ?? '',
      // Étiquette compacte : pertes « vous / adversaire » (batailles du joueur).
      label: m.reportId && m.side ? `-${m.lossOwn} / -${m.lossFoe}` : '',
    },
    geometry: { type: 'Point', coordinates: [m.at[0], m.at[1]] },
  }));
  return { type: 'FeatureCollection', features };
}

// ——— Ordonnancement des tirs récents ———

export interface ScheduledShot {
  /** Délai avant l'effet (ms réelles). */
  delay: number;
  battleId: string;
  shot: BattleShotView;
  /** Le tir vient du camp du joueur (couleur du traceur). */
  own: boolean;
}

export interface ShotScheduleOptions {
  /** Fenêtre d'étalement des tirs nouveaux (ms réelles), typiquement l'intervalle des vues. */
  windowMs: number;
  /** Nombre maximal de tirs joués par bataille et par vue (les plus récents). */
  maxPerBattle: number;
  /** Première vue d'une bataille : tirs de moins de cet âge (temps de jeu) seulement. */
  firstLookMs: number;
}

export const DEFAULT_SCHEDULE: ShotScheduleOptions = {
  windowMs: 1600,
  maxPerBattle: 8,
  firstLookMs: 3 * 60_000,
};

/**
 * Mémorise le dernier tir joué par bataille et renvoie les tirs nouveaux à animer, étalés sur la
 * fenêtre en respectant leur ordre et leurs écarts relatifs (temps de jeu → temps réel).
 */
export class ShotScheduler {
  private seen = new Map<string, GameTime>();

  constructor(private readonly opts: ShotScheduleOptions = DEFAULT_SCHEDULE) {}

  next(
    reports: readonly BattleReportSummary[] | undefined,
    t: GameTime,
    /** Le tireur (position de départ du tir) est-il une force du joueur ou d'un allié ? */
    ownAt?: (p: LngLat) => boolean,
  ): ScheduledShot[] {
    const out: ScheduledShot[] = [];
    const alive = new Set<string>();
    for (const b of reports ?? []) {
      if (b.outcome !== 'ongoing' || !b.live) continue;
      alive.add(b.id);
      const last = this.seen.get(b.id);
      const fresh = b.live.shots.filter((s) =>
        last === undefined ? t - s.t <= this.opts.firstLookMs : s.t > last,
      );
      const newest = b.live.shots[b.live.shots.length - 1]?.t;
      if (newest !== undefined) this.seen.set(b.id, Math.max(last ?? -Infinity, newest));
      else if (last === undefined) this.seen.set(b.id, t);
      if (!fresh.length) continue;
      const list = fresh.slice(-this.opts.maxPerBattle);
      const t0 = list[0]!.t;
      const span = Math.max(1, list[list.length - 1]!.t - t0);
      const n = list.length;
      list.forEach((s, k) => {
        // Écarts relatifs conservés, mais jamais deux tirs au même instant (rafale lisible).
        const rel = n === 1 ? 0 : 0.5 * ((s.t - t0) / span) + 0.5 * (k / (n - 1));
        out.push({
          delay: Math.round(rel * this.opts.windowMs),
          battleId: b.id,
          shot: s,
          own: ownAt ? ownAt(s.from) : false,
        });
      });
    }
    for (const id of [...this.seen.keys()]) if (!alive.has(id)) this.seen.delete(id);
    return out.sort((a, b) => a.delay - b.delay);
  }

  reset() {
    this.seen.clear();
  }
}
