/**
 * Position lisible d'une unité (onglet Armée) : ville la plus proche, « en mer » ou « en vol ».
 * Index spatial des villes par cases de 5° (2 500 provinces), reconstruit si la carte change.
 */
import {
  distanceKm,
  type LngLat,
  type ProvinceDef,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';

const CELL = 5;

interface City {
  pid: string;
  name: string;
  at: LngLat;
}

let indexed: Record<string, ProvinceDef> | null = null;
let buckets = new Map<string, City[]>();

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function index(provinces: Record<string, ProvinceDef>): void {
  if (indexed === provinces) return;
  indexed = provinces;
  buckets = new Map();
  for (const p of Object.values(provinces)) {
    const at = p.cityPoint;
    if (!at) continue;
    const k = key(Math.floor(at[0] / CELL), Math.floor(at[1] / CELL));
    const list = buckets.get(k) ?? [];
    list.push({ pid: p.id, name: p.cityName ?? p.name, at });
    buckets.set(k, list);
  }
}

/** Ville (province) la plus proche d'un point, avec la distance en km. */
export function nearestCity(
  provinces: Record<string, ProvinceDef>,
  at: LngLat,
): { pid: string; name: string; km: number } | null {
  index(provinces);
  if (buckets.size === 0) return null;
  const cx = Math.floor(at[0] / CELL);
  const cy = Math.floor(at[1] / CELL);
  let best = null as { pid: string; name: string; km: number } | null;
  // Anneaux de cases croissants ; on s'arrête quand l'anneau suivant ne peut plus faire mieux.
  for (let r = 0; r <= 36; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = ((((cx + dx) % 72) + 108) % 72) - 36; // bouclage en longitude
        for (const c of buckets.get(key(x, cy + dy)) ?? []) {
          const km = distanceKm(at, c.at);
          if (!best || km < best.km) best = { pid: c.pid, name: c.name, km };
        }
      }
    // Une case fait au moins ~CELL° de latitude (≈ 555 km) : marge prudente.
    if (best && best.km < r * CELL * 111 * Math.cos((Math.abs(at[1]) * Math.PI) / 180) * 0.9) break;
  }
  return best;
}

export type UnitLocationKind = 'city' | 'near' | 'sea' | 'air' | 'embarked';

export interface UnitLocation {
  kind: UnitLocationKind;
  /** Ville la plus proche (absent si la carte n'est pas chargée). */
  city?: string;
  km?: number;
  at: LngLat;
}

/** Au-delà, une unité terrestre est dite « à N km de » la ville la plus proche. */
const NEAR_KM = 40;
/** En deçà, un navire est au port de la ville. */
const PORT_KM = 30;

export function unitLocation(
  u: UnitView,
  sys: WeaponSystem | undefined,
  at: LngLat,
  provinces: Record<string, ProvinceDef>,
  flying: boolean,
): UnitLocation {
  const c = nearestCity(provinces, at);
  const base = { at, ...(c ? { city: c.name, km: Math.round(c.km) } : {}) };
  if (u.status === 'embarked') return { kind: 'embarked', ...base };
  if (sys?.movement === 'air' && flying) return { kind: 'air', ...base };
  if (!c) return { kind: sys?.movement === 'sea' ? 'sea' : 'city', ...base };
  if (sys?.movement === 'sea') return { kind: c.km <= PORT_KM ? 'city' : 'sea', ...base };
  return { kind: c.km <= NEAR_KM ? 'city' : 'near', ...base };
}
