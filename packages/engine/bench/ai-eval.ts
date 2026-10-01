// Évaluation mesurée de l'IA sur la vraie partie (carte, catalogue, ORBAT 2025, scénario « world-today »).
//
//   node --expose-gc bench/run.mjs ai-eval                     (depuis packages/engine)
//   AIEVAL_MODE=forced|free|duel   (défaut forced)
//     forced : guerres réalistes déclarées à J1 entre IA (les deux camps jouent seuls) ;
//     free   : aucune guerre imposée, on observe ce que les IA décident d'elles-mêmes ;
//     duel   : mêmes guerres, l'agresseur et la cible de chaque paire à des niveaux différents
//              (AIEVAL_DUEL=hard:easy, puis inversé dans une seconde passe).
//   AIEVAL_LEVELS=easy,normal,hard  AIEVAL_SEEDS=1,2  AIEVAL_DAYS=14  AIEVAL_HUMAN=fra (joueur passif ;
//   plusieurs séparés par des virgules : une série de parties par joueur)
//   AIEVAL_JSON=1 : une ligne JSON par partie (comparaisons avant / après).
//   AIEVAL_VERBOSE=1 : exemples concrets (captures, guerres, ordres refusés…).
//
// Aucune triche dans la mesure : le banc observe l'état complet pour juger, mais l'IA, elle, ne
// change pas. Le traceur des ordres (src/ai/trace.ts) n'altère ni l'état ni le tirage aléatoire.
import {
  DAY,
  HOUR,
  distanceKm,
  type GameNotification,
  type LngLat,
  type NationId,
  type Order,
} from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, stateHash } from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { atWar, nationUnits, sysOf, unitPosAt, warsOf } from '../src/state/access.js';
import { setAiTracer } from '../src/ai/trace.js';
import { estimateForce, neighborNations, ownForce } from '../src/ai/estimate.js';
import { ds } from '../src/modules/diplo/state.js';
import { ecoNation } from '../src/modules/eco/state.js';
import { breakdown, budgetDay } from '../src/modules/eco/budget.js';
import { mil } from '../src/modules/mil/state.js';
import { loadRealData } from './load.js';

type Level = 'easy' | 'normal' | 'hard';
const env = process.env;
const MODE = (env.AIEVAL_MODE ?? 'forced') as 'forced' | 'free' | 'duel';
const LEVELS = (env.AIEVAL_LEVELS ?? 'easy,normal,hard').split(',') as Level[];
const SEEDS = (env.AIEVAL_SEEDS ?? '1,2').split(',').map(Number);
const DAYS = Number(env.AIEVAL_DAYS ?? 14);
const HUMANS = (env.AIEVAL_HUMAN ?? 'fra').split(',');
let HUMAN = HUMANS[0]!;
const VERBOSE = !!env.AIEVAL_VERBOSE;
const STEP = 6 * HOUR;
const WATCH = env.AIEVAL_WATCH;

/** Guerres imposées (agresseur, cible), toutes entre IA. */
const ALL_WARS: [NationId, NationId][] = [
  ['rus', 'ukr'],
  ['ind', 'pak'],
  ['prk', 'kor'],
  ['sau', 'yem'],
  ['aze', 'arm'],
  ['eth', 'eri'],
  ['dza', 'mar'],
  ['ven', 'guy'],
  ['chn', 'twn'],
  ['isr', 'irn'],
];
let WARS: [NationId, NationId][] = [];

const LAND = new Set(['infantry', 'tank', 'ifv', 'artillery', 'special_forces', 'apc', 'recon']);

const data = loadRealData();
const world = buildWorld(data.map, data.catalog, data.balance, {
  research: data.research,
  orbats: data.orbats,
});
const W = wi(world);

interface Track {
  /** Ordres de l'IA : genre → [réussis, refusés]. */
  orders: Record<string, [number, number]>;
  refusals: Record<string, number>;
  /** Taille des groupes envoyés ensemble (ordres move/attack de l'IA tactique). */
  groupSizes: number[];
  /** Ordres de capture : unité → province visée, date. */
  captures: { uid: string; n: NationId; to: LngLat; t: number; pid: string | null }[];
  /** Destinations successives par unité (va-et-vient). */
  dests: Map<string, { to: LngLat; t: number }[]>;
  /** Ordres par nation et par jour (inactivité). */
  perNationDay: Map<string, number>;
  research: Record<string, number>;
  produced: Record<string, number>;
  intel: Record<string, number>;
  examples: string[];
  /**
   * Arrivées prévues des unités envoyées prendre une ville : nation|province → [ordre, arrivée]. Les
   * ordres d'une même nation vers une même ville à moins de 12 h d'écart forment une vague ; l'écart
   * des arrivées d'une vague mesure la concentration (rassemblement, départs échelonnés).
   */
  arrivals: Map<string, { t: number; eta: number }[]>;
  /** Ordres de capture passant par la mer (débarquements) : unité → province, date. */
  amph: { uid: string; n: NationId; t: number; pid: string | null }[];
  /** Ordres aériens par genre (frappes d'unité, de bâtiment, suppression, escortes et couverture). */
  air: Record<string, number>;
  /** Productions hors de la capitale / total. */
  prodSites: [number, number];
  /** Propositions de paix des IA au joueur humain. */
  peaceToHuman: number;
  /** Déclarations de guerre décidées par l'IA (agresseur>cible), hors défense mutuelle. */
  aggressions: string[];
}

