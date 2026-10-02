import {
  AGENT_ACCESS,
  DAY,
  HOUR,
  loc,
  type AgentDetentionView,
  type DecisionBlock,
  type DecisionEffects,
  type DetaineeAction,
  type DetaineeKind,
  type DetaineeOption,
  type DetaineeStatus,
  type DetaineeView,
  type IntelOpKind,
  type LngLat,
  type NationId,
  type Regime,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, notify, sortedKeys } from '../../state/access.js';
import { noteLoc } from '../../state/loc.js';
import { wi } from '../../state/world.js';
import { board, scheduleMod } from '../kit.js';
import { signal } from '../registry.js';
import { addReputation, addStability, isRegular, pairKey } from '../diplo/state.js';
import { autoResolution } from '../diplo/council.js';
import { clamp } from './config.js';
import { dzcfg, regimeOf, type ActionKey } from './dzconfig.js';
import { hash01, quality, roll } from './levels.js';
import { publish } from './reports.js';
import { catchQuietly, publicArrest } from './agents.js';
import { coverOf, ev, expulsionNote } from './deep.js';
import { ist, nat, type Agent, type Detention } from './state.js';
import { nationName, natDe, natLe } from './text.js';

/**
 * Détenus : un agent étranger arrêté publiquement par notre contre-espionnage devient un détenu (type,
 * pays d'origine, opération en cours, ce qu'il savait). Le pays geôlier décide dans un délai
 * raisonnable (à défaut : détention provisoire) : interroger, expulser (couverture diplomatique) ou
 * renvoyer, emprisonner pour une durée, exécuter (selon le régime et la guerre), retourner, libérer.
 * Chaque décision a des conséquences chiffrées (data/balance, intel.detainees) : relations bilatérales,
 * réputation, stabilité, représailles, affaiblissement du service adverse. Les IA décident selon leur
 * régime et leur relation ; elles se souviennent (représailles, dissuasion) et négocient (swaps.ts).
 *
 * Secrets : le retournement réussi ressemble, vu du propriétaire, à une libération (mêmes effets
 * visibles, même notification) ; le type « agent double » n'est jamais montré au propriétaire.
 */

export const LIVE: ReadonlySet<DetaineeStatus> = new Set(['pending', 'held', 'jailed']);

export function isLive(a: Agent): boolean {
  return !!a.dn && LIVE.has(a.dn.s);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function hasDiplo(state: EngineState): boolean {
  return !!state.mods.diplo;
}

/** Nation régulière vivante (hors rebelles, casques bleus). */
function regular(state: EngineState, n: NationId): boolean {
  return !!state.nations[n]?.alive && (!hasDiplo(state) || isRegular(state, n));
}

// ——— Relations bilatérales ———

/** Relations bilatérales (−100..100, 0 par défaut). */
export function tie(state: EngineState, a: NationId, b: NationId): number {
  return ist(state).rel?.[pairKey(a, b)] ?? 0;
}

/** Variation des relations ; `floor` : une pression ne descend pas en dessous de ce plancher. */
export function addTie(
  state: EngineState,
  a: NationId,
  b: NationId,
  delta: number,
  floor = -100,
): void {
  if (a === b || delta === 0) return;
  const st = ist(state);
  const rel = (st.rel ??= {});
  const k = pairKey(a, b);
  const cur = rel[k] ?? 0;
  let v = cur + delta;
  if (delta < 0 && cur > floor) v = Math.max(v, floor);
  else if (delta < 0) return;
  v = round1(clamp(v, -100, 100));
  if (v === 0) delete rel[k];
  else rel[k] = v;
}

/** Retour quotidien des relations vers 0. */
function decayTies(state: EngineState): void {
  const rel = ist(state).rel;
  if (!rel) return;
  const d = dzcfg(state).relationsDecayPerDay;
  for (const k of sortedKeys(rel)) {
    const v = rel[k]!;
    const nv = round1(Math.abs(v) <= d ? 0 : v - Math.sign(v) * d);
    if (nv === 0) delete rel[k];
    else rel[k] = nv;
  }
}

// ——— Type, valeur ———

/** Type d'un détenu d'après l'agent (vérité du moteur). */
export function detaineeKind(a: Agent): DetaineeKind {
  if (a.state === 'double') return 'double';
  if (a.kind === 'source') return 'source';
  return (coverOf(a) ?? 'diplomatic') === 'diplomatic' ? 'diplomat' : 'illegal';
}

/** Type tel que le propriétaire le connaît (il ignore qu'un de ses agents était retourné). */
export function ownerKind(a: Agent): DetaineeKind {
  if (a.kind === 'source') return 'source';
  return (coverOf(a) ?? 'diplomatic') === 'diplomatic' ? 'diplomat' : 'illegal';
}

/**
 * Valeur d'échange d'un agent pour `viewer` : type (officier > source) et accès, connu du
 * propriétaire, ou du geôlier après interrogatoire.
 */
export function agentValue(state: EngineState, a: Agent, viewer: NationId): number {
  const c = dzcfg(state);
  const own = viewer === a.owner;
  const k = own ? ownerKind(a) : (a.dn?.k ?? detaineeKind(a));
  const ac = own || a.dn?.iv ? (a.ac ?? 0) : 0;
  return round1((c.value[k] ?? 1) * (1 + c.accessValue * ac));
}

function ref(a: Agent): string {
  return `D-${a.id.replace(/^a/, '')}`;
}

function capitalPoint(state: EngineState, n: NationId): LngLat | null {
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  const p = cap ? w.provById.get(cap)?.cityPoint : undefined;
  return p ? [p[0], p[1]] : null;
}

function isPlayer(state: EngineState, n: NationId): boolean {
  return !!state.nations[n]?.isPlayer;
}

/** Notification « détenus » (fenêtre de renseignement, onglet Détenus) à une nation joueuse. */
function note(
  state: EngineState,
  to: NationId,
  id: string,
  title: string,
  text: string,
  params: Parameters<typeof noteLoc>[1],
  severity: 'info' | 'warn' | 'critical' = 'warn',
  at: LngLat | null = null,
): void {
  if (!isPlayer(state, to)) return;
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at,
      category: 'detainee',
      title,
      text,
      severity,
      loc: noteLoc(id, params),
    },
    [to],
  );
}

