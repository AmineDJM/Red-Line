import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';

const login = async (role?: 'moderator' | 'balance') => {
  const api = createApi(createMockTransport({ role, latencyMs: 0 }));
  await api.login({ email: 'a@b.fr', password: 'x' });
  return api;
};

describe('serveur factice (contrat REST)', () => {
  it('refuse sans session (401) puis charge tout le catalogue de data/', async () => {
    const api = createApi(createMockTransport({ latencyMs: 0 }));
    await expect(api.listSystems()).rejects.toMatchObject({ status: 401 });
    await api.login({ email: 'a@b.fr', password: 'x' });
    const { systems } = await api.listSystems();
    expect(systems.filter((s) => s.system.category === 'fighter')).toHaveLength(27);
  });

  it('modifie, historise et revient en arrière', async () => {
    const api = await login();
    const { system } = await api.getSystem('eu.rafale');
    const saved = await api.updateSystem('eu.rafale', {
      data: { ...system.system, cost: { ...system.system.cost, money: 999 } },
      message: 'test',
      scope: 'running_games',
    });
    expect(saved.system.revision).toBe(system.revision + 1);
    const { changes } = await api.history('eu.rafale');
    expect(changes[0]!.after!.cost.money).toBe(999);
    const back = await api.revert('eu.rafale', changes[0]!.id);
    expect(back.system.system.cost.money).toBe(system.system.cost.money);
  });

  it('rejette une fiche invalide avec les issues zod (400)', async () => {
    const api = await login();
    const err = await api
      .createSystem({ data: { id: 'bad' }, message: '', scope: 'new_games' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(Array.isArray((err as ApiError).details)).toBe(true);
  });

  it('duplique, importe et exporte', async () => {
    const api = await login();
    const dup = await api.duplicateSystem('us.f-16', 'us.f-16-test');
    expect(dup.system.system.enabled).toBe(false);
    const { systems } = await api.exportCatalog();
    const f35 = systems.find((s) => s.id === 'us.f-35')!;
    const r = await api.importCatalog({
      systems: [f35, { ...f35, id: 'us.f-35x' }, { id: 1 }],
      message: 'Import',
    });
    expect(r).toMatchObject({ created: ['us.f-35x'], updated: ['us.f-35'] });
    expect(Array.isArray(r.errors) && r.errors.length).toBe(1);
  });

  it('rôles : la modération voit les parties mais pas le catalogue (403)', async () => {
    const api = await login('moderator');
    await expect(api.listSystems()).rejects.toMatchObject({ status: 403 });
    const { games } = await api.listGames();
    const paused = games.find((g) => g.game.status === 'paused')!;
    await api.resumeGame(paused.game.id);
    const after = await api.listGames();
    expect(after.games.find((g) => g.game.id === paused.game.id)!.game.status).toBe('running');
    const m = await api.metrics();
    expect(m.games).toBeGreaterThan(0);
  });
});
