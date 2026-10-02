import { HOUR, type BuildingType, type LngLat, type NationId } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { sortedKeys, warsOf } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { agentsIn, doubledIn, neighborNations, quality, roll } from './levels.js';
import { publish } from './reports.js';
import { BUILDING_LABEL, announce, imagery, knowledge, provincesInCircle } from './provinces.js';
import { ist, nat } from './state.js';
import { bda } from './deep.js';
import { addIncident } from './interior.js';
import { nationName, natA, natAgree, natDe, natLe, provinceName, sectorOf } from './text.js';
import { loc } from '@redline/shared';

/**
 * Réactions du renseignement aux signaux des autres modules (et aux siens). Chaque signal met à jour
 * les compteurs de la note quotidienne et produit au plus un rapport court (une ligne, gabarit
 * générique rempli avec les données du jeu). Les signaux inconnus ou mal formés sont ignorés.
 */

type Data = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
function lngLat(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [x, y] = v as unknown[];
  return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
}

function alive(state: EngineState, n: NationId | undefined): n is NationId {
  return !!n && !!state.nations[n]?.alive;
}

/** Joueurs humains vivants (destinataires des alertes mondiales). */
function players(state: EngineState): NationId[] {
  return state.nationIds.filter((n) => state.nations[n]!.alive && state.nations[n]!.isPlayer);
}

/** Anti-répétition : vrai si la clé a déjà servi depuis moins de `h` heures (sinon la marque). */
function cooling(state: EngineState, n: NationId, key: string, h: number): boolean {
  const ni = nat(state, n);
  const last = ni.flash[key];
  if (last !== undefined && state.time - last < h * HOUR) return true;
  ni.flash[key] = state.time;
  return false;
}

function cityOf(state: EngineState, pid: string | undefined): LngLat | null {
  const p = pid ? wi(state.world).provById.get(pid)?.cityPoint : undefined;
  return p ? [p[0], p[1]] : null;
}

const STRIKE_LABEL: Record<string, string> = {
  missile: 'Frappe de missiles',
  air: 'Frappe aérienne',
  artillery: "Tirs d'artillerie",
};

const CYBER_LABEL: Record<string, string> = {
  radar: 'réseau radar',
  production: 'chaînes de production',
  orders: 'réseaux de commandement',
};

export function onSignal(state: EngineState, name: string, d: Data): void {
  if (!state.mods.intel) return;
  switch (name) {
    case 'strike':
      return strike(state, d);
    case 'nuclear_detonation':
      return nuclear(state, d);
    case 'sabotage':
      return sabotage(state, d);
    case 'cyber':
      return cyber(state, d);
    case 'rebels_funded':
      return rebels(state, d);
    case 'research_complete':
      return research(state, d);
    case 'black_market_detected':
      return blackMarket(state, d);
    case 'imagery':
      return onImagery(state, d);
    case 'domestic_event': {
      const n = str(d.nation);
      if (alive(state, n)) addIncident(state, n, str(d.pid), 'domestic');
      return;
    }
  }
}

/** `strike` { by, victim, at, kind, nuclear } : rapport flash chez la victime (une fois par heure et par tireur). */
function strike(state: EngineState, d: Data): void {
  const victim = str(d.victim);
  const by = str(d.by);
  if (!alive(state, victim) || victim === by) return;
  nat(state, victim).log.strikes++;
  const kind = str(d.kind) ?? 'missile';
  // Évaluation des dégâts chez le tireur (une fois par heure, par cible et par type de frappe).
  const hit = lngLat(d.at);
  if (
    by &&
    hit &&
    alive(state, by) &&
    state.nations[by]!.isPlayer &&
    !cooling(state, by, `bda:${victim}:${kind}`, 1)
  )
    bda(state, by, victim, hit, kind);
  if (cooling(state, victim, `strike:${by ?? '?'}:${kind}`, 1)) return;
  const at = lngLat(d.at);
  const q = quality(state, victim, 'military');
  const known = !!by && (d.nuclear === true || roll(state) < 0.3 + q);
  publish(state, victim, {
    dept: 'military',
    source: 'sigint',
    kind: 'flash',
    title: `FLASH — ${STRIKE_LABEL[kind] ?? 'Frappe'} subie`,
    titleLoc: loc(`engine.intel.strikeSuffered.${STRIKE_LABEL[kind] ? kind : 'other'}`),
    lines: [
      `${STRIKE_LABEL[kind] ?? 'Frappe'} subie${at ? `, ${sectorOf(state, at)}` : ''}. ` +
        (known ? `Origine : ${nationName(state, by)}.` : 'Origine non déterminée.'),
    ],
    at,
    radiusKm: at ? 20 : 0,
    subject: known ? { nationId: by } : {},
    q: 0.85,
  });
}