// ——— Arrestation publique → détenu ———

/** Arrestation publique : l'agent devient un détenu, décision attendue (IA : immédiate). */
export function createDetention(
  state: EngineState,
  a: Agent,
  op?: IntelOpKind,
  k: DetaineeKind = detaineeKind(a),
): void {
  const c = dzcfg(state);
  const dn: Detention = {
    k,
    s: 'pending',
    at: state.time,
    by: state.time + c.decisionDays * DAY,
  };
  if (op) dn.op = op;
  a.dn = dn;
  scheduleMod(state, { t: dn.by, m: 'intel', e: 'dz_due', d: { id: a.id, t: dn.by } });
  note(
    state,
    a.host,
    'detaineeNew',
    'Agent étranger détenu',
    `Un agent ${natDe(state, a.owner)} est entre nos mains : décision attendue.`,
    { owner: { nation: a.owner }, days: c.decisionDays },
    'warn',
    capitalPoint(state, a.host),
  );
  if (!isPlayer(state, a.host)) aiDecide(state, a);
}

// ——— Conséquences ———

function actionKey(a: Agent, action: DetaineeAction): ActionKey {
  if (action === 'expel')
    return a.dn?.k === 'diplomat' || detaineeKind(a) === 'diplomat' ? 'expel' : 'return';
  return action;
}

/** Exécution permise par le régime du geôlier (et la guerre) ; sinon la raison. */
export function executionBlock(
  state: EngineState,
  host: NationId,
  owner: NationId,
): DecisionBlock | null {
  const r = dzcfg(state).regimes[regimeOf(state, host)];
  if (r.execute === 'never') return 'never';
  if (r.execute === 'war' && !atWar(state, host, owner)) return 'war_only';
  return null;
}

/**
 * Conséquences chiffrées d'une décision et sa faisabilité. La même fonction sert à l'aperçu (vue)
 * et à l'application : ce qui est affiché avant de confirmer est exactement ce qui s'applique.
 */
