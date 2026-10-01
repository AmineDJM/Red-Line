import { describe, expect, it } from 'vitest';
import type { NationView, PlayerView, UnitView } from '@redline/shared';
import { HOUR } from '@redline/shared';
import { cuesFor } from '../src/audio/cues.js';
import { CATEGORY_RULES, GLOBAL_MAX, SfxLimiter } from '../src/audio/limiter.js';
import {
  MoodDirector,
  ambienceLayers,
  moodInputFromView,
  selectMood,
  type MoodInput,
} from '../src/audio/musicState.js';
import { parseAudioSettings } from '../src/audio/settings.js';
import { SFX, type SfxDef } from '../src/audio/sounds.js';
import { weldLoop } from '../src/audio/weld.js';

// ——— Sélecteur d'état musical ———

const calm: MoodInput = {
  me: 'dza',
  winner: null,
  winnerIsAlly: false,
  meAlive: true,
  wars: 0,
  alertLevel: 5,
  mobilized: false,
  threatened: false,
  ownInCombat: 0,
  enemiesNear: 0,
  recentHostile: 0,
};

describe('selectMood', () => {
  it('paix par défaut, tension sur alerte, ultimatum ou mobilisation', () => {
    expect(selectMood(calm).mood).toBe('peace');
    expect(selectMood({ ...calm, alertLevel: 3 }).mood).toBe('tension');
    expect(selectMood({ ...calm, alertLevel: 4 }).mood).toBe('peace');
    expect(selectMood({ ...calm, threatened: true }).mood).toBe('tension');
    expect(selectMood({ ...calm, mobilized: true }).mood).toBe('tension');
  });
  it('guerre, puis combat au contact ou sous le feu', () => {
    expect(selectMood({ ...calm, wars: 1 }).mood).toBe('war');
    expect(selectMood({ ...calm, wars: 1, enemiesNear: 3 }).mood).toBe('combat');
    expect(selectMood({ ...calm, wars: 1, recentHostile: 2 }).mood).toBe('combat');
    expect(selectMood({ ...calm, ownInCombat: 1 }).mood).toBe('combat');
    const hot = selectMood({ ...calm, wars: 2, ownInCombat: 12, recentHostile: 5 });
    expect(hot.intensity).toBe(1);
    expect(selectMood({ ...calm, ownInCombat: 1 }).intensity).toBeLessThan(0.6);
  });
  it('fins de partie : victoire (soi ou allié), défaite (autre vainqueur ou nation éliminée)', () => {
    expect(selectMood({ ...calm, winner: 'dza' }).mood).toBe('victory');
    expect(selectMood({ ...calm, winner: 'fra', winnerIsAlly: true }).mood).toBe('victory');
    expect(selectMood({ ...calm, winner: 'mar', ownInCombat: 4 }).mood).toBe('defeat');
    expect(selectMood({ ...calm, meAlive: false, wars: 1 }).mood).toBe('defeat');
  });
  it('couches d’ambiance superposées selon l’état', () => {
    const war = ambienceLayers({ mood: 'war', intensity: 0 });
    expect(war['amb-tension']).toBeGreaterThan(0);
    expect(war['amb-war']).toBeGreaterThan(0);
    expect(war['amb-peace']).toBe(0);
    const combat = ambienceLayers({ mood: 'combat', intensity: 1 });
    expect(combat['amb-combat']).toBe(1);
    expect(combat['amb-war']).toBeGreaterThan(0);
    expect(
      Object.values(ambienceLayers({ mood: 'victory', intensity: 0 })).every((v) => v === 0),
    ).toBe(true);
  });
});

