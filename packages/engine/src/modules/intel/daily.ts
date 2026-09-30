import {
  HOUR,
  distanceKm,
  movementDestination,
  type LngLat,
  type NationId,
  type UnitId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import {
  nationUnits,
  provincesOf,
  sightLevel,
  sortedKeys,
  sysOf,
  unitPosAt,
  warsOf,
} from '../../state/access.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { cfg, clamp } from './config.js';
import { jammedFor, revealContact } from './contacts.js';
import {
  agentsIn,
  allied,
  doubledIn,
  focusNations,
  hash01,
  pick,
  quality,
  researchOf,
  roll,
} from './levels.js';
import { publish } from './reports.js';
import { ist, nat } from './state.js';
import {
  CATEGORY_LABEL,
  NOTHING,
  OPENINGS,
  approx,
  cardinal,
  hedge,
  nationName,
  sectorOf,
} from './text.js';

/**
 * Notes quotidiennes et rapports flash. Textes courts et génériques, construits à partir de l'état du
 * jeu filtré par la qualité du service. Seules les nations tenues par un joueur reçoivent des notes.
 */
function readers(state: EngineState): NationId[] {
  return state.nationIds.filter((n) => state.nations[n]!.alive && state.nations[n]!.isPlayer);
}

export interface Concentration {
  owner: NationId;
  units: number;
  elements: number;
  /** Unités vues par nos capteurs (identifiants communicables). */
  seen: UnitId[];
  /** Unités déduites mais non vues : jamais citées par identifiant dans un rapport. */
  inferred: UnitId[];
  at: LngLat;
  heading: LngLat | null;
}

/**
 * Forces non alliées à moins de `flashBorderKm` d'une de nos villes. Les unités vues comptent toujours ;
 * les autres sont déduites avec une probabilité ∝ qualité (tirage haché, sans consommer le PRNG).
 * Balayage borné par la boîte englobante de nos villes.
 */
export function concentrations(
  state: EngineState,
  n: NationId,
  movingOnly: boolean,
  q: number,
): Concentration[] {
  const c = cfg(state);
  const w = wi(state.world);
  const cities = provincesOf(state, n).map((pid) => w.provById.get(pid)!.cityPoint);
  if (cities.length === 0) return [];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of cities) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const pad = c.flashBorderKm / 111 + 0.5;
  const padX = pad / Math.max(0.2, Math.cos((((y0 + y1) / 2) * Math.PI) / 180));
  const bucket = Math.floor(state.time / (6 * HOUR));
  const groups = new Map<
    NationId,
    { c: Concentration; sx: number; sy: number; hx: number; hy: number; hn: number }
  >();
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    if (allied(state, n, u.owner)) continue;
    if (movingOnly && !u.move) continue;
    const pos = unitPosAt(state, u, state.time);
    if (pos[0] < x0 - padX || pos[0] > x1 + padX || pos[1] < y0 - pad || pos[1] > y1 + pad)
      continue;
    if (!cities.some((p) => distanceKm(p, pos) <= c.flashBorderKm)) continue;
    const seen = sightLevel(state, n, uid) > 0;
    if (!seen && (jammedFor(state, n, pos) || hash01('inf', n, uid, bucket) >= q * 0.7)) continue;
    let g = groups.get(u.owner);
    if (!g) {
      g = {
        c: {
          owner: u.owner,
          units: 0,
          elements: 0,
          seen: [],
          inferred: [],
          at: pos,
          heading: null,
        },
        sx: 0,
        sy: 0,
        hx: 0,
        hy: 0,
        hn: 0,
      };
      groups.set(u.owner, g);
    }
    g.c.units++;
    g.c.elements += u.count;
    (seen ? g.c.seen : g.c.inferred).push(uid);
    g.sx += pos[0];
    g.sy += pos[1];
    const dest = u.move ? movementDestination(u.move) : undefined;
    if (dest) {
      g.hx += dest[0];
      g.hy += dest[1];
      g.hn++;
    }
  }
  const out: Concentration[] = [];
  for (const owner of [...groups.keys()].sort()) {
    const g = groups.get(owner)!;
    g.c.at = [g.sx / g.c.units, g.sy / g.c.units];
    g.c.heading = g.hn > 0 ? [g.hx / g.hn, g.hy / g.hn] : null;
    out.push(g.c);
  }
  return out;
}

