import {
  DAY,
  RESOURCES,
  destination,
  type LngLat,
  type NationId,
  type ProvinceId,
  type Resource,
  type UnitId,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, nationUnits, provincesOf, sortedKeys, warsOf } from '../../state/access.js';
import { roadSpawn, wi } from '../../state/world.js';
import { spawnUnit } from '../../state/units.js';
import { declareWar as coreDeclareWar, makePeace } from '../../state/war.js';
import { destroyUnit } from '../../combat/combat.js';
import { transferProvince } from '../../combat/capture.js';
import { applyOrderImpl } from '../../orders/orders.js';
import { nextFloat, nextInt } from '../../rng/rng.js';
import { modifier, scheduleMod, signal } from '../registry.js';
import {
  PK_NATION,
  REBEL_PREFIX,
  addStability,
  allianceOf,
  cfg,
  clamp,
  ds,
  isPseudo,
  isRegular,
  natList,
  reputation,
  round1,
  sameAlliance,
  stabilityOf,
  type PseudoKind,
} from './state.js';
import { locNations, news, throttled } from './news.js';
import { OK, fail } from './relations.js';

// ——— Pseudo-nations (rebelles par pays, casques bleus) ———

export function ensurePseudo(
  state: EngineState,
  id: NationId,
  kind: PseudoKind,
  of: NationId | null,
): void {
  const d = ds(state);
  if (!d.pseudo[id]) d.pseudo[id] = { kind, of };
  if (state.nations[id]) {
    state.nations[id]!.alive = true;
    return;
  }
  const res = {} as Record<Resource, number>;
  for (const r of RESOURCES) res[r] = 0;
  state.nations[id] = {
    id,
    isAi: true,
    isPlayer: false,
    active: false,
    aiLevel: 'normal',
    alive: true,
    money: 0,
    res,
    provinceCount: 0,
    production: [],
  };
}

export function rebelNationOf(holder: NationId): NationId {
  return `${REBEL_PREFIX}${holder}`;
}

/** Système des unités irrégulières : réglage, sinon l'infanterie capable de capturer la moins chère. */
export function irregularSystem(state: EngineState): WeaponSystem | null {
  const id = cfg(state).irregularSystemId;
  const cat = state.world.catalog;
  if (id) {
    const s = cat.get(id);
    if (s && s.movement === 'land') return s;
  }
  let best: WeaponSystem | null = null;
  for (const sid of wi(state.world).systemIds) {
    const s = cat.get(sid)!;
    if (!s.enabled || s.movement !== 'land' || !s.canCapture || s.category !== 'infantry') continue;
    if (!best || s.cost.money / s.unitSize < best.cost.money / best.unitSize) best = s;
  }
  return best;
}

/** Point d'apparition dans la province, à distance de la ville (repli : la ville). */
function spawnPoint(state: EngineState, pid: ProvinceId, k: number, km: number): LngLat {
  const w = wi(state.world);
  const city = w.provById.get(pid)!.cityPoint;
  for (const f of [1, 0.6, 0.3]) {
    const cand = destination(city, (k * 137.508 + 40) % 360, km * f);
    if (w.nav.cellProv.get(w.nav.cellAt(cand)) === pid) return roadSpawn(w, cand, km * 0.5, pid);
  }
  return city;
}

function spawnIrregular(
  state: EngineState,
  owner: NationId,
  kind: 'rebel' | 'peacekeeper' | 'mercenary',
  pos: LngLat,
  until: number,
  count?: number,
): UnitId | null {
  const sys = irregularSystem(state);
  if (!sys) return null;
  const u = spawnUnit(state, owner, sys.id, pos, count);
  u.stance = kind === 'rebel' ? 'aggressive' : 'defend';
  ds(state).irregular[u.id] = { kind, until };
  return u.id;
}

