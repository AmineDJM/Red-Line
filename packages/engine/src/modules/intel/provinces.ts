import {
  DAY,
  HOUR,
  distanceKm,
  type BuildingType,
  type Department,
  type IntelSource,
  type LngLat,
  type NationId,
  type PlayerView,
  type ProvinceId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { provincesOf, sortedKeys } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { cfg } from './config.js';
import { allied, hash01 } from './levels.js';
import { publish } from './reports.js';
import { ist, nat, type ProvinceKnowledge } from './state.js';
import { provinceName } from './text.js';

/**
 * Connaissance progressive des provinces étrangères. Au départ, une nation connaît ses provinces et
 * celles de ses alliés ; les provinces limitrophes sont « aperçues » (niveau 1). Les missions de
 * reconnaissance, les agents implantés et l'imagerie (signal `imagery`) font monter, par province,
 * deux axes (économique, militaire) de 0 à 3. Chaque niveau révèle un tiers des installations de l'axe
 * (ordre fixe par province, haché) ; la date de mise à jour vieillit.
 */

export const MILITARY_BUILDINGS: ReadonlySet<BuildingType> = new Set<BuildingType>([
  'military_base',
  'air_base',
  'naval_base',
  'bunker',
  'air_defense_site',
  'coastal_battery',
  'radar_station',
  'missile_silo',
  'forward_base',
  'recruiting_office',
  'secret_lab',
]);

export const BUILDING_LABEL: Partial<Record<BuildingType, string>> = {
  refinery: 'raffinerie',
  power_plant: 'centrale électrique',
  port: 'port',
  air_base: 'base aérienne',
  military_base: 'base militaire',
  arms_factory: "usine d'armement",
  research_center: 'centre de recherche',
  oil_field: 'champ pétrolier',
  mine: 'mine',
  farm: 'exploitation agricole',
  electronics_plant: "usine d'électronique",
  local_industry: 'industrie locale',
  recruiting_office: 'bureau de recrutement',
  naval_base: 'base navale',
  bunker: 'bunker',
  air_defense_site: 'site de défense aérienne',
  coastal_battery: 'batterie côtière',
  radar_station: 'station radar',
  missile_silo: 'silo de missiles',
  hospital: 'hôpital',
  secret_lab: 'laboratoire',
  forward_base: 'base avancée',
};

export type Axis = 'e' | 'm';

export function axisOf(b: BuildingType): Axis {
  return MILITARY_BUILDINGS.has(b) ? 'm' : 'e';
}

function adjacentToOwn(state: EngineState, n: NationId, pid: ProvinceId): boolean {
  const def = wi(state.world).provById.get(pid);
  if (!def) return false;
  return def.neighbors.some((q) => state.provinces[q]?.owner === n);
}

/** Connaissance d'une province par une nation ; null = sa province ou celle d'un allié (tout est connu). */
export function knowledge(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
): ProvinceKnowledge | null {
  const P = state.provinces[pid];
  if (!P || allied(state, n, P.owner)) return null;
  const k = ist(state).pk[n]?.[pid];
  const adj = adjacentToOwn(state, n, pid) ? 1 : 0;
  // Frontière observée en continu : mise à jour quotidienne (évite de changer la vue à chaque instant).
  const adjT = adj ? Math.floor(state.time / DAY) * DAY : 0;
  if (!k) return { e: adj, m: adj, t: adjT };
  return {
    e: Math.max(k.e, adj),
    m: Math.max(k.m, adj),
    t: adj && k.e <= adj && k.m <= adj ? Math.max(k.t, adjT) : k.t,
  };
}

/** Installations révélées d'une province pour une connaissance donnée (liste de la carte). */
export function revealed(pid: ProvinceId, all: readonly BuildingType[], k: ProvinceKnowledge) {
  return all.filter((b, i) => {
    const lvl = axisOf(b) === 'm' ? k.m : k.e;
    return lvl >= 3 || hash01('pk', pid, b, i) < lvl / 3;
  });
}

/** Fait progresser la connaissance d'une province ; renvoie les installations nouvellement révélées. */
export function raise(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  de: number,
  dm: number,
): BuildingType[] {
  const before = knowledge(state, n, pid);
  if (!before) return [];
  const all = wi(state.world).provById.get(pid)?.buildings ?? [];
  const old = revealed(pid, all, before);
  const st = ist(state);
  const map = (st.pk[n] ??= {});
  const k: ProvinceKnowledge = {
    e: Math.min(3, before.e + de),
    m: Math.min(3, before.m + dm),
    t: state.time,
  };
  map[pid] = k;
  const now = revealed(pid, all, k);
  const out = [...now];
  for (const b of old) {
    const i = out.indexOf(b);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

export interface Discovery {
  pid: ProvinceId;
  found: BuildingType[];
}

/** Provinces d'une nation à explorer en priorité : moins connues d'abord, capitale en tête. */
export function reconTargets(
  state: EngineState,
  n: NationId,
  victim: NationId,
  axis: Axis,
  count: number,
): ProvinceId[] {
  const cap = wi(state.world).nationById.get(victim)?.capitalProvinceId;
  return provincesOf(state, victim)
    .map((pid) => ({
      pid,
      lvl: knowledge(state, n, pid)?.[axis] ?? 3,
      cap: pid === cap ? 0 : 1,
      h: hash01('rt', n, pid),
    }))
    .filter((x) => x.lvl < 3)
    .sort((a, b) => a.lvl - b.lvl || a.cap - b.cap || a.h - b.h)
    .slice(0, count)
    .map((x) => x.pid);
}

/** Reconnaissance ciblée : +2 niveaux sur une province, ou +1 sur plusieurs provinces d'une nation. */
export function recon(
  state: EngineState,
  n: NationId,
  axis: Axis,
  target: { provinceId?: ProvinceId; nationId?: NationId },
): Discovery[] {
  const out: Discovery[] = [];
  const bump = (pid: ProvinceId, d: number): void => {
    const found = raise(state, n, pid, axis === 'e' ? d : 0, axis === 'm' ? d : 0);
    out.push({ pid, found });
  };
  if (target.provinceId) bump(target.provinceId, 2);
  else if (target.nationId) {
    for (const pid of reconTargets(state, n, target.nationId, axis, cfg(state).reconProvinces))
      bump(pid, 1);
  }
  return out;
}

/** Imagerie (satellite, survol) : les deux axes progressent dans la zone ; un radar ne voit que le militaire. */
export function imagery(
  state: EngineState,
  n: NationId,
  pids: ProvinceId[],
  kind: string,
): Discovery[] {
  const out: Discovery[] = [];
  for (const pid of [...new Set(pids)].sort()) {
    if (!state.provinces[pid]) continue;
    const found = raise(state, n, pid, kind === 'radar' ? 0 : 1, 1);
    out.push({ pid, found });
  }
  return out;
}

/** Provinces dont la ville est dans un cercle (zone d'imagerie sans liste explicite). */
export function provincesInCircle(state: EngineState, at: LngLat, r: number): ProvinceId[] {
  const w = wi(state.world);
  return w.provIds.filter(
    (pid) => !!state.provinces[pid] && distanceKm(w.provById.get(pid)!.cityPoint, at) <= r,
  );
}

/** Rapport annonçant les découvertes (s'il y en a). */
export function announce(
  state: EngineState,
  n: NationId,
  ds: Discovery[],
  meta: {
    dept: Department;
    source: IntelSource;
    title: string;
    q: number;
    kind?: 'result' | 'order_of_battle';
  },
): void {
  const hits = ds.filter((d) => d.found.length > 0);
  const lines: string[] = [];
  for (const d of hits.slice(0, 4)) {
    const names = [...new Set(d.found)].map((b) => BUILDING_LABEL[b] ?? b);
    lines.push(`${provinceName(state, d.pid)} : ${names.join(', ')}.`);
  }
  if (hits.length > 4) lines.push(`Et ${hits.length - 4} autre(s) province(s).`);
  if (hits.length === 0) lines.push('Aucune installation nouvelle identifiée.');
  lines.push(`${ds.length} province(s) mise(s) à jour sur la carte.`);
  const w = wi(state.world);
  const first = (hits[0] ?? ds[0])?.pid;
  const at = first ? (w.provById.get(first)?.cityPoint ?? null) : null;
  publish(state, n, {
    dept: meta.dept,
    source: meta.source,
    kind: meta.kind ?? 'result',
    title: meta.title,
    lines,
    at,
    radiusKm: at ? 50 : 0,
    subject: first ? { nationId: state.provinces[first]!.owner, provinceId: first } : {},
    actions: first ? [{ kind: 'open_province', provinceId: first }] : [],
    q: meta.q,
  });
}

/**
 * Vue : pour chaque province étrangère, `intel` renseigné et `buildings`/`buildingState` filtrés
 * (installations révélées uniquement ; état masqué quand l'information a vieilli).
 */
export function filterProvinces(state: EngineState, n: NationId, view: PlayerView): void {
  const staleMs = cfg(state).provinceStaleH * HOUR;
  for (const pid of sortedKeys(view.provinces)) {
    const pv = view.provinces[pid]!;
    const k = knowledge(state, n, pid);
    if (!k) continue;
    const shown = revealed(pid, pv.buildings, k);
    pv.buildings = shown;
    if (pv.buildingState) {
      const fresh = k.t > 0 && state.time - k.t <= staleMs;
      const ok = new Set(shown);
      const bs = fresh ? pv.buildingState.filter((b) => ok.has(b.type)) : [];
      if (bs.length) pv.buildingState = bs;
      else delete pv.buildingState;
    }
    const level = Math.max(k.e, k.m) as 0 | 1 | 2 | 3;
    pv.intel = { level, economic: k.e > 0, military: k.m > 0, updatedAt: k.t };
  }
}

/** Agents implantés : chaque jour, une province du pays hôte est un peu mieux connue. */
export function agentsReveal(state: EngineState): void {
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.state !== 'active' && a.state !== 'caught') continue;
    const axis: Axis = a.kind === 'officer' && a.since % 2 === 0 ? 'm' : 'e';
    const pid = reconTargets(state, a.owner, a.host, axis, 1)[0];
    if (!pid) continue;
    const found = raise(state, a.owner, pid, axis === 'e' ? 1 : 0, axis === 'm' ? 1 : 0);
    nat(state, a.owner).log.found += found.length;
  }
}
