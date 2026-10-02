import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, HOUR, type IntelOpTarget } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  notificationsFor,
  serializeState,
  stateHash,
  viewFor,
  type World,
} from '../src/index.js';
import { catchQuietly, publicArrest } from '../src/modules/intel/agents.js';
import { addTie, assess, retaliate, serviceHit, tie } from '../src/modules/intel/detainees.js';
import { DZ_DEFAULTS, dzcfg } from '../src/modules/intel/dzconfig.js';
import { swapGain } from '../src/modules/intel/swaps.js';
import { ist, type Agent } from '../src/modules/intel/state.js';
import { ds, reputation, stabilityOf } from '../src/modules/diplo/state.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, CATALOG, buildMap, cityOf } from './fixtures.js';
import { readFileSync } from 'node:fs';

/**
 * Détenus : décisions du pays geôlier et leurs conséquences, représailles des IA, négociations
 * (échanges acceptés, refusés, contre-propositions), fins de peine, régimes politiques, vues sans fuite,
 * déterminisme et anciennes sauvegardes.
 *
 * Régimes de la carte de test : aaa démocratie, bbb autoritaire, ccc hybride, ddd autoritaire.
 */
const worlds = new Map<string, World>();

function world(over: Record<string, unknown> = {}): World {
  const key = JSON.stringify(over);
  let w = worlds.get(key);
  if (!w) {
    const balance = BalanceSchema.parse({
      ...BALANCE,
      intel: {
        detainees: {
          nations: { democracy: ['aaa'], authoritarian: ['bbb', 'ddd'] },
          ...over,
        },
      },
      buildings: { distribute: false },
    });
    w = buildWorld(buildMap(), CATALOG, balance);
    worlds.set(key, w);
  }
  return w;
}

function game(over: Record<string, unknown> = {}, seed = 7): EngineState {
  const s = createGame(world(over), {
    seed,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
      { nationId: 'ccc', isAi: true },
      { nationId: 'ddd', isAi: true },
    ],
    units: [],
  }) as EngineState;
  for (const n of s.nationIds) s.nations[n]!.money = 1e10;
  return s;
}

/** Agent de `owner` implanté chez `host` (opération réussie d'office). */
function plant(
  s: EngineState,
  owner: string,
  host: string,
  op: 'infiltrate_spy' | 'recruit_source' = 'infiltrate_spy',
  cover: IntelOpTarget['cover'] = 'nonofficial',
): Agent {
  const r = applyOrder(s, owner, { kind: 'intelOp', op, target: { nationId: host, cover } });
  if (!r.ok) throw new Error(r.message);
  const o = ist(s).nations[owner]!.ops.at(-1)!;
  o.estimate = 1;
  delete o.dt;
  advanceTo(s, o.completesAt);
  const mine = Object.values(ist(s).agents).filter((a) => a.owner === owner && a.host === host);
  return mine[mine.length - 1]!;
}

/** Agent arrêté publiquement : détenu de `host`. */
function detainee(
  s: EngineState,
  owner: string,
  host: string,
  op: 'infiltrate_spy' | 'recruit_source' = 'infiltrate_spy',
  cover: IntelOpTarget['cover'] = 'nonofficial',
): Agent {
  const a = plant(s, owner, host, op, cover);
  publicArrest(s, a);
  return a;
}

const order = (s: EngineState, n: string, action: string, id: string, days?: number) =>
  applyOrder(s, n, {
    kind: 'detainee',
    agentId: id,
    action: action as 'expel',
    ...(days ? { days } : {}),
  });