/** Dissout des unités (fin de contrat, de mandat) sans pertes comptées pour la stabilité. */
export function disbandUnits(state: EngineState, ids: UnitId[]): void {
  const d = ds(state);
  for (const id of [...ids].sort()) {
    const u = state.units[id];
    delete d.irregular[id];
    if (u) {
      disbanding.add(id);
      try {
        destroyUnit(state, u, null);
      } finally {
        disbanding.delete(id);
      }
    }
  }
}

/** Unités en cours de dissolution (ignorées par le décompte des pertes). */
export const disbanding = new Set<UnitId>();

// ——— Casques bleus ———

export function spawnPeacekeepers(state: EngineState, pids: ProvinceId[], until: number): UnitId[] {
  ensurePseudo(state, PK_NATION, 'peacekeeper', null);
  const per = cfg(state).peacekeepersPerProvince;
  const gc = state.world.balance.combat.groundContactKm;
  const out: UnitId[] = [];
  for (const pid of pids) {
    if (!state.provinces[pid]) continue;
    for (let k = 0; k < per; k++) {
      const id = spawnIrregular(
        state,
        PK_NATION,
        'peacekeeper',
        spawnPoint(state, pid, k, gc * 0.5),
        until,
      );
      if (id) out.push(id);
    }
  }
  if (pids.length > 0) {
    const w = wi(state.world);
    const at = w.provById.get(pids[0]!)?.cityPoint ?? null;
    const names = pids
      .slice(0, 3)
      .map((p) => w.provById.get(p)?.name ?? p)
      .join(', ');
    news(
      state,
      'peacekeepers',
      { P: names, loc: { P: { list: pids.slice(0, 3).map((p) => ({ province: p })) } } },
      at,
      [],
    );
  }
  return out;
}

// ——— Rebelles ———

/** Soulèvement armé contre le détenteur de la province (pseudo-nation rebelle propre à ce pays). */
export function uprising(state: EngineState, pid: ProvinceId, units: number): UnitId[] {
  const P = state.provinces[pid];
  if (!P || !isRegular(state, P.owner) || units <= 0) return [];
  const holder = P.owner;
  const reb = rebelNationOf(holder);
  ensurePseudo(state, reb, 'rebel', holder);
  if (!atWar(state, reb, holder)) coreDeclareWar(state, reb, holder);
  const w = wi(state.world);
  const gc = state.world.balance.combat.groundContactKm;
  const until = state.time + cfg(state).rebelDays * DAY;
  const out: UnitId[] = [];
  for (let k = 0; k < units; k++) {
    const id = spawnIrregular(state, reb, 'rebel', spawnPoint(state, pid, k, gc * 3), until);
    if (id) out.push(id);
  }
  if (out.length > 0) {
    applyOrderImpl(state, reb, { kind: 'move', unitIds: out, to: w.provById.get(pid)!.cityPoint });
  }
  return out;
}

/** Zone disputée contenant la province. */
export function disputedOf(
  state: EngineState,
  pid: ProvinceId,
): { id: string; claimants: NationId[] } | null {
  for (const a of state.world.map.disputed) if (a.provinceIds.includes(pid)) return a;
  return null;
}

/** Détenteur actuel d'une zone disputée : nation qui en tient le plus de provinces. */
export function holderOf(state: EngineState, pids: ProvinceId[]): NationId | null {
  const count = new Map<NationId, number>();
  for (const p of pids) {
    const o = state.provinces[p]?.owner;
    if (o) count.set(o, (count.get(o) ?? 0) + 1);
  }
  let best: NationId | null = null;
  for (const [n, c] of [...count].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!best || c > count.get(best)!) best = n;
  }
  return best;
}

/** Province prise par des rebelles dans une zone disputée : elle se rallie à un prétendant. */
export function rebelCapture(
  state: EngineState,
  pid: ProvinceId,
  from: NationId,
  reb: NationId,
): void {
  const area = disputedOf(state, pid);
  if (!area) return;
  const funders = ds(state).funding[pid] ?? {};
  const cands = area.claimants
    .filter((c) => c !== from && isRegular(state, c) && state.nations[c]!.alive)
    .sort((a, b) => (funders[b] ?? 0) - (funders[a] ?? 0) || (a < b ? -1 : 1));
  const to = cands[0];
  if (to) scheduleMod(state, { t: state.time, m: 'diplo', e: 'handover', d: { pid, to, reb } });
}

