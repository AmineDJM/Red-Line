import type { NationId, ProvinceId, WeaponSystem } from '@redline/shared';
import { retireUnit } from '../../combat/combat.js';
import { refreshUnitPairs } from '../../encounters/pairs.js';
import { isLauncher } from '../../encounters/profile.js';
import { sortedKeys, sortedSet, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { signal } from '../registry.js';
import type { StaticSite } from '../types.js';
import { mil, milBal } from './state.js';
import { cityOf } from './util.js';

/**
 * Sites fixes de défense et de détection publiés par eco dans `board.sites` et annoncés par les
 * signaux `static_defense` / `radar_station` { nation, pid, building, level, health, at, rangeKm }.
 *
 * Choix : chaque site en service est représenté par une UNITÉ FIXE (non déplaçable, hors ordres de
 * mouvement) au point de ville, qui combat et détecte avec le moteur commun (paires, rounds,
 * interceptions) :
 *  - air_defense_site : système `other.air-defense-site` s'il existe, sinon la défense aérienne la
 *    plus répandue chez le propriétaire (sinon celle du catalogue à la plus grande portée) ; portée
 *    d'engagement = `rangeKm` du site ;
 *  - coastal_battery : `other.coastal-battery`, sinon le système terrestre non lanceur aux meilleurs
 *    dégâts antinavires ; portée d'engagement = `rangeKm` ;
 *  - radar_station : `other.radar-station`, sinon le radar de veille (catégorie radar) le plus
 *    répandu chez le propriétaire ou le moins cher ; portée de détection = `rangeKm` ;
 *  - missile_silo : lanceur balistique ou nucléaire le plus répandu chez le propriétaire (frappes par
 *    l'ordre `strike`), durci (military.defenses.siloArmorPerLevel par niveau).
 * Effectif = niveau × military.defenses.unitsPerLevel ; PV = santé du bâtiment. Santé 0 ou niveau 0 :
 * l'unité est retirée. Unité fixe détruite au combat ⇒ signal `building_hit` (dégâts 1) vers eco.
 * Les bunkers restent l'affaire d'eco (crochet unitModifier).
 */

const SITE_TYPES = ['air_defense_site', 'coastal_battery', 'radar_station', 'missile_silo'] as const;
type SiteType = (typeof SITE_TYPES)[number];

export function onSiteSignal(state: EngineState, data: Record<string, unknown>): void {
  const pid = data.pid as ProvinceId | undefined;
  const b = data.building as SiteType | undefined;
  if (!pid || !b || !SITE_TYPES.includes(b) || !state.provinces[pid]) return;
  syncFixed(state, pid, b, {
    n: (data.nation as NationId | undefined) ?? state.provinces[pid]!.owner,
    level: Number(data.level ?? 0) || 0,
    h: data.health === undefined ? 1 : Number(data.health) || 0,
    rangeKm: Number(data.rangeKm ?? 0) || 0,
  });
}

/**
 * Rattrapage (au démarrage, puis à chaque tick horaire) : crée les unités des sites publiés dans
 * board.sites qui n'en ont pas encore (sites posés avant l'initialisation du module) et retire celles
 * dont le site a disparu. Les mises à jour de niveau et de santé passent par les signaux.
 */
export function reconcileSites(state: EngineState): void {
  const sites = board(state).sites ?? {};
  const m = mil(state);
  for (const k of sortedKeys(sites)) {
    const s = sites[k] as StaticSite;
    const cur = m.fixed[k] ? state.units[m.fixed[k]!] : undefined;
    if (cur && cur.owner === s.n) continue;
    syncFixed(state, s.pid, s.b, { n: s.n, level: s.level, h: s.h, rangeKm: s.rangeKm });
  }
  for (const k of sortedKeys(m.fixed)) {
    if (sites[k]) continue;
    const u = state.units[m.fixed[k]!];
    delete m.fixed[k];
    if (u) {
      delete m.fixedOf[u.id];
      delete m.siteRange[u.id];
      retireUnit(state, u);
    }
  }
}

function syncFixed(
  state: EngineState,
  pid: ProvinceId,
  b: SiteType,
  site: { n: NationId; level: number; h: number; rangeKm: number },
): void {
  const m = mil(state);
  const key = `${pid}:${b}`;
  let cur = m.fixed[key] ? state.units[m.fixed[key]!] : undefined;
  const drop = (): void => {
    if (cur) {
      delete m.fixedOf[cur.id];
      delete m.siteRange[cur.id];
      retireUnit(state, cur);
    }
    delete m.fixed[key];
    cur = undefined;
  };
  if (!(site.level > 0) || !(site.h > 0) || !state.nations[site.n]) {
    drop();
    return;
  }
  if (cur && cur.owner !== site.n) drop();
  const count = Math.max(1, Math.round(site.level * milBal(state).defenses.unitsPerLevel));
  if (cur) {
    const sys = sysOf(state, cur);
    cur.count = count;
    cur.maxHp = count * sys.hp;
    cur.hp = cur.maxHp * Math.min(1, site.h);
    if (site.rangeKm > 0 && m.siteRange[cur.id] !== site.rangeKm) {
      m.siteRange[cur.id] = site.rangeKm;
      refreshUnitPairs(state, cur);
    }
    state.rt.dirtyCombat.add(cur.id);
    return;
  }
  const sys = siteSystem(state, site.n, b);
  const at = cityOf(state, pid);
  if (!sys || !at) return;
  const u = spawnUnit(state, site.n, sys.id, at, count, (x) => {
    x.stance = 'defend';
    m.fixedOf[x.id] = key;
    if (site.rangeKm > 0 && b !== 'missile_silo') m.siteRange[x.id] = site.rangeKm;
  });
  u.hp = u.maxHp * Math.min(1, site.h);
  m.fixed[key] = u.id;
}

function siteSystem(state: EngineState, owner: NationId, b: SiteType): WeaponSystem | null {
  const cat = state.world.catalog;
  const direct: Partial<Record<SiteType, string>> = {
    air_defense_site: 'other.air-defense-site',
    coastal_battery: 'other.coastal-battery',
    radar_station: 'other.radar-station',
  };
  const d = direct[b] ? cat.get(direct[b]!) : undefined;
  if (d?.enabled) return d;
  const own = new Map<string, number>();
  for (const id of sortedSet(state.rt.byNation.get(owner))) {
    const u = state.units[id]!;
    if (!u.role && !mil(state).fixedOf[id]) own.set(u.sys, (own.get(u.sys) ?? 0) + u.count);
  }
  let best: WeaponSystem | null = null;
  let bestScore = -Infinity;
  for (const id of wi(state.world).systemIds) {
    const s = cat.get(id)!;
    if (!s.enabled) continue;
    const mine = own.get(id) ?? 0;
    let score = -Infinity;
    if (b === 'air_defense_site') {
      if (s.category === 'air_defense' && s.weaponRangeKm.max > 0 && !isLauncher(s)) {
        score = mine * 1e6 + s.weaponRangeKm.max;
      }
    } else if (b === 'coastal_battery') {
      if (s.movement !== 'air' && s.movement !== 'sea' && !isLauncher(s) && s.damage.ship > 0) {
        score = s.damage.ship * 1000 + s.weaponRangeKm.max;
      }
    } else if (b === 'radar_station') {
      if (s.category === 'radar' && s.sensor?.kind === 'radar') score = mine * 1e12 - s.cost.money;
      else if (s.category === 'air_defense' && !isLauncher(s)) score = -1e15 + s.detectionRangeKm;
    } else if (b === 'missile_silo') {
      const k = s.missile?.kind;
      if (s.missile && (k === 'ballistic' || k === 'icbm')) {
        score = mine * 1e6 + (s.missile.warhead === 'nuclear' ? 1 : 0) * 1e3 - s.generation;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return Number.isFinite(bestScore) ? best : null;
}

/** Une unité fixe détruite au combat : le site est hors service (eco met la santé à 0). */
export function fixedDestroyed(state: EngineState, u: Unit, by: NationId | null): void {
  const m = mil(state);
  const key = m.fixedOf[u.id];
  if (!key) return;
  delete m.fixedOf[u.id];
  delete m.siteRange[u.id];
  if (m.fixed[key] === u.id) delete m.fixed[key];
  const i = key.indexOf(':');
  signal(state, 'building_hit', { pid: key.slice(0, i), building: key.slice(i + 1), damage: 1, by });
}

/** Crochet unitModifier : durcissement des silos. */
export function siloModifier(state: EngineState, u: Unit, key: string): number {
  if (key !== 'combat.armor') return 1;
  const k = (state.mods.mil as { fixedOf?: Record<string, string> } | undefined)?.fixedOf?.[u.id];
  if (!k || !k.endsWith(':missile_silo')) return 1;
  return 1 + milBal(state).defenses.siloArmorPerLevel * u.count;
}
