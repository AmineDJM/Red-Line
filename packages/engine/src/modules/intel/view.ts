import {
  DEPARTMENTS,
  HOUR,
  type AgentView,
  type IntelOpView,
  type IntelReport,
  type IntelView,
  type NationId,
  type PlayerView,
  type ReportAction,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { sortedKeys } from '../../state/access.js';
import { cfg } from './config.js';
import { decoyView } from './contacts.js';
import { capacity, level, researchDone } from './levels.js';
import { filterProvinces } from './provinces.js';
import { ist, type Agent, type StoredOp, type StoredReport } from './state.js';

/**
 * Vue du renseignement d'une nation. Construite champ par champ (liste blanche) : les données internes
 * (intoxication `fk`, victime et agent d'une opération, état réel d'un agent retourné, leurres des
 * autres) ne sortent jamais du moteur. Aucune écriture dans l'état (la vue ne doit rien modifier).
 */
/** Copie d'une action avec un ordre de clés fixe (vue identique avant et après sérialisation). */
function actionView(a: ReportAction): ReportAction {
  switch (a.kind) {
    case 'plan_strike':
    case 'send_recon': {
      const out: ReportAction = { kind: a.kind, at: [a.at[0], a.at[1]] } as ReportAction;
      if (a.kind === 'plan_strike' && a.unitId) (out as { unitId?: string }).unitId = a.unitId;
      return out;
    }
    case 'share':
      return { kind: 'share', reportId: a.reportId };
    case 'open_unit':
      return { kind: 'open_unit', unitId: a.unitId };
    case 'open_province':
      return { kind: 'open_province', provinceId: a.provinceId };
  }
}

export function reportView(state: EngineState, r: StoredReport): IntelReport {
  const c = cfg(state);
  const ageH = Math.max(0, (state.time - r.time) / HOUR);
  // Position des forces : l'incertitude croît avec l'âge (par heure entière : vue stable).
  const moving = r.kind === 'flash' || !!r.subject?.unitIds?.length;
  const out: IntelReport = {
    id: r.id,
    time: r.time,
    dept: r.dept,
    source: r.source,
    kind: r.kind,
    reliability: r.reliability,
    credibility: r.credibility,
    title: r.title,
    body: r.body,
    at: r.at ? [r.at[0], r.at[1]] : null,
    radiusKm:
      r.at && moving
        ? Math.round(r.radiusKm + Math.floor(ageH) * c.reportUncertaintyKmh)
        : r.radiusKm,
    actions: r.actions.map(actionView),
  };
  if (r.subject) {
    const s: NonNullable<IntelReport['subject']> = {};
    if (r.subject.nationId) s.nationId = r.subject.nationId;
    if (r.subject.unitIds?.length) s.unitIds = [...r.subject.unitIds];
    if (r.subject.systemIds?.length) s.systemIds = [...r.subject.systemIds];
    if (r.subject.provinceId) s.provinceId = r.subject.provinceId;
    out.subject = s;
  }
  if (r.sharedBy) out.sharedBy = r.sharedBy;
  if (ageH > c.staleAfterH) out.stale = true;
  return out;
}

function opView(o: StoredOp): IntelOpView {
  const target: IntelOpView['target'] = {};
  if (o.target.nationId) target.nationId = o.target.nationId;
  if (o.target.provinceId) target.provinceId = o.target.provinceId;
  if (o.target.unitId) target.unitId = o.target.unitId;
  if (o.target.at) target.at = [o.target.at[0], o.target.at[1]];
  if (o.target.radiusKm !== undefined) target.radiusKm = o.target.radiusKm;
  const out: IntelOpView = {
    id: o.id,
    kind: o.kind,
    dept: o.dept,
    target,
    startedAt: o.startedAt,
    completesAt: o.completesAt,
    status: o.status,
    estimate: o.estimate,
  };
  if (o.rn) out.recon = { waves: o.rn.n, done: o.rn.w, ok: o.rn.ok, provinces: o.rn.pids.length };
  return out;
}

/** Ce que le propriétaire sait de son agent : un agent démasqué ou retourné reste « actif » à ses yeux. */
function ownerStatus(a: Agent): AgentView['status'] {
  switch (a.state) {
    case 'captured':
      return 'captured';
    case 'exfiltrated':
      return 'exfiltrated';
    case 'active':
      return a.burned ? 'burned' : 'active';
    default:
      return a.burned ? 'burned' : 'active';
  }
}

export function intelView(state: EngineState, n: NationId, view: PlayerView): void {
  const st = ist(state);
  const ni = st?.nations[n];
  if (!st || !ni) return;
  const c = cfg(state);
  const done = researchDone(state, n);
  const departments = DEPARTMENTS.map((id) => {
    const lvl = level(state, n, id, done);
    return {
      id,
      level: lvl,
      budgetPerDay: ni.budget[id],
      capacity: capacity(state, n, id, lvl),
      running: ni.ops.filter((o) => o.status === 'running' && o.dept === id).length,
    };
  });
  const reports = ni.reports
    .slice(-c.viewReports)
    .reverse()
    .map((r) => reportView(state, r));
  const agents: AgentView[] = [];
  const caughtAgents: IntelView['caughtAgents'] = [];
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.owner === n) {
      agents.push({
        id: a.id,
        codename: a.codename,
        nationId: a.host,
        status: ownerStatus(a),
        since: a.since,
        kind: a.kind,
      });
    } else if (a.host === n && a.caughtAt !== undefined && a.state !== 'exfiltrated') {
      caughtAgents.push({
        id: a.id,
        nationId: a.owner,
        caughtAt: a.caughtAt,
        turned: a.state === 'double',
      });
    }
  }
  view.intel = {
    departments,
    reports,
    operations: ni.ops.map(opView),
    agents,
    caughtAgents,
  };
  filterProvinces(state, n, view);
  for (const id of sortedKeys(st.decoys)) {
    const v = decoyView(state, st.decoys[id]!, n);
    if (v && !view.units[v.id]) view.units[v.id] = v;
  }
}