/** Balayage périodique : rapport flash sur mouvement important près de la frontière. */
export function scan(state: EngineState): void {
  const c = cfg(state);
  for (const n of readers(state)) {
    const q = quality(state, n, 'military');
    const ni = nat(state, n);
    for (const g of concentrations(state, n, true, q)) {
      if (g.units < c.flashMinUnits) continue;
      const key = `move:${g.owner}`;
      const last = ni.flash[key];
      if (last !== undefined && state.time - last < c.flashCooldownH * HOUR) continue;
      ni.flash[key] = state.time;
      for (const uid of g.inferred) revealContact(state, n, state.units[uid]!, 1, 25);
      const qq = clamp(0.45 * q + (0.5 * g.seen.length) / g.units + 0.05, 0.05, 0.95);
      const lines = [
        `${approx(state, g.units, qq)} unités de ${nationName(state, g.owner)} en mouvement, ${sectorOf(state, g.at)}.`,
      ];
      if (g.heading) lines.push(`Direction générale : ${cardinal(g.at, g.heading)}.`);
      lines.push(hedge(state, qq));
      publish(state, n, {
        dept: 'military',
        source: 'sigint',
        kind: 'flash',
        title: `FLASH — Mouvement de forces de ${nationName(state, g.owner)}`,
        lines,
        at: g.at,
        radiusKm: 30 + (1 - qq) * 120,
        subject: { nationId: g.owner, unitIds: g.seen.slice(0, 30) },
        actions: [{ kind: 'plan_strike', at: g.at }],
        q: qq,
      });
    }
  }
}

// ——— Notes quotidiennes ———

export function dailyNotes(state: EngineState): void {
  for (const n of readers(state)) {
    interiorNote(state, n);
    exteriorNote(state, n);
    militaryNote(state, n);
  }
}

function plural(k: number, one: string, many: string): string {
  return `${k} ${k > 1 ? many : one}`;
}

function interiorNote(state: EngineState, n: NationId): void {
  const ni = nat(state, n);
  const q = quality(state, n, 'interior');
  const lines = [pick(state, OPENINGS.interior)];
  const log = ni.log;
  const incidents: string[] = [];
  if (log.sabotage) incidents.push(plural(log.sabotage, 'sabotage', 'sabotages'));
  if (log.cyber) incidents.push(plural(log.cyber, 'cyberattaque', 'cyberattaques'));
  if (log.rebels)
    incidents.push(plural(log.rebels, 'financement de rebelles', 'financements de rebelles'));
  if (log.strikes) incidents.push(plural(log.strikes, 'frappe', 'frappes'));
  if (log.caught)
    incidents.push(plural(log.caught, 'agent étranger identifié', 'agents étrangers identifiés'));
  lines.push(incidents.length ? `Incidents : ${incidents.join(', ')}.` : pick(state, NOTHING));
  const st = ist(state);
  const doubles = sortedKeys(st.agents).filter((id) => {
    const a = st.agents[id]!;
    return a.host === n && a.state === 'double';
  }).length;
  if (doubles) lines.push(`${plural(doubles, 'agent double actif', 'agents doubles actifs')}.`);
  const stab = board(state).stability[n];
  if (stab !== undefined) lines.push(`Stabilité : ${Math.round(stab)}/100.`);
  ni.log = { sabotage: 0, cyber: 0, rebels: 0, caught: 0, strikes: 0, found: ni.log.found };
  publish(state, n, {
    dept: 'interior',
    source: 'humint',
    kind: 'daily',
    title: 'Note quotidienne — Sécurité intérieure',
    lines,
    at: null,
    radiusKm: 0,
    q,
    share: false,
  });
}