export function assess(
  state: EngineState,
  a: Agent,
  action: DetaineeAction,
  days?: number,
): { allowed: boolean; reason?: DecisionBlock; effects: DecisionEffects } {
  const c = dzcfg(state);
  const host = a.host;
  const owner = a.owner;
  const k = a.dn?.k ?? detaineeKind(a);
  const war = atWar(state, host, owner);
  const rh = regimeOf(state, host);
  const ro = regimeOf(state, owner);
  const key = actionKey(a, action);
  const base = c.actions[key];
  const kr = c.kindRelations[k] ?? 1;
  let rel = base.relations * kr;
  let rep = base.reputation;
  let stab = base.stability;
  const effects: DecisionEffects = {
    relations: 0,
    reputation: 0,
    stability: 0,
    retaliation: 0,
    serviceHit: base.serviceHit,
  };
  if (base.serviceDays > 0 && base.serviceHit > 0) effects.serviceDays = base.serviceDays;
  const sentence = action === 'jail' ? sentenceOf(state, days) : 0;
  if (action === 'jail') rel += c.jailPerYear * (sentence / 365) * kr;
  if (k === 'diplomat' && (action === 'jail' || action === 'execute' || action === 'interrogate')) {
    effects.immunity = true;
    rel += c.immunityRelations;
    rep += c.immunityReputation;
  }
  if (action === 'execute') {
    const R = c.regimes[rh];
    rep += R.reputation;
    stab += R.stability;
    let world = R.worldRelations;
    if (!war) {
      rel *= c.peaceFactor;
      rep *= c.peaceFactor;
      world *= c.peaceFactor;
    }
    if (world) effects.worldRelations = round1(world);
    if (R.council > 0) effects.council = round2(R.council);
  }
  if (base.retaliation > 0)
    effects.retaliation = round2(
      clamp(
        base.retaliation *
          c.regimes[ro].retaliation *
          (1 + Math.max(0, -tie(state, host, owner)) / 100),
        0,
        0.95,
      ),
    );
  effects.relations = round1(rel);
  effects.reputation = round1(rep);
  effects.stability = round1(stab);
  const q = quality(state, host, 'interior');
  if (action === 'interrogate') {
    effects.chance = round2(clamp((c.interrogateYield[k] ?? 0) * (0.5 + q), 0.05, 0.95));
    effects.hours = c.interrogateHours;
  }
  if (action === 'turn') effects.chance = round2(clamp((c.turnChance[k] ?? 0) * (0.5 + q), 0, 0.9));
  if (action === 'jail' || action === 'interrogate') effects.pressurePerDay = c.pressurePerDay;

  // Faisabilité.
  const block = ((): DecisionBlock | null => {
    if (action === 'arrest')
      return (a.state === 'caught' || a.state === 'double') && !isLive(a) ? null : 'final';
    if (!isLive(a)) return 'final';
    if (a.dn!.iq !== undefined && a.dn!.iq > state.time) return 'interrogating';
    if (action === 'interrogate' && a.dn!.iv) return 'done';
    if (action === 'turn') {
      if (k === 'double' || (c.turnChance[k] ?? 0) <= 0) return 'not_plausible';
      if (a.dn!.tf) return 'done';
    }
    if (action === 'execute') return executionBlock(state, host, owner);
    return null;
  })();
  return block ? { allowed: false, reason: block, effects } : { allowed: true, effects };
}

/** Durée de peine : une des durées proposées (défaut : la médiane), bornée. */
function sentenceOf(state: EngineState, days?: number): number {
  const opts = dzcfg(state).sentenceDays;
  const def = opts[Math.floor(opts.length / 2)] ?? 90;
  const max = Math.max(...opts, 1);
  return Math.round(clamp(days ?? def, 1, max));
}

/** Applique les conséquences d'une décision (relations, réputation, stabilité, monde, Conseil…). */
function applyEffects(
  state: EngineState,
  a: Agent,
  action: DetaineeAction,
  e: DecisionEffects,
): void {
  const host = a.host;
  const owner = a.owner;
  addTie(state, host, owner, e.relations);
  if (hasDiplo(state)) {
    if (e.reputation) addReputation(state, host, e.reputation);
    if (e.stability) addStability(state, host, e.stability, "Affaire d'espionnage");
  }
  if (e.worldRelations) {
    for (const d of state.nationIds) {
      if (d === host || d === owner || !regular(state, d)) continue;
      if (regimeOf(state, d) === 'democracy') addTie(state, host, d, e.worldRelations);
    }
  }
  if (e.council && hasDiplo(state) && roll(state) < e.council)
    autoResolution(
      state,
      'condemnation',
      host,
      owner,
      `Condamnation de l'exécution d'un agent ${natDe(state, owner)} par ${natLe(state, host)}.`,
    );
  if (e.serviceHit > 0) {
    const sh = (nat(state, owner).sh ??= {});
    const cur = sh[host];
    const live = cur && cur.u > state.time;
    sh[host] = {
      f: round2(Math.max(live ? cur.f : 0, e.serviceHit)),
      u: Math.max(live ? cur.u : 0, state.time + (e.serviceDays ?? 0) * DAY),
    };
  }
  // Représailles : mémoire du pays d'origine (IA), résolue à sa prochaine journée.
  if (e.retaliation > 0 && !isPlayer(state, owner) && state.nations[owner]?.alive) {
    const k = action === 'execute' ? 'execute' : action === 'jail' ? 'jail' : 'expel';
    const rank = { expel: 0, jail: 1, execute: 2 } as const;
    const gr = (ist(state).gr ??= {});
    const key = `${owner}>${host}`;
    const cur = gr[key];
    gr[key] = {
      k: cur && rank[cur.k] > rank[k] ? cur.k : k,
      p: round2(Math.max(cur?.p ?? 0, e.retaliation)),
      t: state.time,
    };
  }
}

