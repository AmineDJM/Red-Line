/**
 * Greffon Vite de développement : sert /tiles, /basemap et /glyphs directement depuis `data/`
 * quand le fichier existe (utile sans serveur de jeu, avec ?mock=1). Sinon, la requête passe au proxy.
 * Activé par REDLINE_LOCAL_DATA=1. Gère les requêtes HTTP Range (PMTiles).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const TYPES: Record<string, string> = {
  '.pmtiles': 'application/octet-stream',
  '.geojson': 'application/geo+json',
  '.json': 'application/json',
  '.pbf': 'application/x-protobuf',
};

export function localData(dataDir: string, tilesDir = path.join(dataDir, 'tiles')): Plugin {
  const roots: [string, string][] = [
    ['/tiles/', tilesDir],
    ['/basemap/', path.join(dataDir, 'basemap')],
    ['/glyphs/', path.join(dataDir, 'glyphs')],
  ];
  return {
    name: 'redline-local-data',
    apply: 'serve',
    configureServer(server) {
      // Mini-API en lecture seule pour le mode démonstration (?mock=1), uniquement sur demande explicite
      // (en-tête x-redline-mock) : n'interfère jamais avec le vrai serveur.
      server.middlewares.use((req, res, next) => {
        if (!req.headers['x-redline-mock'] || !req.url?.startsWith('/api/')) return next();
        const url = req.url.split('?')[0];
        const readJson = (f: string): unknown =>
          JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
        const list = (v: unknown, key: string) =>
          Array.isArray(v) ? v : ((v as Record<string, unknown>)?.[key] ?? []);
        const send = (body: unknown) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          if (url === '/api/map/nations')
            return send({ nations: list(readJson('map/nations.json'), 'nations') });
          if (url === '/api/map/provinces')
            return send({ provinces: list(readJson('map/provinces.json'), 'provinces') });
          if (url === '/api/map/routes' && fs.existsSync(path.join(dataDir, 'map/routes.json')))
            return send(readJson('map/routes.json'));
          if (url === '/api/map/provinces.geojson') {
            res.setHeader('Content-Type', 'application/geo+json');
            fs.createReadStream(path.join(dataDir, 'map/provinces.geojson')).pipe(res);
            return;
          }
          if (url === '/api/scenarios') {
            const dir = path.join(dataDir, 'scenarios');
            const scenarios = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.json'))
              .map((f) => readJson(`scenarios/${f}`) as Record<string, unknown>)
              .map((x) => ({
                id: x.id,
                name: x.name,
                description: x.description ?? '',
                playableNations: x.playableNations ?? 'all',
              }));
            return send({ scenarios });
          }
          if (url === '/api/catalog') {
            const dir = path.join(dataDir, 'catalog');
            const systems = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.json'))
              .flatMap((f) => list(readJson(`catalog/${f}`), 'systems') as { enabled?: boolean }[])
              .filter((s) => s.enabled !== false);
            return send({ systems });
          }
        } catch {
          res.statusCode = 404;
          return send({ error: 'not_found' });
        }
        return next();
      });
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const root = roots.find(([prefix]) => url.startsWith(prefix));
        if (!root) return next();
        const rel = url.slice(root[0].length);
        const file = path.resolve(root[1], rel);
        if (
          !file.startsWith(path.resolve(root[1])) ||
          !fs.existsSync(file) ||
          !fs.statSync(file).isFile()
        ) {
          return next();
        }
        const size = fs.statSync(file).size;
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range;
        const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
        if (m) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          if (start >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', String(end - start + 1));
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.setHeader('Content-Length', String(size));
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
