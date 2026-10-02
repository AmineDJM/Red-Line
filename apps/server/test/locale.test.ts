import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALES } from '@redline/shared';
import type { BuiltApp } from '../src/app.js';
import { accountLocale, placeName, serverT } from '../src/i18n/index.js';
import { api, dbAvailable, makeDataDir, resetDb, sessionCookie, startApp } from './helpers.js';

describe('textes du serveur par langue (notifications push)', () => {
  it('repli : langue → anglais → français → clé', () => {
    expect(serverT('fr', 'push.war', { nation: 'France' })).toBe('France vous déclare la guerre.');
    expect(serverT('en', 'push.war', { nation: 'France' })).toContain('France');
    expect(serverT('en', 'push.war', { nation: 'France' })).not.toContain('vous déclare');
    // Clé inconnue : la clé elle-même, jamais d'exception.
    expect(serverT('de', 'push.inexistante')).toBe('push.inexistante');
  });

  it('les quatorze langues traduisent chaque notification, variables comprises', () => {
    for (const l of LOCALES.filter((x) => x !== 'fr')) {
      for (const key of ['war', 'attack', 'provinceLost', 'victoryOf']) {
        const text = serverT(l, `push.${key}`, { nation: 'NATION_X', province: 'PROVINCE_Y' });
        expect(text, `${l}/${key}`).not.toContain('{{');
        expect(text, `${l}/${key}`).not.toMatch(/déclare la guerre|attaque|capture par/);
      }
      expect(serverT(l, 'push.title', { game: 'G1' })).toContain('Red Line');
    }
  });

  it('langue du compte inconnue → français ; noms de lieux localisés quand disponibles', () => {
    expect(accountLocale(null)).toBe('fr');
    expect(accountLocale('xx')).toBe('fr');
    expect(accountLocale('ja')).toBe('ja');
    expect(placeName('fr', 'nations', 'FR', 'France')).toBe('France');
    expect(placeName('en', 'nations', 'ZZ-inconnu', 'Nom français')).toBe('Nom français');
  });
});

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('langue du compte', () => {
  let built: BuiltApp;
  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir: makeDataDir() });
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('un invité reçoit la langue de son navigateur, modifiable ensuite', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { 'accept-language': 'ar-EG,ar;q=0.9,en;q=0.5' },
    });
    expect(res.json().user.locale).toBe('ar');
    const cookie = sessionCookie(res);
    const patch = await api(built.app, cookie)('PATCH', '/api/me', { locale: 'tr' });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().user.locale).toBe('tr');
    const me = await api(built.app, cookie)('GET', '/api/me');
    expect(me.json().user.locale).toBe('tr');
  });

  it('langue invalide refusée, anonyme refusé', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/auth/guest' });
    const cookie = sessionCookie(res);
    const bad = await api(built.app, cookie)('PATCH', '/api/me', { locale: 'xx' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const anon = await api(built.app, null)('PATCH', '/api/me', { locale: 'en' });
    expect(anon.statusCode).toBe(401);
  });
});
