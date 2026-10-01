import {
  HOUR,
  distanceKm,
  type BuildingType,
  type Department,
  type IntelOpKind,
  type IntelOpTarget,
  type LngLat,
  type NationId,
  type OrderErrorCode,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { provincesOf, sightLevel, sortedKeys, warsOf } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { board, scheduleMod } from '../kit.js';
import { modifier, signal } from '../registry.js';
import { OP_META, cfg, clamp, type OpCost } from './config.js';
import {
  agentsIn,
  budgetFactor,
  doubledIn,
  level,
  neighborNations,
  quality,
  researchDone,
  researchOf,
  roll,
} from './levels.js';
import { publish } from './reports.js';
import { announce, recon } from './provinces.js';
import { isNationRecon, nationReconReport, opCost, runWave, scheduleWaves } from './recon.js';
import {
  burn,
  catchQuietly,
  createAgent,
  detectionChance,
  publicArrest,
  turnable,
} from './agents.js';
import {
  deployDecoys,
  exposeDecoys,
  reportExposedDecoys,
  startIntercept,
  startListen,
} from './contacts.js';
import { ist, nat, nextId, type Agent, type StoredOp } from './state.js';
import {
  CATEGORY_LABEL,
  fmtTime,
  nationName,
  natA,
  natAgree,
  natDe,
  natLe,
  provinceName,
  sectorOf,
} from './text.js';
import { loc } from '@redline/shared';

export const OP_LABEL: Record<IntelOpKind, string> = {
  infiltrate_spy: "Infiltration d'un agent",
  recruit_source: "Recrutement d'une source",
  turn_agent: "Retournement d'un agent",
  exfiltrate: 'Exfiltration',
  steal_research: 'Vol de recherche',
  sabotage_factory: 'Sabotage industriel',
  fund_rebels: 'Financement de rebelles',
  listen_area: 'Écoute de zone',
  intercept_army: 'Interception de communications',
  jam_area: 'Brouillage de zone',
  cyber_radar: 'Cyberattaque (radars)',
  cyber_production: 'Cyberattaque (industrie)',
  cyber_orders: 'Cyberattaque (commandement)',
  disinformation: 'Campagne de désinformation',
  leak_plans: 'Fuite organisée',
  plant_fake_report: 'Intoxication (faux rapport)',
  deploy_decoys: 'Déploiement de leurres',
  fake_radio_traffic: 'Faux trafic radio',
  counterintel_sweep: 'Opération de contre-espionnage',
  recon_economic: 'Reconnaissance économique',
  recon_military: 'Reconnaissance militaire',
};

/** Opérations HUMINT contre une nation qui profitent des agents implantés. */
const AGENT_OPS: ReadonlySet<IntelOpKind> = new Set([
  'steal_research',
  'sabotage_factory',
  'fund_rebels',
  'leak_plans',
  'disinformation',
  'plant_fake_report',
]);
const NEEDS_NATION: ReadonlySet<IntelOpKind> = new Set([
  'infiltrate_spy',
  'recruit_source',
  'steal_research',
  'disinformation',
  'leak_plans',
  'plant_fake_report',
  'cyber_radar',
  'cyber_production',
  'cyber_orders',
  'fake_radio_traffic',
]);
const CYBER: Record<string, 'radar' | 'production' | 'orders'> = {
  cyber_radar: 'radar',
  cyber_production: 'production',
  cyber_orders: 'orders',
};

function fail(error: OrderErrorCode, message: string): OrderResult {
  return { ok: false, error, message };
}

/** Département du défenseur face à une opération. */
function defenderDept(kind: IntelOpKind): Department | null {
  switch (kind) {
    case 'listen_area':
    case 'intercept_army':
    case 'deploy_decoys':
    case 'fake_radio_traffic':
    case 'recon_military':
      return 'military';
    case 'turn_agent':
      return 'exterior';
    case 'jam_area':
    case 'counterintel_sweep':
      return null;
    default:
      return 'interior';
  }
}

/** Probabilité de réussite : niveaux attaquant / défenseur, budget, agents, cyber. */
export function successChance(
  state: EngineState,
  n: NationId,
  kind: IntelOpKind,
  victim: NationId | undefined,
  c: OpCost = cfg(state).ops[kind],
): number {
  const meta = OP_META[kind];
  const atk = level(state, n, meta.dept);
  const dd = defenderDept(kind);
  const def = victim && dd ? level(state, victim, dd) : 1;
  let p = c.baseSuccess * (1 + 0.2 * (atk - def)) * (0.6 + 0.8 * budgetFactor(state, n, meta.dept));
  if (victim && AGENT_OPS.has(kind)) {
    const ag = agentsIn(state, n, victim);
    p *= ag > 0 ? 1 + 0.15 * Math.min(4, ag) : kind === 'disinformation' ? 1 : 0.6;
    // Un agent retourné prévient le pays hôte.
    if (doubledIn(state, n, victim)) p *= 0.7;
  }
  if (victim && CYBER[kind]) {
    p *=
      modifier(state, n, 'cyber.attack') / Math.max(0.1, modifier(state, victim, 'cyber.defense'));
  }
  return Math.round(clamp(p, 0.05, 0.95) * 1000) / 1000;
}

interface Resolved {
  victim?: NationId;
  agentId?: string;
  target: IntelOpTarget;
}

function resolveTarget(
  state: EngineState,
  n: NationId,
  kind: IntelOpKind,
  target: IntelOpTarget,
  agentId?: string,
): Resolved | OrderResult {
  const st = ist(state);
  const c = cfg(state);
  const t: IntelOpTarget = {};
  if (NEEDS_NATION.has(kind)) {
    const v = target.nationId;
    if (!v || v === n || !state.nations[v]?.alive)
      return fail('invalid_target', 'Nation cible invalide.');
    t.nationId = v;
  }
  switch (kind) {
    case 'turn_agent': {
      const cands = agentId
        ? turnable(state, n).filter((a) => a.id === agentId)
        : turnable(state, n, target.nationId);
      const a = cands[0];
      if (!a) return fail('invalid_target', 'Aucun agent démasqué à retourner.');
      return { victim: a.owner, agentId: a.id, target: { nationId: a.owner } };
    }
    case 'exfiltrate': {
      const mine = sortedKeys(st.agents)
        .map((id) => st.agents[id]!)
        .filter(
          (a) =>
            a.owner === n &&
            (a.state === 'active' || a.state === 'caught' || a.state === 'double') &&
            (target.unitId ? a.id === target.unitId : a.host === target.nationId),
        )
        .sort((x, y) => Number(!!y.burned) - Number(!!x.burned));
      const a = mine[0];
      if (!a) return fail('invalid_target', 'Aucun agent à exfiltrer.');
      return { victim: a.host, agentId: a.id, target: { nationId: a.host } };
    }
    case 'sabotage_factory':
    case 'fund_rebels': {
      const pid = target.provinceId;
      const P = pid ? state.provinces[pid] : undefined;
      if (!pid || !P || P.owner === n) return fail('invalid_target', 'Province cible invalide.');
      if (kind === 'sabotage_factory' && !wi(state.world).provById.get(pid)?.buildings.length)
        return fail('invalid_target', 'Aucune installation à saboter dans cette province.');
      return { victim: P.owner, target: { provinceId: pid, nationId: P.owner } };
    }
    case 'listen_area':
    case 'jam_area': {
      if (!target.at) return fail('invalid_target', 'Zone à préciser.');
      const r = clamp(target.radiusKm ?? c.listenRadiusKm, 10, c.listenMaxRadiusKm);
      return { target: { at: target.at, radiusKm: r } };
    }
    case 'intercept_army': {
      const id = target.unitId;
      const u = id ? state.units[id] : undefined;
      const known = !!id && (!!state.know[n]?.[id] || sightLevel(state, n, id) > 0);
      if (!id || !known || !u || u.owner === n)
        return fail('invalid_target', 'Unité inconnue de nos services.');
      return { victim: u.owner, target: { unitId: id, nationId: u.owner } };
    }
    case 'deploy_decoys': {
      if (!target.at) return fail('invalid_target', 'Zone à préciser.');
      const w = wi(state.world);
      const near = provincesOf(state, n).some(
        (pid) => distanceKm(w.provById.get(pid)!.cityPoint, target.at!) <= c.decoyMaxKm,
      );
      if (!near) return fail('out_of_range', 'Leurres trop loin de notre territoire.');
      const deceived = target.nationId ? [target.nationId] : warsOf(state, n);
      if (deceived.length === 0 || deceived.some((x) => x === n || !state.nations[x]))
        return fail('invalid_target', 'Aucune nation à tromper.');
      const out: IntelOpTarget = { at: target.at };
      if (target.nationId) out.nationId = target.nationId;
      return { victim: deceived[0]!, target: out };
    }
    case 'fake_radio_traffic': {
      if (!target.at) return fail('invalid_target', 'Zone à préciser.');
      return { victim: t.nationId!, target: { nationId: t.nationId!, at: target.at } };
    }
    case 'counterintel_sweep':
      return { target: {} };
    case 'recon_economic':
    case 'recon_military': {
      if (target.provinceId) {
        const P = state.provinces[target.provinceId];
        if (!P || P.owner === n) return fail('invalid_target', 'Province cible invalide.');
        return { victim: P.owner, target: { provinceId: target.provinceId, nationId: P.owner } };
      }
      const v = target.nationId;
      if (!v || v === n || !state.nations[v]?.alive)
        return fail('invalid_target', 'Nation ou province cible à préciser.');
      return { victim: v, target: { nationId: v } };
    }
    default:
      // Faux rapport : une zone donnée en fait un faux mouvement de forces (sinon de fausses intentions).
      if (kind === 'plant_fake_report' && target.at) t.at = target.at;
      return { victim: t.nationId!, target: t };
  }
}

/** Ordre intelOp (et turnAgent) : validation, coût, capacité, programmation de la fin. */
export function startOp(
  state: EngineState,
  n: NationId,
  kind: IntelOpKind,
  target: IntelOpTarget,
  agentId?: string,
): OrderResult {
  const ns = state.nations[n];
  if (!ns?.alive) return fail('not_allowed', 'Nation vaincue.');
  const meta = OP_META[kind];
  if (!meta) return fail('invalid_target', 'Opération inconnue.');
  const r = resolveTarget(state, n, kind, target, agentId);
  if ('ok' in r) return r;
  const ni = nat(state, n);
  const running = ni.ops.filter((o) => o.status === 'running' && o.dept === meta.dept).length;
  if (running >= capacityOf(state, n, meta.dept))
    return fail('capacity', 'Capacité du département atteinte.');
  const cost = opCost(state, kind, r.target);
  if (ns.money < cost.money) return fail('insufficient_funds', 'Fonds insuffisants.');
  if (
    r.agentId &&
    ni.ops.some((o) => o.status === 'running' && o.agentId === r.agentId && o.kind === kind)
  )
    return fail('not_allowed', 'Opération déjà en cours sur cet agent.');
  ns.money -= cost.money;
  const op: StoredOp = {
    id: nextId(state, 'o'),
    kind,
    dept: meta.dept,
    target: r.target,
    startedAt: state.time,
    completesAt: state.time + Math.max(0.1, cost.durationH) * HOUR,
    status: 'running',
    estimate: successChance(state, n, kind, r.victim, cost),
  };
  if (r.victim) op.victim = r.victim;
  if (r.agentId) op.agentId = r.agentId;
  ni.ops.push(op);
  if (isNationRecon(kind, r.target)) scheduleWaves(state, n, op);
  scheduleMod(state, { t: op.completesAt, m: 'intel', e: 'op', d: { n, id: op.id } });
  return { ok: true };
}

function capacityOf(state: EngineState, n: NationId, dept: Department): number {
  const m = modifier(state, n, 'intel.capacity');
  return Math.max(1, Math.round((1 + level(state, n, dept)) * m));
}

export function cancelOp(state: EngineState, n: NationId, opId: string): OrderResult {
  const ni = nat(state, n);
  const i = ni.ops.findIndex((o) => o.id === opId && o.status === 'running');
  if (i < 0) return fail('invalid_target', 'Opération introuvable.');
  ni.ops.splice(i, 1);
  return { ok: true };
}

function trimOps(state: EngineState, n: NationId): void {
  const ni = nat(state, n);
  const done = ni.ops.filter((o) => o.status !== 'running');
  if (done.length <= 20) return;
  const drop = new Set(done.slice(0, done.length - 20).map((o) => o.id));
  ni.ops = ni.ops.filter((o) => !drop.has(o.id));
}

// ——— Résolution ———

/** Qualité du service adverse face à une opération (0,3 sans victime ni département). */
function defenderQuality(state: EngineState, op: StoredOp): number {
  const dd = defenderDept(op.kind);
  return op.victim && dd ? quality(state, op.victim, dd) : 0.3;
}

/** Phase intermédiaire d'une reconnaissance de pays (événement `wave`). */
export function waveOp(state: EngineState, n: NationId, id: string): void {
  const op = nat(state, n).ops.find((o) => o.id === id);
  if (!op || op.status !== 'running' || !op.rn) return;
  if (runWave(state, n, op, defenderQuality(state, op)) === 'exposed')
    exposeNationRecon(state, n, op);
}

function exposeNationRecon(state: EngineState, n: NationId, op: StoredOp): void {
  op.status = 'compromised';
  nationReconReport(state, n, op, 'compromised', {
    title: `${OP_LABEL[op.kind]} — compromise`,
    titleLoc: loc('engine.intel.opCompromised', { op: { key: `engine.intelOp.${op.kind}` } }),
    source: OP_META[op.kind].source,
  });
  onExposed(state, n, op);
  trimOps(state, n);
}

/** Dernière phase et bilan d'une reconnaissance de pays : réussie si au moins une phase a abouti. */
function finishNationRecon(state: EngineState, n: NationId, op: StoredOp): void {
  if (runWave(state, n, op, defenderQuality(state, op)) === 'exposed')
    return exposeNationRecon(state, n, op);
  const ok = op.rn!.ok > 0;
  op.status = ok ? 'success' : 'failed';
  nationReconReport(state, n, op, op.status, {
    title: `${OP_LABEL[op.kind]} — ${ok ? nationName(state, op.victim!) : 'échec'}`,
    titleLoc: loc('engine.intel.opOutcome', {
      op: { key: `engine.intelOp.${op.kind}` },
      outcome: ok ? { nation: op.victim! } : { key: 'engine.intel.failed' },
    }),
    source: OP_META[op.kind].source,
  });
  trimOps(state, n);
}

export function resolveOp(state: EngineState, n: NationId, id: string): void {
  const ni = nat(state, n);
  const op = ni.ops.find((o) => o.id === id);
  if (!op || op.status !== 'running') return;
  if (op.rn) return finishNationRecon(state, n, op);
  const c = cfg(state).ops[op.kind];
  const victimAlive = !op.victim || !!state.nations[op.victim]?.alive;
  const ok = victimAlive && state.nations[n]?.alive && roll(state) < op.estimate;
  if (ok) {
    op.status = 'success';
    applySuccess(state, n, op);
  } else {
    const dq = defenderQuality(state, op);
    const exposed = victimAlive && roll(state) < c.exposure * (0.5 + dq);
    op.status = exposed ? 'compromised' : 'failed';
    publish(state, n, {
      dept: op.dept,
      source: OP_META[op.kind].source,
      kind: 'result',
      title: `${OP_LABEL[op.kind]} — ${exposed ? 'compromise' : 'échec'}`,
      titleLoc: loc('engine.intel.opOutcome', {
        op: { key: `engine.intelOp.${op.kind}` },
        outcome: { key: exposed ? 'engine.intel.compromised' : 'engine.intel.failed' },
      }),
      lines: [
        exposed
          ? "L'opération a été découverte par les services adverses. Conséquences diplomatiques à prévoir."
          : "L'opération n'a pas atteint son objectif. Pas d'indice de compromission.",
        op.victim ? `Cible : ${nationName(state, op.victim)}.` : '',
      ].filter(Boolean),
      at: op.target.at ?? null,
      radiusKm: op.target.radiusKm ?? 0,
      subject: op.victim ? { nationId: op.victim } : {},
      q: 0.9,
    });
    if (exposed) onExposed(state, n, op);
  }
  trimOps(state, n);
}

function pickAgent(state: EngineState, owner: NationId, host: NationId): Agent | undefined {
  const st = ist(state);
  const list = sortedKeys(st.agents)
    .map((id) => st.agents[id]!)
    .filter(
      (a) => a.owner === owner && a.host === host && (a.state === 'active' || a.state === 'caught'),
    );
  return list.find((a) => a.kind === 'officer') ?? list[0];
}

/** Opération démasquée : arrestation (HUMINT) ou attribution (SIGINT, cyber), hausse de tension. */
function onExposed(state: EngineState, n: NationId, op: StoredOp): void {
  const v = op.victim;
  if (!v) return;
  const meta = OP_META[op.kind];
  if (op.kind === 'turn_agent') {
    const a = op.agentId ? ist(state).agents[op.agentId] : undefined;
    if (a) burn(state, a);
    return;
  }
  if (op.kind === 'exfiltrate') {
    const a = op.agentId ? ist(state).agents[op.agentId] : undefined;
    if (a && (a.state === 'active' || a.state === 'caught' || a.state === 'double'))
      publicArrest(state, a);
    return;
  }
  if (meta.source === 'humint') {
    const a =
      (AGENT_OPS.has(op.kind) ? pickAgent(state, n, v) : undefined) ??
      createAgent(state, n, v, op.kind === 'recruit_source' ? 'source' : 'officer');
    publicArrest(state, a);
    return;
  }
  // SIGINT / cyber : attribution par la victime.
  const q = quality(state, v, 'interior');
  publish(state, v, {
    dept: CYBER[op.kind] ? 'interior' : 'military',
    source: 'sigint',
    kind: CYBER[op.kind] ? 'cyber' : 'counterintel',
    title: `${OP_LABEL[op.kind]} attribuée ${natA(state, n)}`,
    titleLoc: loc('engine.intel.opAttributed', { op: { key: `engine.intelOp.${op.kind}` }, nation: { nation: n } }),
    lines: [
      `Tentative de ${OP_LABEL[op.kind].toLowerCase()} détectée et attribuée ${natA(state, n)}.`,
      'Mesures de protection renforcées.',
    ],
    at: op.target.at ?? null,
    radiusKm: op.target.radiusKm ?? 0,
    subject: { nationId: n },
    q: Math.max(q, 0.5),
  });
  signal(state, 'alert', { amount: cfg(state).exposureTension, reason: 'intel_exposed' });
}

const SABOTAGE_PREF: BuildingType[] = [
  'arms_factory',
  'refinery',
  'power_plant',
  'research_center',
  'air_base',
  'port',
  'military_base',
];

function applySuccess(state: EngineState, n: NationId, op: StoredOp): void {
  const c = cfg(state);
  const v = op.victim;
  const vName = v ? nationName(state, v) : '';
  const vDe = v ? natDe(state, v) : '';
  const vLe = v ? natLe(state, v) : '';
  const vA = v ? natA(state, v) : '';
  const result = (lines: string[], extra: Partial<Parameters<typeof publish>[2]> = {}): void => {
    publish(state, n, {
      dept: op.dept,
      source: OP_META[op.kind].source,
      kind: 'result',
      title: `${OP_LABEL[op.kind]} — réussite`,
      titleLoc: loc('engine.intel.opSuccess', { op: { key: `engine.intelOp.${op.kind}` } }),
      lines,
      at: op.target.at ?? null,
      radiusKm: op.target.radiusKm ?? 0,
      subject: v ? { nationId: v } : {},
      q: 0.9,
      ...extra,
    });
  };
  switch (op.kind) {
    case 'infiltrate_spy':
    case 'recruit_source': {
      const a = createAgent(state, n, v!, op.kind === 'infiltrate_spy' ? 'officer' : 'source');
      result([
        op.kind === 'infiltrate_spy'
          ? `Agent ${a.codename} implanté sur le territoire ${vDe}. Premières remontées sous 24 heures.`
          : `Source ${a.codename} recrutée sur le territoire ${vDe}. Accès limité mais discret.`,
      ]);
      return;
    }
    case 'turn_agent': {
      const a = op.agentId ? ist(state).agents[op.agentId] : undefined;
      if (!a || a.state !== 'caught') {
        result(["L'agent n'était plus disponible : opération sans objet."]);
        return;
      }
      a.state = 'double';
      a.turnedAt = state.time;
      result([
        `Agent ${a.codename} retourné : il travaille désormais pour nous.`,
        `Ses rapports ${vA} sont sous notre contrôle ; son service ignore la manœuvre.`,
      ]);
      return;
    }
    case 'exfiltrate': {
      const a = op.agentId ? ist(state).agents[op.agentId] : undefined;
      if (!a || a.state === 'captured' || a.state === 'exfiltrated') {
        result(["L'agent n'était plus joignable."]);
        return;
      }
      a.state = 'exfiltrated';
      result([`Agent ${a.codename} exfiltré ${vDe}, en sécurité.`]);
      return;
    }
    case 'steal_research': {
      const mine = new Set(researchDone(state, n));
      const res = state.world.research;
      const cands = researchDone(state, v!)
        .filter((id) => !mine.has(id) && (!res || res.has(id)))
        .sort((a, b) => (res?.get(b)?.tier ?? 0) - (res?.get(a)?.tier ?? 0) || (a < b ? -1 : 1));
      const top = cands.filter(
        (id) => (res?.get(id)?.tier ?? 0) === (res?.get(cands[0]!)?.tier ?? 0),
      );
      if (top.length === 0) {
        result([`Aucune avance technologique ${vDe} exploitable par nos laboratoires.`]);
        return;
      }
      const nodeId = top[Math.floor(roll(state) * top.length)]!;
      const g = (ist(state).gates[n] ??= []);
      if (!g.includes(nodeId)) g.push(nodeId);
      g.sort();
      signal(state, 'research_stolen', { by: n, victim: v, nodeId });
      result([
        `Dossiers techniques « ${res?.get(nodeId)?.name ?? nodeId} » récupérés auprès ${vDe}.`,
        'Transmis à nos laboratoires.',
      ]);
      return;
    }
    case 'sabotage_factory': {
      const pid = op.target.provinceId!;
      const bs = wi(state.world).provById.get(pid)?.buildings ?? [];
      const building = SABOTAGE_PREF.find((b) => bs.includes(b)) ?? bs[0]!;
      const [lo, hi] = c.sabotageDamage;
      const damage = Math.round((lo + roll(state) * (hi - lo)) * 100) / 100;
      signal(state, 'sabotage', { by: n, victim: v, pid, building, damage });
      const at = wi(state.world).provById.get(pid)!.cityPoint;
      result(
        [
          `Sabotage réussi : ${building} de ${provinceName(state, pid)} (${vName}) endommagé(e) à ${Math.round(damage * 100)} %.`,
        ],
        { at, radiusKm: 20, subject: { nationId: v!, provinceId: pid } },
      );
      return;
    }
    case 'fund_rebels': {
      const pid = op.target.provinceId!;
      signal(state, 'rebels_funded', { by: n, pid, amount: c.ops.fund_rebels.money });
      const at = wi(state.world).provById.get(pid)!.cityPoint;
      result([`Fonds remis aux groupes rebelles de ${provinceName(state, pid)} (${vName}).`], {
        at,
        radiusKm: 50,
        subject: { nationId: v!, provinceId: pid },
        actions: [{ kind: 'open_province', provinceId: pid }],
      });
      return;
    }
    case 'listen_area': {
      const lvl = quality(state, n, 'military') >= 0.55 ? 2 : 1;
      startListen(state, n, op.target.at!, op.target.radiusKm ?? c.listenRadiusKm, lvl);
      return;
    }
    case 'intercept_army':
      startIntercept(state, n, op.target.unitId!);
      return;
    case 'jam_area': {
      const id = nextId(state, 'j');
      const r = op.target.radiusKm ?? c.listenRadiusKm;
      const until = state.time + c.jamHours * HOUR;
      ist(state).jams[id] = { id, owner: n, at: op.target.at!, r, until };
      scheduleMod(state, { t: until, m: 'intel', e: 'expire', d: { kind: 'jam', id } });
      signal(state, 'jam', { by: n, at: op.target.at!, radiusKm: r, hours: c.jamHours });
      result([`Brouillage actif jusqu'à ${fmtTime(until)} sur ${Math.round(r)} km.`]);
      return;
    }
    case 'cyber_radar':
    case 'cyber_production':
    case 'cyber_orders': {
      const kind = CYBER[op.kind]!;
      signal(state, 'cyber', { by: n, victim: v, kind, hours: c.cyberHours });
      const what =
        kind === 'radar'
          ? 'réseau radar aveuglé'
          : kind === 'production'
            ? 'chaînes de production ralenties'
            : 'transmission des ordres perturbée';
      result([`${vName} : ${what} pour ${c.cyberHours} heures.`], { kind: 'cyber' });
      return;
    }
    case 'disinformation':
      signal(state, 'disinformation', { by: n, victim: v, amount: c.disinformationAmount });
      result([
        `Campagne diffusée dans l'espace médiatique ${vDe}. Effet sur la stabilité attendu.`,
      ]);
      return;
    case 'leak_plans': {
      const { headline, body } = leakContent(state, v!);
      signal(state, 'leak', { by: n, victim: v, headline, body });
      result([`Documents ${vDe} rendus publics : « ${headline} ».`], { kind: 'leak' });
      return;
    }
    case 'plant_fake_report': {
      const planted = plantFake(state, n, v!, op.target.at ?? null, 'report');
      result([
        planted
          ? `Faux rapport introduit dans les circuits ${vDe}.`
          : `Faux rapport transmis ; réception par ${vLe} non confirmée.`,
      ]);
      return;
    }
    case 'fake_radio_traffic': {
      plantFake(state, n, v!, op.target.at!, 'radio');
      result([`Faux trafic radio émis ${sectorOf(state, op.target.at!)} à destination ${vDe}.`]);
      return;
    }
    case 'deploy_decoys': {
      const deceived = op.target.nationId ? [op.target.nationId] : warsOf(state, n);
      const count = c.decoyCount + level(state, n, 'military') - 1;
      const ds = deployDecoys(state, n, op.target.at!, deceived, count);
      result([
        `${ds.length} leurre(s) déployé(s) ${sectorOf(state, op.target.at!)}, visibles par ${deceived.map((x) => natLe(state, x)).join(', ')}.`,
        `Durée : ${c.decoyHours} heures.`,
      ]);
      return;
    }
    case 'counterintel_sweep':
      sweep(state, n);
      return;
    case 'recon_economic':
    case 'recon_military': {
      const axis = op.kind === 'recon_economic' ? 'e' : 'm';
      const target: { provinceId?: string; nationId?: string } = {};
      if (op.target.provinceId) target.provinceId = op.target.provinceId;
      else if (v) target.nationId = v;
      const ds = recon(state, n, axis, target);
      announce(state, n, ds, {
        dept: op.dept,
        source: OP_META[op.kind].source,
        title: `${OP_LABEL[op.kind]} — ${vName}`,
        titleLoc: loc('engine.intel.opOutcome', { op: { key: `engine.intelOp.${op.kind}` }, outcome: vName }),
        q: 0.85,
      });
      return;
    }
  }
}

/** Contre-espionnage : chasse aux agents, leurres, intoxications récentes. */
function sweep(state: EngineState, n: NationId): void {
  const st = ist(state);
  const q = quality(state, n, 'interior');
  let caught = 0;
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.host !== n || a.state !== 'active') continue;
    if (roll(state) < detectionChance(state, a, 8)) {
      catchQuietly(state, a);
      caught++;
    }
  }
  const decoys = exposeDecoys(state, n, q);
  reportExposedDecoys(state, n, decoys);
  let downgraded = 0;
  const since = state.time - 72 * HOUR;
  for (const r of nat(state, n).reports) {
    if (!r.fk || r.time < since || roll(state) >= q) continue;
    r.reliability = r.reliability < 'E' ? 'E' : r.reliability;
    r.credibility = r.credibility < 5 ? 5 : r.credibility;
    downgraded++;
  }
  publish(state, n, {
    dept: 'interior',
    source: 'humint',
    kind: 'result',
    title: `${OP_LABEL.counterintel_sweep} — bilan`,
    titleLoc: loc('engine.intel.sweepReport'),
    lines: [
      caught
        ? `${caught} agent(s) étranger(s) démasqué(s).`
        : 'Aucun nouvel agent étranger identifié.',
      decoys.length ? `${decoys.length} leurre(s) identifié(s).` : 'Pas de leurre identifié.',
      downgraded
        ? `${downgraded} rapport(s) récent(s) réévalué(s) à la baisse (cotation).`
        : 'Rapports récents : pas de réévaluation.',
    ],
    at: null,
    radiusKm: 0,
    q: 0.9,
  });
}