describe('MoodDirector (hystérésis)', () => {
  it('monte tout de suite, redescend après le temps de maintien', () => {
    const d = new MoodDirector({
      peace: 0,
      tension: 10_000,
      war: 5_000,
      combat: 20_000,
      victory: 0,
      defeat: 0,
    });
    expect(d.update({ mood: 'combat', intensity: 0.8 }, 0).mood).toBe('combat');
    // Accalmie brève : on reste au combat.
    expect(d.update({ mood: 'war', intensity: 0 }, 1_000).mood).toBe('combat');
    expect(d.update({ mood: 'war', intensity: 0 }, 15_000).mood).toBe('combat');
    // Reprise du combat : le compteur repart de zéro.
    expect(d.update({ mood: 'combat', intensity: 0.5 }, 16_000).mood).toBe('combat');
    expect(d.update({ mood: 'war', intensity: 0 }, 17_000).mood).toBe('combat');
    expect(d.update({ mood: 'war', intensity: 0 }, 37_500).mood).toBe('war');
    expect(d.update({ mood: 'peace', intensity: 0 }, 38_000).mood).toBe('war');
    expect(d.update({ mood: 'peace', intensity: 0 }, 43_100).mood).toBe('peace');
  });
  it('une fin de partie est définitive jusqu’au reset', () => {
    const d = new MoodDirector();
    d.update({ mood: 'victory', intensity: 0 }, 0);
    expect(d.update({ mood: 'combat', intensity: 1 }, 1).mood).toBe('victory');
    expect(d.update({ mood: 'peace', intensity: 0 }, 999_999).mood).toBe('victory');
    d.reset();
    expect(d.state.mood).toBe('peace');
  });
});

// ——— Déduction depuis la vue ———

const nation = (id: string, extra: Partial<NationView> = {}): NationView => ({
  id,
  name: id,
  color: '#888',
  isAi: true,
  isPlayer: false,
  alive: true,
  provinceCount: 1,
  ...extra,
});

const unit = (
  id: string,
  owner: string,
  pos: [number, number],
  status: UnitView['status'] = 'idle',
): UnitView => ({
  id,
  owner,
  level: owner === 'dza' ? 'own' : 'precise',
  pos,
  lastSeen: 0,
  uncertaintyKm: 0,
  status,
});

function view(partial: Partial<PlayerView>): PlayerView {
  return {
    time: 10 * HOUR,
    me: 'dza',
    nations: { dza: nation('dza'), mar: nation('mar'), fra: nation('fra') },
    provinces: {},
    units: {},
    economy: { money: 0, resources: {}, incomePerDay: { money: 0 }, production: [] } as never,
    victory: { provinceShareTarget: 0.5, leader: null, winner: null },
    ...partial,
  };
}

describe('moodInputFromView', () => {
  it('guerres, combats et ennemis proches', () => {
    const v = view({
      nations: { dza: nation('dza'), mar: nation('mar', { relation: 'war' }), fra: nation('fra') },
      units: {
        a: unit('a', 'dza', [3, 36], 'combat'),
        b: unit('b', 'dza', [-1, 35]),
        e: unit('e', 'mar', [-1.5, 35]),
        far: unit('far', 'mar', [-60, 10]),
        n: unit('n', 'fra', [3.1, 36]),
      },
    });
    const i = moodInputFromView(v, 'dza', 0);
    expect(i.wars).toBe(1);
    expect(i.ownInCombat).toBe(1);
    expect(i.enemiesNear).toBe(1);
    expect(selectMood(i).mood).toBe('combat');
  });
  it('ultimatum récent contre le joueur → tension ; désescalade ou ancienneté → paix', () => {
    const ultimatum = {
      id: 'n1',
      time: 9 * HOUR,
      category: 'war' as const,
      headline: 'Ultimatum du Maroc à l’Algérie',
      body: '',
      at: null,
      nations: ['mar', 'dza'],
    };
    expect(selectMood(moodInputFromView(view({ news: [ultimatum] }), 'dza', 0)).mood).toBe(
      'tension',
    );
    const deesc = { ...ultimatum, id: 'n2', time: 9.5 * HOUR, category: 'peace' as const };
    expect(moodInputFromView(view({ news: [ultimatum, deesc] }), 'dza', 0).threatened).toBe(false);
    const old = view({ news: [ultimatum], time: 80 * HOUR });
    expect(moodInputFromView(old, 'dza', 0).threatened).toBe(false);
    const others = { ...ultimatum, nations: ['mar', 'fra'] };
    expect(moodInputFromView(view({ news: [others] }), 'dza', 0).threatened).toBe(false);
  });
  it('fin de partie et spectateur', () => {
    const v = view({ victory: { provinceShareTarget: 0.5, leader: 'mar', winner: 'mar' } });
    expect(selectMood(moodInputFromView(v, 'dza', 0)).mood).toBe('defeat');
    const spect = view({ spectator: true, alertLevel: 1 });
    expect(selectMood(moodInputFromView(spect, 'dza', 0)).mood).toBe('peace');
  });
});

