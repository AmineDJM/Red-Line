import {
  AGENT_ACCESS,
  DAY,
  HOUR,
  distanceKm,
  loc,
  type AgentCover,
  type Category,
  type LngLat,
  type NationDossier,
  type NationId,
  type SigintView,
  type ThreatIndicator,
} from '@redline/shared';
import type { EngineState, Unit } from '../../state/types.js';
import { atWar, isMoving, nationUnits, notify, sortedKeys, unitPosAt } from '../../state/access.js';
import { partsOf } from '../../state/stack.js';
import { wi } from '../../state/world.js';
import { noteLoc } from '../../state/loc.js';
import { board } from '../kit.js';
import { cfg, clamp, reliabilityOf } from './config.js';
import {
  agentsIn,
  allied,
  doubledIn,
  focusNations,
  hash01,
  level,
  quality,
  researchOf,
  roll,
} from './levels.js';
import { publish, type NewReport } from './reports.js';
import { raise } from './provinces.js';
import { jammedFor, revealContact } from './contacts.js';
import { burn, catchQuietly, publicArrest } from './agents.js';
import { concentrations, type PoolEntry } from './daily.js';
import { ist, nat, type Agent, type Assessment, type StoredOp } from './state.js';
import {
  CATEGORY_LABEL,
  nationName,
  natDe,
  natLe,
  natAgree,
  provinceName,
  sectorLoc,
  sectorOf,
} from './text.js';

/**
 * Profondeur du renseignement : capteurs (SIGINT, imagerie, guerre électronique), décryptage progressif,
 * interception des communications, géolocalisation des émetteurs, réseaux d'agents (couverture,
 * fiabilité, accès, agents doubles), ordre de bataille estimé, indice de menace et alerte stratégique,
 * désignation de cibles et évaluation des dégâts, démantèlement, déception et durcissement des sites.
 *
 * Tout ce qui est publié est une estimation (fourchettes, cotations) ; les intoxications portent un
 * drapeau interne `fk` qui ne sort jamais du moteur. Les calculs quotidiens utilisent un hachage
 * déterministe (hash01) plutôt que le PRNG, pour ne pas décaler les autres tirages.
 */

export interface DeepConfig {
  sigintSatWeight: number;
  sigintAirWeight: number;
  imagerySatWeight: number;
  imageryAirWeight: number;
  ewWeight: number;
  sensorRef: number;
  sensorBonusMax: number;
  encryptionBase: number;
  encryptionPerLevel: number;
  cryptoStep: number;
  cryptoDecayPerDay: number;
  decryptOrders: number;
  decryptPlans: number;
  interceptMaxUnits: number;
  disinfoBase: number;
  geolocateMax: number;
  geolocateUncKm: number;
  jamUncFactor: number;
  ewJamBonus: number;
  coverDetect: Record<AgentCover, number>;
  coverTension: Record<AgentCover, number>;
  reliabilityStart: number;
  reliabilityPerDay: number;
  reliabilityMax: number;
  handlerBonus: number;
  cultivateMinReliability: number;
  accessDetect: number;
  vetDetect: number;
  orbatSpreadMax: number;
  orbatSpreadMin: number;
  dossierNations: number;
  threatWeights: Record<ThreatIndicator, number>;
  massingRef: number;
  alertThreshold: number;
  alertCooldownH: number;
  bdaRadiusKm: number;
  designateRadiusKm: number;
  designateUncKm: number;
  designateMax: number;
  dismantleCatch: number;
  hardenDays: number;
  hardenReduction: number;
}

/** Valeurs par défaut (identiques à data/balance/default.json, section intel.deep). */
export const DEEP_DEFAULTS: DeepConfig = {
  sigintSatWeight: 3,
  sigintAirWeight: 1,
  imagerySatWeight: 3,
  imageryAirWeight: 0.5,
  ewWeight: 1,
  sensorRef: 6,
  sensorBonusMax: 0.4,
  encryptionBase: 0.3,
  encryptionPerLevel: 0.15,
  cryptoStep: 0.3,
  cryptoDecayPerDay: 0.02,
  decryptOrders: 0.25,
  decryptPlans: 0.5,
  interceptMaxUnits: 5,
  disinfoBase: 0.35,
  geolocateMax: 6,
  geolocateUncKm: 15,
  jamUncFactor: 3,
  ewJamBonus: 0.5,
  coverDetect: { diplomatic: 1.2, nonofficial: 0.7 },
  coverTension: { diplomatic: 0.5, nonofficial: 1.5 },
  reliabilityStart: 0.5,
  reliabilityPerDay: 0.03,
  reliabilityMax: 0.9,
  handlerBonus: 1.5,
  cultivateMinReliability: 0.55,
  accessDetect: 1.4,
  vetDetect: 0.6,
  orbatSpreadMax: 0.6,
  orbatSpreadMin: 0.08,
  dossierNations: 6,
  threatWeights: { war: 25, massing: 35, plans: 30, comms: 10, mobilization: 10, covert: 10 },
  massingRef: 40,
  alertThreshold: 60,
  alertCooldownH: 24,
  bdaRadiusKm: 40,
  designateRadiusKm: 120,
  designateUncKm: 5,
  designateMax: 8,
  dismantleCatch: 0.5,
  hardenDays: 3,
  hardenReduction: 0.5,
};

const cache = new WeakMap<object, DeepConfig>();

