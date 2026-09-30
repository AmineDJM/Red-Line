import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import { dbAvailable, makeDataDir, resetDb, startApp } from './helpers.js';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('fichiers statiques, tuiles et carte', () => {
  let built: BuiltApp;
  const dataDir = makeDataDir({ dists: true });
  // TILES_DIR séparé (disque Render) ne contenant que la version zoom 8.
  const tilesDir = mkdtempSync(join(tmpdir(), 'redline-tiles-'));
  const big = Buffer.alloc(10_000, 7);
  writeFileSync(join(tilesDir, 'satellite.pmtiles'), big);

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir, env: { TILES_DIR: tilesDir } });
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('sert /tiles avec les requêtes Range et un cache long', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/tiles/satellite-lowzoom.pmtiles', // repli sur DATA_DIR/tiles
      headers: { range: 'bytes=10-19' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 10-19/4096');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.rawPayload).toEqual(
      Buffer.from(Array.from({ length: 10 }, (_, i) => (10 + i) % 251)),
    );
    expect(String(res.headers['cache-control'])).toContain('max-age=604800');

    const full = await built.app.inject({ method: 'GET', url: '/tiles/satellite.pmtiles' });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(10_000);

    const tail = await built.app.inject({
      method: 'GET',
      url: '/tiles/satellite.pmtiles',
      headers: { range: 'bytes=-100' },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(100);

    const bad = await built.app.inject({
      method: 'GET',
      url: '/tiles/satellite.pmtiles',
      headers: { range: 'bytes=20000-30000' },
    });
    expect(bad.statusCode).toBe(416);

    const head = await built.app.inject({ method: 'HEAD', url: '/tiles/satellite.pmtiles' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('10000');

    expect(
      (await built.app.inject({ method: 'GET', url: '/tiles/absent.pmtiles' })).statusCode,
    ).toBe(404);
    expect(
      (await built.app.inject({ method: 'GET', url: '/tiles/..%2f..%2fetc%2fpasswd' })).statusCode,
    ).toBe(404);
  });

  it('/api/map/tiles choisit satellite.pmtiles (zoom 8) s’il existe', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/map/tiles' });
    expect(res.json()).toEqual({ satellite: '/tiles/satellite.pmtiles', maxzoom: 8 });
  });

  it('sert /basemap et la carte (nations, provinces, geojson avec ETag)', async () => {
    const b = await built.app.inject({ method: 'GET', url: '/basemap/coast.geojson' });
    expect(b.statusCode).toBe(200);
    const nations = await built.app.inject({ method: 'GET', url: '/api/map/nations' });
    expect(nations.json().nations.map((n: { id: string }) => n.id)).toEqual(['fra', 'dza', 'usa']);
    const provinces = await built.app.inject({ method: 'GET', url: '/api/map/provinces' });
    expect(provinces.json().provinces).toHaveLength(4);

    const geo = await built.app.inject({ method: 'GET', url: '/api/map/provinces.geojson' });
    expect(geo.statusCode).toBe(200);
    expect(geo.headers['content-type']).toContain('application/geo+json');
    expect(geo.json().features[0].properties.id).toBe('fra-1');
    const etag = String(geo.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const again = await built.app.inject({
      method: 'GET',
      url: '/api/map/provinces.geojson',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    const gz = await built.app.inject({
      method: 'GET',
      url: '/api/map/provinces.geojson',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
  });

  it('sert le client et le back-office avec repli SPA, sans masquer les API', async () => {
    const root = await built.app.inject({ method: 'GET', url: '/' });
    expect(root.body).toContain('client');
    const deep = await built.app.inject({ method: 'GET', url: '/partie/123' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('client');
    const asset = await built.app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(asset.body).toBe('console.log(1)');
    expect(String(asset.headers['cache-control'])).toContain('immutable');

    // Version précompressée (build) servie selon Accept-Encoding ; repli sinon.
    const { precompress } = await import('../scripts/precompress.mjs');
    writeFileSync(join(dataDir, 'client-dist/assets/big-1.js'), 'const x = 1;\n'.repeat(500));
    await precompress([join(dataDir, 'client-dist')]);
    const brRes = await built.app.inject({
      method: 'GET',
      url: '/assets/big-1.js',
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(brRes.headers['content-encoding']).toBe('br');
    expect(Number(brRes.headers['content-length'])).toBeLessThan(1000);
    const plain = await built.app.inject({ method: 'GET', url: '/assets/big-1.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.length).toBe(13 * 500);
    const tile = await built.app.inject({
      method: 'GET',
      url: '/tiles/satellite-lowzoom.pmtiles',
      headers: { 'accept-encoding': 'br, gzip', range: 'bytes=0-9' },
    });
    expect(tile.statusCode).toBe(206);
    expect(tile.headers['content-encoding']).toBeUndefined();

    const adm = await built.app.inject({ method: 'GET', url: '/admin/catalogue/eu.x' });
    expect(adm.body).toContain('admin');
    expect((await built.app.inject({ method: 'GET', url: '/admin' })).body).toContain('admin');

    for (const url of ['/api/inconnue', '/admin/api/inconnue']) {
      const r = await built.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error).toBe('not_found');
    }
    expect((await built.app.inject({ method: 'POST', url: '/nimporte' })).statusCode).toBe(404);
    expect((await built.app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      ok: true,
    });
  });
});

describe.skipIf(!hasDb)('sans builds du client ni tuiles zoom 8', () => {
  it('renvoie une page texte simple et la version lowzoom', async () => {
    await resetDb();
    const built = await startApp({ dataDir: makeDataDir(), instanceId: 'test-static-2' });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('Red Line');
      const tiles = await built.app.inject({ method: 'GET', url: '/api/map/tiles' });
      expect(tiles.json()).toEqual({ satellite: '/tiles/satellite-lowzoom.pmtiles', maxzoom: 5 });
    } finally {
      await built.app.close();
    }
  });
});
