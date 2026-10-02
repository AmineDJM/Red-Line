import type {
  Department,
  IntelReport,
  IntelReportKind,
  IntelSource,
  LngLat,
  NationId,
  ReportAction,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { notify } from '../../state/access.js';
import { cfg, clamp, credibilityOf, reliabilityOf } from './config.js';
import { roll, sharingPartners } from './levels.js';
import { ist, nat, nextId, type StoredReport } from './state.js';
import { header } from './text.js';
import type { LocText } from '@redline/shared';

export interface NewReport {
  dept: Department;
  source: IntelSource;
  kind: IntelReportKind;
  title: string;
  /** Titre localisable (clé `engine.intel.*` du client). */
  titleLoc?: LocText;
  lines: string[];
  at: LngLat | null;
  radiusKm: number;
  subject?: IntelReport['subject'];
  actions?: ReportAction[];
  /** Qualité de l'information 0..1 (détermine la cotation, bruitée). */
  q: number;
  /** Intoxication : la cotation est tirée avec plus de dispersion ; le drapeau reste dans le moteur. */
  fake?: boolean;
  /** Partage automatique aux alliés (charte intelSharing) : oui par défaut sauf résultats d'opération. */
  share?: boolean;
}

/** Cotation bruitée : les rapports truqués ont une dispersion plus forte (parfois bien cotés). */
export function rate(
  state: EngineState,
  q: number,
  fake: boolean,
): Pick<IntelReport, 'reliability' | 'credibility'> {
  const spread = fake ? 0.5 : 0.3;
  const s1 = clamp(q + (roll(state) - 0.5) * spread, 0, 1);
  const s2 = clamp(q + (roll(state) - 0.5) * spread, 0, 1);
  return { reliability: reliabilityOf(s1), credibility: credibilityOf(s2) };
}

function store(state: EngineState, n: NationId, r: StoredReport, flash: boolean): void {
  const ni = nat(state, n);
  ni.reports.push(r);
  const max = cfg(state).maxReports;
  if (ni.reports.length > max) ni.reports.splice(0, ni.reports.length - max);
  if (state.nations[n]?.isPlayer) {
    notify(state, { kind: 'intel_report', time: state.time, reportId: r.id, flash, at: r.at }, [n]);
  }
}

/** Publie un rapport pour une nation (et ses alliés si la charte le prévoit). */
export function publish(state: EngineState, n: NationId, r: NewReport): StoredReport {
  const id = nextId(state, 'r');
  const { reliability, credibility } = rate(state, r.q, !!r.fake);
  const body = [header(id.slice(1), state.time, r.dept, reliability, credibility), ...r.lines].join(
    '\n',
  );
  const actions: ReportAction[] = [...(r.actions ?? [])];
  if (r.at && !actions.some((a) => a.kind === 'send_recon'))
    actions.push({ kind: 'send_recon', at: r.at });
  actions.push({ kind: 'share', reportId: id });
  const rep: StoredReport = {
    id,
    time: state.time,
    dept: r.dept,
    source: r.source,
    kind: r.kind,
    reliability,
    credibility,
    title: r.title,
    body,
    at: r.at,
    radiusKm: Math.round(r.radiusKm),
    actions,
  };
  if (r.subject) rep.subject = r.subject;
  if (r.titleLoc) rep.loc = { title: r.titleLoc };
  if (r.fake) rep.fk = 1;
  store(state, n, rep, r.kind === 'flash');
  const share = r.share ?? (r.kind !== 'result' && r.kind !== 'counterintel');
  if (share) for (const p of sharingPartners(state, n)) copyTo(state, rep, n, p);
  return rep;
}

/** Copie d'un rapport chez un allié (le caractère truqué suit la copie, jamais la vue). */
export function copyTo(
  state: EngineState,
  rep: StoredReport,
  from: NationId,
  to: NationId,
): StoredReport {
  const id = nextId(state, 'r');
  const copy: StoredReport = {
    ...rep,
    id,
    sharedBy: from,
    actions: [
      ...rep.actions.filter((a) => a.kind !== 'share'),
      { kind: 'share', reportId: id } as ReportAction,
    ],
  };
  if (rep.subject) copy.subject = { ...rep.subject };
  store(state, to, copy, rep.kind === 'flash');
  return copy;
}

export function findReport(state: EngineState, n: NationId, id: string): StoredReport | undefined {
  return ist(state).nations[n]?.reports.find((r) => r.id === id);
}