/** Affaiblissement en cours du service de `n` contre `x` (0..1). */
export function serviceHit(state: EngineState, n: NationId, x: NationId): number {
  const sh = ist(state).nations[n]?.sh?.[x];
  return sh && sh.u > state.time ? sh.f : 0;
}

// ——— Décisions ———

function fail(error: NonNullable<OrderResult['error']>, message: string): OrderResult {
  return { ok: false, error, message };
}

const BLOCK_MSG: Record<DecisionBlock, string> = {
  war_only: 'Exécution impossible en temps de paix pour ce régime.',
  never: 'La peine capitale est abolie.',
  interrogating: 'Interrogatoire en cours.',
  done: 'Déjà fait.',
  not_plausible: 'Retournement impossible pour ce détenu.',
  final: 'Détenu introuvable ou déjà libéré.',
};

/** Ordre `detainee` : décision du pays hôte sur un agent étranger. */
export function decide(
  state: EngineState,
  host: NationId,
  id: string,
  action: DetaineeAction,
  days?: number,
): OrderResult {
  if (!state.nations[host]?.alive) return fail('not_allowed', 'Nation vaincue.');
  const a = ist(state).agents[id];
  if (!a || a.host !== host || (action !== 'arrest' && !a.dn))
    return fail('invalid_target', 'Détenu introuvable.');
  const r = assess(state, a, action, days);
  if (!r.allowed) return fail('not_allowed', BLOCK_MSG[r.reason ?? 'final']);
  const c = dzcfg(state);
  const e = r.effects;
  const owner = a.owner;
  const dn = a.dn!;
  switch (action) {
    case 'arrest':
      applyEffects(state, a, action, e);
      publicArrest(state, a);
      return { ok: true };
    case 'interrogate': {
      applyEffects(state, a, action, e);
      dn.iq = state.time + c.interrogateHours * HOUR;
      scheduleMod(state, { t: dn.iq, m: 'intel', e: 'dz_iq', d: { id: a.id, t: dn.iq } });
      note(
        state,
        owner,
        'spyInterrogated',
        'Agent interrogé',
        `${a.codename} est interrogé par les services ${natDe(state, host)}.`,
        { codename: a.codename, host: { nation: host } },
        'warn',
      );
      return { ok: true };
    }
    case 'expel': {
      applyEffects(state, a, action, e);
      end(state, a, dn.k === 'diplomat' ? 'expelled' : 'returned');
      if (dn.k === 'diplomat') {
        a.ex = 1;
        expulsionNote(state, a, capitalPoint(state, host));
      } else
        note(
          state,
          owner,
          'spyReturned',
          'Agent renvoyé',
          `${a.codename} a été renvoyé dans son pays par ${natLe(state, host)}.`,
          { codename: a.codename, host: { nation: host } },
          'info',
        );
      return { ok: true };
    }
    case 'jail': {
      applyEffects(state, a, action, e);
      const d = sentenceOf(state, days);
      dn.s = 'jailed';
      dn.days = d;
      dn.until = state.time + d * DAY;
      scheduleMod(state, { t: dn.until, m: 'intel', e: 'dz_end', d: { id: a.id, t: dn.until } });
      note(
        state,
        owner,
        'spyJailed',
        'Agent condamné',
        `${a.codename} condamné à ${d} jours de prison par ${natLe(state, host)}.`,
        { codename: a.codename, host: { nation: host }, days: d },
        'warn',
      );
      return { ok: true };
    }
    case 'execute': {
      applyEffects(state, a, action, e);
      end(state, a, 'executed');
      note(
        state,
        owner,
        'spyExecuted',
        'Agent exécuté',
        `${a.codename} a été exécuté par ${natLe(state, host)}.`,
        { codename: a.codename, host: { nation: host } },
        'critical',
      );
      signal(state, 'news', {
        category: 'event',
        headline: `${nationName(state, host)} : un agent ${natDe(state, owner)} exécuté`,
        body: `${natLe(state, host, true)} annonce l'exécution d'un agent ${natDe(state, owner)} condamné pour espionnage. Réprobation internationale.`,
        at: capitalPoint(state, host),
        nations: [host, owner],
        loc: {
          headline: loc('engine.spyNews.executedH', {
            host: { nation: host },
            owner: { nation: owner },
          }),
          body: loc('engine.spyNews.executedB', {
            host: { nation: host },
            owner: { nation: owner },
          }),
        },
      });
      return { ok: true };
    }
    case 'turn': {
      const ok = roll(state) < (e.chance ?? 0);
      if (!ok) {
        dn.tf = 1;
        publish(state, host, {
          dept: 'interior',
          source: 'humint',
          kind: 'counterintel',
          title: `Retournement refusé — détenu ${ref(a)}`,
          titleLoc: loc('engine.intel.turnRefused', { ref: ref(a) }),
          lines: [
            `Le détenu ${ref(a)} (${nationName(state, owner)}) refuse toute coopération.`,
            'Il reste en détention ; une autre décision est attendue.',
          ],
          at: null,
          radiusKm: 0,
          subject: { nationId: owner },
          q: 0.9,
          share: false,
        });
        return { ok: true };
      }
      // Vu du propriétaire : une libération (mêmes effets visibles, même notification).
      applyEffects(state, a, action, e);
      end(state, a, 'turned');
      a.state = 'double';
      a.turnedAt = state.time;
      freeInPlace(state, a);
      publish(state, host, {
        dept: 'interior',
        source: 'humint',
        kind: 'counterintel',
        title: `Détenu ${ref(a)} retourné`,
        titleLoc: loc('engine.intel.detaineeTurned', { ref: ref(a) }),
        lines: [
          `Le détenu ${ref(a)} accepte de travailler pour nous ; il est relâché « faute de preuves ».`,
          `Ses rapports ${natA2(state, owner)} sont désormais sous notre contrôle.`,
        ],
        at: null,
        radiusKm: 0,
        subject: { nationId: owner },
        q: 0.9,
        share: false,
      });
      releasedNote(state, a);
      return { ok: true };
    }
    case 'release': {
      applyEffects(state, a, action, e);
      end(state, a, 'released');
      a.state = dn.k === 'double' ? 'double' : 'active';
      freeInPlace(state, a);
      releasedNote(state, a);
      return { ok: true };
    }
  }
}

