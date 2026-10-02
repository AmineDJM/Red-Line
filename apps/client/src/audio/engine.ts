/**
 * Moteur audio (Web Audio API).
 *
 *   musique ─┐
 *   ambiance ┴─ atténuation (ponctuations) ─┐
 *   effets ─────────────────────────────────┼─ général ─ limiteur doux ─ sortie
 *   interface ──────────────────────────────┘
 *
 *  - Contexte créé au premier geste de l'utilisateur (politique d'autoplay), jamais avant ; rien n'est
 *    téléchargé tant que le son est coupé.
 *  - Chargement paresseux : un morceau n'est téléchargé et décodé que lorsqu'il doit jouer, puis libéré
 *    après un temps de silence (mémoire bornée sur mobile). Boucles exactes à l'échantillon
 *    (`loopStart`/`loopEnd` du manifeste, jointure soudée), fondus enchaînés par gains.
 *  - Onglet caché : fondu puis contexte suspendu (tout se fige, rien ne se télécharge).
 *  - Opus/WebM par défaut, AAC/M4A pour Safari (et en repli si le décodage échoue).
 */
import { SfxLimiter } from './limiter.js';
import { PRELOAD_SFX, SFX, type AmbienceId, type MusicId, type SfxId } from './sounds.js';
import type { AudioSettings } from './settings.js';
import { weldLoop } from './weld.js';

export interface ManifestEntry {
  kind: 'music' | 'ambience' | 'sfx';
  /** Chemin sans extension, relatif à /audio/. */
  base: string;
  duration: number;
  loop: boolean;
  /** Bornes de la boucle dans le fichier (s). */
  loopStart?: number;
  loopEnd?: number;
  channels: number;
  bytes: { webm: number; m4a: number };
}

export interface AudioManifest {
  version: number;
  sounds: Record<string, ManifestEntry>;
}

type Format = 'webm' | 'm4a';
type BusId = 'music' | 'ambience' | 'sfx' | 'ui';

export interface AudioScene {
  music: MusicId | null;
  layers: Partial<Record<AmbienceId, number>>;
  /** Durée des fondus (s). */
  fade: number;
}

interface Track {
  id: string;
  entry: ManifestEntry;
  gain: GainNode;
  /** Niveau voulu (0 : en extinction ou arrêtée). */
  level: number;
  buffer: AudioBuffer | null;
  loading: Promise<AudioBuffer | null> | null;
  source: AudioBufferSourceNode | null;
  /** Position de reprise dans la boucle (s, relative à loopStart). */
  offset: number;
  startedAt: number;
  /** Pièce non bouclée déjà jouée (pas de rejeu tant qu'elle n'a pas été éteinte). */
  played: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const AUDIO_ROOT = '/audio/';
/** Attente maximale du premier chargement d'un effet avant de renoncer (un son en retard gêne). */
const LATE_MS = { sting: 4000, other: 900, ui: 250 } as const;
/** Libération d'une piste muette (mémoire) : musiques (gros tampons) plus vite que les ambiances. */
const RELEASE_IDLE_MS = { music: 30_000, ambience: 90_000 } as const;

function pickFormat(): Format {
  try {
    const a = document.createElement('audio');
    const apple = /Apple/i.test(navigator.vendor ?? '');
    const webm = a.canPlayType('audio/webm; codecs="opus"') !== '';
    const m4a = a.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
    if (webm && !apple) return 'webm';
    if (m4a) return 'm4a';
  } catch {
    /* environnement sans DOM */
  }
  return 'webm';
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private duck: GainNode | null = null;
  private buses: Partial<Record<BusId, GainNode>> = {};
  private manifest: Promise<AudioManifest | null> | null = null;
  private manifestData: AudioManifest | null = null;
  private format: Format = 'webm';
  private sfxBuffers = new Map<SfxId, Promise<AudioBuffer | null>>();
  private sources = new Map<number, AudioBufferSourceNode>();
  private tracks = new Map<string, Track>();
  private limiter = new SfxLimiter();
  private scene: AudioScene = { music: null, layers: {}, fade: 2 };
  private hidden = false;
  private active = false;
  private settings: AudioSettings;
  private saveData = false;

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  /** Le contexte audio existe (premier geste reçu). */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Coque de jeu montée : les scènes et les effets sont joués. */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    const ctx = this.ctx;
    if (!on) {
      this.stopAll(1.2);
      this.limiter.reset();
      // Hors de la partie : contexte suspendu (aucune ressource audio du système retenue).
      setTimeout(() => {
        if (!this.active && ctx) void ctx.suspend().catch(() => {});
      }, 1600);
    } else {
      if (ctx && !this.hidden) void ctx.resume().catch(() => {});
      this.applyScene();
    }
  }

