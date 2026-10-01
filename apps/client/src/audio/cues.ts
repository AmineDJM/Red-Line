/**
 * Notifications de jeu → effets sonores (fonction pure, testée).
 * `hostile` : l'événement compte dans la « chaleur » des combats (musique adaptative).
 */
import type { GameNotification, NationId, PlayerView } from '@redline/shared';
import type { SfxId } from './sounds.js';

export interface Cue {
  id: SfxId;
  /** Volume relatif (événement lointain ou entre tiers : plus doux). */
  gain?: number;
}

export interface CueResult {
  cues: Cue[];
  hostile: boolean;
}

const NONE: CueResult = { cues: [], hostile: false };

function isAlly(view: PlayerView | null, id: NationId): boolean {
  return view?.nations[id]?.relation === 'ally';
}

function isEnemy(view: PlayerView | null, id: NationId | undefined): boolean {
  return !!id && view?.nations[id]?.relation === 'war';
}

export function cuesFor(
  n: GameNotification,
  me: NationId | null,
  view: PlayerView | null,
): CueResult {
  switch (n.kind) {
    case 'war_declared': {
      if (n.by === me || n.against === me)
        return { cues: [{ id: 'war-declared-me' }], hostile: true };
      const close = isAlly(view, n.by) || isAlly(view, n.against);
      return { cues: [{ id: 'war-declared', gain: close ? 1 : 0.65 }], hostile: false };
    }
    case 'peace_signed': {
      if (n.a === me || n.b === me) return { cues: [{ id: 'peace-signed' }], hostile: false };
      if (isAlly(view, n.a) || isAlly(view, n.b)) {
        return { cues: [{ id: 'peace-signed', gain: 0.6 }], hostile: false };
      }
      return NONE;
    }
    case 'province_captured':
      if (n.by === me) return { cues: [{ id: 'city-captured' }], hostile: true };
      if (n.from === me) return { cues: [{ id: 'city-lost' }], hostile: true };
      return NONE;
    case 'province_capture_started':
      if (n.by !== me && view?.provinces[n.provinceId]?.owner === me) {
        return { cues: [{ id: 'radar-alert' }], hostile: true };
      }
      return NONE;
    case 'unit_destroyed':
      return { cues: [{ id: 'unit-destroyed', gain: n.owner === me ? 1 : 0.8 }], hostile: true };
    case 'combat_started':
      return { cues: [{ id: 'radar-alert', gain: 0.8 }], hostile: true };
    case 'unit_detected':
      return isEnemy(view, view?.units[n.unitId]?.owner)
        ? { cues: [{ id: 'radar-alert', gain: 0.7 }], hostile: false }
        : NONE;
    case 'missile_launch': {
      const owner = view?.units[n.unitId]?.owner;
      if (owner === me) return { cues: [{ id: 'missile-launch' }], hostile: true };
      // Missile adverse détecté : alerte radar, puis le départ, plus lointain.
      return {
        cues: [{ id: 'radar-alert' }, { id: 'missile-launch', gain: 0.6 }],
        hostile: true,
      };
    }
    case 'building_hit': {
      const mine = view?.provinces[n.provinceId]?.owner === me;
      return { cues: [{ id: 'airstrike', gain: mine ? 1 : 0.8 }], hostile: true };
    }
    case 'delivery':
      return n.outcome === 'intercepted'
        ? { cues: [{ id: 'interception' }], hostile: false }
        : NONE;
    case 'production_complete':
      return { cues: [{ id: 'production-complete' }], hostile: false };
    case 'research_complete':
      return { cues: [{ id: 'research-complete' }], hostile: false };
    case 'intel_report':
      return { cues: [{ id: 'intel-report', gain: n.flash ? 1 : 0.8 }], hostile: false };
    case 'battle_report':
      return { cues: [{ id: 'intel-report', gain: 0.7 }], hostile: false };
    case 'alert_level':
      return n.level <= 3
        ? { cues: [{ id: 'radar-alert' }], hostile: false }
        : { cues: [{ id: 'notification' }], hostile: false };
    case 'operation':
    case 'council':
    case 'nation_defeated':
      return { cues: [{ id: 'notification' }], hostile: false };
    case 'generic':
      if (n.category === 'nuclear') return { cues: [{ id: 'war-declared-me' }], hostile: true };
      if (n.severity === 'critical') return { cues: [{ id: 'radar-alert' }], hostile: false };
      return {
        cues: [{ id: 'notification', gain: n.severity === 'warn' ? 1 : 0.7 }],
        hostile: false,
      };
    case 'arrived':
    case 'news':
    case 'victory':
      return NONE;
    default:
      return NONE;
  }
}