function natA2(state: EngineState, n: NationId): string {
  return `vers ${nationName(state, n)}`;
}

/** Relâché sur place : son service le croit de nouveau actif (fiabilité perçue en baisse). */
function freeInPlace(state: EngineState, a: Agent): void {
  a.burned = false;
  a.rl = Math.min(a.rl ?? 0.5, 0.35);
}

function releasedNote(state: EngineState, a: Agent): void {
  note(
    state,
    a.owner,
    'spyReleased',
    'Agent libéré',
    `${natLe(state, a.host, true)} a libéré ${a.codename}.`,
    { codename: a.codename, host: { nation: a.host } },
    'info',
  );
}

/** Fin de détention. */
function end(state: EngineState, a: Agent, s: DetaineeStatus): void {
  const dn = a.dn!;
  dn.s = s;
  dn.end = state.time;
  delete dn.iq;
}

/** Libération par échange : l'agent rentre chez lui. */
export function exchanged(state: EngineState, a: Agent): void {
  end(state, a, 'exchanged');
  a.state = 'captured';
}

// ——— Événements ———

/** Échéance de la décision : détention provisoire. */
export function onDue(state: EngineState, id: string, t: number): void {
  const a = ist(state).agents[id];
  if (!a?.dn || a.dn.s !== 'pending' || a.dn.by !== t) return;
  a.dn.s = 'held';
  note(
    state,
    a.host,
    'detaineeHeld',
    'Détention provisoire',
    `Sans décision, l'agent ${natDe(state, a.owner)} est placé en détention provisoire.`,
    { owner: { nation: a.owner } },
    'info',
  );
}

/** Fin de peine : l'agent est libéré et rentre chez lui. */
export function onSentenceEnd(state: EngineState, id: string, t: number): void {
  const a = ist(state).agents[id];
  if (!a?.dn || a.dn.s !== 'jailed' || a.dn.until !== t) return;
  end(state, a, 'served');
  note(
    state,
    a.owner,
    'spyServed',
    'Fin de peine',
    `${a.codename} a purgé sa peine ${natA3(state, a.host)} et regagne le pays.`,
    { codename: a.codename, host: { nation: a.host } },
    'info',
  );
}

function natA3(state: EngineState, n: NationId): string {
  return `(${nationName(state, n)})`;
}

