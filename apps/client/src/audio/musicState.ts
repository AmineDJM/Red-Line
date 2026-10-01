/**
 * Musique adaptative : état musical déduit de la vue reçue (fonctions pures, testées).
 *
 *   paix      → calme, tension sourde
 *   tension   → alerte mondiale élevée, ultimatum ou préparatifs visibles, mobilisation
 *   guerre    → le joueur (ou son alliance) est en guerre
 *   combat    → batailles en cours au contact de ses forces, pertes récentes
 *   victoire / défaite → fin de partie
 *
 * Le directeur (`MoodDirector`) ajoute l'hystérésis : montée immédiate, redescente seulement après un
 * temps de maintien, pour éviter les va-et-vient.
 */
import {
  distanceKm,
  positionAt,
  HOUR,
  type AlertLevel,
  type LngLat,
  type NationId,
  type PlayerView,
  type UnitView,
} from '@redline/shared';
import type { AmbienceId, MusicId } from './sounds.js';

export type Mood = 'peace' | 'tension' | 'war' | 'combat' | 'victory' | 'defeat';

/** Ordre d'escalade (les fins de partie sont à part). */
const RANK: Record<Mood, number> = {
  peace: 0,
  tension: 1,
  war: 2,
  combat: 3,
  victory: 4,
  defeat: 4,
};

export interface MoodInput {
  me: NationId | null;
  /** Vainqueur de la partie (null : en cours). */
  winner: NationId | null;
  /** Le vainqueur est un allié du joueur. */
  winnerIsAlly: boolean;
  meAlive: boolean;
  /** Nombre d'adversaires en guerre avec le joueur. */
  wars: number;
  alertLevel: AlertLevel | null;
  mobilized: boolean;
  /** Ultimatum ou concentration de troupes visant le joueur (ou lancé par lui), encore d'actualité. */
  threatened: boolean;
  /** Unités du joueur engagées au combat. */
  ownInCombat: number;
  /** Unités ennemies (en guerre) à proximité des forces du joueur. */
  enemiesNear: number;
  /** Événements hostiles récents (pertes, captures, missiles, combats signalés) — fenêtre glissante. */
  recentHostile: number;
}

export interface MoodTarget {
  mood: Mood;
  /** 0..1 : intensité du combat (niveau de la couche de bataille). */
  intensity: number;
}

/** Sélecteur instantané (sans hystérésis). */
export function selectMood(input: MoodInput): MoodTarget {
  if (input.winner) {
    return {
      mood: input.winner === input.me || input.winnerIsAlly ? 'victory' : 'defeat',
      intensity: 0,
    };
  }
  if (!input.meAlive) return { mood: 'defeat', intensity: 0 };
  const heat = input.ownInCombat + input.enemiesNear * 0.5 + input.recentHostile;
  if (
    input.ownInCombat > 0 ||
    (input.wars > 0 && (input.enemiesNear > 0 || input.recentHostile >= 2))
  ) {
    return { mood: 'combat', intensity: clamp(0.35 + heat / 10, 0.35, 1) };
  }
  if (input.wars > 0) return { mood: 'war', intensity: clamp(input.recentHostile / 4, 0, 0.5) };
  const highAlert = input.alertLevel !== null && input.alertLevel <= 3;
  if (input.threatened || input.mobilized || highAlert || input.recentHostile > 0) {
    return { mood: 'tension', intensity: 0 };
  }
  return { mood: 'peace', intensity: 0 };
}

/** Temps de maintien avant de redescendre d'un état (ms, temps réel). */
export const HOLD_MS: Record<Mood, number> = {
  combat: 40_000,
  war: 20_000,
  tension: 45_000,
  peace: 0,
  victory: 0,
  defeat: 0,
};

/**
 * Hystérésis : on monte tout de suite, on ne redescend qu'après `HOLD_MS[état courant]` passés
 * continûment sous cet état. Les fins de partie sont définitives.
 */
export class MoodDirector {
  private current: MoodTarget = { mood: 'peace', intensity: 0 };
  private lowerSince: number | null = null;

  constructor(private readonly hold: Record<Mood, number> = HOLD_MS) {}

  get state(): MoodTarget {
    return this.current;
  }

  update(target: MoodTarget, now: number): MoodTarget {
    const cur = this.current;
    if (cur.mood === 'victory' || cur.mood === 'defeat') {
      if (target.mood === cur.mood) return cur;
      // Seule une nouvelle partie (reset) fait sortir d'une fin ; une autre fin la remplace.
      if (target.mood !== 'victory' && target.mood !== 'defeat') return cur;
    }
    if (RANK[target.mood] >= RANK[cur.mood]) {
      this.lowerSince = null;
      this.current =
        target.mood === cur.mood
          ? { mood: cur.mood, intensity: Math.max(target.intensity, cur.intensity * 0.9) }
          : target;
      return this.current;
    }
    this.lowerSince ??= now;
    if (now - this.lowerSince >= this.hold[cur.mood]) {
      this.lowerSince = null;
      this.current = target;
    }
    return this.current;
  }