/** `nuclear_detonation` { by, victim, at, pid } : détectée par tous les joueurs, subie par la victime. */
function nuclear(state: EngineState, d: Data): void {
  const victim = str(d.victim);
  const by = str(d.by);
  const pid = str(d.pid);
  const at = lngLat(d.at) ?? cityOf(state, pid);
  if (alive(state, victim)) nat(state, victim).log.strikes++;
  const aud = new Set(players(state));
  if (alive(state, victim)) aud.add(victim);
  for (const n of [...aud].sort()) {
    if (n === by) continue;
    const known = !!by && (n === victim || roll(state) < quality(state, n, 'military') + 0.2);
    const where = pid ? provinceName(state, pid) : at ? sectorOf(state, at) : 'zone inconnue';
    publish(state, n, {
      dept: 'military',
      source: 'sigint',
      kind: 'flash',
      title: 'FLASH — Détonation nucléaire',
      titleLoc: loc('engine.intel.flashNuclear'),
      lines: [
        `Détonation nucléaire détectée : ${where}. ` +
          (known ? `Attribuée ${natA(state, by)}.` : 'Origine non déterminée.'),
      ],
      at,
      radiusKm: at ? 50 : 0,
      subject: {
        ...(known ? { nationId: by } : {}),
        ...(pid ? { provinceId: pid } : {}),
      },
      q: 0.95,
    });
  }
}

/** `sabotage` { by, victim, pid, building, damage } : sécurité intérieure de la victime. */
function sabotage(state: EngineState, d: Data): void {
  const victim = str(d.victim);
  const by = str(d.by);
  const pid = str(d.pid);
  if (!alive(state, victim) || victim === by) return;
  nat(state, victim).log.sabotage++;
  addIncident(state, victim, pid, 'sabotage');
  // Sabotage d'un réseau rebelle intérieur : déjà notifié par la gestion intérieure.
  if (d.domestic === true) return;
  const b = str(d.building) as BuildingType | undefined;
  const dmg = Math.round(num(d.damage) * 100);
  const known = !!by && roll(state) < 0.5 * quality(state, victim, 'interior');
  const at = cityOf(state, pid);
  publish(state, victim, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: 'Sabotage',
    titleLoc: loc('engine.intel.sabotage'),
    lines: [
      `Sabotage : ${b ? (BUILDING_LABEL[b] ?? b) : 'installation'}${pid ? ` de ${provinceName(state, pid)}` : ''} endommagé(e) à ${dmg} %. ` +
        (known ? `Commandité par ${natLe(state, by)}.` : 'Auteurs non identifiés.'),
    ],
    at,
    radiusKm: at ? 20 : 0,
    subject: { ...(known ? { nationId: by } : {}), ...(pid ? { provinceId: pid } : {}) },
    actions: pid ? [{ kind: 'open_province', provinceId: pid }] : [],
    q: 0.8,
    share: false,
  });
}

/** `cyber` { by, victim, kind, hours } : attaque subie. */
function cyber(state: EngineState, d: Data): void {
  const victim = str(d.victim);
  const by = str(d.by);
  if (!alive(state, victim) || victim === by) return;
  nat(state, victim).log.cyber++;
  addIncident(state, victim, wi(state.world).nationById.get(victim)?.capitalProvinceId, 'cyber');
  const kind = str(d.kind) ?? 'orders';
  const known = !!by && roll(state) < 0.4 * quality(state, victim, 'interior') + 0.1;
  publish(state, victim, {
    dept: 'interior',
    source: 'sigint',
    kind: 'cyber',
    title: 'Cyberattaque',
    titleLoc: loc('engine.intel.cyber'),
    lines: [
      `Cyberattaque contre nos ${CYBER_LABEL[kind] ?? 'systèmes'}, effets ≈ ${Math.round(num(d.hours, 12))} h. ` +
        (known ? `Attribuée ${natA(state, by)}.` : 'Attribution impossible.'),
    ],
    at: null,
    radiusKm: 0,
    subject: known ? { nationId: by } : {},
    q: 0.75,
    share: false,
  });
}

/** `rebels_funded` { by, pid, amount } : détecté par le propriétaire de la province selon sa qualité. */
function rebels(state: EngineState, d: Data): void {
  const pid = str(d.pid);
  const by = str(d.by);
  const victim = pid ? state.provinces[pid]?.owner : undefined;
  if (!alive(state, victim) || victim === by) return;
  const q = quality(state, victim, 'interior');
  if (roll(state) >= 0.4 + 0.5 * q) return;
  nat(state, victim).log.rebels++;
  addIncident(state, victim, pid, 'rebels');
  const known = !!by && roll(state) < 0.5 * q;
  const at = cityOf(state, pid);
  publish(state, victim, {
    dept: 'interior',
    source: 'humint',
    kind: 'counterintel',
    title: 'Groupes armés financés',
    titleLoc: loc('engine.intel.rebelsFunded'),
    lines: [
      `Financement de groupes armés détecté en ${provinceName(state, pid!)}. ` +
        (known ? `Fonds en provenance ${natDe(state, by)}.` : 'Origine des fonds inconnue.'),
    ],
    at,
    radiusKm: at ? 50 : 0,
    subject: { provinceId: pid!, ...(known ? { nationId: by } : {}) },
    actions: [{ kind: 'open_province', provinceId: pid! }],
    q,
    share: false,
  });
}

