// Évaluation mesurée de l'IA sur la vraie partie (carte, catalogue, ORBAT 2025, scénario « world-today »).
//
//   node --expose-gc bench/run.mjs ai-eval                     (depuis packages/engine)
//   AIEVAL_MODE=forced|free|duel   (défaut forced)
//     forced : guerres réalistes déclarées à J1 entre IA (les deux camps jouent seuls) ;
//     free   : aucune guerre imposée, on observe ce que les IA décident d'elles-mêmes ;
//     duel   : mêmes guerres, l'agresseur et la cible de chaque paire à des niveaux différents
//              (AIEVAL_DUEL=hard:easy, puis inversé dans une seconde passe).
//   AIEVAL_LEVELS=easy,normal,hard  AIEVAL_SEEDS=1,2  AIEVAL_DAYS=14  AIEVAL_HUMAN=fra (joueur passif)
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
import { neighborNations } from '../src/ai/estimate.js';
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
const HUMAN = env.AIEVAL_HUMAN ?? 'fra';
const VERBOSE = !!env.AIEVAL_VERBOSE;
const STEP = 6 * HOUR;

/** Guerres imposées (agresseur, cible), toutes entre IA. */
const WARS: [NationId, NationId][] = [
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
].filter(([a, b]) => a !== HUMAN && b !== HUMAN) as [NationId, NationId][];

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
    }
    if (o.kind === 'intelOp') tr.intel[String(o.op)] = (tr.intel[String(o.op)] ?? 0) + 1;
    if (o.kind === 'move' || o.kind === 'attack') {
      const ids = (o as { unitIds: string[] }).unitIds;
      tr.groupSizes.push(ids.length);
      if (o.kind === 'move') {
        const to = (o as { to: LngLat }).to;
        const pid = provAt(st, to);
        const owner = pid ? st.provinces[pid]?.owner : null;
        for (const id of ids) {
          const list = tr.dests.get(id) ?? [];
          list.push({ to, t: st.time });
          tr.dests.set(id, list);
          if (owner && owner !== n && atWar(st, n, owner))
            tr.captures.push({ uid: id, n, to, t: st.time, pid });
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
  const stuck = new Set<string>();
  const lastPos = new Map<string, { p: LngLat; t: number; moving: boolean }>();
  const peakWars = { n: 0 };
  const warringAi = new Set<NationId>();

  const end = (MODE === 'free' ? 0 : DAY) + DAYS * DAY;
  while (s.time < end) {
    const out = advanceTo(s, Math.min(end, s.time + STEP));
    notes.push(...out);
    samples++;
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
          if (garrisoned === 0) atWarSamples.capBare++;
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
  const d = ds(s);
  const alliances = Object.values(d.alliances);
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
  };
  if (VERBOSE) {
    console.log(`\n=== ${r.level} graine ${seed} ===`);
    for (const x of aiWars) {
      const nb = neighborAt0(x.by, x.against) ? 'voisin' : 'NON VOISIN';
      console.log(`  J${(x.time / DAY).toFixed(1)} guerre ${x.by} → ${x.against} (${nb})`);
    }
    for (const x of pingExamples) console.log('  va-et-vient', x);
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
if (MODE === 'duel') {
  const [x, y] = (env.AIEVAL_DUEL ?? 'hard:easy').split(':') as [Level, Level];
  for (const seed of SEEDS) {
    results.push(runGame('normal', seed, [x, y]));
    results.push(runGame('normal', seed, [y, x]));
  }
} else {
  for (const level of LEVELS) for (const seed of SEEDS) results.push(runGame(level, seed));
}
for (const r of results) {
  const { orders, refusals, research, produced, intel, eco, ...flat } = r as Record<
    string,
    unknown
  >;
  console.log('\n' + JSON.stringify(flat));
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
