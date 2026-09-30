import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/host/scheduler.js';
import { gameNow, realTimeFor, reanchor } from '../src/host/clock.js';
import { loadConfig } from '../src/config.js';
import { engineFromModule, loadRealEngine } from '../src/engine.js';
import { createFakeEngine } from './fake-engine.js';
import { sleep } from './helpers.js';

describe('ordonnanceur global', () => {
  it('déclenche les clés dans l’ordre de leur échéance avec un seul minuteur', async () => {
    const fired: string[] = [];
    const s = new Scheduler((k) => fired.push(k));
    const now = Date.now();
    s.set('c', now + 60);
    s.set('a', now + 10);
    s.set('b', now + 30);
    s.set('d', now + 20);
    s.delete('d');
    s.set('a', now + 40); // reprogrammation : l'ancienne entrée est ignorée
    await sleep(120);
    expect(fired).toEqual(['b', 'a', 'c']);
    s.stop();
  });

  it('permet de se reprogrammer depuis le rappel', async () => {
    let n = 0;
    const s: Scheduler = new Scheduler((k) => {
      n++;
      if (n < 5) s.set(k, Date.now() + 5);
    });
    s.set('x', Date.now());
    await sleep(100);
    expect(n).toBe(5);
    expect(s.size).toBe(0);
    s.stop();
  });
});

describe('horloge de partie', () => {
  it('convertit temps réel ↔ temps de jeu et ré-ancre sans retour en arrière', () => {
    const c = { anchorGame: 1000, anchorReal: 10_000, speed: 4, paused: false };
    expect(gameNow(c, 10_500)).toBe(3000);
    expect(realTimeFor(c, 3000)).toBe(10_500);
    const p = reanchor(c, 10_500, 3000, { paused: true });
    expect(gameNow(p, 99_999)).toBe(3000);
    expect(realTimeFor(p, 5000)).toBeNull();
    const r = reanchor(p, 20_000, 3000, { paused: false, speed: 2 });
    expect(gameNow(r, 21_000)).toBe(5000);
  });
});

describe('configuration et moteur', () => {
  it('valide les variables d’environnement', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    // En développement : base du PostgreSQL jetable et migrations au démarrage par défaut.
    expect(loadConfig({})).toMatchObject({
      databaseUrl: 'postgres://postgres@127.0.0.1:54329/redline',
      migrateOnStart: true,
    });
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', NODE_ENV: 'production' })).toThrow(
      /SESSION_SECRET/,
    );
    const c = loadConfig({ DATABASE_URL: 'postgres://x', MIGRATE_ON_START: 'true', PORT: '4000' });
    expect(c).toMatchObject({ port: 4000, migrateOnStart: true, snapshotIntervalS: 60 });
    expect(c.dataDir).toMatch(/\/data$/);
    expect(c.tilesDir).toBe(`${c.dataDir}/tiles`);
    expect(c.clientDist).toMatch(/apps\/client\/dist$/);
  });

  it('assemble le moteur injecté et détecte un moteur incomplet', () => {
    const fake = createFakeEngine();
    const e = engineFromModule(fake as unknown as Record<string, unknown>);
    expect('missing' in e).toBe(false);
    const partial = engineFromModule({ buildWorld: () => null });
    expect('missing' in partial && partial.missing).toContain('advanceTo');
    // Le vrai moteur n'est pas encore implémenté : le serveur le signale sans planter.
    const real = loadRealEngine();
    expect(real.engine === null ? real.missing.length > 0 : true).toBe(true);
  });
});
