import { describe, expect, it } from 'vitest';
import { HOUR, type LngLat } from '@redline/shared';
import { advanceTo, applyOrder, notificationsFor, stateHash, viewFor } from '../src/index.js';
import { signal } from '../src/modules/registry.js';
import { catchQuietly } from '../src/modules/intel/agents.js';
import { ist } from '../src/modules/intel/state.js';
import { cityOf } from './fixtures.js';
import { intelGame, opStatus, runOp } from './intel-helpers.js';

const agentsOf = (s: ReturnType<typeof intelGame>, owner: string) =>
  Object.values(ist(s).agents).filter((a) => a.owner === owner);

describe('renseignement : opérations', () => {
  it('réussite et échec déterministes, coût prélevé, rapport de résultat', () => {
    const s = intelGame();
    const before = s.nations.aaa!.money;
    expect(
      applyOrder(s, 'aaa', { kind: 'intelOp', op: 'listen_area', target: { at: [10, 40] } }).ok,
    ).toBe(true);
    expect(s.nations.aaa!.money).toBe(before - 1_000_000);
    const ok = runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb' }, 'success');
    expect(opStatus(s, 'aaa', ok)).toBe('success');
    const [agent] = agentsOf(s, 'aaa');
    expect(agent).toMatchObject({ host: 'bbb', kind: 'officer', state: 'active' });
    const v = viewFor(s, 'aaa');
    expect(v.intel!.agents).toEqual([
      expect.objectContaining({ id: agent!.id, nationId: 'bbb', status: 'active' }),
    ]);
    expect(v.intel!.reports[0]!.title).toContain('réussite');
    expect(v.intel!.operations.find((o) => o.id === ok)!.status).toBe('success');

    const ko = runOp(s, 'aaa', 'recruit_source', { nationId: 'ccc' }, 'failure');
    expect(['failed', 'compromised']).toContain(opStatus(s, 'aaa', ko));
    expect(agentsOf(s, 'aaa').filter((a) => a.host === 'ccc' && a.state === 'active')).toHaveLength(
      0,
    );
  });

  it('même graine, mêmes ordres : même issue naturelle et même état', () => {
    const play = () => {
      const s = intelGame([], { seed: 99 });
      const ids: string[] = [];
      for (const n of ['ccc', 'ddd', 'bbb'])
        ids.push(runOp(s, 'aaa', 'recruit_source', { nationId: n }, 'natural'));
      advanceTo(s, 2 * 24 * HOUR);
      return { hash: stateHash(s), status: ids.map((id) => opStatus(s, 'aaa', id)) };
    };
    expect(play()).toEqual(play());
  });

  it('ordres refusés : cible invalide, capacité, fonds, annulation', () => {
    const s = intelGame();
    expect(
      applyOrder(s, 'aaa', { kind: 'intelOp', op: 'infiltrate_spy', target: { nationId: 'aaa' } })
        .ok,
    ).toBe(false);
    expect(
      applyOrder(s, 'aaa', {
        kind: 'intelOp',
        op: 'sabotage_factory',
        target: { provinceId: 'aaa-1' },
      }).error,
    ).toBe('invalid_target');
    // Capacité du département extérieur (niveau 1 : 2 opérations simultanées).
    const start = () =>
      applyOrder(s, 'aaa', { kind: 'intelOp', op: 'infiltrate_spy', target: { nationId: 'bbb' } });
    expect(start().ok).toBe(true);
    expect(start().ok).toBe(true);
    expect(start().error).toBe('capacity');
    const op = ist(s).nations.aaa!.ops[0]!;
    expect(applyOrder(s, 'aaa', { kind: 'cancelIntelOp', opId: op.id }).ok).toBe(true);
    s.nations.aaa!.money = 10;
    expect(start().error).toBe('insufficient_funds');
    expect(
      applyOrder(s, 'aaa', { kind: 'intelBudget', dept: 'military', budgetPerDay: 5_000_000 }).ok,
    ).toBe(true);
    expect(
      viewFor(s, 'aaa').intel!.departments.find((d) => d.id === 'military')!.budgetPerDay,
    ).toBe(5_000_000);
  });

  it('agent démasqué : le pays hôte le sait, le propriétaire non ; retournement ; arrestation publique', () => {
    const s = intelGame();
    runOp(s, 'aaa', 'infiltrate_spy', { nationId: 'bbb' });
    runOp(s, 'aaa', 'recruit_source', { nationId: 'bbb' });
    const [officer, source] = agentsOf(s, 'aaa');
    catchQuietly(s, officer!);
    catchQuietly(s, source!);
    const host = viewFor(s, 'bbb').intel!;
    expect(host.caughtAgents.map((a) => a.nationId)).toEqual(['aaa', 'aaa']);
    expect(host.caughtAgents.every((a) => !a.turned)).toBe(true);
    expect(host.reports.some((r) => r.kind === 'counterintel')).toBe(true);
    // Le propriétaire ne voit jamais « capturé » ni « double » tant que l'arrestation n'est pas publique.
    for (const a of viewFor(s, 'aaa').intel!.agents)
      expect(['active', 'burned']).toContain(a.status);

    // Retournement de l'officier par bbb (ordre turnAgent).
    const r = applyOrder(s, 'bbb', { kind: 'turnAgent', agentId: officer!.id });
    expect(r.ok).toBe(true);
    const op = ist(s).nations.bbb!.ops.at(-1)!;
    op.estimate = 1;
    const notes = advanceTo(s, s.time + 30 * HOUR);
    expect(ist(s).agents[officer!.id]!.state).toBe('double');
    expect(viewFor(s, 'bbb').intel!.caughtAgents.find((a) => a.id === officer!.id)!.turned).toBe(
      true,
    );
    const ownerView = viewFor(s, 'aaa').intel!.agents;
    expect(ownerView.find((a) => a.id === officer!.id)!.status).not.toBe('double');
    expect(JSON.stringify(viewFor(s, 'aaa').intel)).not.toContain('"double"');
    // La source, non retournée, a été arrêtée publiquement : incident notifié aux deux nations.
    expect(ownerView.find((a) => a.id === source!.id)!.status).toBe('captured');
    for (const n of ['aaa', 'bbb']) {
      expect(
        notificationsFor(s, n, notes).some((x) => x.kind === 'generic' && x.category === 'intel'),
      ).toBe(true);
    }
    expect(notificationsFor(s, 'ccc', notes).some((x) => x.kind === 'generic')).toBe(false);
  });

  it('faux rapport : stocké comme intoxication dans le moteur, jamais révélé au client', () => {
    const s = intelGame();
    const at: LngLat = cityOf('bbb-2');
    let tries = 0;
    while (!ist(s).nations.bbb!.reports.some((r) => r.fk) && tries++ < 10)
      runOp(s, 'aaa', 'plant_fake_report', { nationId: 'bbb', at });
    const fake = ist(s).nations.bbb!.reports.find((r) => r.fk)!;
    expect(fake).toBeDefined();
    signal(s, 'strike', { by: 'ccc', victim: 'bbb', at, kind: 'air', nuclear: false });
    const v = viewFor(s, 'bbb');
    const json = JSON.stringify(v);
    expect(json).not.toContain('"fk"');
    const fv = v.intel!.reports.find((r) => r.id === fake.id)!;
    const real = v.intel!.reports.find((r) => r.kind === fv.kind && r.id !== fake.id)!;
    expect(real, JSON.stringify(v.intel!.reports.map((r) => [r.kind, r.title]))).toBeDefined();
    // Même forme qu'un vrai rapport du même type : rien ne le distingue, hormis la cotation.
    expect(Object.keys(fv).sort()).toEqual(Object.keys(real).sort());
    expect(fv.body).toMatch(/Cotation [A-F][1-6]/);
  });

  it('leurres : vus comme des unités par la nation trompée, marqués chez leur propriétaire, puis expirés', () => {
    const s = intelGame();
    const at: LngLat = [3.5, 44];
    runOp(s, 'aaa', 'deploy_decoys', { at, nationId: 'bbb' });
    const own = Object.values(viewFor(s, 'aaa').units).filter((u) => u.decoy);
    expect(own.length).toBeGreaterThanOrEqual(3);
    const seen = viewFor(s, 'bbb').units;
    for (const d of own) {
      expect(seen[d.id]).toMatchObject({ owner: 'aaa', level: 'identified' });
      expect(seen[d.id]!.decoy).toBeUndefined();
      expect(seen[d.id]!.systemId).toBe(d.systemId);
    }
    expect(JSON.stringify(viewFor(s, 'bbb'))).not.toContain('"decoy"');
    for (const d of own) expect(viewFor(s, 'ccc').units[d.id]).toBeUndefined();
    advanceTo(s, s.time + 49 * HOUR);
    for (const d of own) {
      expect(viewFor(s, 'aaa').units[d.id]).toBeUndefined();
      expect(viewFor(s, 'bbb').units[d.id]).toBeUndefined();
    }
  });

  it("écoute d'une zone : les émetteurs ennemis apparaissent comme contacts incertains", () => {
    const s = intelGame([
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.tank', pos: [10, 40] },
      { owner: 'bbb', systemId: 'tst.infantry', pos: [10.3, 40.2] },
    ]);
    const enemy = Object.keys(s.units).filter((id) => s.units[id]!.owner === 'bbb');
    for (const id of enemy) expect(viewFor(s, 'aaa').units[id]).toBeUndefined();
    runOp(s, 'aaa', 'listen_area', { at: [10, 40], radiusKm: 100 });
    const v = viewFor(s, 'aaa');
    for (const id of enemy) {
      expect(v.units[id]).toBeDefined();
      expect(v.units[id]!.uncertaintyKm).toBeGreaterThan(0);
    }
    const rep = v.intel!.reports.find((r) => r.title.startsWith('Écoute'))!;
    expect(rep.body).toContain('Nation BBB');
    expect(rep.subject?.unitIds?.sort()).toEqual(enemy.sort());
    // Une unité qui entre dans la zone pendant l'écoute est captée au rafraîchissement suivant.
    expect(ist(s).listens).not.toEqual({});
    advanceTo(s, s.time + 13 * HOUR);
    expect(ist(s).listens).toEqual({});
  });

  it('contre-espionnage : un balayage démasque les leurres et produit un bilan', () => {
    const s = intelGame();
    runOp(s, 'aaa', 'deploy_decoys', { at: [3.5, 44], nationId: 'bbb' });
    const ids = Object.values(viewFor(s, 'aaa').units)
      .filter((u) => u.decoy)
      .map((u) => u.id);
    // Qualité élevée : budget intérieur important.
    applyOrder(s, 'bbb', { kind: 'intelBudget', dept: 'interior', budgetPerDay: 1e9 });
    runOp(s, 'bbb', 'counterintel_sweep', {});
    const v = viewFor(s, 'bbb');
    expect(v.intel!.reports.some((r) => r.title.includes('bilan'))).toBe(true);
    const exposed = Object.values(ist(s).decoys).filter((d) => d.exposed.includes('bbb'));
    for (const d of exposed) expect(v.units[d.id]).toBeUndefined();
    expect(exposed.length + ids.filter((id) => v.units[id]).length).toBe(ids.length);
  });
});