describe('détenus : arrestation et décision attendue', () => {
  it('agent arrêté : détenu en attente, détention provisoire faute de décision', () => {
    const s = game();
    const a = detainee(s, 'bbb', 'aaa');
    expect(a.dn).toMatchObject({ k: 'illegal', s: 'pending' });
    const host = viewFor(s, 'aaa').intel!;
    const d = host.detainees!.find((x) => x.id === a.id)!;
    expect(d.kind).toBe('illegal');
    expect(d.nationId).toBe('bbb');
    expect(d.decideBy).toBe(a.dn!.at + 3 * DAY);
    expect(d.options!.map((o) => o.action)).toEqual([
      'interrogate',
      'expel',
      'jail',
      'jail',
      'jail',
      'execute',
      'turn',
      'release',
    ]);
    // Le geôlier ignore le nom de code ; le propriétaire voit son agent détenu.
    expect(JSON.stringify(host.detainees)).not.toContain(a.codename);
    const own = viewFor(s, 'bbb').intel!.agents.find((x) => x.id === a.id)!;
    expect(own.status).toBe('captured');
    expect(own.detention).toEqual({ fate: 'held', since: a.dn!.at });
    advanceTo(s, a.dn!.by + 1);
    expect(a.dn!.s).toBe('held');
    expect(viewFor(s, 'aaa').intel!.detainees![0]!.status).toBe('held');
  });

  it('interpeller un agent démasqué, retourné ou non', () => {
    const s = game();
    const a = plant(s, 'bbb', 'aaa');
    catchQuietly(s, a);
    expect(viewFor(s, 'aaa').intel!.caughtAgents.map((x) => x.id)).toContain(a.id);
    expect(order(s, 'aaa', 'arrest', a.id).ok).toBe(true);
    expect(a.dn!.k).toBe('illegal');
    expect(viewFor(s, 'aaa').intel!.caughtAgents.map((x) => x.id)).not.toContain(a.id);
    // Un agent retourné interpellé devient un détenu « agent double ».
    const b = plant(s, 'bbb', 'aaa', 'recruit_source');
    b.state = 'double';
    b.caughtAt = s.time;
    expect(order(s, 'aaa', 'arrest', b.id).ok).toBe(true);
    expect(b.dn!.k).toBe('double');
    expect(assess(s, b, 'turn').reason).toBe('not_plausible');
    // Le propriétaire n'apprend jamais qu'il était doublé.
    expect(JSON.stringify(viewFor(s, 'bbb').intel)).not.toContain('"double"');
  });
});