// ——— Limiteur d'effets ———

const def = (over: Partial<SfxDef>): SfxDef => ({
  category: 'combat',
  priority: 50,
  volume: 1,
  bus: 'sfx',
  gapMs: 0,
  ...over,
});

describe('SfxLimiter', () => {
  it('respecte l’écart minimal par son', () => {
    const l = new SfxLimiter();
    const d = def({ category: 'ui', gapMs: 100 });
    expect(l.request('order', d, 0, 50).play).toBe(true);
    expect(l.request('order', d, 50, 50)).toEqual({ play: false, reason: 'gap' });
    expect(l.request('order', d, 120, 50).play).toBe(true);
  });
  it('regroupe une rafale : au plus N lectures par fenêtre, de plus en plus douces', () => {
    const l = new SfxLimiter();
    const d = def({ category: 'combat' });
    const rule = CATEGORY_RULES.combat;
    const plays = [];
    for (let i = 0; i < 10; i++) {
      const r = l.request('unit-destroyed', d, i * 10, 30);
      if (r.play) plays.push(r.gain);
    }
    expect(plays.length).toBe(rule.burstMax);
    expect(plays[1]!).toBeLessThan(plays[0]!);
    // Nouvelle fenêtre : ça rejoue.
    expect(l.request('unit-destroyed', d, rule.burstMs + 100, 30).play).toBe(true);
  });
  it('plafonne une catégorie ; un son plus prioritaire remplace le moins prioritaire', () => {
    const l = new SfxLimiter();
    const low = l.request('war-declared', def({ category: 'sting', priority: 70 }), 0, 5000);
    expect(low.play).toBe(true);
    // Une autre ponctuation moins prioritaire est abandonnée pendant la première.
    expect(l.request('city-captured', def({ category: 'sting', priority: 60 }), 100, 3000)).toEqual(
      {
        play: false,
        reason: 'category',
      },
    );
    const high = l.request('war-declared-me', def({ category: 'sting', priority: 100 }), 200, 6000);
    expect(high.play && low.play && high.replace === low.handle).toBe(true);
  });
  it('plafond global, sans jamais couper une ponctuation dramatique', () => {
    const l = new SfxLimiter(
      { ...CATEGORY_RULES, combat: { maxConcurrent: 99, burstMs: 1, burstMax: 99 } },
      3,
    );
    expect(
      l.request('war-declared-me', def({ category: 'sting', priority: 100 }), 0, 9000).play,
    ).toBe(true);
    expect(l.request('a', def({ priority: 10 }), 0, 9000).play).toBe(true);
    expect(l.request('b', def({ priority: 20 }), 0, 9000).play).toBe(true);
    expect(l.playing(1)).toBe(3);
    const c = l.request('c', def({ priority: 30 }), 0, 9000);
    expect(c.play).toBe(true);
    expect(l.playing(1)).toBe(3);
    // Rien de moins prioritaire que « d » hors ponctuation : abandon.
    expect(l.request('d', def({ priority: 5 }), 0, 9000)).toEqual({
      play: false,
      reason: 'global',
    });
    // Les lectures finies libèrent leur place.
    expect(l.request('e', def({ priority: 5 }), 9001, 100).play).toBe(true);
  });
  it('les réglages réels ne saturent pas une salve de notifications', () => {
    const l = new SfxLimiter();
    let played = 0;
    const ids = Object.keys(SFX) as (keyof typeof SFX)[];
    for (let i = 0; i < 400; i++) {
      const id = ids[i % ids.length]!;
      if (l.request(id, SFX[id], i, 2000).play) played++;
      expect(l.playing(i)).toBeLessThanOrEqual(GLOBAL_MAX);
    }
    expect(played).toBeGreaterThan(0);
    expect(played).toBeLessThan(40);
  });
});

