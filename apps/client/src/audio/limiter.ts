/**
 * Limiteur d'effets (fonction pure du temps fourni, testée) : ne jamais saturer.
 *
 *  - écart minimal par son (`gapMs`) ;
 *  - regroupement des rafales : dans une fenêtre, au plus N lectures du même son, de plus en plus douces ;
 *  - plafond de lectures simultanées par catégorie, puis global ; un son plus prioritaire remplace le
 *    moins prioritaire en cours, sinon il est abandonné.
 */
import type { SfxCategory, SfxDef } from './sounds.js';

export interface CategoryRule {
  /** Lectures simultanées maximales dans la catégorie. */
  maxConcurrent: number;
  /** Fenêtre de regroupement d'une rafale (ms). */
  burstMs: number;
  /** Lectures maximales du même son par fenêtre de rafale. */
  burstMax: number;
}

export const CATEGORY_RULES: Record<SfxCategory, CategoryRule> = {
  sting: { maxConcurrent: 1, burstMs: 3000, burstMax: 1 },
  combat: { maxConcurrent: 3, burstMs: 1600, burstMax: 2 },
  alert: { maxConcurrent: 1, burstMs: 4000, burstMax: 1 },
  info: { maxConcurrent: 2, burstMs: 2500, burstMax: 1 },
  ui: { maxConcurrent: 3, burstMs: 500, burstMax: 4 },
};

/** Lectures simultanées maximales, toutes catégories confondues. */
export const GLOBAL_MAX = 6;

export type DropReason = 'gap' | 'burst' | 'category' | 'global';

export type PlayDecision =
  | {
      play: true;
      /** Identifiant de la lecture (à passer à `release` si elle s'arrête plus tôt). */
      handle: number;
      /** Gain multiplicatif (atténuation dans une rafale). */
      gain: number;
      /** Lecture en cours à couper (remplacée par un son plus prioritaire). */
      replace: number | null;
    }
  | { play: false; reason: DropReason };

interface Active {
  handle: number;
  id: string;
  category: SfxCategory;
  priority: number;
  until: number;
}

export class SfxLimiter {
  private active: Active[] = [];
  private lastPlay = new Map<string, number>();
  private bursts = new Map<string, { start: number; count: number }>();
  private seq = 0;

  constructor(
    private readonly rules: Record<SfxCategory, CategoryRule> = CATEGORY_RULES,
    private readonly globalMax = GLOBAL_MAX,
  ) {}

  /** Demande de lecture du son `id` (durée `durationMs`) à l'instant `now` (ms). */
  request(id: string, def: SfxDef, now: number, durationMs: number): PlayDecision {
    this.active = this.active.filter((a) => a.until > now);
    const last = this.lastPlay.get(id);
    if (last !== undefined && now - last < def.gapMs) return { play: false, reason: 'gap' };

    const rule = this.rules[def.category];
    let burst = this.bursts.get(id);
    if (!burst || now - burst.start >= rule.burstMs) burst = { start: now, count: 0 };
    if (burst.count >= rule.burstMax) return { play: false, reason: 'burst' };

    let replace: number | null = null;
    const inCategory = this.active.filter((a) => a.category === def.category);
    if (inCategory.length >= rule.maxConcurrent) {
      const victim = lowest(inCategory);
      if (!victim || victim.priority >= def.priority) return { play: false, reason: 'category' };
      replace = victim.handle;
    }
    const others = this.active.filter((a) => a.handle !== replace);
    if (others.length >= this.globalMax) {
      // Les ponctuations dramatiques ne sont jamais coupées au profit d'un effet ordinaire.
      const victim = lowest(others.filter((a) => a.category !== 'sting'));
      if (!victim || victim.priority >= def.priority || replace !== null) {
        return { play: false, reason: 'global' };
      }
      replace = victim.handle;
    }

    burst.count += 1;
    this.bursts.set(id, burst);
    this.lastPlay.set(id, now);
    if (replace !== null) this.active = this.active.filter((a) => a.handle !== replace);
    const handle = ++this.seq;
    this.active.push({
      handle,
      id,
      category: def.category,
      priority: def.priority,
      until: now + Math.max(50, durationMs),
    });
    // Rafale : chaque lecture supplémentaire est plus douce (−3,5 dB environ par rang).
    const gain = 1 / (1 + 0.5 * (burst.count - 1));
    return { play: true, handle, gain, replace };
  }

  /** Lecture terminée ou coupée avant la fin prévue. */
  release(handle: number): void {
    this.active = this.active.filter((a) => a.handle !== handle);
  }

  /** Nombre de lectures en cours (diagnostic, tests). */
  playing(now: number): number {
    return this.active.filter((a) => a.until > now).length;
  }

  reset(): void {
    this.active = [];
    this.lastPlay.clear();
    this.bursts.clear();
  }
}

function lowest(list: Active[]): Active | null {
  return list.reduce<Active | null>((m, a) => (!m || a.priority < m.priority ? a : m), null);
}
