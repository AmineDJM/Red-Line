import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/**
 * En-têtes de sécurité et protection CSRF, sans dépendance (équivalent de @fastify/helmet réglé pour
 * Red Line) :
 *   - CSP stricte sur les pages HTML (jeu et back-office), compatible MapLibre : workers en blob:,
 *     tuiles PMTiles, glyphes et fond de carte servis par la même origine, WebSocket même hôte ;
 *   - nosniff, Referrer-Policy, anti-iframe (X-Frame-Options + frame-ancestors), COOP, CORP,
 *     Permissions-Policy, HSTS en production ;
 *   - CSRF : toute requête d'écriture (POST, PUT, PATCH, DELETE) vers l'API doit venir de la même
 *     origine (en-tête Origin, ou Sec-Fetch-Site à défaut). Le cookie de session est déjà SameSite=Lax ;
 *     ce contrôle couvre en plus les sous-domaines frères (domaine personnalisé) et les navigateurs anciens.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes d'écriture appelées par des tiers authentifiés autrement (signature). */
const CSRF_EXEMPT = new Set(['/api/stripe/webhook']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Hôte servi (derrière le proxy de Render : X-Forwarded-Host s'il existe). */
export function servedHost(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) ?? req.headers.host ?? '';
  return String(raw).split(',')[0]!.trim().toLowerCase();
}

/** Vrai si l'origine (en-tête Origin) est celle du site. En développement, localhost est accepté. */
export function sameOrigin(req: FastifyRequest, isProd: boolean): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (host === servedHost(req)) return true;
  return !isProd && LOCAL_HOST.test(host);
}

function csrfOk(req: FastifyRequest, isProd: boolean): boolean {
  if (req.headers.origin !== undefined) return sameOrigin(req, isProd);
  // Pas d'Origin : navigateur ancien ou client hors navigateur. Sec-Fetch-Site tranche s'il est là.
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return true;
  return site === 'same-origin' || site === 'none' || (!isProd && site === 'same-site');
}

export function contentSecurityPolicy(req: FastifyRequest, isProd: boolean): string {
  const host = servedHost(req);
  const ws = host ? ` wss://${host}${isProd ? '' : ` ws://${host}`}` : '';
  const devWs = isProd ? '' : ' ws://localhost:* ws://127.0.0.1:*';
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Styles en ligne : attributs style de React et feuilles injectées par MapLibre.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws}${devWs}`,
    // MapLibre crée ses workers à partir d'un blob: ; le service worker est servi par l'origine.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

function isHtml(reply: FastifyReply): boolean {
  const t = reply.getHeader('content-type');
  return typeof t === 'string' && t.startsWith('text/html');
}

const CLIENT_IP = Symbol('clientIp');

/**
 * Adresse IP du client pour la limitation de débit et les empreintes. Sur Render, X-Forwarded-For
 * n'est pas fiable (Render ajoute sans nettoyer : l'élément de gauche est falsifiable) ; Cloudflare,
 * placé devant tous les services Render, écrase CF-Connecting-IP : CLIENT_IP_HEADER=cf-connecting-ip.
 */
export function clientIp(req: FastifyRequest): string {
  return (req as FastifyRequest & { [CLIENT_IP]?: string })[CLIENT_IP] ?? req.ip ?? '';
}

export function registerSecurity(app: FastifyInstance, config: Config): void {
  const isProd = config.isProd;
  const ipHeader = config.clientIpHeader;

  app.addHook('onRequest', async (req) => {
    if (!ipHeader) return;
    const v = req.headers[ipHeader];
    const ip = (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
    if (ip && ip.length <= 64) (req as FastifyRequest & { [CLIENT_IP]?: string })[CLIENT_IP] = ip;
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!WRITE_METHODS.has(req.method)) return;
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') && !path.startsWith('/admin/api/')) return;
    if (CSRF_EXEMPT.has(path)) return;
    if (!csrfOk(req, isProd)) {
      req.log.warn({ origin: req.headers.origin, path }, 'requête inter-sites refusée (CSRF)');
      return reply
        .code(403)
        .send({ error: 'forbidden_origin', message: 'Requête refusée : origine non autorisée' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()',
    );
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Origin-Agent-Cluster', '?1');
    if (isProd) reply.header('Strict-Transport-Security', 'max-age=15552000');
    if (isHtml(reply)) reply.header('Content-Security-Policy', contentSecurityPolicy(req, isProd));
    // Réponses d'API : jamais en cache partagé (données personnelles), jamais interprétées en HTML.
    const path = req.url.split('?')[0] ?? '';
    if (
      (path.startsWith('/api/') || path.startsWith('/admin/api/')) &&
      !reply.hasHeader('Cache-Control')
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