describe('détenus : décisions et conséquences', () => {
  it('expulsion d’un diplomate, renvoi d’un clandestin : conséquences légères', () => {
    const s = game();
    const dip = detainee(s, 'bbb', 'aaa', 'infiltrate_spy', 'diplomatic');
    const ill = detainee(s, 'bbb', 'aaa');
    const e = assess(s, dip, 'expel').effects;
    expect(e.relations).toBe(-6);
    expect(e.serviceHit).toBe(0.15);
    const t0 = tie(s, 'aaa', 'bbb');
    expect(order(s, 'aaa', 'expel', dip.id).ok).toBe(true);
    expect(tie(s, 'aaa', 'bbb')).toBeCloseTo(t0 - 6, 5);
    expect(dip.dn!.s).toBe('expelled');
    expect(serviceHit(s, 'bbb', 'aaa')).toBe(0.15);
    expect(order(s, 'aaa', 'expel', ill.id).ok).toBe(true);
    expect(ill.dn!.s).toBe('returned');
    const own = viewFor(s, 'bbb').intel!.agents;
    expect(own.find((x) => x.id === dip.id)!.status).toBe('expelled');
    expect(own.find((x) => x.id === ill.id)!.detention!.fate).toBe('returned');
    // Plus de décision possible sur un détenu sorti.
    expect(order(s, 'aaa', 'jail', ill.id, 30).ok).toBe(false);
  });

  it('prison : durée choisie, pression diplomatique, libération à la fin de la peine', () => {
    const s = game();
    const a = detainee(s, 'bbb', 'aaa');
    const e = assess(s, a, 'jail', 90).effects;
    expect(e.relations).toBeCloseTo(-12 - (10 * 90) / 365, 1);
    expect(e.stability).toBe(1);
    expect(e.pressurePerDay).toBe(1);
    const st0 = stabilityOf(s, 'aaa');
    expect(order(s, 'aaa', 'jail', a.id, 90).ok).toBe(true);
    expect(stabilityOf(s, 'aaa')).toBeCloseTo(st0 + 1, 5);
    expect(a.dn).toMatchObject({ s: 'jailed', days: 90 });
    const own = viewFor(s, 'bbb').intel!.agents.find((x) => x.id === a.id)!;
    expect(own.detention).toMatchObject({ fate: 'jailed', days: 90, until: a.dn!.until });
    // Pression diplomatique : les relations baissent chaque jour tant qu'il est détenu.
    const t1 = tie(s, 'aaa', 'bbb');
    advanceTo(s, s.time + 3 * DAY);
    expect(tie(s, 'aaa', 'bbb')).toBeLessThan(t1);
    const notes = advanceTo(s, a.dn!.until! + HOUR);
    expect(a.dn!.s).toBe('served');
    expect(viewFor(s, 'bbb').intel!.agents.find((x) => x.id === a.id)!.status).toBe('released');
    expect(
      notificationsFor(s, 'bbb', notes).some(
        (n) => n.kind === 'generic' && n.category === 'detainee',
      ),
    ).toBe(true);
  });

  it('exécution : impossible en paix pour une démocratie, très coûteuse en guerre', () => {
    const s = game();
    const a = detainee(s, 'ccc', 'aaa');
    expect(assess(s, a, 'execute').reason).toBe('war_only');
    expect(order(s, 'aaa', 'execute', a.id).ok).toBe(false);
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'ccc' }).ok).toBe(true);
    const e = assess(s, a, 'execute').effects;
    expect(e.relations).toBe(-40);
    expect(e.reputation).toBe(-18);
    expect(e.stability).toBe(-6);
    expect(e.worldRelations).toBe(-10);
    expect(e.council).toBe(0.6);
    expect(e.retaliation).toBeGreaterThan(0.7);
    const rep0 = reputation(s, 'aaa');
    expect(order(s, 'aaa', 'execute', a.id).ok).toBe(true);
    expect(a.dn!.s).toBe('executed');
    expect(reputation(s, 'aaa')).toBeLessThan(rep0 - 10);
    expect(viewFor(s, 'ccc').intel!.agents.find((x) => x.id === a.id)!.status).toBe('executed');
    // Représailles mémorisées par l'IA d'origine, service dissuadé contre nous.
    expect(ist(s).gr!['ccc>aaa']).toMatchObject({ k: 'execute' });
    expect(serviceHit(s, 'ccc', 'aaa')).toBe(0.35);
    // Dépêche publique.
    expect(ds(s).news.some((n) => n.loc?.headline.key === 'engine.spyNews.executedH')).toBe(true);
  });

  it('exécution par un régime autoritaire : possible en paix, coût intérieur moindre', () => {
    const s = game();
    const a = detainee(s, 'aaa', 'bbb');
    const e = assess(s, a, 'execute').effects;
    expect(assess(s, a, 'execute').allowed).toBe(true);
    // Paix : relations et réputation × 1,5 ; stabilité intérieure en hausse (fermeté).
    expect(e.relations).toBe(-60);
    expect(e.reputation).toBe(-13.5);
    expect(e.stability).toBe(1);
    const dem = detainee(s, 'bbb', 'aaa');
    applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    // Démocratie en guerre : stabilité en baisse, réprobation des démocraties.
    expect(assess(s, dem, 'execute').effects.stability).toBeLessThan(0);
    // Diplomate : violation de l'immunité en plus.
    const dip = detainee(s, 'aaa', 'bbb', 'infiltrate_spy', 'diplomatic');
    const ed = assess(s, dip, 'execute').effects;
    expect(ed.immunity).toBe(true);
    expect(ed.reputation).toBeLessThan(assess(s, a, 'execute').effects.reputation);
  });

  it('interrogatoire : réseau identifié, opérations éventées ; aucune autre décision pendant', () => {
    // Aveux certains au tirage près (chance plafonnée à 95 %) : graine fixée.
    const s = game(
      {
        interrogateYield: { diplomat: 1, illegal: 1, source: 1, double: 1 },
        interrogateFalse: { diplomat: 0, illegal: 0, source: 0, double: 0 },
        interrogateHours: 12,
      },
      8,
    );
    const b1 = plant(s, 'bbb', 'aaa');
    const b2 = plant(s, 'bbb', 'aaa', 'recruit_source');
    const a = detainee(s, 'bbb', 'aaa');
    // Opération de bbb contre nous en préparation : éventée par les aveux.
    expect(
      applyOrder(s, 'bbb', { kind: 'intelOp', op: 'steal_research', target: { nationId: 'aaa' } })
        .ok,
    ).toBe(true);
    const plotted = ist(s).nations.bbb!.ops.at(-1)!;
    delete plotted.dt;
    expect(order(s, 'aaa', 'interrogate', a.id).ok).toBe(true);
    expect(order(s, 'aaa', 'jail', a.id, 30).ok).toBe(false);
    expect(viewFor(s, 'bbb').intel!.agents.find((x) => x.id === a.id)!.detention!.fate).toBe(
      'interrogation',
    );
    advanceTo(s, a.dn!.iq! + 1);
    expect(a.dn!.iv).toBe(1);
    expect(b1.state).toBe('caught');
    expect(b2.state).toBe('caught');
    const d = viewFor(s, 'aaa').intel!.detainees!.find((x) => x.id === a.id)!;
    expect(d.interrogated).toBe(true);
    expect(d.revealed!.agents).toBe(2);
    expect(d.revealed!.ops).toBeGreaterThanOrEqual(1);
    expect(plotted.dt).toBe(1);
    expect(d.access).toBe('street');
    expect(
      ist(s).nations.aaa!.reports.some((r) => r.loc?.title?.key === 'engine.intel.interrogation'),
    ).toBe(true);
    expect(order(s, 'aaa', 'interrogate', a.id).ok).toBe(false);
  });

  it('retournement : réussi, il ressemble à une libération pour son service', () => {
    const s = game({ turnChance: { diplomat: 1, illegal: 1, source: 1, double: 0 } });
    const a = detainee(s, 'bbb', 'aaa', 'recruit_source');
    const r = detainee(s, 'bbb', 'aaa', 'recruit_source');
    expect(order(s, 'aaa', 'turn', a.id).ok).toBe(true);
    expect(a.state).toBe('double');
    expect(a.dn!.s).toBe('turned');
    expect(order(s, 'aaa', 'release', r.id).ok).toBe(true);
    expect(r.state).toBe('active');
    const own = viewFor(s, 'bbb').intel!;
    const va = own.agents.find((x) => x.id === a.id)!;
    const vr = own.agents.find((x) => x.id === r.id)!;
    expect(va.status).toBe(vr.status);
    expect(va.detention).toEqual({ ...vr.detention, since: va.detention!.since });
    expect(JSON.stringify(own)).not.toMatch(/"turned"|"double"/);
    // Côté geôlier : retourné, dans la liste des agents doublés.
    const host = viewFor(s, 'aaa').intel!;
    expect(host.detainees!.find((x) => x.id === a.id)!.status).toBe('turned');
    expect(host.caughtAgents.find((x) => x.id === a.id)!.turned).toBe(true);
  });
});

