/**
 * Catalogue des sons (identifiants du manifeste `public/audio/manifest.json`) et règles de lecture.
 * Les fichiers sont produits par `tools/audio/build.py` (ElevenLabs, généré pour Red Line).
 */

export type MusicId = 'peace' | 'tension' | 'war' | 'combat' | 'victory' | 'defeat';
export type AmbienceId = 'amb-peace' | 'amb-tension' | 'amb-war' | 'amb-combat';
export type SfxId =
  | 'war-declared'
  | 'war-declared-me'
  | 'peace-signed'
  | 'city-captured'
  | 'city-lost'
  | 'unit-destroyed'
  | 'missile-launch'
  | 'interception'
  | 'airstrike'
  | 'radar-alert'
  | 'production-complete'
  | 'research-complete'
  | 'intel-report'
  | 'notification'
  | 'order'
  | 'select'
  | 'window-open'
  | 'window-close';

export const AMBIENCE_IDS: readonly AmbienceId[] = [
  'amb-peace',
  'amb-tension',
  'amb-war',
  'amb-combat',
];

/**
 * Catégories de limitation : ponctuations dramatiques (une à la fois), combat (rafales regroupées),
 * alertes, informations, interface (très discrète).
 */
export type SfxCategory = 'sting' | 'combat' | 'alert' | 'info' | 'ui';

export interface SfxDef {
  category: SfxCategory;
  /** 0..100 : un son prioritaire passe devant les autres de sa catégorie quand elle est saturée. */
  priority: number;
  /** Volume relatif (0..1) appliqué en plus du bus. */
  volume: number;
  /** Bus de sortie : effets de jeu ou interface. */
  bus: 'sfx' | 'ui';
  /** Écart minimal entre deux lectures du même son (ms). */
  gapMs: number;
  /** Abaisse la musique et les ambiances pendant la lecture (ponctuations). */
  duck?: boolean;
}

export const SFX: Record<SfxId, SfxDef> = {
  'war-declared-me': {
    category: 'sting',
    priority: 100,
    volume: 1,
    bus: 'sfx',
    gapMs: 4000,
    duck: true,
  },
  'war-declared': {
    category: 'sting',
    priority: 70,
    volume: 0.7,
    bus: 'sfx',
    gapMs: 12000,
    duck: true,
  },
  'peace-signed': {
    category: 'sting',
    priority: 80,
    volume: 0.9,
    bus: 'sfx',
    gapMs: 6000,
    duck: true,
  },
  'city-captured': {
    category: 'sting',
    priority: 75,
    volume: 0.85,
    bus: 'sfx',
    gapMs: 2500,
    duck: true,
  },
  'city-lost': {
    category: 'sting',
    priority: 85,
    volume: 0.9,
    bus: 'sfx',
    gapMs: 2500,
    duck: true,
  },
  'unit-destroyed': { category: 'combat', priority: 40, volume: 0.7, bus: 'sfx', gapMs: 350 },
  'missile-launch': { category: 'combat', priority: 55, volume: 0.75, bus: 'sfx', gapMs: 900 },
  interception: { category: 'combat', priority: 50, volume: 0.75, bus: 'sfx', gapMs: 600 },
  airstrike: { category: 'combat', priority: 45, volume: 0.75, bus: 'sfx', gapMs: 1500 },
  'radar-alert': { category: 'alert', priority: 60, volume: 0.6, bus: 'sfx', gapMs: 6000 },
  'production-complete': { category: 'info', priority: 30, volume: 0.6, bus: 'sfx', gapMs: 1500 },
  'research-complete': { category: 'info', priority: 35, volume: 0.65, bus: 'sfx', gapMs: 1500 },
  'intel-report': { category: 'info', priority: 30, volume: 0.6, bus: 'sfx', gapMs: 2500 },
  notification: { category: 'info', priority: 10, volume: 0.5, bus: 'ui', gapMs: 1200 },
  order: { category: 'ui', priority: 20, volume: 0.8, bus: 'ui', gapMs: 60 },
  select: { category: 'ui', priority: 15, volume: 0.6, bus: 'ui', gapMs: 90 },
  'window-open': { category: 'ui', priority: 5, volume: 0.7, bus: 'ui', gapMs: 120 },
  'window-close': { category: 'ui', priority: 5, volume: 0.6, bus: 'ui', gapMs: 120 },
};

/** Ponctuations à précharger dès le déverrouillage (latence nulle au moment critique). */
export const PRELOAD_SFX: readonly SfxId[] = ['war-declared-me', 'war-declared', 'order', 'select'];
