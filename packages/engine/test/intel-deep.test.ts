import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type IntelOpKind, type IntelOpTarget } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import { board } from '../src/modules/kit.js';
import { signal } from '../src/modules/registry.js';
import { catchQuietly, publicArrest } from '../src/modules/intel/agents.js';
import { successFactor } from '../src/modules/intel/interior.js';
import { dcfg, encryption } from '../src/modules/intel/deep.js';
import { ist } from '../src/modules/intel/state.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf } from './fixtures.js';
import { intelGame, intelWorld, opStatus, runOp } from './intel-helpers.js';

/** Unités de bbb (chars, défense aérienne) près de sa capitale et de la frontière d'aaa. */
function game(seed = 7): EngineState {
  return intelGame(
    [
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      { owner: 'aaa', systemId: 'tst.jammer', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') },
      { owner: 'bbb', systemId: 'tst.sam', pos: cityOf('bbb-2') },
      { owner: 'bbb', systemId: 'tst.radar', pos: cityOf('bbb-5') },
    ],
    { seed },
  );
}

/**
 * Opération réussie dont le dénouement voit `plans` comme plans de guerre (la stratégie des IA
 * réécrit les plans des nations à chaque pas : on les pose juste avant l'instant voulu).
 */
function runPlanned(
  s: EngineState,
  n: string,
  op: IntelOpKind,
  target: IntelOpTarget,
  plans: Record<string, string[]>,
): void {
  const r = applyOrder(s, n, { kind: 'intelOp', op, target });
  if (!r.ok) throw new Error(r.message);
  const o = ist(s).nations[n]!.ops.at(-1)!;
  o.estimate = 1;
  delete o.dt;
  at(s, o.completesAt, plans);
}

/** Avance jusqu'à `t` avec des plans de guerre posés juste avant. */
function at(s: EngineState, t: number, plans: Record<string, string[]>): void {
  advanceTo(s, t - 1);
  board(s).warPlans = plans;
  advanceTo(s, t);
}

function agentOf(s: EngineState, owner: string, host: string) {
  return Object.values(ist(s).agents).find((a) => a.owner === owner && a.host === host)!;
}

describe('renseignement approfondi : SIGINT', () => {
  it('capteurs en service : la guerre électronique est comptée chaque jour', () => {
    const s = game();
    advanceTo(s, DAY + HOUR);
    const v = viewFor(s, 'aaa').intel!;
    expect(v.sensors!.ew).toBeGreaterThan(0);
    expect(viewFor(s, 'bbb').intel!.sensors!.ew).toBe(0);
    // Brouillage : rayon élargi par les brouilleurs en service.
    runOp(s, 'aaa', 'jam_area', { at: cityOf('bbb-2'), radiusKm: 100 });
    const jam = Object.values(ist(s).jams).find((j) => j.owner === 'aaa')!;
    expect(jam.r).toBeGreaterThan(100);
  });

  it('cryptanalyse progressive, puis interception : ordres puis intentions lisibles', () => {
    const s = game();
    // Contenu illisible sans décryptage.
    runOp(s, 'aaa', 'intercept_comms', { nationId: 'bbb' });
    let last = ist(s).nations.aaa!.reports.at(-1)!;
    if (!last.fk) expect(last.body).toContain('Contenu chiffré');
    const before = ist(s).nations.aaa!.cr?.bbb ?? 0;
    runOp(s, 'aaa', 'cryptanalysis', { nationId: 'bbb' });
    const after = ist(s).nations.aaa!.cr!.bbb!;
    expect(after).toBeGreaterThan(before);
    expect(ist(s).nations.aaa!.reports.at(-1)!.title).toContain('Cryptanalyse');
    // Décryptage complet (plusieurs campagnes) : les plans de guerre apparaissent au dossier.
    ist(s).nations.aaa!.cr!.bbb = 1;
    runPlanned(s, 'aaa', 'intercept_comms', { nationId: 'bbb' }, { bbb: ['aaa'] });
    last = ist(s).nations.aaa!.reports.at(-1)!;
    expect(last.fk).toBeUndefined();
    expect(last.body).toContain('guerre contre');
    const d = viewFor(s, 'aaa').intel!.dossiers!.find((x) => x.nationId === 'bbb')!;
    expect(d.intentions!.plansAgainst).toEqual(['aaa']);
    expect(d.crypto).toBeGreaterThan(0.9);
    expect(d.encryption).toBe(encryption(s, 'bbb'));
  });

  it('faux trafic : un bon contre-espionnage adverse intoxique, jamais visible dans la vue', () => {
    const s = game(3);
    ist(s).nations.bbb!.budget.interior = 1e9;
    let fake = false;
    for (let i = 0; i < 20 && !fake; i++) {
      runOp(s, 'aaa', 'intercept_comms', { nationId: 'bbb' });
      fake = !!ist(s).nations.aaa!.reports.at(-1)!.fk;
    }
    expect(fake).toBe(true);
    expect(ist(s).nations.aaa!.ev!.bbb!.pl!.fk).toBe(1);
    const json = JSON.stringify(viewFor(s, 'aaa'));
    expect(json).not.toContain('"fk"');
    expect(
      viewFor(s, 'aaa').intel!.dossiers!.find((x) => x.nationId === 'bbb')!.intentions,
    ).toBeTruthy();
  });

  it('géolocalisation des émetteurs : défense aérienne et radars localisés (contacts identifiés)', () => {
    const s = game();
    runOp(s, 'aaa', 'geolocate_emitters', { nationId: 'bbb' });
    const known = s.know.aaa ?? {};
    const sams = Object.keys(s.units).filter(
      (id) => s.units[id]!.owner === 'bbb' && s.units[id]!.sys !== 'tst.tank',
    );
    expect(sams.length).toBe(2);
    for (const id of sams) expect(known[id]?.lvl).toBe(2);
    const tank = Object.keys(s.units).find((id) => s.units[id]!.sys === 'tst.tank')!;
    expect(known[tank]).toBeUndefined();
  });
});

describe('renseignement approfondi : militaire', () => {
  it('désignation de cibles : forces de la province identifiées, frappe proposée par unité', () => {
    const s = game();
    runOp(s, 'aaa', 'designate_targets', { provinceId: 'bbb-2' });
    const r = viewFor(s, 'aaa').intel!.reports.find((x) => x.title.startsWith('Désignation'))!;
    expect(r.subject!.unitIds!.length).toBeGreaterThanOrEqual(2);
    expect(r.actions.some((a) => a.kind === 'plan_strike' && !!a.unitId)).toBe(true);
    expect(ist(s).pk.aaa!['bbb-2']!.m).toBe(3);
  });

  it('évaluation des dégâts après une frappe, chez le tireur seulement', () => {
    const s = game();
    signal(s, 'strike', { by: 'aaa', victim: 'bbb', at: cityOf('bbb-2'), kind: 'missile' });
    const a = viewFor(s, 'aaa').intel!.reports.find((x) => x.title.startsWith('Évaluation'));
    expect(a?.body).toContain('Forces encore présentes');
    expect(viewFor(s, 'bbb').intel!.reports.some((x) => x.title.startsWith('Évaluation'))).toBe(
      false,
    );
  });

  it('ordre de bataille estimé, indice de menace, alerte stratégique et bulletin par théâtre', () => {
    const s = game();
    ist(s).nations.aaa!.cr = { bbb: 1 };
    runPlanned(s, 'aaa', 'intercept_comms', { nationId: 'bbb' }, { bbb: ['aaa'] });
    // bbb masse des forces près des villes d'aaa.
    const t = s.time;
    advanceTo(s, Math.ceil((t + 1) / DAY) * DAY + 7 * HOUR);
    const v = viewFor(s, 'aaa').intel!;
    const d = v.dossiers!.find((x) => x.nationId === 'bbb')!;
    expect(d.indicators).toContain('plans');
    expect(d.forces!.total[0]).toBeLessThanOrEqual(d.forces!.total[1]);
    // L'estimation encadre la vérité (pas d'agent double).
    let truth = 0;
    for (const u of Object.values(s.units)) if (u.owner === 'bbb') truth += u.count;
    expect(d.forces!.total[0]).toBeLessThanOrEqual(truth);
    expect(d.forces!.total[1]).toBeGreaterThanOrEqual(truth);
    const note = v.reports.find((r) => r.kind === 'daily' && r.dept === 'military')!;
    expect(note.body).toContain('Synthèse par théâtre');
    if (d.threat >= dcfg(s).alertThreshold) {
      expect(d.alert).toBe(true);
      expect(v.reports.some((r) => r.title.startsWith('ALERTE STRATÉGIQUE'))).toBe(true);
    }
    // Les IA ne calculent pas de dossiers (pas de lecteur) : pas de coût.
    expect(ist(s).nations.ccc!.ev).toBeUndefined();
  });

  it('alerte stratégique au-delà du seuil', () => {
    const s = intelGame([
      ...Array.from({ length: 40 }, () => ({
        owner: 'bbb',
        systemId: 'tst.tank',
        pos: [5.5, 40] as [number, number],
      })),
      // Un drone d'aaa observe la concentration.
      { owner: 'aaa', systemId: 'tst.drone', pos: [5.5, 40] as [number, number] },
    ]);
    const e = ((ist(s).nations.aaa!.ev ??= {}).bbb = {
      t: 0,
      th: 0,
      ind: [],
      pl: { t: 0, v: ['aaa'], s: 'sigint', q: 1 },
      cm: 0,
    });
    advanceTo(s, 7 * HOUR);
    expect(e.th).toBeGreaterThanOrEqual(dcfg(s).alertThreshold);
    const v = viewFor(s, 'aaa').intel!;
    expect(v.reports.some((r) => r.kind === 'flash' && r.title.startsWith('ALERTE'))).toBe(true);
    expect(v.dossiers![0]!.nationId).toBe('bbb');
    expect(v.dossiers![0]!.alert).toBe(true);
  });
});

describe('renseignement approfondi : HUMINT', () => {
  it('couverture, fiabilité qui progresse, culture de la source jusqu’à l’état-major', () => {
    const s = game();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb', cover: 'nonofficial' });
    const a = agentOf(s, 'aaa', 'bbb');
    expect(a.cv).toBe('nonofficial');
    let av = viewFor(s, 'aaa').intel!.agents[0]!;
    expect(av).toMatchObject({ cover: 'nonofficial', access: 'street' });
    // Fiabilité insuffisante au départ : culture refusée.
    const r = applyOrder(s, 'aaa', {
      kind: 'intelOp',
      op: 'cultivate_source',
      target: { nationId: 'bbb' },
    });
    expect(r.ok).toBe(false);
    a.state = 'active';
    delete a.burned;
    advanceTo(s, s.time + 3 * DAY);
    expect(a.rl!).toBeGreaterThan(dcfg(s).cultivateMinReliability);
    a.state = 'active';
    delete a.burned;
    runOp(s, 'aaa', 'cultivate_source', { nationId: 'bbb' });
    expect(a.ac).toBe(1);
    a.state = 'active';
    delete a.burned;
    runOp(s, 'aaa', 'cultivate_source', { nationId: 'bbb' });
    expect(a.ac).toBe(2);
    av = viewFor(s, 'aaa').intel!.agents[0]!;
    expect(av.access).toBe('staff');
    a.state = 'active';
    delete a.burned;
    at(s, (Math.floor(s.time / DAY) + 1) * DAY, { bbb: ['ccc'] });
    const d = viewFor(s, 'aaa').intel!.dossiers!.find((x) => x.nationId === 'bbb')!;
    expect(d.intentions).toMatchObject({ plansAgainst: ['ccc'], source: 'humint' });
    expect(d.economy!.money[0]).toBeLessThanOrEqual(d.economy!.money[1]);
    expect(d.access).toBe('staff');
  });

  it('agent double : informations truquées, démasqué par une vérification', () => {
    const s = game();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb' });
    const a = agentOf(s, 'aaa', 'bbb');
    a.state = 'double';
    a.ac = 2;
    advanceTo(s, s.time + DAY);
    const e = ist(s).nations.aaa!.ev!.bbb!;
    expect(e.pl!.v).toEqual([]);
    expect(e.pl!.fk).toBe(1);
    // Le propriétaire ne sait rien.
    expect(JSON.stringify(viewFor(s, 'aaa'))).not.toContain('"double"');
    for (let i = 0; i < 6 && !a.burned; i++) runOp(s, 'aaa', 'vet_agents', { nationId: 'bbb' });
    expect(a.burned).toBe(true);
    expect(viewFor(s, 'aaa').intel!.agents[0]!.status).toBe('double');
  });

  it('couverture diplomatique : expulsion plutôt qu’arrestation', () => {
    const s = game();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb', cover: 'diplomatic' });
    const a = agentOf(s, 'aaa', 'bbb');
    publicArrest(s, a);
    // Pays hôte joueur : détenu, décision attendue ; l'expulsion (persona non grata) est sa décision.
    expect(viewFor(s, 'aaa').intel!.agents[0]!.status).toBe('captured');
    expect(applyOrder(s, 'bbb', { kind: 'detainee', agentId: a.id, action: 'expel' }).ok).toBe(
      true,
    );
    expect(viewFor(s, 'aaa').intel!.agents[0]!.status).toBe('expelled');
    // Pays hôte IA en paix : il expulse d'office l'officier sous couverture diplomatique.
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'ccc', cover: 'diplomatic' });
    const b = agentOf(s, 'aaa', 'ccc');
    publicArrest(s, b);
    expect(viewFor(s, 'aaa').intel!.agents.find((x) => x.id === b.id)!.status).toBe('expelled');
  });
});