describe('détenus : IA', () => {
  it('IA autoritaire en guerre : interrogatoire, puis exécution possible de nos agents', () => {
    const s = game({
      regimes: { authoritarian: { aiExecute: 1 } },
      interrogateHours: 1,
    });
    applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'ddd' });
    const a = detainee(s, 'aaa', 'ddd');
    expect(a.dn!.iq).toBeGreaterThan(s.time);
    advanceTo(s, a.dn!.iq! + 1);
    expect(a.dn!.s).toBe('executed');
    expect(viewFor(s, 'aaa').intel!.agents.find((x) => x.id === a.id)!.status).toBe('executed');
  });

  it('IA hybride en paix et bonnes relations : renvoi ; diplomates expulsés', () => {
    const s = game();
    addTie(s, 'aaa', 'ccc', 40);
    const a = detainee(s, 'aaa', 'ccc');
    advanceTo(s, s.time + 3 * DAY);
    expect(a.dn!.s).toBe('returned');
    const d = detainee(s, 'aaa', 'ccc', 'infiltrate_spy', 'diplomatic');
    expect(d.dn!.s).toBe('expelled');
  });

  it('IA en mauvaises relations : prison longue', () => {
    const s = game();
    addTie(s, 'aaa', 'ccc', -55);
    const a = detainee(s, 'aaa', 'ccc');
    advanceTo(s, s.time + 3 * DAY);
    expect(['jailed', 'executed']).toContain(a.dn!.s);
    if (a.dn!.s === 'jailed') expect(a.dn!.days).toBe(365);
  });

  it('représailles : exécution d’un détenu, expulsions réciproques', () => {
    const s = game();
    const mine = detainee(s, 'aaa', 'ccc');
    mine.dn!.s = 'held';
    delete mine.dn!.iq;
    retaliate(s, 'ccc', 'aaa', 'execute');
    expect(mine.dn!.s).toBe('executed');
    const dip = plant(s, 'aaa', 'ccc', 'infiltrate_spy', 'diplomatic');
    retaliate(s, 'ccc', 'aaa', 'expel');
    expect(dip.dn!.s).toBe('expelled');
  });

  it('représailles déclenchées par une décision, résolues à la journée suivante', () => {
    const s = game({ regimes: { hybrid: { retaliation: 5 } } });
    const dip = plant(s, 'aaa', 'ccc', 'infiltrate_spy', 'diplomatic');
    const theirs = detainee(s, 'ccc', 'aaa');
    expect(order(s, 'aaa', 'expel', theirs.id).ok).toBe(true);
    expect(ist(s).gr!['ccc>aaa']!.p).toBe(0.95);
    advanceTo(s, s.time + 2 * DAY);
    expect(ist(s).gr!['ccc>aaa']).toBeUndefined();
    expect(dip.dn?.s).toBe('expelled');
  });
});