export function dcfg(state: EngineState): DeepConfig {
  const bal = state.world.balance;
  let c = cache.get(bal);
  if (!c) {
    const src = ((bal.intel as { deep?: Partial<DeepConfig> } | undefined)?.deep ?? {}) as Partial<
      Record<string, unknown>
    >;
    const out = { ...DEEP_DEFAULTS } as Record<string, unknown>;
    for (const k of Object.keys(DEEP_DEFAULTS)) {
      const v = src[k];
      if (v === undefined) continue;
      const d = (DEEP_DEFAULTS as unknown as Record<string, unknown>)[k];
      out[k] = d && typeof d === 'object' ? { ...d, ...(v as object) } : v;
    }
    c = out as unknown as DeepConfig;
    cache.set(bal, c);
  }
  return c;
}

// ——— Capteurs ———

interface Sensors {
  s: number;
  i: number;
  e: number;
}

const has = (roles: readonly string[], ...xs: string[]): boolean =>
  xs.some((x) => roles.includes(x));

/** Poids de capteurs d'un matériel, par élément : écoute, imagerie, guerre électronique (cache). */
const sysWeights = new WeakMap<object, Map<string, [number, number, number]>>();

function weightsOf(state: EngineState, sysId: string, c: DeepConfig): [number, number, number] {
  let m = sysWeights.get(c);
  if (!m) sysWeights.set(c, (m = new Map()));
  let w = m.get(sysId);
  if (w) return w;
  const sys = state.world.catalog.get(sysId);
  w = [0, 0, 0];
  if (sys) {
    const roles = sys.roles ?? [];
    const sat = sys.category === 'space';
    if (has(roles, 'sigint', 'elint') || sys.sensor?.kind === 'sigint')
      w[0] = sat ? c.sigintSatWeight : c.sigintAirWeight;
    if (
      has(roles, 'imagery', 'sar') ||
      (has(roles, 'reconnaissance') && (sat || sys.category === 'drone' || !!sys.air))
    )
      w[1] = sat ? c.imagerySatWeight : c.imageryAirWeight;
    if ((sys.ew?.jamming ?? 0) > 0 && !sat) w[2] = c.ewWeight;
  }
  m.set(sysId, w);
  return w;
}

/**
 * Recalcul quotidien des capteurs de toutes les nations (un seul parcours des unités, poids par
 * matériel en cache ; sommes de multiples de 0,5 : exactes quel que soit l'ordre).
 */
