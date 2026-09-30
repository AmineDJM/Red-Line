import { gameTimeAt, type ClockState, type GameTime, type RealTime } from '@redline/shared';

/** Temps de jeu entier (ms) à l'instant réel `now`. */
export function gameNow(clock: ClockState, now: RealTime): GameTime {
  return Math.floor(gameTimeAt(clock, now));
}

/** Instant réel où l'horloge atteindra `t` (null si en pause). */
export function realTimeFor(clock: ClockState, t: GameTime): RealTime | null {
  if (clock.paused || clock.speed <= 0) return null;
  return clock.anchorReal + (t - clock.anchorGame) / clock.speed;
}

/**
 * Ré-ancre l'horloge à `now` (changement de vitesse ou pause). `current` est le temps de jeu effectif
 * de la partie à cet instant (on ne revient jamais en arrière).
 */
export function reanchor(
  clock: ClockState,
  now: RealTime,
  current: GameTime,
  change: { speed?: number; paused?: boolean },
): ClockState {
  return {
    anchorGame: Math.max(current, gameNow(clock, now)),
    anchorReal: now,
    speed: change.speed ?? clock.speed,
    paused: change.paused ?? clock.paused,
  };
}