describe('renseignement approfondi : sécurité intérieure', () => {
  it('démantèlement du réseau adverse sur notre sol', () => {
    const s = game();
    runOp(s, 'bbb', 'infiltrate_spy', { nationId: 'aaa' });
    runOp(s, 'bbb', 'infiltrate_spy', { nationId: 'aaa' });
    const mine = Object.values(ist(s).agents).filter((a) => a.owner === 'bbb');
    catchQuietly(s, mine[0]!);
    runOp(s, 'aaa', 'dismantle_network', { nationId: 'bbb' });
    expect(mine[0]!.state).toBe('captured');
    expect(ist(s).nations.aaa!.reports.at(-1)!.title).toContain('Démantèlement');
  });

  it('déception : faux plans chez l’adversaire, drapeau interne jamais visible', () => {
    const s = game();
    runOp(s, 'aaa', 'deception_plan', { nationId: 'bbb' });
    const pl = ist(s).nations.bbb!.ev!.aaa!.pl!;
    expect(pl.fk).toBe(1);
    expect(pl.v).not.toContain('bbb');
    const vb = viewFor(s, 'bbb');
    expect(JSON.stringify(vb)).not.toContain('"fk"');
    expect(vb.intel!.reports.some((r) => r.kind === 'intentions')).toBe(true);
  });

  it('sites durcis : sabotages freinés pendant quelques jours', () => {
    const s = game();
    runOp(s, 'bbb', 'harden_sites', {});
    expect(viewFor(s, 'bbb').intel!.hardenedUntil).toBeGreaterThan(s.time);
    const r = applyOrder(s, 'aaa', {
      kind: 'intelOp',
      op: 'sabotage_factory',
      target: { provinceId: 'bbb-2' },
    });
    expect(r.ok).toBe(true);
    const op = ist(s).nations.aaa!.ops.at(-1)!;
    delete op.dt;
    expect(successFactor(s, op)).toBeCloseTo(1 - dcfg(s).hardenReduction);
    advanceTo(s, s.time + 4 * DAY);
    expect(successFactor(s, op)).toBe(1);
    expect(opStatus(s, 'aaa', op.id)).not.toBe('running');
  });
});