/** Fin d'interrogatoire : aveux (réseau, opérations, intentions), parfois intoxication. */
export function onInterrogationEnd(state: EngineState, id: string, t: number): void {
  const a = ist(state).agents[id];
  const dn = a?.dn;
  if (!a || !dn || dn.iq !== t) return;
  delete dn.iq;
  dn.iv = 1;
  const c = dzcfg(state);
  const host = a.host;
  const owner = a.owner;
  const st = ist(state);
  const chance = assess(state, a, 'interrogate').effects.chance ?? 0;
  const lines: string[] = [];
  let fake = false;
  let q = 0.75;
  if (roll(state) < chance) {
    if (roll(state) < (c.interrogateFalse[dn.k] ?? 0)) {
      // Intoxication : de fausses intentions, plausibles, et aucun réseau.
      fake = true;
      q = 0.6;
      const others = state.nationIds.filter(
        (y) => y !== owner && y !== host && state.nations[y]?.alive,
      );
      const decoy = others.length
        ? others[Math.floor(hash01('dz', a.id, state.time) * others.length)]!
        : host;
      const e = ev(state, host, owner);
      e.pl = { t: state.time, v: [decoy], s: 'humint', q: 0.5, fk: 1 };
      dn.rv = [0, 0];
      lines.push(
        `Aveux : ${natLe(state, owner)} préparerait une opération contre ${natLe(state, decoy)}.`,
        'Le détenu affirme agir seul : aucun autre membre du réseau cité.',
      );
    } else {
      const net = sortedKeys(st.agents)
        .map((k) => st.agents[k]!)
        .filter(
          (x) => x.id !== a.id && x.owner === owner && x.host === host && x.state === 'active',
        )
        .slice(0, c.revealAgents);
      for (const x of net) catchQuietly(state, x);
      let ops = 0;
      for (const o of nat(state, owner).ops)
        if (o.status === 'running' && o.victim === host && !o.dt) {
          o.dt = 1;
          ops++;
        }
      dn.rv = [net.length, ops];
      lines.push(
        `Aveux exploitables : ${net.length} autre(s) agent(s) du réseau ${natDe(state, owner)} identifié(s) et placé(s) sous surveillance.`,
        ops
          ? `${ops} opération(s) ${natDe(state, owner)} en préparation contre nous éventée(s).`
          : 'Aucune opération en préparation contre nous signalée.',
        `Accès du détenu : ${['rue', 'ministère', 'état-major'][a.ac ?? 0]}.`,
      );
      if (dn.k !== 'source') {
        const plans = (board(state).warPlans?.[owner] ?? []).slice().sort();
        const e = ev(state, host, owner);
        e.pl = { t: state.time, v: plans, s: 'humint', q: 0.6 };
        lines.push(
          plans.length
            ? `Intentions : préparatifs ${natDe(state, owner)} contre ${plans.map((y) => natLe(state, y)).join(', ')}.`
            : `Intentions : aucun préparatif offensif ${natDe(state, owner)} connu du détenu.`,
        );
      }
    }
  } else {
    dn.rv = [0, 0];
    lines.push("Le détenu n'a rien révélé d'exploitable : silence et déclarations invérifiables.");
  }
  publish(state, host, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: `Interrogatoire — détenu ${ref(a)} (${nationName(state, owner)})`,
    titleLoc: loc('engine.intel.interrogation', { ref: ref(a), nation: { nation: owner } }),
    lines,
    at: null,
    radiusKm: 0,
    subject: { nationId: owner },
    q,
    ...(fake ? { fake: true } : {}),
    share: false,
  });
  if (!isPlayer(state, host)) aiDecide(state, a);
}

// ——— IA : décision du geôlier ———

/**
 * Décision d'une IA sur un détenu : interrogatoire d'abord (sauf diplomate), retournement d'une source,
 * exécution si le régime s'y prête et la relation est hostile, expulsion des diplomates, renvoi en
 * bonnes relations, sinon prison (plus longue en guerre ou en mauvaises relations).
 */
export function aiDecide(state: EngineState, a: Agent): void {
  const dn = a.dn;
  if (!dn || !LIVE.has(dn.s) || dn.s === 'jailed') return;
  if (dn.iq !== undefined && dn.iq > state.time) return;
  const c = dzcfg(state);
  const host = a.host;
  const owner = a.owner;
  const war = atWar(state, host, owner);
  const rel = tie(state, host, owner);
  const rh = regimeOf(state, host);
  const go = (action: DetaineeAction, days?: number) => decide(state, host, a.id, action, days).ok;
  if (!dn.iv && dn.k !== 'diplomat' && go('interrogate')) return;
  if (dn.k === 'source' && !dn.tf && hash01('dz-turn', a.id) < 0.5 && go('turn')) {
    if (!isLive(a)) return;
  }
  const hostile = war || rel <= -40;
  if (
    hostile &&
    dn.k !== 'diplomat' &&
    !executionBlock(state, host, owner) &&
    hash01('dz-ex', a.id) < c.regimes[rh].aiExecute * (war ? 1.5 : 1) &&
    go('execute')
  )
    return;
  const opts = [...c.sentenceDays].sort((x, y) => x - y);
  const max = opts[opts.length - 1] ?? 365;
  const mid = opts[Math.floor(opts.length / 2)] ?? 90;
  const min = opts[0] ?? 30;
  if (dn.k === 'diplomat') {
    if (war && rh === 'authoritarian') go('jail', max);
    else go('expel');
    return;
  }
  if (!war && rel >= 20 && dn.k !== 'double' && go('expel')) return;
  go('jail', war || rel <= -50 ? max : rel <= -15 ? mid : min);
}

