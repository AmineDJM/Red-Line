/**
 * Branchement du son sur le jeu, uniquement par abonnements aux stores (game, ui) :
 *  - déverrouillage au premier geste, pause quand l'onglet est caché, réglages persistés ;
 *  - notifications reçues → effets (limiteur), missiles disparus avant l'impact → interception ;
 *  - fenêtres, console, sélection, ordres envoyés → sons d'interface très discrets ;
 *  - état musical (paix, tension, guerre, combat, fin) recalculé régulièrement depuis la vue.
 */
import type { NationId, PlayerView, UnitId } from '@redline/shared';
import { DEBUG_HOOKS } from '../config.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { cuesFor } from './cues.js';
import { AudioEngine } from './engine.js';
import {
  MOOD_MUSIC,
  MoodDirector,
  ambienceLayers,
  moodInputFromView,
  selectMood,
  type Mood,
  type MoodTarget,
} from './musicState.js';
import { useAudioSettings } from './settings.js';
import type { SfxId } from './sounds.js';

let engine: AudioEngine | null = null;

/** Moteur unique (créé sans contexte audio : celui-ci n'existe qu'après un geste). */
export function audioEngine(): AudioEngine {
  engine ??= new AudioEngine(useAudioSettings.getState());
  return engine;
}

/** Joue un effet d'interface ou de jeu (sans effet avant le premier geste ou si muet). */
export function playSfx(id: SfxId, gain?: number): void {
  engine?.playSfx(id, gain);
}

/** Fenêtre glissante des événements hostiles (temps réel). */
const HOSTILE_WINDOW_MS = 75_000;
/** Notifications reçues juste après la connexion : historique, pas d'effets. */
const WARMUP_MS = 2500;
/** Période de recalcul de l'état musical. */
const MOOD_TICK_MS = 1500;

/** Durée des fondus enchaînés selon la transition (s). */
function fadeFor(from: Mood, to: Mood, reduced: boolean): number {
  const base =
    to === 'combat'
      ? 2.5
      : to === 'war'
        ? from === 'combat'
          ? 6
          : 3.5
        : to === 'victory' || to === 'defeat'
          ? 2
          : 7;
  return reduced ? base * 1.6 : base;
}

/**
 * Démarre le son de la coque de jeu ; renvoie la fonction d'arrêt (fondu de sortie, désabonnements).
 * Les abonnements ne touchent à rien d'autre que le moteur audio.
 */
