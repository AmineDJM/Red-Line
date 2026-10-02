import { HOUR, interceptProfile, type AirThreat, type WeaponSystem } from '@redline/shared';
import type { World } from '../../api.js';
import { isLanded, weaponRange, type Range } from '../../encounters/profile.js';
import { sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { milBal, milOpt } from './state.js';

/**
 * Profils de défense antiaérienne (lecture seule, sans effet) : ce qu'une unité peut intercepter,
 * à quelle distance, avec quelle probabilité et quelle doctrine, et la catégorie de menace d'une unité
 * volante. Utilisé par le cœur (paires, combat) et par le module (airdefense.ts).
 *
 * Trois origines :
 *  - fiche `interceptor.envelopes` (« explicite ») : enveloppes par catégorie ; la défense engage tout
 *    ce qui vole (aéronefs compris) par intercepteurs ;
 *  - fiche `interceptor` sans enveloppes (ancienne) : catégories déduites de `against`, portée d'arme
 *    et probabilité uniques ; seuls les missiles et munitions rôdeuses sont interceptés, les aéronefs
 *    restent engagés en rounds de combat (comportement d'origine) ;
 *  - sans fiche mais dégâts « missile » > 0 (chasseurs, navires) : interception de repli des missiles
 *    de croisière et des drones (et des balistiques pour une unité au sol ou en mer qui frappe fort).
 */

export interface AdEnv extends Range {
  pk: number;
  shots: number;
}

export interface AdProf {
  explicit: boolean;
  env: Partial<Record<AirThreat, AdEnv>>;
  /** Intercepteurs par élément. */
  magazine: number;
  /** Canaux de tir par élément et par fenêtre (null : équilibrage). */
  channels: number | null;
  reactionMs: number;
  /** Durée d'un rechargement complet (progressif). */
  reloadMs: number;
  /** Portée d'interception la plus grande (km). */
  maxKm: number;
}

const cache = new WeakMap<World, Map<string, AdProf | null>>();

function build(state: EngineState, sys: WeaponSystem): AdProf | null {
  // Calcul partagé avec l'interface (notes d'efficacité) : packages/shared/src/airdefense.ts.
  const p = interceptProfile(sys, milBal(state));
  if (!p) return null;
  return {
    explicit: p.explicit,
    env: p.env,
    magazine: p.magazine,
    channels: p.channels,
    reactionMs: p.reactionS * 1000,
    reloadMs: p.reloadH * HOUR,
    maxKm: p.maxKm,
  };
}

/**
 * Profils des fiches synthétiques de piles mixtes (state/stack.ts), par objet : une telle fiche garde
 * l'identifiant de son matériel principal mais pas ses valeurs (portée, dégâts). Rangée sous cet
 * identifiant dans le cache du monde, elle rendrait le profil dépendant de l'ordre des appels (partagé
 * entre parties, perdu au redémarrage du serveur).
 */
const synthCache = new WeakMap<WeaponSystem, AdProf | null>();

/** Profil d'un système (mis en cache par monde ; fiche synthétique : par objet). */
export function adSysProfile(state: EngineState, sys: WeaponSystem): AdProf | null {
  if (state.world.catalog.get(sys.id) !== sys) {
    let p = synthCache.get(sys);
    if (p === undefined) {
      p = build(state, sys);
      synthCache.set(sys, p);
    }
    return p;
  }
  let m = cache.get(state.world);
  if (!m) cache.set(state.world, (m = new Map()));
  let p = m.get(sys.id);
  if (p === undefined) {
    p = build(state, sys);
    m.set(sys.id, p);
  }
  return p;
}

/** Système à enveloppes détaillées : engage aussi les aéronefs par intercepteurs. */
export function isExplicitAd(sys: WeaponSystem): boolean {
  return !!sys.interceptor?.envelopes;
}

/** Profil d'une unité capable d'intercepter maintenant (ni hors carte, ni posée, ni munition). */
export function adProfile(state: EngineState, u: Unit): AdProf | null {
  if (u.off || u.role) return null;
  if (weaponRange(state, u).max <= 0) return null;
  return adSysProfile(state, sysOf(state, u));
}

/** Catégorie d'interception d'un type de missile (fiche `missile.kind`). */
export function missileThreat(sys: WeaponSystem): AirThreat {
  if (sys.category === 'drone') return 'drone';
  const k = sys.missile?.kind;
  if (k === 'ballistic' || k === 'icbm' || k === 'slbm') return 'ballistic_missile';
  if (k === 'hypersonic') return 'hypersonic';
  return 'cruise_missile';
}

/** Catégorie de menace aérienne d'une unité (null : pas une cible aérienne en vol). */
export function threatOf(state: EngineState, t: Unit): AirThreat | null {
  if (t.off) return null;
  const s = sysOf(state, t);
  if (t.role === 'missile') return missileThreat(s);
  if (s.movement !== 'air' || s.missile || s.category === 'space') return null;
  if (s.air && isLanded(state, t)) return null;
  const c = s.targetClass;
  return c === 'aircraft' || c === 'helicopter' || c === 'drone' ? c : null;
}

/**
 * Enveloppe effective de `I` contre la catégorie `c` : celle de la fiche, bornée par la portée d'un site
 * de défense fixe (selon son niveau). Null si la catégorie n'est pas engagée.
 */
export function envOf(state: EngineState, I: Unit, prof: AdProf, c: AirThreat): AdEnv | null {
  const e = prof.env[c];
  if (!e) return null;
  const site = milOpt(state)?.siteRange[I.id];
  if (site === undefined || site >= e.max) return e;
  if (site <= e.min) return null;
  return { ...e, max: site };
}

/**
 * Bande d'enveloppe de `I` contre `t` pour la surveillance des paires (seuils de franchissement) :
 * seulement pour les systèmes à enveloppes détaillées (les autres utilisent la portée d'arme).
 */
export function adBand(state: EngineState, I: Unit, t: Unit): Range | null {
  // Chemin rapide (évaluation de chaque paire) : un intercepteur n'est jamais une pile mixte.
  if (I.mix || !state.world.catalog.get(I.sys)?.interceptor?.envelopes) return null;
  const prof = adProfile(state, I);
  if (!prof) return null;
  const c = threatOf(state, t);
  return c ? envOf(state, I, prof, c) : null;
}