  reset(): void {
    this.current = { mood: 'peace', intensity: 0 };
    this.lowerSince = null;
  }
}

/** Morceau de musique de chaque état. */
export const MOOD_MUSIC: Record<Mood, MusicId> = {
  peace: 'peace',
  tension: 'tension',
  war: 'war',
  combat: 'combat',
  victory: 'victory',
  defeat: 'defeat',
};

/** Couches d'ambiance superposées (niveaux 0..1) selon l'état et l'intensité. */
export function ambienceLayers(t: MoodTarget): Record<AmbienceId, number> {
  const out: Record<AmbienceId, number> = {
    'amb-peace': 0,
    'amb-tension': 0,
    'amb-war': 0,
    'amb-combat': 0,
  };
  switch (t.mood) {
    case 'peace':
      out['amb-peace'] = 1;
      break;
    case 'tension':
      out['amb-peace'] = 0.45;
      out['amb-tension'] = 1;
      break;
    case 'war':
      out['amb-tension'] = 0.55;
      out['amb-war'] = 0.6 + 0.4 * t.intensity;
      break;
    case 'combat':
      out['amb-war'] = 0.6;
      out['amb-combat'] = 0.45 + 0.55 * t.intensity;
      break;
    default:
      break;
  }
  return out;
}

// ——— Déduction depuis la vue ———

const ULTIMATUM = /ultimatum|concentrations? de troupes|menace/i;
/** Un ultimatum reste « d'actualité » pendant ce temps de jeu (le délai par défaut est de 24 h). */
const THREAT_WINDOW = 36 * HOUR;
/** Rayon de « proximité » d'une force ennemie (km). */
export const NEAR_KM = 300;

/** Position courante approchée d'une unité. */
function where(u: UnitView, t: number): LngLat {
  return u.move && u.move.legs.length ? positionAt(u.move, t) : u.pos;
}

/**
 * Entrée du sélecteur depuis la vue du joueur. `recentHostile` est fourni par l'appelant (fenêtre
 * glissante en temps réel sur les notifications reçues).
 */
export function moodInputFromView(
  view: PlayerView | null,
  me: NationId | null,
  recentHostile: number,
): MoodInput {
  const base: MoodInput = {
    me,
    winner: null,
    winnerIsAlly: false,
    meAlive: true,
    wars: 0,
    alertLevel: null,
    mobilized: false,
    threatened: false,
    ownInCombat: 0,
    enemiesNear: 0,
    recentHostile,
  };
  if (!view || !me || view.spectator) return base;
  const t = view.time;
  const mine = view.nations[me];
  const enemies = new Set<NationId>();
  for (const r of view.diplomacy?.relations ?? [])
    if (r.relation === 'war') enemies.add(r.nationId);
  for (const n of Object.values(view.nations))
    if (n.relation === 'war' && n.id !== me) enemies.add(n.id);
  const winner = view.victory?.winner ?? null;
  const myAlliance = view.diplomacy?.myAllianceId ?? mine?.allianceId ?? null;
  const winnerIsAlly =
    !!winner &&
    winner !== me &&
    (view.nations[winner]?.relation === 'ally' ||
      (!!myAlliance && view.nations[winner]?.allianceId === myAlliance));

  // Ultimatum : la dernière nouvelle « guerre / paix » concernant le joueur est une menace récente.
  let threatened = false;
  const news = view.news ?? [];
  for (let i = news.length - 1; i >= 0; i--) {
    const n = news[i]!;
    if (!n.nations.includes(me)) continue;
    if (t - n.time > THREAT_WINDOW) continue;
    if (n.category === 'peace') break;
    if (n.category === 'war' && ULTIMATUM.test(n.headline)) {
      threatened = true;
      break;
    }
  }

  let ownInCombat = 0;
  const own: LngLat[] = [];
  const hostile: LngLat[] = [];
  for (const u of Object.values(view.units)) {
    if (u.owner === me) {
      if (u.status === 'destroyed') continue;
      if (u.status === 'combat') ownInCombat++;
      if (enemies.size) own.push(where(u, t));
    } else if (enemies.has(u.owner) && u.status !== 'destroyed') {
      hostile.push(where(u, t));
    }
  }
  let enemiesNear = 0;
  if (own.length && hostile.length) {
    // Échantillonnage borné : la mesure n'a pas besoin d'être exhaustive.
    const ownS = sample(own, 200);
    for (const h of sample(hostile, 200)) {
      if (ownS.some((o) => Math.abs(o[1] - h[1]) < 4 && distanceKm(o, h) <= NEAR_KM)) enemiesNear++;
    }
  }
  return {
    ...base,
    winner,
    winnerIsAlly,
    meAlive: mine?.alive ?? true,
    wars: enemies.size,
    alertLevel: view.alertLevel ?? null,
    mobilized: !!mine?.mobilized,
    threatened,
    ownInCombat,
    enemiesNear,
  };
}

function sample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const step = list.length / max;
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)]!);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