export function onHandover(state: EngineState, pid: ProvinceId, to: NationId, reb: NationId): void {
  const P = state.provinces[pid];
  if (!P || P.owner !== reb || !state.nations[to]?.alive) return;
  const from = ds(state).pseudo[reb]?.of ?? undefined;
  transferProvince(state, pid, to);
  const def = wi(state.world).provById.get(pid)!;
  news(
    state,
    'rallied',
    { A: to, B: from, P: def.name, loc: { P: { province: def.id } } },
    def.cityPoint,
    from ? [to, from] : [to],
  );
}

// ——— Ordres : procuration ———

export function orderFundRebels(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  amount: number,
): OrderResult {
  const P = state.provinces[pid];
  if (!P || P.owner === n || !isRegular(state, P.owner))
    return fail('invalid_target', 'Province invalide.');
  if (sameAlliance(state, n, P.owner)) return fail('not_allowed', 'Impossible contre un allié.');
  const ns = state.nations[n]!;
  if (!(amount > 0) || ns.money < amount) return fail('insufficient_funds', 'Fonds insuffisants.');
  ns.money -= amount;
  signal(state, 'rebels_funded', { by: n, pid, amount });
  return OK;
}

/** Signal `rebels_funded` (ordre diplo ou opération de renseignement) : agitation dans la province. */
export function onRebelsFunded(
  state: EngineState,
  by: NationId,
  pid: ProvinceId,
  amount: number,
): void {
  const P = state.provinces[pid];
  if (!P || !(amount > 0)) return;
  const c = cfg(state);
  const d = ds(state);
  const victim = state.nations[P.owner];
  const ref = Math.max(1, (victim?.money ?? 0) * c.fundRebelsRefShare);
  let eff = (amount / ref) * c.fundRebelsUnrestPerRef;
  const area = disputedOf(state, pid);
  if (area && area.claimants.includes(by) && by !== P.owner) eff /= c.claimantFundingDiscount;
  d.unrest[pid] = round1(clamp((d.unrest[pid] ?? 0) + eff));
  const f = (d.funding[pid] ??= {});
  f[by] = (f[by] ?? 0) + amount;
  if (area && d.disputed[area.id]) {
    d.disputed[area.id]!.tension = round1(clamp(d.disputed[area.id]!.tension + eff / 2));
  }
}

export function orderHireMercenaries(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  count: number,
): OrderResult {
  const P = state.provinces[pid];
  if (!P || P.owner !== n) return fail('not_owner', 'Cette province ne vous appartient pas.');
  const sys = irregularSystem(state);
  if (!sys) return fail('not_allowed', 'Aucune société militaire disponible.');
  const c = cfg(state);
  const cost = count * (sys.cost.money / sys.unitSize) * c.mercenaryCostFactor;
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds', 'Fonds insuffisants.');
  ns.money -= cost;
  const at = wi(state.world).provById.get(pid)!.cityPoint;
  const id = spawnIrregular(state, n, 'mercenary', at, state.time + c.mercenaryDays * DAY, count);
  if (!id) return fail('not_allowed', 'Aucune société militaire disponible.');
  if (!throttled(state, `merc|${n}`, 7 * DAY)) {
    news(
      state,
      'mercenaries',
      { A: n, P: wi(state.world).provById.get(pid)!.name, loc: { P: { province: pid } } },
      at,
      [n],
    );
  }
  return OK;
}

