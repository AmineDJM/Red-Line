import { AIR_THREATS, type AirThreat, type WeaponSystem } from './catalog.js';

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