export function refreshSensors(state: EngineState): void {
  const c = dcfg(state);
  const acc = new Map<NationId, Sensors>();
  const add = (owner: NationId, sysId: string, k: number): void => {
    const w = weightsOf(state, sysId, c);
    if (w[0] === 0 && w[1] === 0 && w[2] === 0) return;
    let a = acc.get(owner);
    if (!a) acc.set(owner, (a = { s: 0, i: 0, e: 0 }));
    a.s += w[0] * k;
    a.i += w[1] * k;
    a.e += w[2] * k;
  };
  for (const uid in state.units) {
    const u = state.units[uid]!;
    if (u.mix) for (const p of u.mix) add(u.owner, p.sys, p.c);
    else add(u.owner, u.sys, u.count);
  }
  for (const n of state.nationIds) {
    const ni = ist(state).nations[n];
    if (!ni) continue;
    const a = acc.get(n);
    if (a && (a.s > 0 || a.i > 0 || a.e > 0))
      ni.sx = { s: round2(a.s), i: round2(a.i), e: round2(a.e) };
    else delete ni.sx;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Bonus de capteurs (0..sensorBonusMax) : écoute (`s`), imagerie (`i`) ou guerre électronique (`e`). */
export function sensorBonus(state: EngineState, n: NationId, k: keyof Sensors): number {
  const c = dcfg(state);
  const x = ist(state).nations[n]?.sx?.[k] ?? 0;
  return x > 0 ? (c.sensorBonusMax * x) / (x + c.sensorRef) : 0;
}

export function sensorsView(state: EngineState, n: NationId): SigintView {
  const sx = ist(state).nations[n]?.sx;
  return {
    sigint: sx?.s ?? 0,
    imagery: sx?.i ?? 0,
    ew: sx?.e ?? 0,
    bonus:
      Math.round(Math.max(sensorBonus(state, n, 's'), sensorBonus(state, n, 'i')) * 1000) / 1000,
  };
}

// ——— Chiffrement et décryptage ———

/** Niveau moyen des services intérieur et militaire d'une nation (1..4). */
function serviceLevel(state: EngineState, x: NationId): number {
  return (level(state, x, 'interior') + level(state, x, 'military')) / 2;
}

/** Chiffrement d'une nation (0..0,95) : niveaux de ses services intérieur et militaire. */
export function encryption(state: EngineState, x: NationId, lv = serviceLevel(state, x)): number {
  const c = dcfg(state);
  return Math.round(clamp(c.encryptionBase + c.encryptionPerLevel * (lv - 1), 0, 0.95) * 100) / 100;
}

export function decrypt(state: EngineState, n: NationId, x: NationId): number {
  return ist(state).nations[n]?.cr?.[x] ?? 0;
}

/** Changements de clés : le décryptage s'érode chaque jour. */
export function cryptoDaily(state: EngineState): void {
  const d = dcfg(state).cryptoDecayPerDay;
  for (const n of state.nationIds) {
    const cr = ist(state).nations[n]?.cr;
    if (!cr) continue;
    for (const x of sortedKeys(cr)) {
      const v = Math.round(cr[x]! * (1 - d) * 1000) / 1000;
      if (v < 0.01) delete cr[x];
      else cr[x] = v;
    }
  }
}

function ev(state: EngineState, n: NationId, x: NationId): Assessment {
  const ni = nat(state, n);
  const e = ((ni.ev ??= {})[x] ??= { t: state.time, th: 0, ind: [] });
  return e;
}

// ——— Résultats des opérations ———

export type Result = (lines: string[], extra?: Partial<NewReport>) => void;

const pct = (x: number): string => `${Math.round(x * 100)} %`;

export function applyCryptanalysis(state: EngineState, n: NationId, x: NationId, result: Result) {
  const c = dcfg(state);
  const lv = serviceLevel(state, x);
  const enc = encryption(state, x, lv);
  const q = quality(state, n, 'military');
  const cr = (nat(state, n).cr ??= {});
  const before = cr[x] ?? 0;
  const after =
    Math.round(Math.min(1, before + (c.cryptoStep * (0.5 + q)) / (0.5 + enc)) * 1000) / 1000;
  cr[x] = after;
  const e = ev(state, n, x);
  e.en = enc;
  e.te = { ...(e.te ?? {}), t: state.time, l: Math.round(lv * 10) / 10 };
  result(
    [
      `Chiffrement ${natDe(state, x)} estimé à ${pct(enc)}.`,
      `Décryptage : ${pct(before)} → ${pct(after)}.`,
      after >= c.decryptPlans
        ? 'Les échanges de commandement et diplomatiques sont lisibles.'
        : after >= c.decryptOrders
          ? 'Les ordres de mouvement sont lisibles ; les intentions restent chiffrées.'
          : 'Contenu encore illisible : analyse du trafic seulement.',
    ],
    {
      titleLoc: loc('engine.intel.crypto', { nation: { nation: x } }),
      title: `Cryptanalyse — ${nationName(state, x)}`,
    },
  );
}

/** Unités d'une nation (vivantes), triées. */
function unitsOf(state: EngineState, x: NationId): Unit[] {
  return nationUnits(state, x)
    .map((id) => state.units[id]!)
    .filter(Boolean);
}

export function applyInterceptComms(state: EngineState, n: NationId, x: NationId, result: Result) {
  const c = dcfg(state);
  const p = decrypt(state, n, x);
  const title = `Interception des communications — ${nationName(state, x)}`;
  const titleLoc = loc('engine.intel.comint', { nation: { nation: x } });
  // Intoxication : un bon contre-espionnage adverse injecte du faux trafic dans ce qu'on intercepte.
  if (roll(state) < c.disinfoBase * quality(state, x, 'interior') * (1 - p)) {
    const pool = state.nationIds.filter(
      (y) => y !== x && state.nations[y]?.alive && !allied(state, x, y),
    );
    const fakeTarget = pool.includes(n) || pool.length === 0 ? n : pool[0]!;
    const e = ev(state, n, x);
    e.pl = { t: state.time, v: [fakeTarget], s: 'sigint', q: 0.5, fk: 1 };
    e.cm = state.time;
    result(
      [
        `Trafic de commandement ${natDe(state, x)} en forte hausse.`,
        `Messages déchiffrés : préparatifs d'offensive contre ${natLe(state, fakeTarget)}.`,
      ],
      { title, titleLoc, kind: 'intentions', q: 0.55, fake: true },
    );
    return;
  }
  const units = unitsOf(state, x);
  const moving = units.filter((u) => isMoving(u, state.time));
  const lines = [
    `Analyse du trafic : ${moving.length >= 5 ? 'activité élevée' : moving.length > 0 ? 'activité modérée' : 'activité faible'} sur les réseaux de commandement ${natDe(state, x)}.`,
  ];
  const e = ev(state, n, x);
  if (moving.length >= 5) e.cm = state.time;
  let revealed = 0;
  if (p >= c.decryptOrders) {
    const pick = moving
      .slice()
      .sort((a, b) => hash01('ic', n, a.id, state.time) - hash01('ic', n, b.id, state.time))
      .slice(0, c.interceptMaxUnits);
    for (const u of pick) {
      const pos = unitPosAt(state, u, state.time);
      const unc = 30 * (jammedFor(state, n, pos) ? c.jamUncFactor : 1);
      if (revealContact(state, n, u, 1, unc)) revealed++;
      const legs = u.move?.legs ?? [];
      const dest = legs.length ? legs[legs.length - 1]!.to : null;
      if (dest)
        lines.push(`• Ordre de mouvement intercepté : destination ${sectorOf(state, dest)}.`);
    }
  }
  if (p >= c.decryptPlans) {
    const plans = (board(state).warPlans?.[x] ?? []).slice().sort();
    e.pl = { t: state.time, v: plans, s: 'sigint', q: clamp(0.5 + 0.5 * p, 0, 0.95) };
    lines.push(
      plans.length
        ? `Intentions : ${natLe(state, x)} ${natAgree(state, x, 'prépare', 'préparent')} une guerre contre ${plans.map((y) => natLe(state, y)).join(', ')}.`
        : `Intentions : aucun préparatif offensif ${natDe(state, x)} dans les échanges déchiffrés.`,
    );
  } else if (p < c.decryptOrders) {
    lines.push(`Contenu chiffré (décryptage ${pct(p)}) : poursuivre la cryptanalyse.`);
  }
  if (revealed) lines.push(`${revealed} formation(s) localisée(s) sur la carte.`);
  e.t = state.time;
  result(lines, {
    title,
    titleLoc,
    kind: p >= c.decryptPlans ? 'intentions' : 'result',
    q: 0.6 + 0.3 * p,
  });
}

/** Émetteurs : radars, défense aérienne, avions de guet, postes de commandement. */
function isEmitter(state: EngineState, u: Unit): boolean {
  return partsOf(state, u).some(
    (p) =>
      p.sys.category === 'radar' ||
      p.sys.category === 'air_defense' ||
      p.sys.sensor?.kind === 'radar' ||
      p.sys.sensor?.kind === 'aew' ||
      p.sys.sensor?.kind === 'early_warning' ||
      (p.sys.roles ?? []).includes('command'),
  );
}

export function applyGeolocate(state: EngineState, n: NationId, x: NationId, result: Result) {
  const c = dcfg(state);
  const max = Math.round(c.geolocateMax * (1 + sensorBonus(state, n, 's') * 2));
  const cands = unitsOf(state, x)
    .filter((u) => isEmitter(state, u))
    .sort((a, b) => hash01('ge', n, a.id, state.time) - hash01('ge', n, b.id, state.time))
    .slice(0, max);
  const cats = new Map<Category, number>();
  let shown = 0;
  let at: LngLat | null = null;
  for (const u of cands) {
    const pos = unitPosAt(state, u, state.time);
    const unc = c.geolocateUncKm * (jammedFor(state, n, pos) ? c.jamUncFactor : 1);
    if (!revealContact(state, n, u, 2, unc)) continue;
    shown++;
    at ??= pos;
    const cat = partsOf(state, u)[0]!.sys.category;
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
  }
  const list = [...cats.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${v} ${CATEGORY_LABEL[k]}`)
    .join(', ');
  result(
    shown
      ? [
          `${shown} émetteur(s) ${natDe(state, x)} géolocalisé(s) : ${list}.`,
          'Positions reportées sur la carte (contacts d’écoute).',
        ]
      : [`Aucun émetteur ${natDe(state, x)} actif détecté.`],
    {
      title: `Émetteurs géolocalisés — ${nationName(state, x)}`,
      titleLoc: loc('engine.intel.emitters', { nation: { nation: x } }),
      at,
      radiusKm: at ? c.geolocateUncKm : 0,
      actions: at ? [{ kind: 'plan_strike', at }] : [],
    },
  );
}

export function applyDesignate(state: EngineState, n: NationId, op: StoredOp, result: Result) {
  const c = dcfg(state);
  const pid = op.target.provinceId!;
  const owner = state.provinces[pid]?.owner;
  const center = wi(state.world).provById.get(pid)!.cityPoint;
  raise(state, n, pid, 0, 3);
  const found: { u: Unit; d: number }[] = [];
  if (owner) {
    for (const u of unitsOf(state, owner)) {
      const pos = unitPosAt(state, u, state.time);
      const d = distanceKm(pos, center);
      if (d <= c.designateRadiusKm) found.push({ u, d });
    }
  }
  found.sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1));
  const tg = found.slice(0, c.designateMax);
  const ids: string[] = [];
  for (const { u } of tg) {
    const pos = unitPosAt(state, u, state.time);
    const unc = c.designateUncKm * (jammedFor(state, n, pos) ? c.jamUncFactor : 1);
    revealContact(state, n, u, 2, unc);
    ids.push(u.id);
  }
  const bs = wi(state.world).provById.get(pid)?.buildings ?? [];
  result(
    [
      `Analyse d'imagerie de ${provinceName(state, pid)} : ${tg.length} objectif(s) mobile(s) désigné(s), ${bs.length} installation(s) cartographiée(s).`,
      tg.length
        ? 'Coordonnées transmises aux unités de frappe.'
        : 'Aucune force mobile dans la zone.',
    ],
    {
      title: `Désignation de cibles — ${provinceName(state, pid)}`,
      titleLoc: loc('engine.intel.targets', { province: { province: pid } }),
      at: center,
      radiusKm: c.designateRadiusKm,
      subject: owner ? { nationId: owner, provinceId: pid, unitIds: ids } : { provinceId: pid },
      actions: [
        ...tg.slice(0, 3).map((t) => ({
          kind: 'plan_strike' as const,
          at: unitPosAt(state, t.u, state.time),
          unitId: t.u.id,
        })),
        { kind: 'open_province' as const, provinceId: pid },
      ],
      kind: 'order_of_battle',
    },
  );
}

/** Évaluation des dégâts après une frappe (rapport chez le tireur, s'il est joueur). */
export function bda(
  state: EngineState,
  by: NationId,
  victim: NationId,
  at: LngLat,
  kind: string,
): void {
  if (!state.nations[by]?.isPlayer || !state.nations[by]?.alive) return;
  const c = dcfg(state);
  const q = clamp(quality(state, by, 'military') + sensorBonus(state, by, 'i'), 0, 0.95);
  let units = 0;
  let damaged = 0;
  for (const u of unitsOf(state, victim)) {
    if (distanceKm(unitPosAt(state, u, state.time), at) > c.bdaRadiusKm) continue;
    units++;
    if (u.hp < u.maxHp * 0.6) damaged++;
  }
  const fuzz = (k: number): string =>
    q >= 0.6
      ? `${k}`
      : k === 0
        ? 'aucune'
        : `${Math.max(1, Math.round(k * (0.7 + hash01('bda', by, at[0], state.time) * 0.6)))} environ`;
  publish(state, by, {
    dept: 'military',
    source: 'sigint',
    kind: 'result',
    title: `Évaluation des dégâts — ${sectorOf(state, at)}`,
    titleLoc: loc('engine.intel.bda', { sector: sectorLoc(state, at) }),
    lines: [
      `Frappe ${kind === 'artillery' ? "d'artillerie" : kind === 'air' ? 'aérienne' : 'de missiles'} contre ${natLe(state, victim)}.`,
      units
        ? `Forces encore présentes dans un rayon de ${c.bdaRadiusKm} km : ${fuzz(units)} unité(s), dont ${fuzz(damaged)} fortement endommagée(s).`
        : `Plus aucune force identifiée dans un rayon de ${c.bdaRadiusKm} km.`,
      units ? 'Nouvelle frappe à envisager.' : 'Objectif considéré comme neutralisé.',
    ],
    at,
    radiusKm: c.bdaRadiusKm,
    subject: { nationId: victim },
    actions: units ? [{ kind: 'plan_strike', at }] : [],
    q,
    share: false,
  });
}

// ——— HUMINT : agents ———

/** Couverture choisie (absente : agent d'avant les couvertures, règles d'origine). */
export function coverOf(a: Agent): AgentCover | undefined {
  return a.cv;
}

/** Multiplicateur de détection d'un agent : couverture et niveau d'accès (sources haut placées). */
export function agentRisk(state: EngineState, a: Agent): number {
  const c = dcfg(state);
  const cv = coverOf(a);
  return (cv ? (c.coverDetect[cv] ?? 1) : 1) * Math.pow(c.accessDetect, a.ac ?? 0);
}

/** Tension supplémentaire à l'arrestation selon la couverture. */
export function arrestTension(state: EngineState, a: Agent): number {
  const cv = coverOf(a);
  return cv ? (dcfg(state).coverTension[cv] ?? 1) : 1;
}

export function reliabilityOfAgent(state: EngineState, a: Agent): number {
  return a.rl ?? dcfg(state).reliabilityStart;
}

/** Agent qu'on peut faire progresser (le propriétaire le croit actif). */
function liveForOwner(a: Agent): boolean {
  return !a.burned && (a.state === 'active' || a.state === 'caught' || a.state === 'double');
}

export function cultivable(state: EngineState, n: NationId, x?: NationId, id?: string): Agent[] {
  const st = ist(state);
  return sortedKeys(st.agents)
    .map((k) => st.agents[k]!)
    .filter(
      (a) =>
        a.owner === n &&
        liveForOwner(a) &&
        (a.ac ?? 0) < AGENT_ACCESS.length - 1 &&
        (!x || a.host === x) &&
        (!id || a.id === id),
    )
    .sort(
      (a, b) =>
        reliabilityOfAgent(state, b) - reliabilityOfAgent(state, a) || (a.id < b.id ? -1 : 1),
    );
}

export function applyCultivate(state: EngineState, n: NationId, op: StoredOp, result: Result) {
  const a = op.agentId ? ist(state).agents[op.agentId] : undefined;
  if (!a || (!liveForOwner(a) && a.state !== 'double')) {
    result(["L'agent n'était plus joignable : opération sans objet."]);
    return;
  }
  a.ac = Math.min(AGENT_ACCESS.length - 1, (a.ac ?? 0) + 1);
  result(
    [
      a.ac >= 2
        ? `${a.codename} a désormais accès à l'état-major ${natDe(state, a.host)} : plans de guerre et ordre de bataille.`
        : `${a.codename} a désormais accès à un ministère ${natDe(state, a.host)} : budget et programmes de recherche.`,
      'Exposition accrue : surveillance renforcée recommandée.',
    ],
    {
      title: `Source ${a.codename} — accès élargi`,
      titleLoc: loc('engine.intel.sourceAccess', { codename: a.codename }),
    },
  );
}

export function applyVet(state: EngineState, n: NationId, x: NationId, result: Result) {
  const c = dcfg(state);
  const st = ist(state);
  const q = quality(state, n, 'exterior');
  let checked = 0;
  const doubles: Agent[] = [];
  let burned = 0;
  for (const k of sortedKeys(st.agents)) {
    const a = st.agents[k]!;
    if (a.owner !== n || a.host !== x || !liveForOwner(a)) continue;
    checked++;
    if (a.state === 'double' && roll(state) < c.vetDetect * (0.5 + q)) {
      a.burned = true;
      a.rl = 0.1;
      doubles.push(a);
    } else if (a.state === 'caught' && roll(state) < c.vetDetect * (0.5 + q)) {
      burn(state, a);
      burned++;
    } else if (a.state === 'active') {
      a.rl = Math.min(c.reliabilityMax, reliabilityOfAgent(state, a) + 0.1);
    }
  }
  // Le dossier pays perd ses intentions fournies par un agent double démasqué.
  if (doubles.length) {
    const e = nat(state, n).ev?.[x];
    if (e?.pl && e.pl.s === 'humint') delete e.pl;
  }
  result(
    [
      `${checked} agent(s) vérifié(s) ${natA2(state, x)}.`,
      doubles.length
        ? `Agent(s) double(s) identifié(s) : ${doubles.map((a) => a.codename).join(', ')}. Leurs informations sont à écarter.`
        : 'Aucun agent double identifié.',
      burned ? `${burned} agent(s) probablement sous surveillance adverse.` : '',
    ].filter(Boolean),
    {
      title: `Vérification des agents — ${nationName(state, x)}`,
      titleLoc: loc('engine.intel.vet', { nation: { nation: x } }),
      kind: 'counterintel',
    },
  );
}

function natA2(state: EngineState, x: NationId): string {
  return `(${nationName(state, x)})`;
}

/**
 * Tour quotidien des réseaux : fiabilité perçue (officier traitant sur place = progression plus rapide),
 * sources de haut niveau (ministère : économie et recherche ; état-major : plans de guerre). Un agent
 * double fournit des informations truquées (drapeau interne).
 */
export function networksDaily(state: EngineState): void {
  const c = dcfg(state);
  const st = ist(state);
  const handlers = new Set<string>();
  for (const k of sortedKeys(st.agents)) {
    const a = st.agents[k]!;
    if (a.kind === 'officer' && liveForOwner(a)) handlers.add(`${a.owner}|${a.host}`);
  }
  const reported = new Set<string>();
  for (const k of sortedKeys(st.agents)) {
    const a = st.agents[k]!;
    if (!liveForOwner(a) && a.state !== 'double') continue;
    if (a.burned) continue;
    const bonus = a.kind === 'source' && handlers.has(`${a.owner}|${a.host}`) ? c.handlerBonus : 1;
    a.rl = round2(
      Math.min(c.reliabilityMax, reliabilityOfAgent(state, a) + c.reliabilityPerDay * bonus),
    );
    const ac = a.ac ?? 0;
    if (ac < 1 || a.state === 'caught') continue;
    if (!state.nations[a.owner]?.isPlayer) continue;
    const x = a.host;
    const fake = a.state === 'double';
    const e = ev(state, a.owner, x);
    const rl = reliabilityOfAgent(state, a);
    const money = Math.max(0, state.nations[x]?.money ?? 0) * (fake ? 0.5 : 1);
    const spread = (1 - rl) * 0.4 + 0.05;
    const h = hash01('ec', a.id, Math.floor(state.time / DAY));
    e.ec = {
      t: state.time,
      m: [
        Math.round((money * (1 - spread * (0.3 + 0.7 * h))) / 1e6) * 1e6,
        Math.round((money * (1 + spread * (0.3 + 0.7 * (1 - h)))) / 1e6) * 1e6,
      ],
    };
    const cur = researchOf(state, x)?.current?.id;
    e.te = { ...(e.te ?? {}), t: state.time, ...(cur && !fake ? { r: cur } : {}) };
    if (ac < 2 || reported.has(`${a.owner}|${x}`)) continue;
    reported.add(`${a.owner}|${x}`);
    const plans = fake ? [] : (board(state).warPlans?.[x] ?? []).slice().sort();
    const prev = e.pl?.v.join(',');
    e.pl = { t: state.time, v: plans, s: 'humint', q: rl, ...(fake ? { fk: 1 as const } : {}) };
    if (prev === plans.join(',')) continue;
    publish(state, a.owner, {
      dept: 'exterior',
      source: 'humint',
      kind: 'intentions',
      title: `Source de haut niveau — ${nationName(state, x)}`,
      titleLoc: loc('engine.intel.highLevel', { nation: { nation: x } }),
      lines: [
        `Source ${a.codename} (état-major ${natDe(state, x)}).`,
        plans.length
          ? `Plans de guerre en préparation contre ${plans.map((y) => natLe(state, y)).join(', ')}.`
          : 'Aucun plan de guerre en préparation.',
      ],
      at: null,
      radiusKm: 0,
      subject: { nationId: x },
      q: rl,
      ...(fake ? { fake: true } : {}),
      share: false,
    });
  }
}

// ——— Sécurité intérieure ———

export function applyDismantle(state: EngineState, n: NationId, x: NationId, result: Result) {
  const c = dcfg(state);
  const st = ist(state);
  const q = quality(state, n, 'interior');
  let caught = 0;
  let arrested = 0;
  for (const k of sortedKeys(st.agents)) {
    const a = st.agents[k]!;
    if (a.owner !== x || a.host !== n) continue;
    if (a.state === 'caught') {
      publicArrest(state, a);
      arrested++;
    } else if (a.state === 'active' && roll(state) < c.dismantleCatch * (0.5 + q)) {
      catchQuietly(state, a);
      caught++;
    }
  }
  result(
    [
      `Réseau ${natDe(state, x)} visé sur notre territoire.`,
      `${arrested} interpellation(s) publique(s), ${caught} agent(s) nouvellement identifié(s) et placé(s) sous surveillance.`,
      caught + arrested === 0
        ? 'Aucun membre du réseau identifié : réseau inexistant ou très cloisonné.'
        : '',
    ].filter(Boolean),
    {
      title: `Démantèlement du réseau ${natDe(state, x)}`,
      titleLoc: loc('engine.intel.dismantle', { nation: { nation: x } }),
      kind: 'counterintel',
    },
  );
}

/** Déception : faux plans transmis à la nation `x` (par ses propres agents chez nous). */
export function applyDeception(state: EngineState, n: NationId, x: NationId, result: Result) {
  const others = state.nationIds.filter(
    (y) => y !== n && y !== x && state.nations[y]?.alive && !allied(state, n, y),
  );
  const decoy = others.length
    ? others[Math.floor(hash01('dp', n, x, state.time) * others.length)]!
    : x;
  const e = ev(state, x, n);
  e.pl = { t: state.time, v: [decoy], s: 'humint', q: 0.7, fk: 1 };
  if (state.nations[x]?.isPlayer) {
    publish(state, x, {
      dept: 'exterior',
      source: 'humint',
      kind: 'intentions',
      title: `Intentions ${natDe(state, n)}`,
      titleLoc: loc('engine.intel.intentions', { nation: { nation: n } }),
      lines: [
        `Document de planification ${natDe(state, n)} obtenu par une source sur place.`,
        `Offensive en préparation contre ${natLe(state, decoy)}.`,
      ],
      at: null,
      radiusKm: 0,
      subject: { nationId: n },
      q: 0.55 + 0.3 * quality(state, n, 'interior'),
      fake: true,
      share: false,
    });
  }
  result(
    [
      `Faux plans transmis aux services ${natDe(state, x)} : ils désignent ${natLe(state, decoy)} comme notre prochain objectif.`,
      agentsIn(state, x, n) > 0
        ? 'Canal : agents adverses présents sur notre sol.'
        : 'Canal : fuite diplomatique contrôlée (crédibilité moindre).',
    ],
    {
      title: `Opération de déception — ${nationName(state, x)}`,
      titleLoc: loc('engine.intel.deception', { nation: { nation: x } }),
    },
  );
}

export function applyHarden(state: EngineState, n: NationId, result: Result) {
  const c = dcfg(state);
  const ni = nat(state, n);
  ni.hd = Math.max(ni.hd ?? 0, state.time) + c.hardenDays * DAY;
  result(
    [
      `Sites sensibles durcis pour ${c.hardenDays} jour(s) : gardes, contrôles d'accès, réseaux isolés.`,
      `Sabotages et cyberattaques industrielles : chance de réussite adverse réduite de ${pct(c.hardenReduction)}.`,
    ],
    { title: 'Sites sensibles durcis', titleLoc: loc('engine.intel.hardened') },
  );
}

export function hardenFactor(state: EngineState, victim: NationId): number {
  const hd = ist(state).nations[victim]?.hd;
  return hd !== undefined && hd > state.time ? 1 - dcfg(state).hardenReduction : 1;
}

/** Notification d'expulsion (couverture diplomatique). */
export function expulsionNote(state: EngineState, a: Agent, at: LngLat | null): void {
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at,
      category: 'intel',
      title: 'Diplomates expulsés',
      text: `${natLe(state, a.host, true)} ${natAgree(state, a.host, 'expulse', 'expulsent')} des diplomates ${natDe(state, a.owner)} pour espionnage.`,
      severity: 'warn',
      loc: noteLoc('agentExpelled', { host: { nation: a.host }, owner: { nation: a.owner } }),
    },
    [a.owner, a.host],
  );
}