/** Faits sur une nation, révélés chacun avec une probabilité ∝ qualité. */
function nationFacts(state: EngineState, n: NationId, x: NationId, qx: number): string[] {
  const facts: string[] = [];
  const wars = warsOf(state, x);
  if (wars.length)
    facts.push(`en guerre contre ${wars.map((y) => nationName(state, y)).join(', ')}`);
  const plans = board(state).warPlans?.[x] ?? [];
  if (plans.length && roll(state) < qx)
    facts.push(`prépare une offensive contre ${plans.map((y) => nationName(state, y)).join(', ')}`);
  const aid = board(state).allianceOf[x];
  if (aid && roll(state) < qx) {
    const mates = state.nationIds.filter((y) => y !== x && board(state).allianceOf[y] === aid);
    if (mates.length)
      facts.push(
        `alliée à ${mates
          .slice(0, 3)
          .map((y) => nationName(state, y))
          .join(', ')}`,
      );
  }
  if (board(state).mobilized[x]) facts.push('mobilisation générale');
  const prod = state.nations[x]?.production ?? [];
  if (prod.length && roll(state) < qx) {
    const s = state.world.catalog.get(prod[0]!.systemId);
    facts.push(
      `${approx(state, prod.length, qx)} système(s) en production` +
        (qx >= 0.6 && s ? `, dont ${s.name}` : ''),
    );
  }
  const cur = researchOf(state, x)?.current?.id;
  if (cur && roll(state) < qx * 0.8)
    facts.push(`recherche en cours : ${state.world.research?.get(cur)?.name ?? cur}`);
  return facts;
}

function exteriorNote(state: EngineState, n: NationId): void {
  const ni = nat(state, n);
  const base = quality(state, n, 'exterior');
  const lines = [pick(state, OPENINGS.exterior)];
  let fake = false;
  let sumQ = 0;
  const focus = focusNations(state, n, 3);
  for (const x of focus) {
    const ag = Math.min(1, agentsIn(state, n, x));
    const qx = clamp(base * (0.5 + 0.5 * ag) + 0.1 * ag, 0.05, 0.95);
    sumQ += qx;
    if (doubledIn(state, n, x)) {
      // Source retournée : information orientée par le pays hôte (drapeau interne uniquement).
      fake = true;
      lines.push(`• ${nationName(state, x)} : posture défensive, pas d'intention hostile relevée.`);
      continue;
    }
    const facts = nationFacts(state, n, x, qx);
    lines.push(
      `• ${nationName(state, x)} : ${facts.length ? facts.join(' ; ') : ag > 0 ? 'pas de changement notable' : 'pas de source directe'}.`,
    );
  }
  if (focus.length === 0) lines.push(pick(state, NOTHING));
  if (ni.log.found) {
    lines.push(
      `${plural(ni.log.found, 'installation étrangère repérée', 'installations étrangères repérées')} par nos agents.`,
    );
    ni.log.found = 0;
  }
  const q = focus.length ? sumQ / focus.length : base;
  publish(state, n, {
    dept: 'exterior',
    source: 'humint',
    kind: 'daily',
    title: 'Note quotidienne — Renseignement extérieur',
    lines,
    at: null,
    radiusKm: 0,
    subject: focus.length === 1 ? { nationId: focus[0]! } : {},
    q: fake ? clamp(q - 0.1, 0.05, 0.9) : q,
    fake,
  });
}

function militaryNote(state: EngineState, n: NationId): void {
  const q = quality(state, n, 'military');
  const lines = [pick(state, OPENINGS.military)];
  for (const x of focusNations(state, n, 2)) {
    const cats = new Map<string, number>();
    for (const uid of nationUnits(state, x)) {
      const u = state.units[uid]!;
      const cat = sysOf(state, u).category;
      cats.set(cat, (cats.get(cat) ?? 0) + u.count);
    }
    const top = [...cats.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, q >= 0.5 ? 4 : 2)
      .map(
        ([k, v]) => `${approx(state, v, q)} ${CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL]}`,
      );
    lines.push(
      `• ${nationName(state, x)} : ${top.length ? top.join(', ') : 'aucune force identifiée'}.`,
    );
  }
  const conc = concentrations(state, n, false, q).sort((a, b) => b.units - a.units)[0];
  let at: LngLat | null = null;
  if (conc && conc.units >= 2) {
    at = conc.at;
    lines.push(
      `Présence frontalière : ${approx(state, conc.units, q)} unités de ${nationName(state, conc.owner)}, ${sectorOf(state, conc.at)}.`,
    );
  }
  const known = Object.values(state.know[n] ?? {}).filter((c) => c.seen).length;
  lines.push(`Contacts suivis : ${known}.`);
  publish(state, n, {
    dept: 'military',
    source: 'sigint',
    kind: 'daily',
    title: 'Note quotidienne — Renseignement militaire',
    lines,
    at,
    radiusKm: at ? 60 + (1 - q) * 100 : 0,
    subject: conc ? { nationId: conc.owner } : {},
    actions: at ? [{ kind: 'plan_strike', at }] : [],
    q,
  });
}