// ——— Tour quotidien ———

/** Relations, pression des détenus, nations disparues, décisions des IA en attente. */
export function detaineesDaily(state: EngineState): void {
  decayTies(state);
  const c = dzcfg(state);
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (!isLive(a)) continue;
    if (!state.nations[a.host]?.alive || !state.nations[a.owner]?.alive) {
      end(state, a, 'served');
      continue;
    }
    addTie(state, a.host, a.owner, -c.pressurePerDay, c.pressureFloor);
    if (!isPlayer(state, a.host)) aiDecide(state, a);
  }
  retaliations(state);
}

// ——— Représailles (IA du pays d'origine) ———

function liveHeldBy(state: EngineState, host: NationId, owner: NationId): Agent[] {
  const st = ist(state);
  return sortedKeys(st.agents)
    .map((k) => st.agents[k]!)
    .filter((a) => a.host === host && a.owner === owner && isLive(a))
    .sort(
      (x, y) => agentValue(state, y, host) - agentValue(state, x, host) || (x.id < y.id ? -1 : 1),
    );
}

/** Représailles en attente : tirage haché, puis riposte proportionnée (exécution, prison, expulsions). */
function retaliations(state: EngineState): void {
  const st = ist(state);
  const gr = st.gr;
  if (!gr) return;
  for (const key of sortedKeys(gr)) {
    const g = gr[key]!;
    delete gr[key];
    const [origin, host] = key.split('>') as [NationId, NationId];
    if (isPlayer(state, origin) || !regular(state, origin) || !regular(state, host)) continue;
    if (hash01('dz-rt', key, g.t) >= g.p) continue;
    retaliate(state, origin, host, g.k);
  }
}

export function retaliate(
  state: EngineState,
  origin: NationId,
  host: NationId,
  k: 'expel' | 'jail' | 'execute',
): void {
  const c = dzcfg(state);
  const st = ist(state);
  const held = liveHeldBy(state, origin, host);
  const max = Math.max(...c.sentenceDays, 1);
  const mine = sortedKeys(st.agents)
    .map((x) => st.agents[x]!)
    .filter(
      (a) =>
        a.owner === host && a.host === origin && (a.state === 'active' || a.state === 'caught'),
    );
  const say = (id: string, title: string, text: string, sev: 'warn' | 'critical' = 'warn') =>
    note(state, host, id, title, text, { nation: { nation: origin } }, sev);
  const free = held.filter((a) => !(a.dn!.iq !== undefined && a.dn!.iq > state.time));
  if (k === 'execute' && free.length && !executionBlock(state, origin, host)) {
    if (decide(state, origin, free[0]!.id, 'execute').ok) {
      say(
        'reprisalExecute',
        'Représailles',
        `${natLe(state, origin, true)} exécute un de nos agents détenus en représailles.`,
        'critical',
      );
      return;
    }
  }
  if (k !== 'expel') {
    const waiting = held.filter((a) => a.dn!.s !== 'jailed' || (a.dn!.days ?? 0) < max);
    if (waiting.length) {
      for (const a of waiting) decide(state, origin, a.id, 'jail', max);
      say(
        'reprisalJail',
        'Représailles',
        `${natLe(state, origin, true)} durcit la détention de nos agents (peines maximales).`,
      );
      return;
    }
    if (mine.length) {
      const a = mine[0]!;
      publicArrest(state, a);
      say(
        'reprisalArrest',
        'Représailles',
        `${natLe(state, origin, true)} arrête un de nos agents en représailles.`,
      );
      return;
    }
  }
  // Expulsions réciproques : nos officiers sous couverture diplomatique, sinon des diplomates.
  const diplomats = mine.filter((a) => detaineeKind(a) === 'diplomat');
  for (const a of diplomats) {
    publicArrest(state, a);
    if (isLive(a)) decide(state, origin, a.id, 'expel');
  }
  if (!diplomats.length) addTie(state, origin, host, -3);
  say(
    'reprisalExpel',
    'Représailles',
    `${natLe(state, origin, true)} expulse nos diplomates en représailles.`,
  );
}

// ——— Vues ———

const OPTION_ACTIONS: DetaineeAction[] = [
  'interrogate',
  'expel',
  'jail',
  'execute',
  'turn',
  'release',
];

