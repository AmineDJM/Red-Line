import { HOUR, type NationId } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { notify, sortedKeys } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { scheduleMod } from '../kit.js';
import { signal } from '../registry.js';
import { cfg, clamp } from './config.js';
import { budgetFactor, level, quality, roll } from './levels.js';
import { publish } from './reports.js';
import { addIncident, agentDetectFactor } from './interior.js';
import { ist, nat, nextId, type Agent } from './state.js';
import { codename, fmtTime, nationName, natAgree, natDe, natLe } from './text.js';
import { noteLoc } from '../../state/loc.js';
import { loc } from '@redline/shared';

export function createAgent(
  state: EngineState,
  owner: NationId,
  host: NationId,
  kind: 'officer' | 'source',
): Agent {
  const id = nextId(state, 'a');
  const a: Agent = {
    id,
    codename: codename(state),
    owner,
    host,
    kind,
    since: state.time,
    state: 'active',
  };
  ist(state).agents[id] = a;
  return a;
}

function capitalPoint(state: EngineState, n: NationId): [number, number] | null {
  const w = wi(state.world);
  const cap = w.nationById.get(n)?.capitalProvinceId;
  const p = cap ? w.provById.get(cap)?.cityPoint : undefined;
  return p ? [p[0], p[1]] : null;
}

/** Chance quotidienne qu'un agent soit démasqué par le contre-espionnage du pays hôte. */
export function detectionChance(state: EngineState, a: Agent, bonus = 1): number {
  const c = cfg(state);
  const lh = level(state, a.host, 'interior');
  const lo = level(state, a.owner, 'exterior');
  const p =
    (c.agentDetectPerDay *
      (0.5 + 0.5 * lh) *
      (0.5 + budgetFactor(state, a.host, 'interior')) *
      (a.kind === 'source' ? 0.6 : 1) *
      agentDetectFactor(state, a.host) *
      bonus) /
    (1 + 0.3 * lo);
  return clamp(p, 0, 0.9);
}

/** Tour quotidien : chaque agent actif peut être démasqué ; les agents d'un pays disparu rentrent. */
export function dailyAgents(state: EngineState): void {
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.state === 'captured' || a.state === 'exfiltrated') continue;
    if (!state.nations[a.host]?.alive || !state.nations[a.owner]?.alive) {
      a.state = 'exfiltrated';
      continue;
    }
    if (a.state === 'active' && roll(state) < detectionChance(state, a)) catchQuietly(state, a);
  }
}

/**
 * Capture discrète : le pays hôte sait, le propriétaire l'ignore (sauf s'il le devine). L'arrestation
 * devient publique après `caughtGraceH`, sauf retournement ou exfiltration entre-temps.
 */
export function catchQuietly(state: EngineState, a: Agent): void {
  const c = cfg(state);
  a.state = 'caught';
  a.caughtAt = state.time;
  nat(state, a.host).log.caught++;
  addIncident(state, a.host, wi(state.world).nationById.get(a.host)?.capitalProvinceId, 'agent');
  const until = state.time + c.caughtGraceH * HOUR;
  publish(state, a.host, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: `Agent ${natDe(state, a.owner)} démasqué`,
    titleLoc: loc('engine.intel.agentExposed', { nation: { nation: a.owner } }),
    lines: [
      `${a.kind === 'officer' ? 'Officier traitant' : 'Source recrutée'} au service ${natDe(state, a.owner)} identifié(e) et placé(e) sous surveillance.`,
      `Arrestation publique prévue ${fmtTime(until)}. Retournement possible d'ici là (ordre « retourner »).`,
    ],
    at: capitalPoint(state, a.host),
    radiusKm: 50,
    subject: { nationId: a.owner },
    q: Math.max(0.7, quality(state, a.host, 'interior')),
  });
  if (roll(state) < 0.5 * quality(state, a.owner, 'exterior')) burn(state, a);
  scheduleMod(state, { t: until, m: 'intel', e: 'arrest', d: { id: a.id } });
}

/** Le propriétaire comprend que son agent est grillé. */
export function burn(state: EngineState, a: Agent): void {
  if (a.burned) return;
  a.burned = true;
  publish(state, a.owner, {
    dept: 'exterior',
    source: 'humint',
    kind: 'flash',
    title: `Agent ${a.codename} compromis`,
    titleLoc: loc('engine.intel.agentCompromised', { codename: a.codename }),
    lines: [
      `Signaux d'alerte sur ${a.codename} (${nationName(state, a.host)}) : contacts manqués, filature probable.`,
      'Exfiltration recommandée sans délai.',
    ],
    at: capitalPoint(state, a.host),
    radiusKm: 100,
    subject: { nationId: a.host },
    q: quality(state, a.owner, 'exterior'),
    share: false,
  });
}

export function handleArrest(state: EngineState, id: string): void {
  const a = ist(state).agents[id];
  if (!a || a.state !== 'caught') return;
  publicArrest(state, a);
}

/** Arrestation publique : incident diplomatique (signal agent_caught), notification générique. */
export function publicArrest(state: EngineState, a: Agent): void {
  a.state = 'captured';
  a.burned = true;
  a.caughtAt ??= state.time;
  const at = capitalPoint(state, a.host);
  signal(state, 'agent_caught', { spyNation: a.owner, onNation: a.host });
  signal(state, 'alert', { amount: cfg(state).exposureTension, reason: 'agent_caught' });
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at,
      category: 'intel',
      title: 'Agent démasqué',
      text: `${natLe(state, a.host, true)} ${natAgree(state, a.host, 'annonce', 'annoncent')} l'arrestation d'un agent ${natDe(state, a.owner)}.`,
      severity: 'warn',
      loc: noteLoc('agentCaught', { host: { nation: a.host }, owner: { nation: a.owner } }),
    },
    [a.owner, a.host],
  );
  publish(state, a.host, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: `Arrestation d'un agent ${natDe(state, a.owner)}`,
    titleLoc: loc('engine.intel.agentArrest', { nation: { nation: a.owner } }),
    lines: [
      `L'agent étranger placé sous surveillance a été interpellé.`,
      `Incident diplomatique ouvert avec ${natLe(state, a.owner)}.`,
    ],
    at,
    radiusKm: 50,
    subject: { nationId: a.owner },
    q: 0.9,
  });
  publish(state, a.owner, {
    dept: 'exterior',
    source: 'humint',
    kind: 'flash',
    title: `Agent ${a.codename} arrêté`,
    titleLoc: loc('engine.intel.agentArrested', { codename: a.codename }),
    lines: [
      `${a.codename} a été arrêté par les services ${natDe(state, a.host)}.`,
      'Réseau local à considérer comme compromis. Perte de réputation attendue.',
    ],
    at,
    radiusKm: 50,
    subject: { nationId: a.host },
    q: 0.9,
    share: false,
  });
}

/** Agents ennemis démasqués et pas encore arrêtés publiquement, retournables par `host`. */
export function turnable(state: EngineState, host: NationId, owner?: NationId): Agent[] {
  const st = ist(state);
  return sortedKeys(st.agents)
    .map((id) => st.agents[id]!)
    .filter((a) => a.host === host && a.state === 'caught' && (!owner || a.owner === owner));
}