function provAt(state: EngineState, p: LngLat): string | null {
  const nav = W.nav;
  return nav.cellProv.get(nav.cellOfPos(p)) ?? null;
}

function nodeBranch(id: string): string {
  return world.research?.get(id)?.branch ?? '?';
}

function runGame(level: Level, seed: number, duel?: [Level, Level]): Record<string, unknown> {
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  const s = createGame(world, {
    seed,
    players: [{ nationId: HUMAN, isAi: false }],
    aiLevel: level,
    scenario: data.scenario,
    speed: 1,
  }) as EngineState;
  const tr: Track = {
    orders: {},
    refusals: {},
    groupSizes: [],
    captures: [],
    dests: new Map(),
    perNationDay: new Map(),
    research: {},
    produced: {},
    intel: {},
    examples: [],
    arrivals: new Map(),
    amph: [],
    air: {},
    prodSites: [0, 0],
    peaceToHuman: 0,
    aggressions: [],
  };
  setAiTracer((st, n, o, r) => {
    const k = o.kind === 'intelOp' ? `intel:${String(o.op)}` : o.kind;
    (tr.orders[k] ??= [0, 0])[r.ok ? 0 : 1]++;
    if (!r.ok)
      tr.refusals[`${k}:${r.error ?? '?'}`] = (tr.refusals[`${k}:${r.error ?? '?'}`] ?? 0) + 1;
    const day = Math.floor(st.time / DAY);
    tr.perNationDay.set(`${n}@${day}`, (tr.perNationDay.get(`${n}@${day}`) ?? 0) + 1);
    if (!r.ok) return;
    if (o.kind === 'research')
      tr.research[nodeBranch(String(o.nodeId))] =
        (tr.research[nodeBranch(String(o.nodeId))] ?? 0) + 1;
    if (o.kind === 'produce') {
      const sys = world.catalog.get(String((o as Order & { systemId: string }).systemId));
      const cat = sys?.category ?? '?';
      tr.produced[cat] = (tr.produced[cat] ?? 0) + ((o as { count?: number }).count ?? 1);
      tr.prodSites[1]++;
      if ((o as { provinceId: string }).provinceId !== W.nationById.get(n)?.capitalProvinceId)
        tr.prodSites[0]++;
    }
    if (o.kind === 'proposePeace' && (o as { nationId: string }).nationId === HUMAN)
      tr.peaceToHuman++;
    if (o.kind === 'declareWar') tr.aggressions.push(`${n}>${(o as { nationId: string }).nationId}`);
    if (o.kind === 'strike' || o.kind === 'patrol') {
      const ids = (o as { unitIds: string[] }).unitIds;
      const u0 = st.units[ids[0]!];
      const s0 = u0 ? sysOf(st, u0) : null;
      let k: string = o.kind;
      if (o.kind === 'strike' && s0?.movement === 'air') {
        const tg = (o as { target: { type: string; unitId?: string } }).target;
        const tu = tg.type === 'unit' ? st.units[tg.unitId!] : null;
        const ts = tu ? sysOf(st, tu) : null;
        k =
          tg.type === 'building'
            ? 'airDeep'
            : ts?.category === 'air_defense' || ts?.category === 'radar'
              ? 'airSead'
              : 'airGround';
      } else if (o.kind === 'strike') k = 'missile';
      else if (s0?.movement === 'sea') k = 'shipPatrol';
      else if (s0?.category === 'fighter') {
        const cap = W.nationById.get(n)?.capitalProvinceId;
        const capPt = cap ? W.provById.get(cap)!.cityPoint : null;
        const at = (o as { at: LngLat }).at;
        k = capPt && distanceKm(capPt, at) < 50 ? 'fighterCap' : 'fighterCover';
      } else k = 'otherPatrol';
      tr.air[k] = (tr.air[k] ?? 0) + 1;
    }
    if (o.kind === 'intelOp') tr.intel[String(o.op)] = (tr.intel[String(o.op)] ?? 0) + 1;
    if (o.kind === 'move' || o.kind === 'attack') {
      const ids = (o as { unitIds: string[] }).unitIds;
      // AIEVAL_WATCH=u123 : chaque ordre donné à cette unité, avec la situation des provinces.
      if (WATCH && ids.includes(WATCH)) {
        const to = o.kind === 'move' ? (o as { to: LngLat }).to : null;
        const pid = to ? provAt(st, to) : null;
        const mem = (st.mods as { ai?: { mem: Record<string, { commit?: unknown }> } }).ai?.mem[n];
        console.log(
          `  [${WATCH}] J${(st.time / DAY).toFixed(2)} ${n} ${o.kind} ${ids.length} unités → ` +
            `${pid ?? (o as { targetId?: string }).targetId} (à ${pid ? st.provinces[pid]?.owner : '?'})` +
            ` engagement ${JSON.stringify((mem?.commit as Record<string, unknown> | undefined)?.[WATCH] ?? null)}`,
        );
      }
      tr.groupSizes.push(ids.length);
      if (o.kind === 'move') {
        const to = (o as { to: LngLat }).to;
        const pid = provAt(st, to);
        const owner = pid ? st.provinces[pid]?.owner : null;
        for (const id of ids) {
          const list = tr.dests.get(id) ?? [];
          list.push({ to, t: st.time });
          tr.dests.set(id, list);
          if (owner && owner !== n && atWar(st, n, owner)) {
            tr.captures.push({ uid: id, n, to, t: st.time, pid });
            const legs = st.units[id]?.move?.legs;
            const eta = legs?.length ? legs[legs.length - 1]!.t1 : st.time;
            const key = `${n}|${pid}`;
            const arr = tr.arrivals.get(key) ?? [];
            arr.push({ t: st.time, eta });
            tr.arrivals.set(key, arr);
            if (legs?.some((l) => l.medium === 'sea'))
              tr.amph.push({ uid: id, n, t: st.time, pid });
          }
        }
      }
    }
  });

  const isAi = (n: NationId) => s.nations[n]?.isAi;
  const deficitAtStart = new Set<NationId>();
  for (const n of s.nationIds) {
    if (budgetDay(s, n) <= 0) continue;
    const b = breakdown(s, n);
    if (b.upkeepTotal > b.total) deficitAtStart.add(n);
  }
  let declared = 0;
  if (MODE !== 'free') {
    advanceTo(s, DAY);
    for (const [a, b] of WARS) {
      if (!s.nations[a] || !s.nations[b]) continue;
      if (duel) {
        s.nations[a]!.aiLevel = duel[0];
        s.nations[b]!.aiLevel = duel[1];
      }
      if (applyOrder(s, a, { kind: 'declareWar', nationId: b }).ok) declared++;
    }
  }

  // ——— Observation ———
  const notes: GameNotification[] = [];
  const start = Object.fromEntries(
    s.nationIds.map((n) => [n, { money: s.nations[n]!.money, provs: s.nations[n]!.provinceCount }]),
  );
  const capOf = (n: NationId) => W.nationById.get(n)?.capitalProvinceId;
  let samples = 0;
  const atWarSamples = {
    idleLand: 0,
    land: 0,
    capThreat: 0,
    capThreatThin: 0,
    capBare: 0,
    airUsed: 0,
    air: 0,
  };
  const capDefense: number[] = [];
  const bareBy = new Map<NationId, number>();
  const stuck = new Set<string>();
  const lastPos = new Map<string, { p: LngLat; t: number; moving: boolean }>();
  const peakWars = { n: 0 };
  const warringAi = new Set<NationId>();

  const end = (MODE === 'free' ? 0 : DAY) + DAYS * DAY;
  // Erreur d'estimation des forces voisines (|ln(estimée / réelle)|), estimation du moteur et
  // hypothèse miroir (provinces × force par province de l'observateur), relevée à J1, J7, J14.
  const estErr: Record<string, number[]> = { engine: [], mirror: [] };
  const estOver: Record<string, number> = { engine: 0, mirror: 0 };
  const estDays = new Set([1, 7, 14]);
  const plans = new Map<string, { n: NationId; t: NationId; at: number }>();
  // Dépêches d'ultimatum et de désescalade (relevées au fil de l'eau : le fil est borné).
  const seenNews = new Set<string>();
  const ultim = { all: 0, human: 0, deesc: 0, deescHuman: 0 };
  // Monde actif : guerres entre IA (paires régulières), début et fin relevés à chaque pas.
  const regular = (n: NationId) => !!W.nationById.get(n);
  const aiPair = (k: string) => {
    const [a, b] = k.split('|') as [NationId, NationId];
    return regular(a) && regular(b) && !!isAi(a) && !!isAi(b);
  };
  const warLog = new Map<string, { from: number; to: number | null; by: NationId }[]>();
  const openWars = new Set<string>();
  const peakAiWars = { n: 0, nations: 0 };
  const sampleWars = () => {
    const now = new Set(Object.keys(s.wars).filter(aiPair));
    for (const k of now) {
      if (openWars.has(k)) continue;
      openWars.add(k);
      const list = warLog.get(k) ?? [];
      list.push({ from: s.wars[k]!, to: null, by: ds(s).aggressor[k] ?? k.split('|')[0]! });
      warLog.set(k, list);
    }
    for (const k of [...openWars]) {
      if (now.has(k)) continue;
      openWars.delete(k);
      const list = warLog.get(k)!;
      list[list.length - 1]!.to = s.time;
    }
    peakAiWars.n = Math.max(peakAiWars.n, now.size);
    const inv = new Set<string>();
    for (const k of now) for (const x of k.split('|')) inv.add(x);
    peakAiWars.nations = Math.max(peakAiWars.nations, inv.size);
  };
  const owner0 = Object.fromEntries(Object.keys(s.provinces).map((p) => [p, s.provinces[p]!.owner]));
  while (s.time < end) {
    const out = advanceTo(s, Math.min(end, s.time + STEP));
    notes.push(...out);
    samples++;
    sampleWars();
    const mem =
      (s.mods as { ai?: { mem: Record<string, { plan?: { t: string } }> } }).ai?.mem ?? {};
    for (const x of Object.keys(mem).sort()) {
      const p = mem[x]!.plan;
      if (p && !plans.has(`${x}>${p.t}`)) plans.set(`${x}>${p.t}`, { n: x, t: p.t, at: s.time });
    }
    for (const it of ds(s).news) {
      if (seenNews.has(it.id)) continue;
      seenNews.add(it.id);
      const h = it.nations.includes(HUMAN);
      if (/renonce|Désescalade/.test(it.headline)) {
        ultim.deesc++;
        if (h) ultim.deescHuman++;
      } else if (/ultimatum|Tension extrême/i.test(it.headline)) {
        ultim.all++;
        if (h) ultim.human++;
      }
    }
    const dayNow = Math.round(s.time / DAY);
    if (s.time % DAY === 0 && estDays.has(dayNow)) {
      estDays.delete(dayNow);
      for (const n of s.nationIds) {
        const ns = s.nations[n]!;
        if (!ns.isAi || !ns.alive) continue;
        const mine = ownForce(s, n);
        for (const t of neighborNations(s, n)) {
          const real = ownForce(s, t).value;
          if (!s.nations[t]?.alive || real <= 0) continue;
          const e1 = estimateForce(s, n, t, mine, 1);
          const e2 = s.nations[t]!.provinceCount * mine.perProvince;
          if (e1 > 0) estErr.engine!.push(Math.abs(Math.log(e1 / real)));
          if (e2 > 0) estErr.mirror!.push(Math.abs(Math.log(e2 / real)));
          if (e1 > real) estOver.engine!++;
          if (e2 > real) estOver.mirror!++;
        }
      }
    }
    peakWars.n = Math.max(peakWars.n, Object.keys(s.wars).length);
    const ms = mil(s).ms;
    for (const n of s.nationIds) {
      const ns = s.nations[n]!;
      if (!ns.isAi || !ns.alive) continue;
      const enemies = warsOf(s, n);
      if (enemies.length === 0) continue;
      warringAi.add(n);
      const cap = capOf(n);
      const capPt = cap ? W.provById.get(cap)!.cityPoint : null;
      let defenders = 0;
      // Garnison effective : unité terrestre arrêtée dans la ville (elle empêche la capture).
      let garrisoned = 0;
      const gc = s.world.balance.combat.groundContactKm;
      for (const id of nationUnits(s, n)) {
        const u = s.units[id]!;
        if (u.role || u.off) continue;
        const sys = sysOf(s, u);
        const p = unitPosAt(s, u, s.time);
        if (LAND.has(sys.category) && sys.movement === 'land') {
          atWarSamples.land++;
          if (!u.move && !u.target) atWarSamples.idleLand++;
          if (capPt && distanceKm(p, capPt) <= 150) defenders++;
          if (capPt && !u.move && distanceKm(p, capPt) <= gc) garrisoned++;
          // Bloquée : un trajet en cours mais aucun déplacement en 24 h.
          const prev = lastPos.get(id);
          if (prev && u.move && prev.moving && s.time - prev.t >= DAY && distanceKm(prev.p, p) < 1)
            stuck.add(id);
          if (!prev || s.time - prev.t >= DAY) lastPos.set(id, { p, t: s.time, moving: !!u.move });
        } else if (sys.movement === 'air' && ms[id]) {
          atWarSamples.air++;
          if (ms[id]!.mis !== 'none') atWarSamples.airUsed++;
        }
      }
      // Menace sur la capitale : unité terrestre ennemie (réelle) à moins de 300 km.
      if (capPt && s.provinces[cap!]?.owner === n) {
        let threat = 0;
        for (const e of enemies) {
          for (const id of nationUnits(s, e)) {
            const u = s.units[id]!;
            if (u.role || u.off) continue;
            const sys = sysOf(s, u);
            if (sys.movement !== 'land' || !sys.canCapture) continue;
            if (distanceKm(unitPosAt(s, u, s.time), capPt) <= 300) threat++;
          }
        }
        if (threat > 0) {
          atWarSamples.capThreat++;
          capDefense.push(defenders / threat);
          if (defenders < threat) atWarSamples.capThreatThin++;
          if (garrisoned === 0) {
            atWarSamples.capBare++;
            bareBy.set(n, (bareBy.get(n) ?? 0) + 1);
          }
        }
      }
    }
  }
  setAiTracer(null);

  // ——— Bilan ———
  const byKind = (k: string) => notes.filter((x) => x.kind === k);
  const captured = byKind('province_captured') as Extract<
    GameNotification,
    { kind: 'province_captured' }
  >[];
  const capitalLost = captured.filter((c) => capOf(c.from) === c.provinceId);
  const liberations = captured.filter((c) => W.provById.get(c.provinceId)?.nationId === c.by);
  const wars = byKind('war_declared') as Extract<GameNotification, { kind: 'war_declared' }>[];
  const aiWars = wars.filter((x) => isAi(x.by) && x.time > (MODE === 'free' ? 0 : DAY + 1));
  const neighborAt0 = (a: NationId, b: NationId) =>
    W.provsByNation
      .get(a)
      ?.some((p) => W.provById.get(p)!.neighbors.some((q) => W.provById.get(q)?.nationId === b));
  const farWars = aiWars.filter((x) => !neighborAt0(x.by, x.against));
  const destroyed = byKind('unit_destroyed') as Extract<
    GameNotification,
    { kind: 'unit_destroyed' }
  >[];

  // Captures tentées : succès (province prise par la nation) et « suicides » (unité détruite sans prise).
  const capturedBy = new Map<string, number>();
  for (const c of captured) capturedBy.set(`${c.by}|${c.provinceId}`, c.time);
  const deadAt = new Map<string, number>();
  for (const d of destroyed) deadAt.set(d.unitId, d.time);
  let capOk = 0;
  let capDead = 0;
  for (const c of tr.captures) {
    const ok = c.pid ? capturedBy.get(`${c.n}|${c.pid}`) : undefined;
    if (ok !== undefined && ok >= c.t) capOk++;
    else if ((deadAt.get(c.uid) ?? -1) >= c.t) capDead++;
  }
  // Va-et-vient : une unité renvoyée vers une destination déjà quittée (A → B → A) en moins de 24 h.
  let pingPong = 0;
  const pingExamples: string[] = [];
  for (const [uid, list] of tr.dests) {
    for (let i = 2; i < list.length; i++) {
      if (
        list[i]!.t - list[i - 2]!.t < DAY &&
        distanceKm(list[i]!.to, list[i - 2]!.to) < 30 &&
        distanceKm(list[i]!.to, list[i - 1]!.to) > 30
      ) {
        pingPong++;
        if (pingExamples.length < 8) {
          const where = (p: LngLat) => provAt(s, p) ?? 'mer';
          pingExamples.push(
            `${uid} : ` +
              list
                .slice(i - 2, i + 1)
                .map((x) => `J${(x.t / DAY).toFixed(2)}→${where(x.to)}`)
                .join(' '),
          );
        }
      }
    }
  }
  // Inactivité : nation IA en guerre sans aucun ordre pendant un jour entier.
  let idleDays = 0;
  let warDays = 0;
  for (const n of warringAi) {
    for (let d = MODE === 'free' ? 0 : 1; d < (MODE === 'free' ? DAYS : DAYS + 1); d++) {
      warDays++;
      if (!tr.perNationDay.get(`${n}@${d}`)) idleDays++;
    }
  }
  // Économie de toutes les IA dotées d'un budget.
  const eco = {
    nations: 0,
    negative: 0,
    belowDay: 0,
    poorer: 0,
    upkeepOver: 0,
    researchDone: 0,
    minDays: Infinity,
    /** En solde négatif sans être en déficit structurel au départ : faillite due aux dépenses. */
    negativeSolvent: 0,
    /** Déficit structurel au départ (entretien de l'ORBAT supérieur au budget). */
    deficitAtStart: deficitAtStart.size,
  };
  for (const n of s.nationIds) {
    const ns = s.nations[n]!;
    if (!ns.isAi || !ns.alive) continue;
    const bd = budgetDay(s, n);
    if (bd <= 0) continue;
    eco.nations++;
    if (ns.money < 0) eco.negative++;
    if (ns.money < 0 && !deficitAtStart.has(n)) eco.negativeSolvent++;
    if (ns.money < bd) eco.belowDay++;
    if (ns.money < start[n]!.money) eco.poorer++;
    eco.minDays = Math.min(eco.minDays, ns.money / bd);
    const b = breakdown(s, n);
    if (b.upkeepTotal > b.total) eco.upkeepOver++;
    eco.researchDone += ecoNation(s, n).doneAt ? Object.keys(ecoNation(s, n).doneAt).length : 0;
  }
  // Duel : bilan territorial agresseur / cible.
  let duelScore: Record<string, number> | undefined;
  if (duel) {
    duelScore = { aggressorGain: 0, targetGain: 0 };
    for (const [a, b] of WARS) {
      if (!s.nations[a] || !s.nations[b]) continue;
      duelScore.aggressorGain! += s.nations[a]!.provinceCount - start[a]!.provs;
      duelScore.targetGain! += s.nations[b]!.provinceCount - start[b]!.provs;
    }
  }
  // Joueur humain : guerres déclarées contre lui, délai de la première, issue.
  const humanWars = wars
    .filter((x) => x.against === HUMAN && isAi(x.by))
    .map((x) => {
      const peace = (
        byKind('peace_signed') as Extract<GameNotification, { kind: 'peace_signed' }>[]
      )
        .filter((p) => p.time >= x.time && [p.a, p.b].includes(HUMAN) && [p.a, p.b].includes(x.by))
        .map((p) => p.time)[0];
      const taken = captured.filter(
        (c) => c.by === x.by && c.from === HUMAN && c.time >= x.time && (!peace || c.time <= peace),
      ).length;
      return {
        by: x.by,
        day: Math.round((x.time / DAY) * 10) / 10,
        taken,
        end: peace
          ? `paix J${(peace / DAY).toFixed(1)}`
          : atWar(s, x.by, HUMAN)
            ? 'en cours'
            : 'finie',
      };
    });
  const spreads: number[] = [];
  for (const key of [...tr.arrivals.keys()].sort()) {
    const list = tr.arrivals.get(key)!.sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1]!.t - list[i]!.t <= 12 * HOUR) j++;
      if (j > i) {
        const etas = list.slice(i, j + 1).map((x) => x.eta);
        spreads.push((Math.max(...etas) - Math.min(...etas)) / HOUR);
      }
      i = j + 1;
    }
  }
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const a = [...xs].sort((p, q) => p - q);
    return Math.round(a[Math.floor(a.length / 2)]! * 100) / 100;
  };
  const amphOk = tr.amph.filter((c) => {
    const ok = c.pid ? capturedBy.get(`${c.n}|${c.pid}`) : undefined;
    return ok !== undefined && ok >= c.t;
  }).length;
  const amphDead = tr.amph.filter((c) => (deadAt.get(c.uid) ?? -1) >= c.t).length;
  const d = ds(s);
  const alliances = Object.values(d.alliances);
  // Monde actif : bilan des guerres entre IA.
  const t0w = MODE === 'free' ? 0 : DAY + 1;
  const aiWarList = [...warLog.entries()]
    .flatMap(([k, l]) => l.map((x) => ({ k, ...x })))
    .filter((x) => x.from >= t0w);
  const ended = aiWarList.filter((x) => x.to !== null);
  const durations = ended.map((x) => (x.to! - x.from) / DAY);
  const aiCaptured = captured.filter(
    (c) => isAi(c.by) && isAi(c.from) && c.time >= t0w && regular(c.by) && regular(c.from),
  );
  const changed = Object.keys(s.provinces).filter((p) => s.provinces[p]!.owner !== owner0[p]);
  const aiPeace = (
    byKind('peace_signed') as Extract<GameNotification, { kind: 'peace_signed' }>[]
  ).filter((p) => isAi(p.a) && isAi(p.b) && p.time >= t0w);
  const conquests = new Set(aiCaptured.map((c) => `${c.by}>${c.from}`));
  const aggr = tr.aggressions.filter((x) => {
    const [a, b] = x.split('>') as [NationId, NationId];
    return isAi(a) && isAi(b);
  });
  const worldStats = {
    aiAiWars: aiWarList.length,
    aiAggressions: aggr.length,
    aiAllianceWars: Math.max(0, aiWarList.length - aggr.length),
    aiWarsEnded: ended.length,
    aiWarDaysAvg: durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : 0,
    aiWarDaysMedian: median(durations),
    aiWarsOngoing: aiWarList.length - ended.length,
    peakAiWars: peakAiWars.n,
    peakNationsAtWar: peakAiWars.nations,
    aiPeace: aiPeace.length,
    aiProvincesTaken: aiCaptured.length,
    conquerors: conquests.size,
    provincesChangedHands: changed.length,
    defeatedAi: (byKind('nation_defeated') as Extract<GameNotification, { kind: 'nation_defeated' }>[]).filter(
      (x) => isAi(x.nationId),
    ).length,
  };
  const warLines = aiWarList.map((x) => {
    const [a, b] = x.k.split('|') as [NationId, NationId];
    const tgt = x.by === a ? b : a;
    const taken = aiCaptured.filter(
      (c) =>
        [c.by, c.from].includes(a) &&
        [c.by, c.from].includes(b) &&
        c.time >= x.from &&
        (x.to === null || c.time <= x.to),
    );
    const gain = taken.filter((c) => c.by === x.by).length;
    const loss = taken.length - gain;
    const kind = aggr.includes(`${x.by}>${tgt}`) ? 'agression' : 'alliance';
    return `J${(x.from / DAY).toFixed(1)}–${x.to === null ? 'en cours' : `J${(x.to / DAY).toFixed(1)}`} ${x.by}→${tgt} (${kind}) +${gain}/-${loss}`;
  });
  const cpu = process.cpuUsage(c0);
  const groups = tr.groupSizes;
  const r = {
    mode: MODE,
    level: duel ? `${duel[0]}>${duel[1]}` : level,
    seed,
    days: DAYS,
    hash: stateHash(s),
    cpuS: Math.round((cpu.user + cpu.system) / 1e5) / 10,
    wallS: Math.round((performance.now() - t0) / 100) / 10,
    forcedWars: declared,
    aiWarsDeclared: aiWars.length,
    aiWarsNonNeighbor: farWars.length,
    warsAtEnd: Object.keys(s.wars).length,
    peakWars: peakWars.n,
    peace: byKind('peace_signed').length,
    alliances: alliances.length,
    allianceMembers: alliances.reduce((a, x) => a + x.members.length, 0),
    defeated: byKind('nation_defeated').length,
    provincesCaptured: captured.length,
    liberations: liberations.length,
    capitalsLost: capitalLost.length,
    unitsDestroyed: destroyed.length,
    captureOrders: tr.captures.length,
    captureSuccess: capOk,
    captureUnitLost: capDead,
    groupAvg: groups.length
      ? Math.round((groups.reduce((a, b) => a + b, 0) / groups.length) * 100) / 100
      : 0,
    groupSolo: groups.length
      ? Math.round((groups.filter((g) => g === 1).length / groups.length) * 100)
      : 0,
    idleLandPct: atWarSamples.land
      ? Math.round((atWarSamples.idleLand / atWarSamples.land) * 100)
      : 0,
    airInMissionPct: atWarSamples.air
      ? Math.round((atWarSamples.airUsed / atWarSamples.air) * 100)
      : 0,
    capThreatSamples: atWarSamples.capThreat,
    capBarePct: atWarSamples.capThreat
      ? Math.round((atWarSamples.capBare / atWarSamples.capThreat) * 100)
      : 0,
    capThreatThinPct: atWarSamples.capThreat
      ? Math.round((atWarSamples.capThreatThin / atWarSamples.capThreat) * 100)
      : 0,
    stuckUnits: stuck.size,
    pingPong,
    idleWarDaysPct: warDays ? Math.round((idleDays / warDays) * 100) : 0,
    human: HUMAN,
    humanWars,
    humanPlans: [...plans.values()]
      .filter((p) => p.t === HUMAN)
      .map((p) => `${p.n}@J${(p.at / DAY).toFixed(1)}`),
    ultimatums: ultim.human,
    deescalations: ultim.deescHuman,
    ultimatumsAll: ultim.all,
    deescalationsAll: ultim.deesc,
    humanProvLost: start[HUMAN] ? start[HUMAN]!.provs - (s.nations[HUMAN]?.provinceCount ?? 0) : 0,
    humanAlive: !!s.nations[HUMAN]?.alive,
    peaceToHuman: tr.peaceToHuman,
    waves: spreads.length,
    spreadAvgH: spreads.length
      ? Math.round((spreads.reduce((a, b) => a + b, 0) / spreads.length) * 10) / 10
      : 0,
    spreadOver3hPct: spreads.length
      ? Math.round((spreads.filter((x) => x > 3).length / spreads.length) * 100)
      : 0,
    amphOrders: tr.amph.length,
    amphSuccess: amphOk,
    amphUnitLost: amphDead,
    air: tr.air,
    prodOutsideCapitalPct: tr.prodSites[1]
      ? Math.round((tr.prodSites[0] / tr.prodSites[1]) * 100)
      : 0,
    estErrEngine: median(estErr.engine!),
    estErrMirror: median(estErr.mirror!),
    estOverEnginePct: estErr.engine!.length
      ? Math.round((estOver.engine! / estErr.engine!.length) * 100)
      : 0,
    estOverMirrorPct: estErr.mirror!.length
      ? Math.round((estOver.mirror! / estErr.mirror!.length) * 100)
      : 0,
    eco: { ...eco, minDays: Math.round(eco.minDays * 10) / 10 },
    orders: tr.orders,
    refusals: Object.fromEntries(
      Object.entries(tr.refusals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    ),
    research: tr.research,
    produced: tr.produced,
    intel: tr.intel,
    ...(duelScore ? { duel: duelScore } : {}),
    world: worldStats,
    warLines,
  };
  if (VERBOSE) {
    console.log(`\n=== ${r.level} graine ${seed} ===`);
    for (const x of aiWars) {
      const nb = neighborAt0(x.by, x.against) ? 'voisin' : 'NON VOISIN';
      console.log(`  J${(x.time / DAY).toFixed(1)} guerre ${x.by} → ${x.against} (${nb})`);
    }
    for (const x of pingExamples) console.log('  va-et-vient', x);
    const capBy = new Map<string, [number, number, number]>();
    for (const c of tr.captures) {
      const k = `${c.n}→${c.pid ? W.provById.get(c.pid)?.nationId : '?'}`;
      const e = capBy.get(k) ?? [0, 0, 0];
      e[0]++;
      const ok = c.pid ? capturedBy.get(`${c.n}|${c.pid}`) : undefined;
      if (ok !== undefined && ok >= c.t) e[1]++;
      else if ((deadAt.get(c.uid) ?? -1) >= c.t) e[2]++;
      capBy.set(k, e);
    }
    console.log(
      '  captures (ordres/pris/perdus)',
      [...capBy]
        .sort((a, b) => b[1][2] - a[1][2])
        .slice(0, 10)
        .map(([k, v]) => `${k}:${v.join('/')}`)
        .join(' '),
    );
    const amphBy = new Map<string, [number, number, number]>();
    for (const c of tr.amph) {
      const k = `${c.n}→${c.pid ? W.provById.get(c.pid)?.nationId : '?'}`;
      const e = amphBy.get(k) ?? [0, 0, 0];
      e[0]++;
      const ok = c.pid ? capturedBy.get(`${c.n}|${c.pid}`) : undefined;
      if (ok !== undefined && ok >= c.t) e[1]++;
      else if ((deadAt.get(c.uid) ?? -1) >= c.t) e[2]++;
      amphBy.set(k, e);
    }
    console.log(
      '  débarquements (ordres/pris/perdus)',
      [...amphBy].map(([k, v]) => `${k}:${v.join('/')}`).join(' '),
    );
    console.log(
      '  capitale dégarnie (relevés)',
      [...bareBy]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v}`)
        .join(' '),
    );
    for (const c of captured.slice(0, 40))
      console.log(
        `  J${(c.time / DAY).toFixed(1)} ${c.by} prend ${c.provinceId} à ${c.from}${capOf(c.from) === c.provinceId ? ' (CAPITALE)' : ''}`,
      );
    for (const [a, b] of WARS) {
      if (!s.nations[a] || !s.nations[b]) continue;
      const line = (n: NationId) => {
        const units = nationUnits(s, n)
          .map((id) => s.units[id]!)
          .filter((u: Unit) => !u.role);
        return `${n} ${s.nations[n]!.provinceCount}/${start[n]!.provs} prov, ${units.length} unités, ${(s.nations[n]!.money / 1e9).toFixed(1)} G$ (${(start[n]!.money / 1e9).toFixed(1)}), file ${s.nations[n]!.production.length}`;
      };
      console.log(
        `  ${line(a)} | ${line(b)} | guerre ${atWar(s, a, b) ? 'en cours' : 'finie'} | voisins ${neighborNations(s, a).includes(b)}`,
      );
    }
  }
  return r;
}

const results: Record<string, unknown>[] = [];
for (const h of HUMANS) {
  HUMAN = h;
  WARS = ALL_WARS.filter(([a, b]) => a !== HUMAN && b !== HUMAN);
  if (MODE === 'duel') {
    const [x, y] = (env.AIEVAL_DUEL ?? 'hard:easy').split(':') as [Level, Level];
    for (const seed of SEEDS) {
      results.push(runGame('normal', seed, [x, y]));
      results.push(runGame('normal', seed, [y, x]));
    }
  } else {
    for (const level of LEVELS) for (const seed of SEEDS) results.push(runGame(level, seed));
  }
}
for (const r of results) {
  const {
    orders,
    refusals,
    research,
    produced,
    intel,
    eco,
    humanWars,
    air,
    world: wld,
    warLines,
    ...flat
  } = r as Record<string, unknown>;
  console.log('\n' + JSON.stringify(flat));
  console.log('  monde', JSON.stringify(wld));
  for (const l of (warLines as string[]).slice(0, 60)) console.log('   ', l);
  console.log('  joueur', JSON.stringify(humanWars), 'air', JSON.stringify(air));
  console.log('  éco', JSON.stringify(eco));
  console.log('  ordres', JSON.stringify(orders));
  console.log('  refus', JSON.stringify(refusals));
  console.log(
    '  recherche',
    JSON.stringify(research),
    'production',
    JSON.stringify(produced),
    'renseignement',
    JSON.stringify(intel),
  );
  if (env.AIEVAL_JSON) console.log('AIEVAL_JSON ' + JSON.stringify(r));
}
