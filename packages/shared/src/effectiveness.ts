import type { AirThreat, Category, TargetClass, WeaponSystem } from './catalog.js';
import { interceptProfile, type InterceptProfile } from './airdefense.js';
import {
  EffectivenessBalanceSchema,
  MilitaryBalanceSchema,
  type EffectivenessBalance,
  type MilitaryBalance,
} from './balance.js';

/**
 * Efficacité par catégorie de cible : une note de 0 à 1 (et un niveau sur 5 crans : nul, faible,
 * moyen, bon, excellent) pour chaque système, dérivée des valeurs que le moteur emploie réellement :
 *
 *  - tir en rounds (combat/combat.ts) : part d'un élément « type » de la catégorie détruite par round
 *    et par élément = dégâts[classe] × (1 − blindage type) ÷ points de vie type ; un aéronef frappe
 *    une cible de surface en mission de frappe (military.strike.airStrikeMult rounds d'un coup) ;
 *    un bâtiment encaisse dégâts « building » ÷ military.strike.buildingHp ;
 *  - interception (modules/mil/airdefense.ts, profil partagé `interceptProfile`) : probabilité de
 *    détruire une menace type = 1 − (1 − pk × (1 − évasion ou furtivité type))^tirs ; la défense
 *    à enveloppes n'engage les aéronefs QUE par intercepteurs, les missiles en vol ne sont jamais
 *    engagés en rounds ;
 *  - « type » : médianes des systèmes actifs du catalogue de la catégorie (blindage, points de vie,
 *    furtivité, évasion).
 *
 * La note rapporte cette efficacité brute à celle des meilleurs systèmes du catalogue contre la
 * catégorie (quantile `effectiveness.refQuantile`, armes nucléaires exclues) : « excellent » veut dire
 * parmi les meilleurs du jeu contre ce type de cible. Les blindés et l'artillerie partagent la colonne
 * « armor » de la matrice ; l'artillerie, moins protégée, est notée sur l'échelle des blindés (un char
 * est donc plus efficace contre l'artillerie que contre un autre char). Pile mixte : moyenne des notes
 * pondérée par le nombre d'éléments de chaque matériel (comme la matrice de dégâts d'une pile).
 */

export const EFFECT_TARGETS = [
  'aircraft',
  'helicopter',
  'drone',
  'missile',
  'armor',
  'infantry',
  'artillery',
  'ship',
  'submarine',
  'building',
] as const;
export type EffectTarget = (typeof EFFECT_TARGETS)[number];

/** Niveau affiché : 0 nul, 1 faible, 2 moyen, 3 bon, 4 excellent. */
export type EffectLevel = 0 | 1 | 2 | 3 | 4;

export type EffectScores = Record<EffectTarget, number>;

/** Colonne de la matrice de dégâts employée contre chaque catégorie (null : interception seule). */
const COLUMN: Record<EffectTarget, TargetClass | null> = {
  aircraft: 'aircraft',
  helicopter: 'helicopter',
  drone: 'drone',
  missile: null,
  armor: 'armor',
  infantry: 'infantry',
  artillery: 'armor',
  ship: 'ship',
  submarine: 'submarine',
  building: 'building',
};

/** Menace aérienne correspondante (interception). */
const THREAT: Partial<Record<EffectTarget, AirThreat>> = {
  aircraft: 'aircraft',
  helicopter: 'helicopter',
  drone: 'drone',
};

const MISSILE_THREATS = ['cruise_missile', 'ballistic_missile', 'hypersonic'] as const;

/** Catégorie dont l'échelle sert de référence (même colonne de dégâts). */
const SCALE: Partial<Record<EffectTarget, EffectTarget>> = { artillery: 'armor' };

const SURFACE = new Set<EffectTarget>([
  'armor',
  'infantry',
  'artillery',
  'ship',
  'submarine',
  'building',
]);

/** Système qui, pris pour cible, compte dans la catégorie (population des valeurs « type »). */
function memberOf(s: WeaponSystem): EffectTarget | null {
  if (s.missile) return s.category === 'drone' ? 'drone' : 'missile';
  const c: Category = s.category;
  if (c === 'tank' || c === 'ifv') return 'armor';
  if (c === 'infantry') return 'infantry';
  if (c === 'artillery') return 'artillery';
  if (c === 'surface_ship') return 'ship';
  if (c === 'submarine') return 'submarine';
  if (s.movement === 'air') {
    if (s.targetClass === 'helicopter') return 'helicopter';
    if (s.targetClass === 'drone') return 'drone';
    if (s.targetClass === 'aircraft') return 'aircraft';
  }
  return null;
}

/** Missile en vol : catégorie de menace (comme le moteur, ad-profile.ts `missileThreat`). */
function missileThreatOf(s: WeaponSystem): AirThreat {
  if (s.category === 'drone') return 'drone';
  const k = s.missile?.kind;
  if (k === 'ballistic' || k === 'icbm' || k === 'slbm') return 'ballistic_missile';
  if (k === 'hypersonic') return 'hypersonic';
  return 'cruise_missile';
}