export function orderCourtNeutral(
  state: EngineState,
  n: NationId,
  target: NationId,
  aid: number,
): OrderResult {
  const A = allianceOf(state, n);
  if (!A) return fail('not_allowed', 'Il faut appartenir à une alliance pour courtiser un neutre.');
  if (!isRegular(state, target) || target === n || !state.nations[target]!.alive)
    return fail('invalid_target', 'Nation invalide.');
  if (allianceOf(state, target)) return fail('not_allowed', "Cette nation n'est pas neutre.");
  if (atWar(state, n, target)) return fail('not_allowed', 'Vous êtes en guerre avec cette nation.');
  const ns = state.nations[n]!;
  if (!(aid > 0) || ns.money < aid) return fail('insufficient_funds', 'Fonds insuffisants.');
  const tn = state.nations[target]!;
  const c = cfg(state);
  const ref = Math.max(1, tn.money * c.courtRefShare);
  ns.money -= aid;
  tn.money += aid;
  const d = ds(state);
  const L = (d.leaning[target] ??= {});
  const gain = (aid / ref) * (0.5 + reputation(state, n) / 100);
  L[A.id] = round1(clamp((L[A.id] ?? 0) + gain, 0, 1) * 100) / 100;
  return OK;
}

// ——— Tick journalier : zones disputées, révoltes, agitation, irréguliers ———

function revolt(
  state: EngineState,
  pid: ProvinceId,
  armedChance: number,
  areaName?: string,
  claimants?: NationId[],
): void {
  const P = state.provinces[pid]!;
  const holder = P.owner;
  const d = ds(state);
  const w = wi(state.world);
  const def = w.provById.get(pid)!;
  d.unrest[pid] = round1(clamp((d.unrest[pid] ?? 0) + 10));
  addStability(state, holder, -2, 'Révoltes');
  const armed = nextFloat(ds(state).rng) < armedChance;
  const vars = {
    B: holder,
    P: def.name,
    X: areaName ?? '',
    Y: natList(state, claimants ?? []),
    loc: { P: { province: pid }, Y: locNations(claimants ?? []) },
  };
  if (armed) {
    const tension = areaName
      ? (d.disputed[disputedOf(state, pid)!.id]?.tension ?? 50)
      : (d.unrest[pid] ?? 0);
    uprising(state, pid, cfg(state).rebelUnits + Math.floor(tension / 50));
    news(state, 'uprising', vars, def.cityPoint, [holder]);
  } else {
    news(state, areaName ? 'revolt_disputed' : 'revolt', vars, def.cityPoint, [holder]);
  }
  signal(state, 'revolt', { pid, nation: holder, armed });
}