// ——— Effets des notifications ———

describe('cuesFor', () => {
  const v = view({
    nations: {
      dza: nation('dza'),
      mar: nation('mar', { relation: 'war' }),
      fra: nation('fra', { relation: 'ally' }),
      ita: nation('ita'),
    },
    units: { m1: unit('m1', 'mar', [0, 30]), m2: unit('m2', 'dza', [3, 36]) },
    provinces: { p1: { id: 'p1', owner: 'dza', buildings: [] } },
  });
  it('déclaration de guerre : plus forte contre le joueur', () => {
    expect(cuesFor({ kind: 'war_declared', time: 0, by: 'mar', against: 'dza' }, 'dza', v)).toEqual(
      {
        cues: [{ id: 'war-declared-me' }],
        hostile: true,
      },
    );
    const third = cuesFor({ kind: 'war_declared', time: 0, by: 'ita', against: 'mar' }, 'dza', v);
    expect(third.cues[0]!.id).toBe('war-declared');
    expect(third.cues[0]!.gain).toBeLessThan(1);
    const ally = cuesFor({ kind: 'war_declared', time: 0, by: 'ita', against: 'fra' }, 'dza', v);
    expect(ally.cues[0]!.gain).toBe(1);
  });
  it('captures, pertes, missiles, paix', () => {
    const cap = (by: string, from: string) =>
      cuesFor(
        { kind: 'province_captured', time: 0, at: [0, 0], provinceId: 'p', by, from },
        'dza',
        v,
      ).cues.map((c) => c.id);
    expect(cap('dza', 'mar')).toEqual(['city-captured']);
    expect(cap('mar', 'dza')).toEqual(['city-lost']);
    expect(cap('mar', 'ita')).toEqual([]);
    const missile = (unitId: string) =>
      cuesFor(
        { kind: 'missile_launch', time: 0, at: [0, 0], unitId, impactAt: 100 },
        'dza',
        v,
      ).cues.map((c) => c.id);
    expect(missile('m2')).toEqual(['missile-launch']);
    expect(missile('m1')).toEqual(['radar-alert', 'missile-launch']);
    expect(
      cuesFor({ kind: 'peace_signed', time: 0, a: 'dza', b: 'mar' }, 'dza', v).cues[0]!.id,
    ).toBe('peace-signed');
    expect(cuesFor({ kind: 'peace_signed', time: 0, a: 'ita', b: 'mar' }, 'dza', v).cues).toEqual(
      [],
    );
  });
});

// ——— Soudure des boucles et réglages ———

describe('weldLoop', () => {
  it('rend la jointure continue (fin de boucle → début de boucle)', () => {
    // Fichier : [pré-marge = fin de boucle] + boucle + [post-marge], avec un léger décalage de codec.
    const a = 100;
    const b = 1100;
    // Signal périodique (la boucle en contient 10 périodes) ; artefact de codec avant `loopEnd`.
    const data = new Float32Array(1200);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin((2 * Math.PI * (i - a)) / 100) + (i >= b - 64 && i < b ? 0.3 : 0);
    }
    const before = Math.abs(data[b - 1]! - data[a]!);
    weldLoop(data, a, b, 64);
    const after = Math.abs(data[b - 1]! - data[a]!);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(Math.abs(data[a - 1]! - data[a]!), 6);
  });
});

describe('parseAudioSettings', () => {
  it('tolère les valeurs absentes, invalides ou hors bornes', () => {
    const d = parseAudioSettings(null);
    expect(d.muted).toBe(false);
    expect(parseAudioSettings('pas du json')).toEqual(d);
    const s = parseAudioSettings('{"master":2,"music":-1,"sfx":"x","muted":true}');
    expect(s.master).toBe(1);
    expect(s.music).toBe(0);
    expect(s.sfx).toBe(d.sfx);
    expect(s.muted).toBe(true);
  });
});
