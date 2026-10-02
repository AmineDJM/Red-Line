import { AIR_THREATS, type AirThreat, type WeaponSystem } from './catalog.js';
import type { MilitaryBalance } from './balance.js';

/**
 * Défense antiaérienne : enveloppes d'engagement d'un système par catégorie de menace, lues de sa
 * fiche (`interceptor.envelopes`) ou, pour les fiches anciennes, déduites de `interceptor.against`
 * (portée d'arme et probabilité uniques). Même lecture côté moteur et côté client (fiche, cercles).
 */
export interface AirDefenseLine {
  threat: AirThreat;
  minKm: number;
  maxKm: number;
  ceilingKm?: number;
  pk: number;
  /** Intercepteurs par cible (absent : doctrine par défaut de l'équilibrage). */
  shots?: number;
}

export interface AirDefenseTable {
  /** Enveloppes détaillées de la fiche (sinon déduites de `against`). */
  explicit: boolean;
  lines: AirDefenseLine[];
  /** Intercepteurs par élément. */
  magazine: number;
  channels?: number;
  reactionS?: number;
  reloadH?: number;
}

const LEGACY: Record<string, AirThreat[]> = {
  aircraft: ['aircraft'],
  cruise: ['cruise_missile'],
  ballistic: ['ballistic_missile'],
  hypersonic: ['hypersonic'],
  drone: ['drone'],
};

const tableCache = new WeakMap<WeaponSystem, AirDefenseTable | null>();

/** Table d'engagement d'un système doté d'une fiche `interceptor`, null sinon (ordre AIR_THREATS). */
export function airDefenseTable(sys: WeaponSystem): AirDefenseTable | null {
  const hit = tableCache.get(sys);
  if (hit !== undefined) return hit;
  const ic = sys.interceptor;
  let out: AirDefenseTable | null = null;
  if (ic) {
    const lines: AirDefenseLine[] = [];
    if (ic.envelopes) {
      for (const c of AIR_THREATS) {
        const e = ic.envelopes[c];
        if (!e) continue;
        const l: AirDefenseLine = { threat: c, minKm: e.minKm, maxKm: e.maxKm, pk: e.pk };
        if (e.ceilingKm !== undefined) l.ceilingKm = e.ceilingKm;
        if (e.shots !== undefined) l.shots = e.shots;
        lines.push(l);
      }
    } else {
      const set = new Set<AirThreat>();
      for (const a of ic.against) for (const c of LEGACY[a] ?? []) set.add(c);
      for (const c of AIR_THREATS) {
        if (!set.has(c)) continue;
        lines.push({
          threat: c,
          minKm: sys.weaponRangeKm.min,
          maxKm: sys.weaponRangeKm.max,
          pk: ic.pk,
        });
      }
    }
    out = { explicit: !!ic.envelopes, lines, magazine: ic.magazine };
    if (ic.channels !== undefined) out.channels = ic.channels;
    if (ic.reactionS !== undefined) out.reactionS = ic.reactionS;
    if (ic.reloadH !== undefined) out.reloadH = ic.reloadH;
  }
  tableCache.set(sys, out);
  return out;
}

/** Enveloppe d'un système contre une catégorie (null : catégorie non engagée). */
export function airDefenseLine(sys: WeaponSystem, threat: AirThreat): AirDefenseLine | null {
  const t = airDefenseTable(sys);
  if (!t) return null;
  for (const l of t.lines) if (l.threat === threat) return l;
  return null;
}

/** Plus grande portée d'interception d'une table (0 si vide). */
export function airDefenseMaxKm(t: AirDefenseTable): number {
  let m = 0;
  for (const l of t.lines) if (l.maxKm > m) m = l.maxKm;
  return m;
}

/** Enveloppe d'interception résolue (doctrine de tir comprise). */
export interface InterceptEnv {
  min: number;
  max: number;
  pk: number;
  shots: number;
}

/**
 * Profil d'interception d'un système, tel que le moteur l'emploie (engine/modules/mil/ad-profile.ts) :
 *  - fiche `interceptor.envelopes` (« explicite ») : enveloppes par catégorie ; la défense engage tout
 *    ce qui vole (aéronefs compris) par intercepteurs ;
 *  - fiche `interceptor` sans enveloppes (ancienne) : catégories déduites de `against`, portée d'arme
 *    et probabilité uniques ; seuls les missiles et munitions rôdeuses sont interceptés ;
 *  - sans fiche mais dégâts « missile » > 0 (chasseurs, navires) : interception de repli des missiles
 *    de croisière et des drones (et des balistiques pour une unité au sol ou en mer qui frappe fort).
 * Même calcul pour le moteur et pour l'interface (notes d'efficacité) : une seule source de vérité.
 */
export interface InterceptProfile {
  explicit: boolean;
  env: Partial<Record<AirThreat, InterceptEnv>>;
  /** Intercepteurs par élément. */
  magazine: number;
  /** Canaux de tir par élément et par fenêtre (null : équilibrage). */
  channels: number | null;
  /** Délai de réaction (secondes ; 0 pour les fiches anciennes et le repli). */
  reactionS: number;
  /** Durée d'un rechargement complet (heures, progressif). */
  reloadH: number;
  /** Portée d'interception la plus grande (km). */
  maxKm: number;
}

export function interceptProfile(sys: WeaponSystem, bal: MilitaryBalance): InterceptProfile | null {
  const ic = sys.interceptor;
  const env: Partial<Record<AirThreat, InterceptEnv>> = {};
  let maxKm = 0;
  const put = (c: AirThreat, e: InterceptEnv): void => {
    env[c] = e;
    if (e.max > maxKm) maxKm = e.max;
  };
  if (ic) {
    const t = airDefenseTable(sys)!;
    const legacyShots = Math.max(1, Math.round(bal.intercept.shotsPerMissile));
    for (const l of t.lines) {
      put(l.threat, {
        min: l.minKm,
        max: l.maxKm,
        pk: l.pk,
        shots: t.explicit
          ? (l.shots ?? Math.max(1, Math.round(bal.airDefense.shots[l.threat])))
          : legacyShots,
      });
    }
    return {
      explicit: t.explicit,
      env,
      magazine: ic.magazine,
      channels: ic.channels ?? null,
      reactionS: t.explicit ? (ic.reactionS ?? bal.airDefense.reactionS) : 0,
      reloadH: ic.reloadH ?? bal.intercept.reloadHours,
      maxKm,
    };
  }
  if (sys.damage.missile > 0) {
    const b = bal.intercept;
    const r = sys.weaponRangeKm;
    // Chasseur : missiles air-air contre missiles de croisière et drones (veille, interception).
    const fighter = sys.movement === 'air';
    const a = bal.airDefense;
    const e = {
      min: r.min,
      max: r.max,
      pk: fighter
        ? Math.min(a.fighterPkMax, sys.damage.missile * a.fighterPkPerDamage)
        : Math.min(b.fallbackPkMax, sys.damage.missile * b.fallbackPkPerDamage),
      shots: Math.max(1, Math.round(b.shotsPerMissile)),
    };
    put('cruise_missile', e);
    put('drone', e);
    // Un aéronef n'intercepte pas un missile balistique.
    if (sys.damage.missile >= 12 && sys.movement !== 'air') put('ballistic_missile', e);
    return {
      explicit: false,
      env,
      magazine: fighter ? a.fighterMagazine : b.fallbackMagazine,
      channels: null,
      reactionS: 0,
      reloadH: b.reloadHours,
      maxKm,
    };
  }
  return null;
}