// ——— Renseignement militaire : évaluation quotidienne (nations des joueurs) ———

function orbatOf(state: EngineState, n: NationId, x: NationId, qx: number) {
  const c = dcfg(state);
  const day = Math.floor(state.time / DAY);
  const cats = new Map<Category, number>();
  for (const u of unitsOf(state, x))
    for (const p of partsOf(state, u))
      cats.set(p.sys.category, (cats.get(p.sys.category) ?? 0) + p.c);
  // Agent retourné chez `x` : l'adversaire fait passer des effectifs minorés.
  const skew = doubledIn(state, n, x) ? 0.6 : 1;
  const spread = c.orbatSpreadMax - (c.orbatSpreadMax - c.orbatSpreadMin) * qx;
  const range = (k: number, key: string): [number, number] => {
    const v = k * skew;
    const lo = Math.max(
      0,
      Math.floor(v * (1 - spread * (0.3 + 0.7 * hash01('lo', n, x, day, key)))),
    );
    const hi = Math.ceil(v * (1 + spread * (0.3 + 0.7 * hash01('hi', n, x, day, key))));
    return [lo, Math.max(lo, hi)];
  };
  const list = [...cats.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, qx >= 0.5 ? 8 : qx >= 0.3 ? 5 : 3);
  let total = 0;
  for (const v of cats.values()) total += v;
  return {
    time: state.time,
    total: range(total, 'total'),
    cats: list.map(([category, k]) => ({ category, range: range(k, category) })),
  };
}