/**
 * Catégorie d'une cible désignée (barre de confirmation d'un ordre d'attaque) : salve en vol ou
 * munition, aéronef posé (bâtiment), sinon d'après le matériel. Null : sans catégorie (satellite…).
 */
export function effectTargetOf(
  s: WeaponSystem,
  opts: { inFlight?: boolean; landed?: boolean } = {},
): EffectTarget | null {
  if (opts.inFlight) return s.category === 'drone' ? 'drone' : 'missile';
  if (s.missile || (s.air && opts.landed)) return 'building';
  const m = memberOf(s);
  if (m) return m;
  // Défense antiaérienne, radars, convois : colonne de leur classe de cible.
  if (s.targetClass === 'armor') return 'artillery';
  if (s.targetClass === 'infantry') return 'infantry';
  if (s.targetClass === 'ship') return 'ship';
  if (s.targetClass === 'building') return 'building';
  return null;
}

interface Ref {
  hp: number;
  armor: number;
  stealth: number;
}

export interface EffectivenessContext {
  bal: EffectivenessBalance;
  mil: MilitaryBalance;
  ref: Record<EffectTarget, Ref>;
  /** Évasion type des missiles en vol, par menace. */
  evasion: Record<(typeof MISSILE_THREATS)[number], number>;
  /** Efficacité brute qui vaut la note 1, par catégorie. */
  norm: Record<EffectTarget, number>;
  cache: Map<string, EffectScores>;
}

function median(xs: number[], fallback: number): number {
  if (xs.length === 0) return fallback;
  const a = [...xs].sort((x, y) => x - y);
  const m = (a.length - 1) / 2;
  return (a[Math.floor(m)]! + a[Math.ceil(m)]!) / 2;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const p = q * (a.length - 1);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return a[lo]! + (a[hi]! - a[lo]!) * (p - lo);
}

/** Probabilité de détruire une menace type par engagement (salve de `shots` intercepteurs). */
function interceptKill(
  sys: WeaponSystem,
  prof: InterceptProfile | null,
  threat: AirThreat,
  ctx: Pick<EffectivenessContext, 'mil' | 'ref' | 'evasion'>,
): number {
  const e = prof?.env[threat];
  if (!prof || !e || e.pk <= 0) return 0;
  // Fiches anciennes et repli : aéronefs engagés en rounds, pas par intercepteurs.
  if (!prof.explicit && (threat === 'aircraft' || threat === 'helicopter')) return 0;
  let pk = e.pk;
  if (threat === 'drone' || threat === 'aircraft' || threat === 'helicopter') {
    const sd = sys.sensor?.stealthDetect ?? 0;
    const st = ctx.ref[threat].stealth;
    pk *= 1 - Math.min(1, st * (1 - sd) * ctx.mil.airDefense.stealthPkFactor);
  } else {
    pk *= 1 - ctx.evasion[threat];
  }
  pk = Math.max(0, Math.min(0.98, pk));
  return 1 - Math.pow(1 - pk, e.shots);
}

/** Efficacité brute (part d'une cible type détruite par round, frappe ou engagement). */
function rawOf(
  sys: WeaponSystem,
  t: EffectTarget,
  ctx: Pick<EffectivenessContext, 'mil' | 'ref' | 'evasion' | 'bal'>,
): number {
  const prof = interceptProfile(sys, ctx.mil);
  if (t === 'missile') {
    const w = ctx.bal.missileWeights;
    let num = 0;
    let den = 0;
    for (const c of MISSILE_THREATS) {
      num += w[c] * interceptKill(sys, prof, c, ctx);
      den += w[c];
    }
    return den > 0 ? num / den : 0;
  }
  const threat = THREAT[t];
  const ic = threat ? interceptKill(sys, prof, threat, ctx) : 0;
  let round = 0;
  const col = COLUMN[t]!;
  const d = sys.damage[col];
  // Défense à enveloppes : jamais de rounds contre ce qui vole. Sans portée d'arme ni munition : rien.
  const air = !!threat;
  const fires = sys.weaponRangeKm.max > 0 || !!sys.missile;
  if (d > 0 && fires && !(air && sys.interceptor?.envelopes)) {
    const strike = sys.air && !sys.missile && SURFACE.has(t) ? ctx.mil.strike.airStrikeMult : 1;
    if (t === 'building') round = (d * strike) / ctx.mil.strike.buildingHp;
    else {
      const r = ctx.ref[t];
      round = (d * strike * (1 - r.armor)) / r.hp;
    }
  }
  return Math.max(round, ic);
}

/**
 * Contexte de notation (valeurs type et échelles) d'un catalogue et d'un équilibrage. À calculer une
 * fois par catalogue (le client le mémorise) ; les notes de chaque système y sont mises en cache.
 */
