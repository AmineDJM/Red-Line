import { describe, expect, it } from 'vitest';
import type { NationDef, ProvinceDef } from '@redline/shared';
import type { Api } from '../src/api/types.js';
import { useWorld } from '../src/store/world.js';

/** Serveur factice : carte courante (version 2) et carte archivée (version 1, autres identifiants). */
function fakeApi() {
  const calls: string[] = [];
  const nation = (v: number): NationDef =>
    ({ id: 'dza', name: 'Algérie', capitalProvinceId: v === 1 ? 'dza-26' : 'dza-13' }) as NationDef;
  const province = (id: string): ProvinceDef =>
    ({
      id,
      name: id,
      nationId: 'dza',
      neighbors: [],
      income: { money: 1 },
    }) as unknown as ProvinceDef;
  const ver = (map?: number) => map ?? 2;
  const api = {
    kind: 'http',
    async nations(map?: number) {
      calls.push(`nations:${map ?? '-'}`);
      return { nations: [nation(ver(map))], mapVersion: ver(map) };
    },
    async provinces(map?: number) {
      calls.push(`provinces:${map ?? '-'}`);
      return ver(map) === 1 ? [province('dza-26'), province('dza-41')] : [province('dza-13')];
    },
    async provincesGeoJSON(map?: number) {
      calls.push(`geo:${map ?? '-'}`);
      return { type: 'FeatureCollection', features: [] };
    },
    async routes(map?: number) {
      calls.push(`routes:${map ?? '-'}`);
      return null;
    },
    async mapNames(map: number) {
      calls.push(`names:${map}`);
      return { provinces: {}, cities: {} };
    },
    async catalog() {
      return [];
    },
    async tiles() {
      return null;
    },
    async basemap() {
      return { land: null, coastline: null, seas: null, countries: null, cities: null };
    },
    async glyphsAvailable() {
      return false;
    },
    async researchNodes() {
      return [];
    },
    async balance() {
      return null;
    },
  } as unknown as Api;
  return { api, calls };
}

describe('carte de la partie (versions de carte)', () => {
  it('carte courante, puis carte archivée d’une partie ancienne, puis retour', async () => {
    const { api, calls } = fakeApi();
    const w = useWorld.getState();
    await w.load(api);
    expect(useWorld.getState().status).toBe('ready');
    expect(useWorld.getState().mapVersion).toBe(2);
    expect(Object.keys(useWorld.getState().provinces)).toEqual(['dza-13']);

    // Partie courante (version 2 annoncée par l'accueil) : aucun rechargement.
    calls.length = 0;
    await useWorld.getState().load(api, 2);
    expect(calls.filter((c) => !c.startsWith('routes'))).toEqual([]);

    // Partie ancienne : carte 1 (identifiants et routes de la carte 1).
    await useWorld.getState().load(api, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(
      expect.arrayContaining(['nations:1', 'provinces:1', 'geo:1', 'routes:1']),
    );
    expect(useWorld.getState().mapVersion).toBe(1);
    expect(Object.keys(useWorld.getState().provinces).sort()).toEqual(['dza-26', 'dza-41']);
    expect(useWorld.getState().nations.dza!.capitalProvinceId).toBe('dza-26');

    // Retour au salon : carte courante rechargée.
    calls.length = 0;
    await useWorld.getState().load(api);
    expect(calls).toEqual(expect.arrayContaining(['nations:-', 'provinces:-']));
    expect(useWorld.getState().mapVersion).toBe(2);
    expect(Object.keys(useWorld.getState().provinces)).toEqual(['dza-13']);
  });

  it('demandes croisées : seule la dernière carte demandée est retenue', async () => {
    const { api } = fakeApi();
    const a = useWorld.getState().load(api, 2);
    const b = useWorld.getState().load(api, 1);
    await Promise.all([a, b]);
    expect(useWorld.getState().requestedMap).toBe(1);
    expect(useWorld.getState().mapVersion).toBe(1);
    expect(Object.keys(useWorld.getState().provinces).sort()).toEqual(['dza-26', 'dza-41']);
  });
});