function bestAccess(state: EngineState, n: NationId, x: NationId): number {
  const st = ist(state);
  let best = -1;
  for (const k of sortedKeys(st.agents)) {
    const a = st.agents[k]!;
    if (a.owner === n && a.host === x && liveForOwner(a)) best = Math.max(best, a.ac ?? 0);
  }
  return best;
}

/**
 * Évaluation quotidienne d'une nation joueuse : dossiers des nations suivies (forces estimées, indice
 * de menace, indicateurs), alerte stratégique au franchissement du seuil. Renvoie les lignes « par
 * théâtre » du bulletin quotidien (note du renseignement militaire).
 */
export function assessDaily(state: EngineState, n: NationId, pool: PoolEntry[]): string[] {
  const c = dcfg(state);
  const ni = nat(state, n);
  const qm = quality(state, n, 'military');
  const nations = new Set(focusNations(state, n, c.dossierNations));
  for (const x of sortedKeys(ni.cr ?? {})) nations.add(x);
  for (const x of sortedKeys(ni.ev ?? {})) if (state.nations[x]?.alive) nations.add(x);
  const conc = concentrations(state, n, false, qm, pool);
  const massing = new Map<NationId, number>();
  for (const k of conc) massing.set(k.owner, (massing.get(k.owner) ?? 0) + k.elements);
  const since = state.time - 3 * DAY;
  const covert = new Set<NationId>();
  for (const r of ni.reports)
    if (
      r.time >= since &&
      (r.kind === 'counterintel' || r.kind === 'cyber') &&
      r.subject?.nationId &&
      r.dept === 'interior'
    )
      covert.add(r.subject.nationId);
  const lines: string[] = [];
  const theatres: { x: NationId; e: Assessment }[] = [];
  for (const x of [...nations].sort()) {
    if (!state.nations[x]?.alive || x === n || allied(state, n, x)) {
      if (ni.ev?.[x] && !state.nations[x]?.alive) delete ni.ev[x];
      continue;
    }
    const e = ev(state, n, x);
    const acc = bestAccess(state, n, x);
    const qx = clamp(
      0.55 * qm + sensorBonus(state, n, 'i') + (acc >= 2 ? 0.25 : 0) + 0.2 * decrypt(state, n, x),
      0,
      0.95,
    );
    e.ob = orbatOf(state, n, x, qx);
    const ind: ThreatIndicator[] = [];
    let th = 0;
    const w = c.threatWeights;
    if (atWar(state, n, x)) {
      ind.push('war');
      th += w.war;
    }
    const m = massing.get(x) ?? 0;
    if (m > 0) {
      ind.push('massing');
      th += w.massing * Math.min(1, m / c.massingRef);
    }
    if (e.pl && e.pl.v.includes(n) && state.time - e.pl.t <= 7 * DAY) {
      ind.push('plans');
      th += w.plans * e.pl.q;
    }
    if (e.cm !== undefined && state.time - e.cm <= 2 * DAY) {
      ind.push('comms');
      th += w.comms;
    }
    if (acc >= 1 && (state.nations[x]?.production?.length ?? 0) >= 3) {
      ind.push('mobilization');
      th += w.mobilization;
    }
    if (covert.has(x)) {
      ind.push('covert');
      th += w.covert;
    }
    e.tp = e.th;
    e.th = Math.round(clamp(th, 0, 100));
    e.ind = ind;
    e.t = state.time;
    const lv = serviceLevel(state, x);
    e.en = encryption(state, x, lv);
    e.te = { ...(e.te ?? {}), t: e.te?.t ?? state.time, l: Math.round(lv * 10) / 10 };
    theatres.push({ x, e });
    if (
      e.th >= c.alertThreshold &&
      !atWar(state, n, x) &&
      (e.al === undefined || state.time - e.al >= c.alertCooldownH * HOUR)
    ) {
      e.al = state.time;
      const cap = wi(state.world).nationById.get(x)?.capitalProvinceId;
      const at = cap ? (wi(state.world).provById.get(cap)?.cityPoint ?? null) : null;
      publish(state, n, {
        dept: 'military',
        source: 'sigint',
        kind: 'flash',
        title: `ALERTE STRATÉGIQUE — ${nationName(state, x)}`,
        titleLoc: loc('engine.intel.strategicAlert', { nation: { nation: x } }),
        lines: [
          `Indice d'imminence d'attaque ${natDe(state, x)} : ${e.th}/100.`,
          `Indicateurs : ${ind.map((i) => IND_LABEL[i]).join(', ')}.`,
          'Mise en alerte des forces et du dispositif de défense recommandée.',
        ],
        at,
        radiusKm: at ? 300 : 0,
        subject: { nationId: x },
        q: clamp(0.4 + 0.5 * qm, 0, 0.95),
        share: false,
      });
    }
  }
  theatres.sort((a, b) => b.e.th - a.e.th || (a.x < b.x ? -1 : 1));
  for (const { x, e } of theatres.slice(0, 5)) {
    const arrow = e.tp === undefined || e.tp === e.th ? '=' : e.th > e.tp ? '↑' : '↓';
    const f = e.ob ? ` Forces estimées : ${e.ob.total[0]}–${e.ob.total[1]} éléments.` : '';
    lines.push(
      `• ${nationName(state, x)} — menace ${e.th}/100 (${arrow})${e.ind.length ? ` : ${e.ind.map((i) => IND_LABEL[i]).join(', ')}` : ''}.${f}`,
    );
  }
  return lines;
}