describe('détenus : négociations', () => {
  it('échange 1 contre 1 avec une IA : accepté, agents rentrés, relations en hausse', () => {
    const s = game();
    const ours = detainee(s, 'aaa', 'ccc');
    ours.dn!.s = 'held';
    ours.dn!.k = 'illegal';
    const theirs = detainee(s, 'ccc', 'aaa');
    const t0 = tie(s, 'aaa', 'ccc');
    const r = applyOrder(s, 'aaa', {
      kind: 'proposeSwap',
      nationId: 'ccc',
      give: [theirs.id],
      get: [ours.id],
    });
    expect(r.ok).toBe(true);
    const sw = Object.values(ist(s).sw!).find((x) => x.from === 'aaa')!;
    expect(viewFor(s, 'aaa').intel!.swaps![0]!.status).toBe('open');
    advanceTo(s, s.time + dzcfg(s).aiAnswerHours * HOUR + 1);
    expect(sw.st).toBe('accepted');
    expect(ours.dn!.s).toBe('exchanged');
    expect(theirs.dn!.s).toBe('exchanged');
    expect(tie(s, 'aaa', 'ccc')).toBeGreaterThan(t0);
    expect(viewFor(s, 'aaa').intel!.agents.find((x) => x.id === ours.id)!.status).toBe('released');
  });

  it('libération demandée sans contrepartie : contre-proposition chiffrée, acceptée contre paiement', () => {
    const s = game();
    const ours = detainee(s, 'aaa', 'ccc');
    if (ours.dn!.s !== 'held' && ours.dn!.s !== 'jailed' && ours.dn!.s !== 'pending')
      ours.dn!.s = 'held';
    applyOrder(s, 'aaa', { kind: 'proposeSwap', nationId: 'ccc', give: [], get: [ours.id] });
    advanceTo(s, s.time + dzcfg(s).aiAnswerHours * HOUR + 1);
    const sws = Object.values(ist(s).sw!);
    expect(sws.find((x) => x.from === 'aaa')!.st).toBe('refused');
    const counter = sws.find((x) => x.from === 'ccc' && x.c)!;
    expect(counter).toBeTruthy();
    expect(counter.m).toBeLessThan(0);
    // Valeur demandée cohérente : au moins la valeur de l'agent en dollars.
    expect(-counter.m).toBeGreaterThanOrEqual(DZ_DEFAULTS.value.illegal * DZ_DEFAULTS.usdPerValue);
    const v = viewFor(s, 'aaa').intel!.swaps!.find((x) => x.id === counter.id)!;
    expect(v.counter).toBe(true);
    expect(v.give[0]!.label).toBe(ours.codename);
    const money = s.nations.aaa!.money;
    expect(applyOrder(s, 'aaa', { kind: 'answerSwap', swapId: counter.id, accept: true }).ok).toBe(
      true,
    );
    expect(s.nations.aaa!.money).toBe(money + counter.m);
    expect(ours.dn!.s).toBe('exchanged');
  });

  it('proposition déraisonnable : refusée net', () => {
    const s = game();
    const ours = detainee(s, 'aaa', 'ccc');
    if (ours.dn!.s !== 'held' && ours.dn!.s !== 'jailed' && ours.dn!.s !== 'pending')
      ours.dn!.s = 'held';
    // On réclame notre agent ET de l'argent.
    applyOrder(s, 'aaa', {
      kind: 'proposeSwap',
      nationId: 'ccc',
      give: [],
      get: [ours.id],
      money: -500e6,
    });
    const notes = advanceTo(s, s.time + dzcfg(s).aiAnswerHours * HOUR + 1);
    const sws = Object.values(ist(s).sw!);
    expect(sws.find((x) => x.from === 'aaa')!.st).toBe('refused');
    expect(sws.some((x) => x.from === 'ccc' && x.c)).toBe(false);
    expect(
      notificationsFor(s, 'aaa', notes).some(
        (n) => n.kind === 'generic' && n.loc?.title.key === 'engine.note.swapRefused.title',
      ),
    ).toBe(true);
  });

  it('entre joueurs, en guerre : échange plusieurs contre plusieurs avec accord de non-ingérence', () => {
    const s = game();
    applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    const o1 = detainee(s, 'aaa', 'bbb');
    const o2 = detainee(s, 'aaa', 'bbb', 'recruit_source');
    const t1 = detainee(s, 'bbb', 'aaa');
    const t2 = detainee(s, 'bbb', 'aaa', 'recruit_source');
    expect(
      applyOrder(s, 'aaa', {
        kind: 'proposeSwap',
        nationId: 'bbb',
        give: [t1.id, t2.id],
        get: [o1.id, o2.id],
        accordDays: 30,
      }).ok,
    ).toBe(true);
    const sw = viewFor(s, 'bbb').intel!.swaps![0]!;
    // Côté bbb : ses agents par nom de code, nos détenus par référence.
    expect(sw.give.map((x) => x.label).sort()).toEqual([t1.codename, t2.codename].sort());
    expect(sw.get.every((x) => x.label.startsWith('D-'))).toBe(true);
    expect(applyOrder(s, 'bbb', { kind: 'answerSwap', swapId: sw.id, accept: true }).ok).toBe(true);
    for (const a of [o1, o2, t1, t2]) expect(a.dn!.s).toBe('exchanged');
    // Accord de non-ingérence : plus d'opérations l'un contre l'autre.
    const r = applyOrder(s, 'aaa', {
      kind: 'intelOp',
      op: 'infiltrate_spy',
      target: { nationId: 'bbb' },
    });
    expect(r.ok).toBe(false);
    expect(
      viewFor(s, 'aaa').intel!.ties!.find((x) => x.nationId === 'bbb')!.accordUntil,
    ).toBeGreaterThan(s.time);
  });

  it('valeur des agents : un officier vaut plus qu’une source ; hostilité et guerre renchérissent', () => {
    const s = game();
    const off = detainee(s, 'aaa', 'ccc');
    const src = detainee(s, 'aaa', 'ccc', 'recruit_source');
    for (const a of [off, src]) a.dn!.s = 'held';
    const base = { from: 'aaa', to: 'ccc', give: [] as string[], m: 0, d: 0 };
    const g1 = swapGain(s, 'ccc', { ...base, get: [off.id] }).gain;
    const g2 = swapGain(s, 'ccc', { ...base, get: [src.id] }).gain;
    expect(g1).toBeLessThan(g2);
    addTie(s, 'aaa', 'ccc', -80);
    expect(swapGain(s, 'ccc', { ...base, get: [src.id] }).gain).toBeLessThan(g2);
  });

  it('initiative de l’IA : elle propose un échange quand chacun détient des agents de l’autre', () => {
    const s = game();
    const ours = detainee(s, 'aaa', 'ccc');
    ours.dn!.s = 'held';
    detainee(s, 'ccc', 'aaa');
    advanceTo(s, s.time + 12 * DAY);
    const all = Object.values(ist(s).sw ?? {});
    expect(all.some((x) => x.from === 'ccc' && x.to === 'aaa')).toBe(true);
  });
});

