import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { servedHost } from './security.js';

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * Origine publique pour les URL absolues (canonique, Open Graph, sitemap) : PUBLIC_URL si elle est
 * définie (domaine définitif, même si le site est appelé par l'adresse onrender.com), sinon l'hôte de la
 * requête (développement). Un hôte invalide retombe sur localhost.
 */
export function publicOrigin(config: Config, req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const host = servedHost(req);
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${HOST.test(host) ? host : 'localhost'}`;
}