/**
 * Intoxication : un faux rapport dans les circuits de la victime. Son contre-espionnage peut la déjouer ;
 * sinon, sa cotation est en moyenne plus basse qu'un vrai rapport (mais pas toujours).
 */
export function plantFake(
  state: EngineState,
  by: NationId,
  victim: NationId,
  at: LngLat | null,
  channel: 'report' | 'radio',
): boolean {
  const guard = channel === 'radio' ? 'military' : 'interior';
  const vq = quality(state, victim, guard);
  if (roll(state) < 0.35 * vq) {
    publish(state, victim, {
      dept: guard,
      source: channel === 'radio' ? 'sigint' : 'humint',
      kind: 'counterintel',
      title: channel === 'radio' ? 'Trafic radio suspect' : "Tentative d'intoxication déjouée",
      titleLoc: loc(channel === 'radio' ? 'engine.intel.radioSuspect' : 'engine.intel.intoxFoiled'),
      lines: [
        channel === 'radio'
          ? 'Trafic radio artificiel repéré (volumes anormaux, indicatifs incohérents). Probable intoxication.'
          : 'Information fabriquée repérée avant diffusion. Origine en cours d’analyse.',
      ],
      at,
      radiusKm: at ? 80 : 0,
      q: vq,
    });
    return false;
  }
  const qf = clamp(
    0.4 + 0.45 * quality(state, by, 'exterior') - 0.35 * vq + 0.1 * (roll(state) - 0.5),
    0.05,
    0.9,
  );
  const w = wi(state.world);
  if (at) {
    // Faux mouvement massif (même gabarit qu'un vrai rapport flash).
    const units = 6 + Math.floor(roll(state) * 20);
    const cats = ['tank', 'ifv', 'artillery', 'infantry'] as const;
    const cat = cats[Math.floor(roll(state) * cats.length)]!;
    publish(state, victim, {
      dept: 'military',
      source: 'sigint',
      kind: 'flash',
      title: `FLASH — Mouvement massif de forces ${natDe(state, by)}`,
      titleLoc: loc('engine.intel.flashMassive', { nation: { nation: by } }),
      lines: [
        `≈ ${units} unités en mouvement ${sectorOf(state, at)}, dont ${CATEGORY_LABEL[cat]}.`,
        channel === 'radio'
          ? 'Trafic radio en forte hausse sur les réseaux de commandement adverses.'
          : 'Colonnes signalées par une source sur place.',
      ],
      at,
      radiusKm: 40 + Math.round(roll(state) * 60),
      subject: { nationId: by },
      actions: [{ kind: 'plan_strike', at }],
      q: qf,
      fake: true,
    });
  } else {
    // Fausses intentions, parfois sous faux drapeau (un voisin de la victime).
    const pool = neighborNations(state, victim).filter((x) => x !== by);
    const actor =
      pool.length && roll(state) < 0.5 ? pool[Math.floor(roll(state) * pool.length)]! : by;
    const cap = w.nationById.get(actor)?.capitalProvinceId;
    const capAt = cap ? (w.provById.get(cap)?.cityPoint ?? null) : null;
    publish(state, victim, {
      dept: 'exterior',
      source: 'humint',
      kind: 'intentions',
      title: `Intentions ${natDe(state, actor)}`,
      titleLoc: loc('engine.intel.intentions', { nation: { nation: actor } }),
      lines: [
        `${natLe(state, actor, true)} ${natAgree(state, actor, 'préparerait', 'prépareraient')} une offensive contre ${natLe(state, victim)} sous 72 heures.`,
        'Mobilisation discrète des réserves signalée par une source proche de l’état-major.',
      ],
      at: capAt,
      radiusKm: capAt ? 150 : 0,
      subject: { nationId: actor },
      q: qf,
      fake: true,
    });
  }
  return true;
}