export function unrestDaily(state: EngineState): void {
  const d = ds(state);
  const c = cfg(state);
  const disputedPids = new Set<ProvinceId>();
  // Zones disputées : tension, détenteur, révoltes contre le détenteur quel qu'il soit (règle symétrique).
  for (const area of [...state.world.map.disputed].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const st = d.disputed[area.id];
    if (!st) continue;
    const pids = area.provinceIds.filter((p) => state.provinces[p]).sort();
    for (const p of pids) disputedPids.add(p);
    const holder = holderOf(state, pids);
    if (!holder) continue;
    st.holder = holder;
    const drift = c.disputedTensionDriftPerDay;
    const claimWar = area.claimants.some((x) =>
      area.claimants.some((y) => x < y && atWar(state, x, y)),
    );
    const target = claimWar ? 100 : area.tension;
    st.tension = round1(
      st.tension < target
        ? Math.min(target, st.tension + drift * (claimWar ? 5 : 1))
        : Math.max(target, st.tension - drift),
    );
    const held = pids.filter((p) => isRegular(state, state.provinces[p]!.owner));
    if (held.length === 0) continue;
    const s = stabilityOf(state, holder);
    const chance = clamp(
      area.revoltRate *
        (st.tension / 50) *
        (1 + Math.max(0, c.revoltThreshold - s) / Math.max(1, c.revoltThreshold)),
      0,
      1,
    );
    if (nextFloat(ds(state).rng) < chance) {
      const pid = held[nextInt(ds(state).rng, held.length)]!;
      revolt(
        state,
        pid,
        clamp(c.armedUprisingChance * (st.tension / 50), 0, 1),
        area.name,
        area.claimants,
      );
    }
  }
  // Provinces agitées par un financement étranger.
  for (const pid of sortedKeys(d.unrest)) {
    const P = state.provinces[pid];
    if (!P || disputedPids.has(pid) || !isRegular(state, P.owner)) continue;
    const u = d.unrest[pid]!;
    if (u < 10) continue;
    const f = modifier(state, P.owner, 'unrest.risk');
    if (nextFloat(ds(state).rng) < clamp(c.revoltChancePerDay * (u / 50) * f, 0, 1)) {
      revolt(state, pid, clamp(c.armedUprisingChance * (u / 60), 0, 1));
    }
  }
  // Nations instables : une révolte possible par jour, dans la province la plus agitée.
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive) continue;
    const s = stabilityOf(state, n);
    if (s >= c.revoltThreshold) continue;
    const term = (c.revoltThreshold - s) / Math.max(1, c.revoltThreshold);
    const f = modifier(state, n, 'unrest.risk');
    if (nextFloat(ds(state).rng) >= clamp(c.revoltChancePerDay * term * 2 * f, 0, 1)) continue;
    const provs = provincesOf(state, n);
    if (provs.length === 0) continue;
    let pid = provs[nextInt(ds(state).rng, provs.length)]!;
    for (const p of provs) if ((d.unrest[p] ?? 0) > (d.unrest[pid] ?? 0)) pid = p;
    revolt(state, pid, clamp(c.armedUprisingChance * term, 0, 1));
  }
  // Érosion de l'agitation et des financements.
  for (const pid of sortedKeys(d.unrest)) {
    const v = d.unrest[pid]! - c.unrestDecayPerDay;
    if (v <= 0) delete d.unrest[pid];
    else d.unrest[pid] = round1(v);
  }
  for (const pid of sortedKeys(d.funding)) {
    const f = d.funding[pid]!;
    for (const k of sortedKeys(f)) {
      f[k] = f[k]! * 0.9;
      if (f[k]! < 1e-6) delete f[k];
    }
    if (Object.keys(f).length === 0) delete d.funding[pid];
  }
  irregularDaily(state);
}

/** Fin des contrats de mercenaires, dispersion des rebelles, paix avec les pseudo-nations éteintes. */
function irregularDaily(state: EngineState): void {
  const d = ds(state);
  const done: UnitId[] = [];
  for (const id of sortedKeys(d.irregular)) {
    const it = d.irregular[id]!;
    const u = state.units[id];
    if (!u) {
      delete d.irregular[id];
      continue;
    }
    if (it.kind === 'peacekeeper' || it.until > state.time) continue;
    if (it.kind === 'rebel' && (u.engaged || u.move)) continue;
    done.push(id);
  }
  disbandUnits(state, done);
  for (const n of sortedKeys(d.pseudo)) {
    if (!state.nations[n]) continue;
    if (nationUnits(state, n).length > 0 || state.nations[n]!.provinceCount > 0) continue;
    for (const e of warsOf(state, n)) makePeace(state, n, e);
  }
}

/** Initialisation des zones disputées présentes dans la partie. */
export function initDisputed(state: EngineState): void {
  const d = ds(state);
  for (const area of state.world.map.disputed) {
    const pids = area.provinceIds.filter((p) => state.provinces[p]);
    if (pids.length === 0) continue;
    const holder = holderOf(state, pids);
    if (!holder) continue;
    d.disputed[area.id] = { tension: area.tension, holder };
  }
}

/** Capture dans une zone disputée : la tension monte. */
export function disputedCaptured(state: EngineState, pid: ProvinceId): void {
  const area = disputedOf(state, pid);
  if (!area) return;
  const st = ds(state).disputed[area.id];
  if (!st) return;
  st.tension = round1(clamp(st.tension + cfg(state).disputedCaptureTension));
  const pids = state.world.map.disputed
    .find((a) => a.id === area.id)!
    .provinceIds.filter((p) => state.provinces[p]);
  st.holder = holderOf(state, pids) ?? st.holder;
}

export function isIrregularRebel(state: EngineState, n: NationId): boolean {
  return isPseudo(state, n) && ds(state).pseudo[n]!.kind === 'rebel';
}