const IND_LABEL: Record<ThreatIndicator, string> = {
  war: 'guerre en cours',
  massing: 'concentration de forces',
  plans: 'plans de guerre',
  comms: 'trafic de commandement en hausse',
  mobilization: 'mobilisation industrielle',
  covert: 'opérations clandestines',
};

// ——— Vue : dossiers pays ———

export function dossiersView(state: EngineState, n: NationId): NationDossier[] {
  const ni = ist(state).nations[n];
  if (!ni?.ev) return [];
  const out: NationDossier[] = [];
  const st = ist(state);
  for (const x of sortedKeys(ni.ev)) {
    if (!state.nations[x]?.alive) continue;
    const e = ni.ev[x]!;
    let agents = 0;
    let acc = -1;
    let rlSum = 0;
    for (const k of sortedKeys(st.agents)) {
      const a = st.agents[k]!;
      if (a.owner !== n || a.host !== x || !liveForOwner(a)) continue;
      agents++;
      acc = Math.max(acc, a.ac ?? 0);
      rlSum += reliabilityOfAgent(state, a);
    }
    const cr = ni.cr?.[x] ?? 0;
    const q = clamp(
      0.3 + (agents ? (rlSum / agents) * 0.3 : 0) + cr * 0.3 + (e.ob ? 0.1 : 0),
      0,
      0.95,
    );
    const d: NationDossier = {
      nationId: x,
      updatedAt: e.t,
      threat: e.th,
      trend: e.tp === undefined || e.tp === e.th ? 0 : e.th > e.tp ? 1 : -1,
      indicators: [...e.ind],
      crypto: Math.round(cr * 1000) / 1000,
      encryption: e.en ?? 0,
      agents,
      reliability: reliabilityOf(q),
    };
    if (e.al !== undefined && state.time - e.al < dcfg(state).alertCooldownH * HOUR) d.alert = true;
    if (e.ob)
      d.forces = {
        time: e.ob.time,
        total: [e.ob.total[0], e.ob.total[1]],
        cats: e.ob.cats.map((k) => ({ category: k.category, range: [k.range[0], k.range[1]] })),
      };
    if (e.pl)
      d.intentions = {
        time: e.pl.t,
        plansAgainst: [...e.pl.v],
        source: e.pl.s,
        reliability: reliabilityOf(e.pl.q),
      };
    if (e.ec) d.economy = { time: e.ec.t, money: [e.ec.m[0], e.ec.m[1]] };
    if (e.te) {
      const t: NonNullable<NationDossier['tech']> = { time: e.te.t };
      if (e.te.r) t.research = e.te.r;
      if (e.te.l !== undefined) t.services = e.te.l;
      d.tech = t;
    }
    if (acc >= 0) d.access = AGENT_ACCESS[acc];
    out.push(d);
  }
  return out.sort((a, b) => b.threat - a.threat || (a.nationId < b.nationId ? -1 : 1));
}
