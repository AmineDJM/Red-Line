import { create } from 'zustand';

/** Réglages du son (persistés dans le stockage local du navigateur). */
export interface AudioSettings {
  /** Volume général 0..1. */
  master: number;
  /** Musique et ambiances 0..1. */
  music: number;
  /** Effets de jeu 0..1. */
  sfx: number;
  /** Interface (clics, fenêtres) 0..1. */
  ui: number;
  muted: boolean;
  /** Sons réduits : pas d'ambiance de bataille, ponctuations adoucies, transitions plus lentes. */
  reduced: boolean;
}

export const AUDIO_STORAGE_KEY = 'rl.audio';

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultAudioSettings(): AudioSettings {
  return {
    master: 0.8,
    music: 0.6,
    sfx: 0.85,
    ui: 0.75,
    muted: false,
    reduced: prefersReducedMotion(),
  };
}

const unit = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** Lecture tolérante (valeurs absentes ou invalides → défaut). */
export function parseAudioSettings(raw: string | null): AudioSettings {
  const d = defaultAudioSettings();
  if (!raw) return d;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof AudioSettings, unknown>>;
    return {
      master: unit(o.master, d.master),
      music: unit(o.music, d.music),
      sfx: unit(o.sfx, d.sfx),
      ui: unit(o.ui, d.ui),
      muted: typeof o.muted === 'boolean' ? o.muted : d.muted,
      reduced: typeof o.reduced === 'boolean' ? o.reduced : d.reduced,
    };
  } catch {
    return d;
  }
}

function load(): AudioSettings {
  if (typeof window === 'undefined') return defaultAudioSettings();
  try {
    return parseAudioSettings(localStorage.getItem(AUDIO_STORAGE_KEY));
  } catch {
    return defaultAudioSettings();
  }
}

function save(s: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible (navigation privée, quota) : réglage valable pour la session */
  }
}

export interface AudioSettingsStore extends AudioSettings {
  set(patch: Partial<AudioSettings>): void;
  toggleMute(): void;
}

export const useAudioSettings = create<AudioSettingsStore>((set, get) => ({
  ...load(),
  set(patch) {
    set(patch);
    const { master, music, sfx, ui, muted, reduced } = get();
    save({ master, music, sfx, ui, muted, reduced });
  },
  toggleMute() {
    get().set({ muted: !get().muted });
  },
}));