describe('renseignement approfondi : déterminisme et sauvegardes', () => {
  function play(seed: number): EngineState {
    const s = game(seed);
    board(s).warPlans = { bbb: ['aaa'] };
    for (const op of ['cryptanalysis', 'intercept_comms', 'geolocate_emitters'] as const)
      runOp(s, 'aaa', op, { nationId: 'bbb' }, 'natural');
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb', cover: 'diplomatic' }, 'natural');
    runOp(s, 'bbb', 'deception_plan', { nationId: 'aaa' }, 'natural');
    advanceTo(s, s.time + 2 * DAY);
    return s;
  }

  it('rejeu identique et reprise après sérialisation', () => {
    const a = play(5);
    const b = play(5);
    expect(stateHash(a)).toBe(stateHash(b));
    const c = deserializeState(intelWorld(), serializeState(a)) as unknown as EngineState;
    for (const s of [a, c]) advanceTo(s, s.time + 2 * DAY);
    expect(stateHash(c)).toBe(stateHash(a));
  });

  it('sauvegarde ancienne (sans les nouveaux champs) : reprise et vue sans erreur', () => {
    const s = play(9);
    const st = ist(s);
    for (const n of Object.keys(st.nations)) {
      const ni = st.nations[n]!;
      delete ni.sx;
      delete ni.cr;
      delete ni.ev;
      delete ni.hd;
    }
    for (const a of Object.values(st.agents)) {
      delete a.cv;
      delete a.ac;
      delete a.rl;
      delete a.ex;
    }
    const c = deserializeState(intelWorld(), serializeState(s)) as unknown as EngineState;
    expect(() => viewFor(c, 'aaa')).not.toThrow();
    advanceTo(c, c.time + 2 * DAY);
    const v = viewFor(c, 'aaa').intel!;
    expect(v.sensors).toBeTruthy();
    expect(Array.isArray(v.dossiers)).toBe(true);
    expect(
      v.agents.every((x) => x.access === 'street' || x.access === undefined || !!x.access),
    ).toBe(true);
  });
});