describe('détenus : vues, déterminisme, sauvegardes', () => {
  it('aucune fuite : un tiers ne voit rien, le propriétaire ne voit ni options ni type double', () => {
    const s = game();
    const a = detainee(s, 'bbb', 'aaa');
    order(s, 'aaa', 'jail', a.id, 30);
    const third = viewFor(s, 'ccc').intel!;
    expect(third.detainees).toEqual([]);
    expect(third.swaps).toEqual([]);
    expect(JSON.stringify(third)).not.toContain(a.id);
    const own = JSON.stringify(viewFor(s, 'bbb').intel);
    expect(own).not.toContain('"options"');
    expect(own).not.toContain('D-');
  });

  it('rejeu identique et reprise après sérialisation', () => {
    const play = (seed: number) => {
      const s = game({}, seed);
      const a = detainee(s, 'bbb', 'aaa');
      order(s, 'aaa', 'interrogate', a.id);
      detainee(s, 'aaa', 'ccc');
      const b = detainee(s, 'ccc', 'aaa');
      advanceTo(s, s.time + 3 * DAY);
      order(s, 'aaa', 'jail', b.id, 30);
      return s;
    };
    const x = play(3);
    const y = play(3);
    expect(stateHash(x)).toBe(stateHash(y));
    const z = deserializeState(world(), serializeState(x)) as unknown as EngineState;
    for (const s of [x, z]) advanceTo(s, s.time + 10 * DAY);
    expect(stateHash(z)).toBe(stateHash(x));
  });

  it('ancienne sauvegarde (sans détention ni relations) : reprise et vue sans erreur', () => {
    const s = game();
    const a = detainee(s, 'bbb', 'aaa');
    const st = ist(s);
    delete a.dn;
    a.ex = 1;
    delete st.rel;
    delete st.sw;
    delete st.gr;
    delete st.na;
    delete st.si;
    for (const n of Object.keys(st.nations)) delete st.nations[n]!.sh;
    const c = deserializeState(world(), serializeState(s)) as unknown as EngineState;
    expect(() => viewFor(c, 'aaa')).not.toThrow();
    advanceTo(c, c.time + 2 * DAY);
    expect(viewFor(c, 'bbb').intel!.agents.find((x) => x.id === a.id)!.status).toBe('expelled');
    expect(viewFor(c, 'aaa').intel!.detainees).toEqual([]);
  });

  it('équilibrage : data/balance identique aux valeurs par défaut du moteur', () => {
    const defaultBalance = JSON.parse(
      readFileSync(new URL('../../../data/balance/default.json', import.meta.url), 'utf8'),
    ) as unknown;
    const d = (defaultBalance as { intel: { detainees: Record<string, unknown> } }).intel.detainees;
    const { nations: _n, ...rest } = d;
    const { nations: _m, ...defs } = DZ_DEFAULTS as unknown as Record<string, unknown>;
    expect(rest).toEqual(defs);
    expect(BalanceSchema.parse(defaultBalance).intel?.detainees).toBeTruthy();
  });
});
