import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import { advanceTo, notificationsFor, viewFor } from '../src/index.js';
import { signal } from '../src/modules/registry.js';
import { cityOf } from './fixtures.js';
import { D, game, ok } from './diplo-helpers.js';

describe('diplomatie : fil d’actualité mondial', () => {
  it('dépêches générées à partir des événements, en français, publiques', () => {
    const s = game();
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    const notes = advanceTo(s, HOUR);
    expect(notes.some((n) => n.kind === 'war_declared')).toBe(true);
    const v = viewFor(s, 'ddd');
    const war = v.news!.find((n) => n.category === 'war')!;
    expect(war.headline).toMatch(/Nation AAA/);
    expect(war.headline).toMatch(/Nation BBB/);
    expect(war.nations).toEqual(['aaa', 'bbb']);
    expect(war.at).toEqual(cityOf('bbb-2'));
    // La notification « news » est publique.
    const n = notes.filter((x) => x.kind === 'news');
    expect(n.length).toBeGreaterThan(0);
    expect(notificationsFor(s, 'ddd', notes).some((x) => x.kind === 'news')).toBe(true);
  });

  it('signaux des autres modules : frappes, batailles, fuites, espions, blocus, dépêches libres', () => {
    const s = game();
    signal(s, 'strike', {
      by: 'aaa',
      victim: 'bbb',
      at: cityOf('bbb-5'),
      kind: 'missile',
      nuclear: false,
    });
    signal(s, 'strike', {
      by: 'aaa',
      victim: 'bbb',
      at: cityOf('bbb-5'),
      kind: 'missile',
      nuclear: false,
    }); // regroupée
    signal(s, 'battle_end', {
      reportId: 'r1',
      at: cityOf('bbb-4'),
      winner: 'aaa',
      nations: ['bbb', 'aaa'],
    });
    signal(s, 'leak', {
      by: 'ccc',
      victim: 'bbb',
      headline: 'Des plans secrets publiés',
      body: 'Détails.',
    });
    signal(s, 'agent_caught', { spyNation: 'ccc', onNation: 'aaa' });
    signal(s, 'blockade', { by: 'aaa', pid: 'bbb-2', on: true });
    signal(s, 'news', {
      category: 'economy',
      headline: 'Titre libre',
      body: 'Corps',
      at: null,
      nations: ['aaa'],
    });
    signal(s, 'inconnu', { x: 1 }); // ignoré
    const cats = D(s).news.map((x) => x.category);
    expect(cats).toEqual(['strike', 'war', 'leak', 'leak', 'economy', 'economy']);
    const strike = D(s).news[0]!;
    expect(strike.headline + strike.body).toMatch(/missiles|Province bbb-5/);
    expect(D(s).news.find((x) => x.headline === 'Des plans secrets publiés')).toBeTruthy();
    expect(D(s).rep.ccc).toBeLessThan(50); // espion démasqué
    // Six heures plus tard, une nouvelle frappe refait une dépêche.
    advanceTo(s, 7 * HOUR);
    signal(s, 'strike', {
      by: 'aaa',
      victim: 'bbb',
      at: cityOf('bbb-5'),
      kind: 'missile',
      nuclear: false,
    });
    expect(D(s).news.filter((x) => x.category === 'strike')).toHaveLength(2);
  });

  it('titres variés et déterministes', () => {
    const run = () => {
      const s = game({ seed: 9 });
      ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
      ok(s, 'ccc', { kind: 'declareWar', nationId: 'ddd' });
      ok(s, 'bbb', { kind: 'declareWar', nationId: 'ccc' });
      ok(s, 'aaa', { kind: 'declareWar', nationId: 'ddd' });
      advanceTo(s, DAY);
      return D(s).news.map((n) => `${n.id} ${n.headline} | ${n.body}`);
    };
    const a = run();
    expect(run()).toEqual(a);
    const heads = new Set(a.filter((x) => x.includes('Nation')).map((x) => x.split(' ')[1]));
    expect(heads.size).toBeGreaterThan(1);
    // La vue donne les plus récentes d'abord.
    const s = game();
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    ok(s, 'ccc', { kind: 'declareWar', nationId: 'ddd' });
    const v = viewFor(s, 'aaa').news!;
    expect(v[0]!.time).toBeGreaterThanOrEqual(v[v.length - 1]!.time);
    expect(Number(v[0]!.id.slice(1))).toBeGreaterThan(Number(v[1]!.id.slice(1)));
  });
});
