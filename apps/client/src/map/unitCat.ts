/**
 * Familles d'unités pour l'affichage (filtres du menu de pile, composition des infobulles) et
 * repérage des unités retranchées (défenseur au contact de sa propre ville). Fonctions pures.
 */
import {
  distanceKm,
  type LngLat,
  type NationId,
  type ProvinceDef,
  type ProvinceView,
  type WeaponSystem,
} from '@redline/shared';

/** Terre, air, mer, défense aérienne (et radars), missiles, autres. */
export type UnitCat = 'land' | 'air' | 'sea' | 'ad' | 'missile' | 'other';

export const UNIT_CATS: UnitCat[] = ['land', 'air', 'sea', 'ad', 'missile', 'other'];

export function unitCat(sys: WeaponSystem | undefined): UnitCat {
  if (!sys) return 'other';
  switch (sys.category) {
    case 'air_defense':
    case 'radar':
      return 'ad';
    case 'strike_missile':
    case 'nuclear':
      return 'missile';
    case 'fighter':
    case 'bomber':
    case 'air_support':
    case 'helicopter':
    case 'drone':
      return 'air';
    case 'surface_ship':
    case 'submarine':
      return 'sea';
    case 'tank':
    case 'ifv':
    case 'artillery':
    case 'infantry':
    case 'logistics':
      return 'land';
    default:
      return sys.movement === 'air' ? 'air' : sys.movement === 'sea' ? 'sea' : 'other';
  }
}

/** Couleur d'accent d'une famille (pastilles de composition). */
export const CAT_TONE: Record<UnitCat, string> = {
  land: '#3ddc84',
  air: '#4cc9f0',
  sea: '#3a86ff',
  ad: '#ffb020',
  missile: '#ff4d5e',
  other: '#8a96a3',
};

/**
 * Index spatial des villes de province (cellules de ~0,5°) : « cette position est-elle au contact
 * d'une ville tenue par telle nation ? » en temps constant.
 */
export class CityIndex {
  private cells = new Map<string, { id: string; pt: LngLat }[]>();

  constructor(defs: Iterable<ProvinceDef>) {
    for (const d of defs) {
      const k = this.key(d.cityPoint);
      const l = this.cells.get(k) ?? [];
      l.push({ id: d.id, pt: d.cityPoint });
      this.cells.set(k, l);
    }
  }

  private key(p: LngLat, dx = 0, dy = 0) {
    return `${Math.floor(p[0] * 2) + dx}|${Math.floor(p[1] * 2) + dy}`;
  }

  /** Province dont la ville est à moins de `km` de p et appartient à `owner` (sinon null). */
  ownCityNear(
    p: LngLat,
    owner: NationId,
    provinces: Record<string, ProvinceView> | undefined,
    km: number,
  ): string | null {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const c of this.cells.get(this.key(p, dx, dy)) ?? []) {
          if (provinces?.[c.id]?.owner !== owner) continue;
          if (distanceKm(p, c.pt) <= km) return c.id;
        }
    return null;
  }
}