export function startAudio(): () => void {
  const eng = audioEngine();
  const offs: (() => void)[] = [];
  const now = () => performance.now();

  // ——— Déverrouillage (politique d'autoplay) ———
  const gestures = ['pointerdown', 'keydown', 'touchend'] as const;
  const onGesture = () => {
    eng.unlock();
    if (eng.unlocked) gestures.forEach((g) => window.removeEventListener(g, onGesture, true));
  };
  gestures.forEach((g) => window.addEventListener(g, onGesture, true));
  offs.push(() => gestures.forEach((g) => window.removeEventListener(g, onGesture, true)));

  // ——— Visibilité ———
  const onVisibility = () => eng.setHidden(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', onVisibility);
  offs.push(() => document.removeEventListener('visibilitychange', onVisibility));
  onVisibility();

  // ——— Réglages ———
  eng.configure(useAudioSettings.getState());
  offs.push(
    useAudioSettings.subscribe((s) => {
      eng.configure(s);
      // Réactivation depuis les réglages : le clic est un geste, le contexte peut naître.
      if (!s.muted) eng.unlock();
    }),
  );

  eng.setActive(true);

  // ——— Notifications → effets ———
  const hostile: number[] = [];
  let lastNotif = useGame.getState().notifications[0]?.id ?? 0;
  let warmUntil = now() + WARMUP_MS;
  offs.push(
    useGame.subscribe((s, prev) => {
      if (s.view && !prev.view) warmUntil = now() + WARMUP_MS;
      if (s.notifications === prev.notifications) return;
      const fresh = s.notifications.filter((n) => n.id > lastNotif);
      if (!fresh.length) return;
      lastNotif = Math.max(lastNotif, ...fresh.map((n) => n.id));
      if (now() < warmUntil) return;
      // Les plus anciennes d'abord : la file est rangée de la plus récente à la plus ancienne.
      for (const n of fresh.reverse()) {
        const r = cuesFor(n.item, s.me, s.view);
        if (r.hostile) hostile.push(now());
        for (const c of r.cues) eng.playSfx(c.id, c.gain);
      }
    }),
  );

  // ——— Missiles disparus avant l'impact : interception ———
  let missiles = new Map<UnitId, number>();
  offs.push(
    useGame.subscribe((s, prev) => {
      if (s.viewVersion === prev.viewVersion || !s.view) return;
      const next = trackMissiles(s.view);
      if (now() >= warmUntil) {
        for (const [id, impactAt] of missiles) {
          if (!next.has(id) && !s.view.units[id] && s.view.time < impactAt - 30_000) {
            eng.playSfx('interception');
          }
        }
      }
      missiles = next;
    }),
  );

  // ——— Interface : fenêtres, console, sélection ———
  offs.push(
    useUi.subscribe((s, prev) => {
      if (s.windows.length > prev.windows.length) eng.playSfx('window-open');
      else if (s.windows.length < prev.windows.length) eng.playSfx('window-close');
      if (s.paletteOpen !== prev.paletteOpen || s.alertsOpen !== prev.alertsOpen) {
        eng.playSfx(s.paletteOpen || s.alertsOpen ? 'window-open' : 'window-close');
      }
      if (s.selection !== prev.selection && s.selection.length > 0) {
        const same =
          s.selection.length === prev.selection.length &&
          s.selection.every((id, i) => id === prev.selection[i]);
        if (!same) eng.playSfx('select');
      }
    }),
  );

  // ——— Ordres envoyés : clic discret (enveloppe de la connexion, restaurée à l'arrêt) ———
  let unwrap: (() => void) | null = null;
  const wrap = () => {
    unwrap?.();
    unwrap = null;
    const conn = useGame.getState().connection;
    if (!conn) return;
    const original = conn.sendOrder;
    conn.sendOrder = (order) => {
      eng.playSfx('order');
      return original.call(conn, order);
    };
    unwrap = () => {
      conn.sendOrder = original;
    };
  };
  wrap();
  offs.push(
    useGame.subscribe((s, prev) => {
      if (s.connection !== prev.connection) wrap();
    }),
  );
  offs.push(() => unwrap?.());

  // ——— Musique adaptative ———
  const director = new MoodDirector();
  let applied: MoodTarget | null = null;
  let me: NationId | null = null;
  const tick = () => {
    const { view, me: who } = useGame.getState();
    if (who !== me) {
      me = who;
      director.reset();
      applied = null;
    }
    const t = now();
    while (hostile.length && t - hostile[0]! > HOSTILE_WINDOW_MS) hostile.shift();
    if (!view) return;
    const target = director.update(selectMood(moodInputFromView(view, who, hostile.length)), t);
    if (
      applied &&
      applied.mood === target.mood &&
      Math.abs(applied.intensity - target.intensity) < 0.1
    ) {
      return;
    }
    const reduced = useAudioSettings.getState().reduced;
    eng.setScene({
      music: MOOD_MUSIC[target.mood],
      layers: ambienceLayers(target),
      fade:
        applied?.mood === target.mood ? 3 : fadeFor(applied?.mood ?? 'peace', target.mood, reduced),
    });
    applied = target;
  };
  tick();
  const timer = setInterval(tick, MOOD_TICK_MS);
  offs.push(() => clearInterval(timer));

  if (DEBUG_HOOKS) {
    (window as unknown as { __rlAudio?: unknown }).__rlAudio = {
      engine: eng,
      state: () => ({ ...eng.debug(), mood: director.state }),
    };
  }

  return () => {
    offs.forEach((off) => off());
    eng.setActive(false);
  };
}

function trackMissiles(view: PlayerView): Map<UnitId, number> {
  const out = new Map<UnitId, number>();
  for (const u of Object.values(view.units)) if (u.missile) out.set(u.id, u.missile.impactAt);
  return out;
}