/** Contenu d'une fuite : vrais secrets de la victime (plans, production, recherche, opérations). */
function leakContent(state: EngineState, victim: NationId): { headline: string; body: string } {
  const le = natLe(state, victim);
  const de = natDe(state, victim);
  const facts: { head: string; line: string }[] = [];
  const plans = board(state).warPlans?.[victim] ?? [];
  if (plans.length) {
    const t = plans.map((x) => natLe(state, x)).join(', ');
    facts.push({
      head: `${le} ${natAgree(state, victim, 'préparait', 'préparaient')} une guerre contre ${t}`,
      line: `Plans d'offensive contre ${t}.`,
    });
  }
  const prod = state.nations[victim]?.production ?? [];
  if (prod.length) {
    const s = state.world.catalog.get(prod[0]!.systemId);
    facts.push({
      head: `le programme d'armement secret ${de}`,
      line: `${prod.length} système(s) d'armes en production, dont ${s?.name ?? prod[0]!.systemId}.`,
    });
  }
  const cur = researchOf(state, victim)?.current?.id;
  if (cur) {
    const nm = state.world.research?.get(cur)?.name ?? cur;
    facts.push({
      head: `${le} ${natAgree(state, victim, 'développe', 'développent')} « ${nm} »`,
      line: `Programme de recherche « ${nm} ».`,
    });
  }
  const ops = nat(state, victim).ops.filter((o) => o.status === 'running' && o.victim);
  if (ops.length) {
    const t = [...new Set(ops.map((o) => natLe(state, o.victim!)))].join(', ');
    facts.push({
      head: `les opérations clandestines ${de}`,
      line: `Opérations clandestines en cours visant ${t}.`,
    });
  }
  if (facts.length === 0)
    facts.push({
      head: `documents internes ${de}`,
      line: 'Correspondance interne embarrassante sur la conduite des affaires militaires.',
    });
  return {
    headline: `Fuite : ${facts[0]!.head}`,
    body: facts.map((f) => f.line).join(' '),
  };
}
