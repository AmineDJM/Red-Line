import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogFileSchema, NationDefSchema, ProvinceDefSchema, type NationDef, type ProvinceDef, type WeaponSystem } from '@redline/shared';
import catalogFixture from '../test-fixtures/catalog.json';
import nationsFixture from '../test-fixtures/nations.json';
import provincesFixture from '../test-fixtures/provinces.json';
import { MockGameConnection } from '../src/net/mock.js';
import { bindConnection, gameNow, useGame } from '../src/store/game.js';

describe('fixtures du mode démonstration', () => {
  it('respectent les schémas partagés', () => {
    expect(() => CatalogFileSchema.parse(catalogFixture)).not.toThrow();
    for (const n of nationsFixture.nations) expect(() => NationDefSchema.parse(n)).not.toThrow();
    for (const p of provincesFixture.provinces) expect(() => ProvinceDefSchema.parse(p)).not.toThrow();
  });
});

describe('MockGameConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const data = {
    nations: nationsFixture.nations as NationDef[],
    provinces: provincesFixture.provinces as unknown as ProvinceDef[],
    catalog: CatalogFileSchema.parse(catalogFixture).systems as WeaponSystem[],
  };

  it('produit une vue plausible (unités à tous les niveaux d’information)', () => {
    const conn = new MockGameConnection(data, { me: 'dza', liveEvents: false });
    const unbind = bindConnection(conn);
    const v = useGame.getState().view!;
    expect(v.me).toBe('dza');
    const units = Object.values(v.units);
    expect(units.filter((u) => u.owner === 'dza').length).toBeGreaterThan(10);
    const levels = new Set(units.map((u) => u.level));
    for (const l of ['own', 'precise', 'identified', 'detected']) expect(levels.has(l as never)).toBe(true);
    expect(units.filter((u) => u.level === 'detected').every((u) => u.systemId === undefined)).toBe(true);
    expect(useGame.getState().notifications.length).toBeGreaterThan(0);
    unbind();
  });

  it('répond à un ordre de déplacement par un trajet et à la vitesse par un ré-ancrage', async () => {
    const conn = new MockGameConnection(data, { me: 'dza', liveEvents: false });
    const unbind = bindConnection(conn);
    const own = Object.values(useGame.getState().view!.units).find((u) => u.owner === 'dza' && u.systemId)!;
    const res = await conn.sendOrder({ kind: 'move', unitIds: [own.id], to: [own.pos[0] + 1, own.pos[1]] });
    expect(res.ok).toBe(true);
    const moved = useGame.getState().view!.units[own.id]!;
    expect(moved.move?.legs).toHaveLength(1);
    expect(moved.status).toBe('moving');

    const before = gameNow();
    conn.setSpeed(8);
    vi.advanceTimersByTime(1000);
    expect(gameNow() - before).toBeGreaterThanOrEqual(7900);
    conn.setPaused(true);
    const frozen = gameNow();
    vi.advanceTimersByTime(5000);
    expect(gameNow()).toBe(frozen);
    unbind();
  });

  it('refuse un ordre sur une unité ennemie', async () => {
    const conn = new MockGameConnection(data, { me: 'dza', liveEvents: false });
    const unbind = bindConnection(conn);
    const enemy = Object.values(useGame.getState().view!.units).find((u) => u.owner !== 'dza')!;
    await expect(conn.sendOrder({ kind: 'stop', unitIds: [enemy.id] })).resolves.toMatchObject({ ok: false, error: 'not_owner' });
    unbind();
  });
});
