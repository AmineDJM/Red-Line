import type {
  AgentView,
  DecisionEffects,
  DetaineeKind,
  DetaineeOption,
  DetaineeView,
  IntelView,
  NationId,
  SwapView,
} from '@redline/shared';

/**
 * Logique pure de l'onglet « Détenus » de la console de renseignement : lignes de conséquences
 * affichées avant confirmation, gravité du risque de représailles, nos agents détenus à l'étranger,
 * valeur d'échange et propositions en attente. Testée sans navigateur.
 */

export type FxTone = 'red' | 'amber' | 'green' | 'cyan' | 'neutral';

/** Une ligne de conséquence : clé de libellé, valeur affichable, ton. */
export interface FxLine {
  key:
    | 'relations'
    | 'reputation'
    | 'stability'
    | 'retaliation'
    | 'serviceHit'
    | 'worldRelations'
    | 'council'
    | 'chance'
    | 'pressure'
    | 'immunity'
    | 'hours';
  value: number;
  tone: FxTone;
  /** Affichage : variation signée, pourcentage, durée, simple drapeau. */
  format: 'signed' | 'pct' | 'hours' | 'flag' | 'perDay';
  days?: number;
}

/** Gravité d'un risque (0..1) : nul, faible, modéré, élevé. */
export function riskGrade(p: number): 'none' | 'low' | 'moderate' | 'high' {
  if (p <= 0) return 'none';
  if (p < 0.25) return 'low';
  if (p < 0.55) return 'moderate';
  return 'high';
}

const signedTone = (v: number): FxTone => (v > 0 ? 'green' : v < 0 ? 'red' : 'neutral');

/** Conséquences d'une décision, dans l'ordre d'affichage (lignes nulles omises). */
export function effectLines(e: DecisionEffects): FxLine[] {
  const out: FxLine[] = [];
  if (e.chance !== undefined)
    out.push({
      key: 'chance',
      value: e.chance,
      format: 'pct',
      tone: e.chance >= 0.5 ? 'green' : 'amber',
    });
  if (e.hours) out.push({ key: 'hours', value: e.hours, format: 'hours', tone: 'neutral' });
  if (e.relations)
    out.push({
      key: 'relations',
      value: e.relations,
      format: 'signed',
      tone: signedTone(e.relations),
    });
  if (e.reputation)
    out.push({
      key: 'reputation',
      value: e.reputation,
      format: 'signed',
      tone: signedTone(e.reputation),
    });
  if (e.stability)
    out.push({
      key: 'stability',
      value: e.stability,
      format: 'signed',
      tone: signedTone(e.stability),
    });
  if (e.worldRelations)
    out.push({
      key: 'worldRelations',
      value: e.worldRelations,
      format: 'signed',
      tone: signedTone(e.worldRelations),
    });
  if (e.retaliation > 0) {
    const g = riskGrade(e.retaliation);
    out.push({
      key: 'retaliation',
      value: e.retaliation,
      format: 'pct',
      tone: g === 'high' ? 'red' : g === 'moderate' ? 'amber' : 'cyan',
    });
  }
  if (e.serviceHit > 0)
    out.push({
      key: 'serviceHit',
      value: e.serviceHit,
      format: 'pct',
      tone: 'green',
      ...(e.serviceDays ? { days: e.serviceDays } : {}),
    });
  if (e.council) out.push({ key: 'council', value: e.council, format: 'pct', tone: 'red' });
  if (e.pressurePerDay)
    out.push({ key: 'pressure', value: -e.pressurePerDay, format: 'perDay', tone: 'amber' });
  if (e.immunity) out.push({ key: 'immunity', value: 1, format: 'flag', tone: 'red' });
  return out;
}

/** Détenus encore entre nos mains (décision possible). */
export function liveDetainees(intel: IntelView | null | undefined): DetaineeView[] {
  return (intel?.detainees ?? []).filter(
    (d) => d.status === 'pending' || d.status === 'held' || d.status === 'jailed',
  );
}

/** Nos agents détenus à l'étranger (en cours, puis sorts connus récents). */
export function agentsAbroad(intel: IntelView | null | undefined): AgentView[] {
  const order = (a: AgentView) =>
    a.detention && ['held', 'interrogation', 'jailed'].includes(a.detention.fate) ? 0 : 1;
  return (intel?.agents ?? [])
    .filter((a) => !!a.detention)
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        (b.detention!.since ?? 0) - (a.detention!.since ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
}

/** Notre agent est encore détenu (négociable). */
export function stillHeld(a: AgentView): boolean {
  return !!a.detention && ['held', 'interrogation', 'jailed'].includes(a.detention.fate);
}

/** Propositions reçues en attente de notre réponse. */
export function incomingSwaps(intel: IntelView | null | undefined, me: NationId): SwapView[] {
  return (intel?.swaps ?? []).filter((s) => s.status === 'open' && s.to === me);
}

/** Décisions à prendre (pastille de l'onglet) : détenus en attente + propositions reçues. */
export function detaineeAlerts(intel: IntelView | null | undefined, me: NationId): number {
  return (
    (intel?.detainees ?? []).filter((d) => d.status === 'pending').length +
    incomingSwaps(intel, me).length
  );
}

/**
 * Options regroupées par action (l'emprisonnement a une option par durée) : la première option de
 * chaque action, et la liste des durées proposées.
 */
export function groupOptions(
  options: DetaineeOption[],
): { action: DetaineeOption['action']; options: DetaineeOption[] }[] {
  const out: { action: DetaineeOption['action']; options: DetaineeOption[] }[] = [];
  for (const o of options) {
    const g = out.find((x) => x.action === o.action);
    if (g) g.options.push(o);
    else out.push({ action: o.action, options: [o] });
  }
  return out;
}

/** Valeur d'échange estimée d'un de nos agents (même barème que le moteur, accès compris). */
export function agentValueOf(
  a: Pick<AgentView, 'kind' | 'cover' | 'access'>,
  table: Partial<Record<DetaineeKind, number>> | undefined,
  accessValue = 0.5,
): number {
  const kind: DetaineeKind =
    a.kind === 'source' ? 'source' : a.cover === 'nonofficial' ? 'illegal' : 'diplomat';
  const ac = a.access === 'staff' ? 2 : a.access === 'ministry' ? 1 : 0;
  const v = (table?.[kind] ?? { diplomat: 3, illegal: 4, source: 1.5, double: 1 }[kind]) as number;
  return Math.round(v * (1 + accessValue * ac) * 10) / 10;
}
