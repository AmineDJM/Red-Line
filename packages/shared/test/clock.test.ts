import { describe, expect, it } from 'vitest';
import { clockRate, gameTimeAt, type ClockState } from '../src/index.js';

const MIN = 60_000;

describe('horloge de partie : vitesse × cadence de base', () => {
  it('sans cadence (anciennes parties) : temps réel × vitesse', () => {
    const c: ClockState = { anchorGame: 0, anchorReal: 0, speed: 2, paused: false };
    expect(clockRate(c)).toBe(2);
    expect(gameTimeAt(c, MIN)).toBe(2 * MIN);
  });

  it('cadence 10 : ×1 = 10 min de jeu par minute, ×2 = 20 min, ×4 = 40 min', () => {
    for (const [speed, minutes] of [
      [1, 10],
      [2, 20],
      [4, 40],
    ] as const) {
      const c: ClockState = { anchorGame: 0, anchorReal: 0, speed, paused: false, rate: 10 };
      expect(gameTimeAt(c, MIN)).toBe(minutes * MIN);
    }
  });

  it('en pause : figée', () => {
    const c: ClockState = { anchorGame: 5, anchorReal: 0, speed: 4, paused: true, rate: 10 };
    expect(gameTimeAt(c, 10 * MIN)).toBe(5);
  });
});