/**
 * `research_complete` { nation (ou nationId, n, by), nodeId } : la porte est retenue (niveaux des
 * départements) ; les nations ayant un agent sur place peuvent l'apprendre.
 */
function research(state: EngineState, d: Data): void {
  const n = str(d.nation) ?? str(d.nationId) ?? str(d.n) ?? str(d.by);
  const nodeId = str(d.nodeId);
  if (!n || !nodeId || !state.nations[n]) return;
  const st = ist(state);
  const g = (st.gates[n] ??= []);
  if (!g.includes(nodeId)) {
    g.push(nodeId);
    g.sort();
  }
  const owners = new Set<NationId>();
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.host === n && a.state === 'active' && alive(state, a.owner)) owners.add(a.owner);
  }
  const name = state.world.research?.get(nodeId)?.name ?? nodeId;
  for (const o of [...owners].sort()) {
    if (doubledIn(state, o, n) || roll(state) >= quality(state, o, 'exterior')) continue;
    publish(state, o, {
      dept: 'exterior',
      source: 'humint',
      kind: 'intentions',
      title: `Programme achevé — ${nationName(state, n)}`,
      titleLoc: loc('engine.intel.programDone', { nation: { nation: n } }),
      lines: [
        `${natLe(state, n, true)} ${natAgree(state, n, 'a', 'ont')} achevé le programme « ${name} ».`,
      ],
      at: null,
      radiusKm: 0,
      subject: { nationId: n },
      q: quality(state, o, 'exterior'),
    });
  }
}

/** `black_market_detected` { buyer, systemId } : ennemis, voisins et nations ayant des agents chez l'acheteur. */
function blackMarket(state: EngineState, d: Data): void {
  const buyer = str(d.buyer);
  const sys = str(d.systemId);
  if (!alive(state, buyer) || !sys) return;
  const cands = new Set<NationId>([...warsOf(state, buyer), ...neighborNations(state, buyer)]);
  const st = ist(state);
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (a.host === buyer && a.state === 'active') cands.add(a.owner);
  }
  const label = state.world.catalog.get(sys)?.name ?? sys;
  for (const n of [...cands].sort()) {
    if (n === buyer || !alive(state, n)) continue;
    const q = quality(state, n, 'exterior');
    if (roll(state) >= q + (agentsIn(state, n, buyer) > 0 ? 0.3 : 0)) continue;
    publish(state, n, {
      dept: 'exterior',
      source: 'humint',
      kind: 'intentions',
      title: `Marché noir — ${nationName(state, buyer)}`,
      titleLoc: loc('engine.intel.blackMarket', { nation: { nation: buyer } }),
      lines: [`Achat au marché noir par ${natLe(state, buyer)} : ${label}.`],
      at: null,
      radiusKm: 0,
      subject: { nationId: buyer, systemIds: [sys] },
      q,
    });
  }
}

/**
 * `imagery` { nation, at, radiusKm, kind, pids } (satellites, reconnaissance aérienne, radars ; émis
 * par le module mil) : la zone est révélée ; un rapport annonce les installations découvertes.
 */
function onImagery(state: EngineState, d: Data): void {
  const n = str(d.nation);
  if (!alive(state, n)) return;
  let pids = Array.isArray(d.pids)
    ? (d.pids as unknown[]).filter((x) => typeof x === 'string')
    : [];
  const at = lngLat(d.at);
  if (pids.length === 0 && at)
    pids = provincesInCircle(state, at, Math.max(1, num(d.radiusKm, 50)));
  const foreign = (pids as string[]).filter((pid) => knowledge(state, n, pid) !== null);
  if (foreign.length === 0) return;
  const kind = str(d.kind) ?? 'satellite';
  const ds = imagery(state, n, foreign, kind);
  const hits = ds.filter((x) => x.found.length > 0);
  if (hits.length === 0) return;
  const owner = state.provinces[hits[0]!.pid]!.owner;
  announce(state, n, ds, {
    dept: 'military',
    source: 'sigint',
    title: `Imagerie — ${nationName(state, owner)}`,
    titleLoc: loc('engine.intel.imagery', { nation: { nation: owner } }),
    q: 0.85,
    kind: 'order_of_battle',
  });
}
