import { describe, expect, it } from 'vitest';
import type { NationDef, PlayerView, ProvinceDef, UnitView, WeaponSystem } from '@redline/shared';
import { formatMoney } from '@redline/ui';
import {
  norm,
  parseCommand,
  resolvePlace,
  resolveUnits,
  suggest,
  type CommandCtx,
} from '../src/lib/commands.js';

const NBSP = ' ';

describe('formatMoney', () => {
  it('choisit l’unité et arrondit sans « $1 000 k »', () => {
    expect(formatMoney(85_000)).toBe(`$85${NBSP}k`);
    expect(formatMoney(450e6)).toBe(`$450${NBSP}M`);
    expect(formatMoney(1.24e9)).toBe(`$1,2${NBSP}Md`);
    expect(formatMoney(999_700)).toBe(`$1${NBSP}M`);
    expect(formatMoney(640)).toBe('$640');
  });
  it('gère les signes et les valeurs invalides', () => {
    expect(formatMoney(-2.5e6)).toBe(`−$2,5${NBSP}M`);
    expect(formatMoney(3e6, { signed: true })).toBe(`+$3${NBSP}M`);
    expect(formatMoney(Number.NaN)).toBe('—');
  });
});

// ——— Contexte minimal de la console ———

const unit = (id: string, owner: string, systemId: string, pos: [number, number]): UnitView => ({
  id,
  owner,
  level: owner === 'dza' ? 'own' : 'precise',
  pos,
  lastSeen: 0,
  uncertaintyKm: 0,
  systemId,
  count: 1,
  status: 'idle',
});

const province = (
  id: string,
  nationId: string,
  name: string,
  cityName: string,
  at: [number, number],
) =>
  ({
    id,
    name,
    nationId,
    centroid: at,
    cityPoint: at,
    cityName,
    isCapital: true,
    coastal: false,
    income: { money: 1 },
    buildings: [],
    neighbors: [],
    areaKm2: 1,
  }) as ProvinceDef;

const ctx: CommandCtx = {
  me: 'dza',
  view: {
    time: 0,
    me: 'dza',
    nations: {},
    provinces: {},
    units: {
      u1: unit('u1', 'dza', 'ground.t-90m', [3, 36]),
      u2: unit('u2', 'dza', 'ground.t-90m', [3.1, 36]),
      u3: unit('u3', 'dza', 'air.su-30mka', [3, 35]),
      e1: unit('e1', 'mar', 'ground.m1a2', [-6, 34]),
    },
    economy: { money: 0, incomePerDay: { money: 0 } } as PlayerView['economy'],
    victory: {} as PlayerView['victory'],
  } as PlayerView,
  catalog: {
    'ground.t-90m': { id: 'ground.t-90m', name: 'T-90M' } as WeaponSystem,
    'air.su-30mka': { id: 'air.su-30mka', name: 'Su-30MKA' } as WeaponSystem,
    'ground.m1a2': { id: 'ground.m1a2', name: 'M1A2 Abrams' } as WeaponSystem,
  },
  provinces: {
    'dza-1': province('dza-1', 'dza', 'Alger', 'Alger', [3.05, 36.75]),
    'mar-1': province('mar-1', 'mar', 'Rabat-Salé', 'Rabat', [-6.84, 34.02]),
  },
  nations: {
    dza: { id: 'dza', name: 'Algérie', capitalProvinceId: 'dza-1' } as NationDef,
    mar: { id: 'mar', name: 'Maroc', capitalProvinceId: 'mar-1' } as NationDef,
  },
  research: {},
  selection: ['u3'],
  label: (key, opts) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
};

describe('console de commande', () => {
  it('normalise accents et casse', () => {
    expect(norm('  Déplacer   ÉTÉ ')).toBe('deplacer ete');
  });

  it('résout les unités : sélection, tout, identifiants, nom de système', () => {
    expect(resolveUnits('sel', ctx)).toEqual(['u3']);
    expect(resolveUnits('tout', ctx).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(resolveUnits('u1,u2', ctx)).toEqual(['u1', 'u2']);
    expect(resolveUnits('t-90', ctx).sort()).toEqual(['u1', 'u2']);
    expect(resolveUnits('e1', ctx)).toEqual([]);
  });

  it('résout les lieux : ville, nation (capitale), coordonnées', () => {
    expect(resolvePlace('rabat', ctx)?.provinceId).toBe('mar-1');
    expect(resolvePlace('Maroc', ctx)?.provinceId).toBe('mar-1');
    expect(resolvePlace('36.5, 2.9', ctx)?.at).toEqual([2.9, 36.5]);
    expect(resolvePlace('atlantide', ctx)).toBeNull();
  });

  it('analyse un ordre de déplacement (alias français compris)', () => {
    const a = parseCommand('deplacer t-90m Rabat', ctx);
    expect(a.type).toBe('order');
    if (a.type === 'order') {
      expect(a.order).toMatchObject({ kind: 'move', to: [-6.84, 34.02] });
      expect(a.order.kind === 'move' && [...a.order.unitIds].sort()).toEqual(['u1', 'u2']);
    }
  });

  it('refuse une attaque sur une unité amie et accepte une cible ennemie', () => {
    expect(parseCommand('attack sel u1', ctx).type).toBe('error');
    expect(parseCommand('attack sel e1', ctx)).toMatchObject({
      type: 'order',
      order: { kind: 'attack', unitIds: ['u3'], targetId: 'e1' },
    });
  });

  it('gère vitesse, pause, fenêtres et commandes inconnues', () => {
    expect(parseCommand('speed x4', ctx)).toEqual({ type: 'speed', speed: 4 });
    expect(parseCommand(':pause', ctx)).toEqual({ type: 'pause', paused: true });
    expect(parseCommand('open research', ctx)).toEqual({ type: 'open', window: 'research' });
    expect(parseCommand('xyzzy', ctx).type).toBe('error');
    expect(parseCommand('', ctx).type).toBe('error');
  });

  it('propose les commandes puis les arguments', () => {
    const first = suggest('mo', ctx).map((s) => s.insert);
    expect(first[0]).toMatch(/^move/);
    const places = suggest('move t-90m Ra', ctx);
    expect(places.some((s) => /rabat/i.test(s.label))).toBe(true);
  });
});