export function effectivenessContext(
  systems: Iterable<WeaponSystem>,
  balance?: { military?: unknown; effectiveness?: unknown } | null,
): EffectivenessContext {
  const bal = EffectivenessBalanceSchema.parse(balance?.effectiveness ?? {});
  const mil = MilitaryBalanceSchema.parse(balance?.military ?? {});
  const list = [...systems].filter((s) => s.enabled !== false);
  const pop = new Map<EffectTarget, WeaponSystem[]>();
  const evs: Record<string, number[]> = {};
  for (const s of list) {
    const m = memberOf(s);
    if (m) pop.set(m, [...(pop.get(m) ?? []), s]);
    if (s.missile && s.category !== 'drone')
      (evs[missileThreatOf(s)] ??= []).push(s.missile.evasion);
  }
  const ref = {} as Record<EffectTarget, Ref>;
  for (const t of EFFECT_TARGETS) {
    const p = pop.get(t) ?? [];
    ref[t] =
      t === 'building'
        ? { hp: mil.strike.buildingHp, armor: 0, stealth: 0 }
        : {
            hp: Math.max(
              1e-6,
              median(
                p.map((s) => s.hp),
                1,
              ),
            ),
            armor: median(
              p.map((s) => s.armor),
              0,
            ),
            stealth: median(
              p.map((s) => s.stealth),
              0,
            ),
          };
  }
  const evasion = {
    cruise_missile: median(evs.cruise_missile ?? [], 0),
    ballistic_missile: median(evs.ballistic_missile ?? [], 0),
    hypersonic: median(evs.hypersonic ?? [], 0),
  };
  const base = { bal, mil, ref, evasion };
  const norm = {} as Record<EffectTarget, number>;
  const armed = list.filter((s) => s.missile?.warhead !== 'nuclear');
  for (const t of EFFECT_TARGETS) {
    const k = armed.map((s) => rawOf(s, SCALE[t] ?? t, base)).filter((x) => x > 0);
    norm[t] = quantile(k, bal.refQuantile) || 1;
  }
  return { ...base, norm, cache: new Map() };
}

/** Notes (0..1) d'un système contre chaque catégorie de cible. */
export function systemEffectiveness(sys: WeaponSystem, ctx: EffectivenessContext): EffectScores {
  const hit = ctx.cache.get(sys.id);
  if (hit) return hit;
  const out = {} as EffectScores;
  for (const t of EFFECT_TARGETS) {
    const raw = rawOf(sys, t, ctx);
    out[t] = raw > 0 ? Math.min(1, raw / ctx.norm[SCALE[t] ?? t]) : 0;
  }
  ctx.cache.set(sys.id, out);
  return out;
}

/** Pile (mixte ou non) : moyenne des notes pondérée par le nombre d'éléments de chaque matériel. */
export function mixEffectiveness(
  parts: readonly { system: WeaponSystem; count: number }[],
  ctx: EffectivenessContext,
): EffectScores {
  const out = {} as EffectScores;
  for (const t of EFFECT_TARGETS) out[t] = 0;
  let n = 0;
  for (const p of parts) {
    if (!(p.count > 0)) continue;
    const s = systemEffectiveness(p.system, ctx);
    for (const t of EFFECT_TARGETS) out[t] += s[t] * p.count;
    n += p.count;
  }
  if (n > 0) for (const t of EFFECT_TARGETS) out[t] /= n;
  return out;
}

/** Niveau d'une note : nul (0), faible, moyen, bon, excellent (seuils de l'équilibrage). */
export function effectLevel(score: number, ctx: Pick<EffectivenessContext, 'bal'>): EffectLevel {
  if (!(score > 0)) return 0;
  const l = ctx.bal.levels;
  if (score >= l.excellent) return 4;
  if (score >= l.good) return 3;
  if (score >= l.medium) return 2;
  return 1;
}

/**
 * Note d'une pile contre une cible précise (barre de confirmation d'un ordre d'attaque) : même calcul,
 * avec le blindage, les points de vie, la furtivité ou l'évasion de la cible elle-même, sur l'échelle
 * de sa catégorie. Null si la cible n'a pas de catégorie (satellite).
 */
export function effectAgainst(
  parts: readonly { system: WeaponSystem; count: number }[],
  target: WeaponSystem,
  ctx: EffectivenessContext,
  opts: { inFlight?: boolean; landed?: boolean } = {},
): { target: EffectTarget; score: number } | null {
  const t = effectTargetOf(target, opts);
  if (!t) return null;
  const sub = { ...ctx, ref: { ...ctx.ref }, evasion: { ...ctx.evasion }, bal: { ...ctx.bal } };
  if (t === 'missile') {
    const th = missileThreatOf(target) as (typeof MISSILE_THREATS)[number];
    sub.evasion[th] = target.missile?.evasion ?? 0;
    sub.bal.missileWeights = { cruise_missile: 0, ballistic_missile: 0, hypersonic: 0, [th]: 1 };
  } else if (t !== 'building') {
    sub.ref[t] = { hp: Math.max(1e-6, target.hp), armor: target.armor, stealth: target.stealth };
  }
  let sum = 0;
  let n = 0;
  for (const p of parts) {
    if (!(p.count > 0)) continue;
    const raw = rawOf(p.system, t, sub);
    sum += (raw > 0 ? Math.min(1, raw / ctx.norm[SCALE[t] ?? t]) : 0) * p.count;
    n += p.count;
  }
  return { target: t, score: n > 0 ? sum / n : 0 };
}