  /**
   * À appeler dans un gestionnaire de geste (clic, touche) : crée ou relance le contexte.
   * Sans effet si le son est coupé (rien n'est créé ni téléchargé).
   */
  unlock(): void {
    if (this.settings.muted) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.hidden) void this.ctx.resume().catch(() => {});
      return;
    }
    const w = typeof window !== 'undefined' ? window : undefined;
    const Ctor =
      w?.AudioContext ??
      (w as unknown as { webkitAudioContext?: typeof AudioContext })?.webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    this.format = pickFormat();
    this.saveData = !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
    // Limiteur doux de sécurité : jamais de saturation, même si tout se superpose.
    const safety = ctx.createDynamicsCompressor();
    safety.threshold.value = -6;
    safety.knee.value = 6;
    safety.ratio.value = 12;
    safety.attack.value = 0.003;
    safety.release.value = 0.25;
    safety.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(safety);
    this.duck = ctx.createGain();
    this.duck.connect(this.master);
    for (const id of ['music', 'ambience', 'sfx', 'ui'] as BusId[]) {
      const g = ctx.createGain();
      g.connect(id === 'music' || id === 'ambience' ? this.duck : this.master);
      this.buses[id] = g;
    }
    this.applySettings(0);
    void ctx.resume().catch(() => {});
    void this.loadManifest().then((m) => {
      if (!m) return;
      this.applyScene();
      const idle =
        (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ??
        ((cb: () => void) => setTimeout(cb, 1500));
      idle(() => PRELOAD_SFX.forEach((id) => void this.sfxBuffer(id)));
    });
  }

  configure(settings: AudioSettings): void {
    const wasMuted = this.settings.muted;
    this.settings = settings;
    if (!this.ctx) return;
    this.applySettings(0.12);
    if (settings.muted && !wasMuted) {
      for (const h of [...this.sources.keys()]) this.stopSource(h, 0.1);
      for (const t of this.tracks.values()) this.level(t, 0, 0.15);
    } else this.applyScene();
  }

  private applySettings(ramp: number): void {
    const s = this.settings;
    // Courbe perceptive : un curseur à mi-course ≈ −12 dB.
    const curve = (v: number) => v * v;
    this.setGain(this.master, s.muted || this.hidden ? 0 : curve(s.master), ramp);
    this.setGain(this.buses.music, curve(s.music), ramp);
    this.setGain(this.buses.ambience, curve(s.music) * (s.reduced ? 0.5 : 0.9), ramp);
    this.setGain(this.buses.sfx, curve(s.sfx), ramp);
    this.setGain(this.buses.ui, curve(s.ui), ramp);
  }

  private setGain(g: GainNode | null | undefined, v: number, ramp: number): void {
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(v, t + Math.max(0.01, ramp));
  }

  private loadManifest(): Promise<AudioManifest | null> {
    this.manifest ??= fetch(`${AUDIO_ROOT}manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<AudioManifest>) : null))
      .then((m) => {
        this.manifestData = m && typeof m === 'object' && m.sounds ? m : null;
        return this.manifestData;
      })
      .catch(() => null);
    return this.manifest;
  }

  /** Télécharge et décode un son (repli sur l'autre format si le premier échoue). */
  private async decode(entry: ManifestEntry): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const one = async (format: Format) => {
      const res = await fetch(`${AUDIO_ROOT}${entry.base}.${format}`);
      if (!res.ok) throw new Error(String(res.status));
      return ctx.decodeAudioData(await res.arrayBuffer());
    };
    try {
      return await one(this.format);
    } catch {
      try {
        const buf = await one(this.format === 'webm' ? 'm4a' : 'webm');
        // L'autre format marche mieux sur ce navigateur : on s'y tient.
        this.format = this.format === 'webm' ? 'm4a' : 'webm';
        return buf;
      } catch {
        return null;
      }
    }
  }

  // ——— Effets ———

  private sfxBuffer(id: SfxId): Promise<AudioBuffer | null> {
    let p = this.sfxBuffers.get(id);
    if (!p) {
      p = this.loadManifest().then((m) => {
        const entry = m?.sounds[id];
        return entry ? this.decode(entry) : null;
      });
      this.sfxBuffers.set(id, p);
    }
    return p;
  }

  /** Joue un effet (soumis au limiteur). `gain` : volume relatif supplémentaire. */
  playSfx(id: SfxId, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.active || this.settings.muted || this.hidden) return;
    const def = SFX[id];
    const entry = this.manifestData?.sounds[id];
    const decision = this.limiter.request(
      id,
      def,
      performance.now(),
      (entry?.duration ?? 2) * 1000,
    );
    if (!decision.play) return;
    if (decision.replace !== null) this.stopSource(decision.replace, 0.08);
    const asked = performance.now();
    const late =
      LATE_MS[def.category === 'sting' ? 'sting' : def.category === 'ui' ? 'ui' : 'other'];
    void this.sfxBuffer(id).then((buf) => {
      const stale = performance.now() - asked > late;
      if (!buf || stale || this.ctx !== ctx || this.hidden || this.settings.muted) {
        this.limiter.release(decision.handle);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const soft = this.settings.reduced && def.category === 'sting' ? 0.7 : 1;
      g.gain.value = def.volume * decision.gain * gain * soft;
      src.connect(g).connect(this.buses[def.bus]!);
      src.onended = () => {
        this.sources.delete(decision.handle);
        this.limiter.release(decision.handle);
        g.disconnect();
      };
      this.sources.set(decision.handle, src);
      src.start();
      if (def.duck) this.duckFor(buf.duration);
    });
  }

  private stopSource(handle: number, fade: number): void {
    const src = this.sources.get(handle);
    if (!src || !this.ctx) return;
    try {
      src.stop(this.ctx.currentTime + fade);
    } catch {
      /* déjà arrêtée */
    }
    this.sources.delete(handle);
  }

  /** Abaisse musique et ambiances le temps d'une ponctuation dramatique. */
  private duckFor(seconds: number): void {
    const ctx = this.ctx;
    const g = this.duck?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    const hold = t + Math.max(0.3, seconds * 0.6);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.35, t + 0.15);
    g.setValueAtTime(0.35, hold);
    g.linearRampToValueAtTime(1, hold + 1.8);
  }

  // ——— Musique et ambiances ———

  /** Scène voulue : morceau et couches d'ambiance (fondus enchaînés). */
  setScene(scene: AudioScene): void {
    this.scene = scene;
    this.applyScene();
  }

  private applyScene(): void {
    if (!this.ctx || !this.manifestData || !this.active || this.settings.muted) return;
    const { music, layers, fade } = this.scene;
    const wanted = new Map<string, number>();
    if (music) wanted.set(music, 1);
    if (!this.saveData) {
      for (const [id, level] of Object.entries(layers)) {
        // Sons réduits : pas de couche de bataille.
        const v = this.settings.reduced && id === 'amb-combat' ? 0 : (level ?? 0);
        if (v > 0.001) wanted.set(id, v);
      }
    }
    // Le morceau sortant continue tant que l'entrant n'est pas chargé : jamais de trou de silence.
    const next = music ? this.track(music) : null;
    const waiting = !!next && !next.source && !next.played;
    for (const t of this.tracks.values()) {
      if (wanted.has(t.id) || (waiting && t.entry.kind === 'music')) continue;
      this.level(t, 0, fade);
    }
    for (const [id, v] of wanted) {
      const t = this.track(id);
      if (t) this.level(t, v, fade);
    }
  }

  private track(id: string): Track | null {
    const ctx = this.ctx;
    const entry = this.manifestData?.sounds[id];
    if (!ctx || !entry || entry.kind === 'sfx') return null;
    let t = this.tracks.get(id);
    if (!t) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.buses[entry.kind === 'music' ? 'music' : 'ambience']!);
      t = {
        id,
        entry,
        gain,
        level: 0,
        buffer: null,
        loading: null,
        source: null,
        offset: 0,
        startedAt: 0,
        played: false,
        stopTimer: null,
        releaseTimer: null,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  private level(t: Track, level: number, fade: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (level <= 0.001) {
      if (t.level === 0) return;
      t.level = 0;
      this.ramp(t.gain, 0, fade);
      if (t.stopTimer) clearTimeout(t.stopTimer);
      t.stopTimer = setTimeout(() => this.halt(t), fade * 1000 + 200);
      return;
    }
    if (t.stopTimer) clearTimeout(t.stopTimer);
    if (t.releaseTimer) clearTimeout(t.releaseTimer);
    t.stopTimer = t.releaseTimer = null;
    t.level = level;
    if (t.source) {
      this.ramp(t.gain, level, fade);
      return;
    }
    if (t.played) return;
    // Démarrage : chargement paresseux, puis fondu entrant depuis zéro.
    t.loading ??= this.decode(t.entry).then((buf) => {
      if (buf && t.entry.loop && t.entry.loopStart !== undefined && t.entry.loopEnd !== undefined) {
        const a = Math.round(t.entry.loopStart * buf.sampleRate);
        const b = Math.round(t.entry.loopEnd * buf.sampleRate);
        for (let c = 0; c < buf.numberOfChannels; c++) weldLoop(buf.getChannelData(c), a, b);
      }
      t.buffer = buf;
      t.loading = null;
      return buf;
    });
    void t.loading.then(() => {
      if (!t.buffer || t.level <= 0 || t.source || this.ctx !== ctx) return;
      this.start(t);
      this.ramp(t.gain, t.level, fade);
      // Morceau entrant prêt : le sortant peut maintenant s'effacer (fondu enchaîné).
      if (t.entry.kind === 'music') this.applyScene();
    });
  }

  private start(t: Track): void {
    const ctx = this.ctx!;
    const buf = t.buffer!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const { loop, loopStart = 0, loopEnd = buf.duration } = t.entry;
    let at = 0;
    if (loop) {
      src.loop = true;
      src.loopStart = loopStart;
      src.loopEnd = loopEnd;
      at = loopStart + (t.offset % (loopEnd - loopStart));
    } else {
      t.offset = 0;
      t.played = true;
    }
    t.gain.gain.cancelScheduledValues(ctx.currentTime);
    t.gain.gain.setValueAtTime(0, ctx.currentTime);
    src.connect(t.gain);
    src.onended = () => {
      if (t.source === src) t.source = null;
    };
    src.start(ctx.currentTime + 0.02, at);
    t.source = src;
    t.startedAt = ctx.currentTime + 0.02 - (at - loopStart);
  }

  /** Arrêt après extinction : mémorise la position (reprise au même endroit), puis libère. */
  private halt(t: Track): void {
    const ctx = this.ctx;
    t.stopTimer = null;
    if (t.level > 0 || !ctx) return;
    t.played = false;
    if (t.source) {
      const { loopStart = 0, loopEnd = t.buffer?.duration ?? 1 } = t.entry;
      if (t.entry.loop) t.offset = (ctx.currentTime - t.startedAt) % (loopEnd - loopStart);
      try {
        t.source.stop();
      } catch {
        /* déjà arrêtée */
      }
      t.source.disconnect();
      t.source = null;
    }
    t.releaseTimer = setTimeout(
      () => {
        if (t.level > 0 || t.source) return;
        t.buffer = null;
        t.gain.disconnect();
        this.tracks.delete(t.id);
      },
      RELEASE_IDLE_MS[t.entry.kind === 'music' ? 'music' : 'ambience'],
    );
  }

  private ramp(g: GainNode, v: number, fade: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(v, t + Math.max(0.05, fade));
  }

  /** Coupe tout en fondu (sortie de la partie). */
  stopAll(fade: number): void {
    for (const t of this.tracks.values()) this.level(t, 0, fade);
    for (const h of [...this.sources.keys()]) this.stopSource(h, Math.min(fade, 0.5));
  }

  // ——— Visibilité ———

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx) return;
    if (hidden) {
      this.applySettings(0.25);
      setTimeout(() => {
        if (this.hidden) void ctx.suspend().catch(() => {});
      }, 320);
    } else {
      void ctx.resume().catch(() => {});
      this.applySettings(0.8);
    }
  }

  /** État de diagnostic (window.__rlAudio). */
  debug(): Record<string, unknown> {
    return {
      state: this.ctx?.state ?? 'locked',
      format: this.format,
      active: this.active,
      hidden: this.hidden,
      scene: this.scene,
      tracks: [...this.tracks.values()].map((t) => ({
        id: t.id,
        level: t.level,
        playing: !!t.source,
        loaded: !!t.buffer,
      })),
      playing: this.limiter.playing(performance.now()),
    };
  }
}