/** Détenus d'une nation (geôlier) : en cours, puis sortis depuis moins de 30 jours. */
export function detaineesView(state: EngineState, n: NationId): DetaineeView[] {
  const st = ist(state);
  const c = dzcfg(state);
  const out: DetaineeView[] = [];
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    const dn = a.dn;
    if (a.host !== n || !dn) continue;
    const live = LIVE.has(dn.s);
    if (!live && (dn.end ?? dn.at) < state.time - 30 * DAY) continue;
    const v: DetaineeView = {
      id: a.id,
      ref: ref(a),
      nationId: a.owner,
      kind: dn.k,
      status: dn.s,
      arrestedAt: dn.at,
      value: agentValue(state, a, n),
    };
    if (dn.s === 'pending') v.decideBy = dn.by;
    if (dn.days !== undefined) v.days = dn.days;
    if (dn.until !== undefined) v.until = dn.until;
    if (dn.iq !== undefined && dn.iq > state.time) v.interrogating = dn.iq;
    if (dn.iv) {
      v.interrogated = true;
      v.access = AGENT_ACCESS[a.ac ?? 0] ?? 'street';
      if (dn.rv) v.revealed = { agents: dn.rv[0], ops: dn.rv[1] };
    }
    if (dn.op) v.op = dn.op;
    if (dn.end !== undefined) v.endedAt = dn.end;
    if (live) {
      const options: DetaineeOption[] = [];
      for (const action of OPTION_ACTIONS) {
        if (action === 'jail') {
          for (const d of c.sentenceDays) {
            const r = assess(state, a, action, d);
            options.push(opt(action, r, d));
          }
        } else options.push(opt(action, assess(state, a, action)));
      }
      v.options = options;
    }
    out.push(v);
  }
  return out.sort(
    (x, y) =>
      Number(!!y.options) - Number(!!x.options) ||
      y.arrestedAt - x.arrestedAt ||
      (x.id < y.id ? -1 : 1),
  );
}

function opt(action: DetaineeAction, r: ReturnType<typeof assess>, days?: number): DetaineeOption {
  const o: DetaineeOption = { action, allowed: r.allowed, effects: { ...r.effects } };
  if (days !== undefined) o.days = days;
  if (r.reason) o.reason = r.reason;
  return o;
}

/** Sort d'un agent détenu, tel que le propriétaire le connaît. */
export function detentionView(state: EngineState, a: Agent): AgentDetentionView | undefined {
  const dn = a.dn;
  if (!dn) return undefined;
  const since = dn.end ?? dn.at;
  switch (dn.s) {
    case 'pending':
    case 'held':
      return {
        fate: dn.iq !== undefined && dn.iq > state.time ? 'interrogation' : 'held',
        since: dn.at,
      };
    case 'jailed':
      return { fate: 'jailed', since: dn.at, days: dn.days ?? 0, until: dn.until ?? dn.at };
    case 'turned':
      return { fate: 'released', since };
    default:
      return { fate: dn.s, since };
  }
}

/** Statut d'agent vu du propriétaire, d'après la détention (null : règles d'origine). */
export function detentionStatus(
  a: Agent,
): 'captured' | 'expelled' | 'executed' | 'released' | null {
  const dn = a.dn;
  if (!dn) return null;
  switch (dn.s) {
    case 'pending':
    case 'held':
    case 'jailed':
      return 'captured';
    case 'expelled':
    case 'returned':
      return 'expelled';
    case 'executed':
      return 'executed';
    case 'exchanged':
    case 'served':
      return 'released';
    default:
      // Libéré sur place (ou retourné) : statut ordinaire de l'agent.
      return null;
  }
}

/** Régimes et relations des nations concernées (détenus, agents détenus, échanges, relations non nulles). */
export function tiesView(
  state: EngineState,
  n: NationId,
): { nationId: NationId; score: number; regime: Regime; accordUntil?: number }[] {
  const st = ist(state);
  const set = new Set<NationId>();
  const p = `${n}|`;
  const q = `|${n}`;
  for (const k of sortedKeys(st.rel ?? {})) {
    if (k.startsWith(p)) set.add(k.slice(p.length));
    else if (k.endsWith(q)) set.add(k.slice(0, k.length - q.length));
  }
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (!a.dn) continue;
    if (a.host === n) set.add(a.owner);
    else if (a.owner === n) set.add(a.host);
  }
  for (const id of sortedKeys(st.sw ?? {})) {
    const s = st.sw![id]!;
    if (s.from === n) set.add(s.to);
    else if (s.to === n) set.add(s.from);
  }
  return [...set]
    .filter((x) => x !== n && !!state.nations[x])
    .sort()
    .map((x) => {
      const out: { nationId: NationId; score: number; regime: Regime; accordUntil?: number } = {
        nationId: x,
        score: tie(state, n, x),
        regime: regimeOf(state, x),
      };
      const na = st.na?.[pairKey(n, x)];
      if (na !== undefined && na > state.time) out.accordUntil = na;
      return out;
    });
}
