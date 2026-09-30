import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasRole, type PublicUser, type Role } from '@redline/shared';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'rl_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Un jeton plus vieux que ça est remplacé par un nouveau à la prochaine requête (rotation). */
const ROTATE_AFTER_MS = 24 * 3600_000;
/** L'ancien jeton reste valable quelques secondes après rotation (requêtes concurrentes). */
const ROTATE_GRACE_MS = 60_000;
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export type UserRow = typeof users.$inferSelect;

export interface AuthState {
  user: UserRow;
  sessionId: string;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    isGuest: u.isGuest,
  };
}

export function hashPassword(pw: string): Promise<string> {
  return argonHash(pw);
}

let dummyHash: Promise<string> | null = null;

/** Vérification factice (même coût) quand l'utilisateur n'existe pas : pas d'énumération par le temps. */
export async function verifyDummy(pw: string): Promise<false> {
  dummyHash ??= argonHash('red-line-dummy-password');
  await verifyPassword(await dummyHash, pw);
  return false;
}

export async function verifyPassword(hashed: string, pw: string): Promise<boolean> {
  try {
    return await argonVerify(hashed, pw);
  } catch {
    return false;
  }
}

function sessionIdOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CookieOptions {
  secure: boolean;
}

export class Auth {
  /** Appelé à la connexion et à chaque mise à jour de last_seen_at (empreintes, activité horaire). */
  onSeen: ((user: UserRow, request: FastifyRequest) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly cookie: CookieOptions,
  ) {}

  async createSession(reply: FastifyReply, userId: string, userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const id = sessionIdOf(token);
    await this.db.insert(sessions).values({
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: userAgent?.slice(0, 300) ?? null,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.cookie.secure,
      signed: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return id;
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** Lit le jeton (signé) du cookie. */
  tokenFrom(request: FastifyRequest): string | null {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) return null;
    const u = request.unsignCookie(raw);
    return u.valid && u.value ? u.value : null;
  }

  /** Utilisateur de la requête (mis en cache sur la requête), sans rotation. */
  async resolve(request: FastifyRequest): Promise<AuthState | null> {
    const cached = (request as FastifyRequest & { _auth?: AuthState | null })._auth;
    if (cached !== undefined) return cached;
    let state: AuthState | null = null;
    const token = this.tokenFrom(request);
    if (token) {
      const id = sessionIdOf(token);
      const rows = await this.db
        .select({ s: sessions, u: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
        .limit(1);
      const row = rows[0];
      // Compte banni : traité comme non connecté (ses sessions sont aussi supprimées au bannissement).
      if (row && !row.u.bannedAt) {
        state = { user: row.u, sessionId: row.s.id };
        (request as FastifyRequest & { _sessionCreatedAt?: Date })._sessionCreatedAt =
          row.s.createdAt;
      }
    }
    (request as FastifyRequest & { _auth?: AuthState | null })._auth = state;
    return state;
  }

  setResolved(request: FastifyRequest, state: AuthState | null): void {
    (request as FastifyRequest & { _auth?: AuthState | null })._auth = state;
  }

  /** Résout l'utilisateur, fait tourner le jeton s'il est ancien et met à jour last_seen_at. */
  async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthState | null> {
    const state = await this.resolve(request);
    if (!state) return null;
    const createdAt = (request as FastifyRequest & { _sessionCreatedAt?: Date })._sessionCreatedAt;
    const now = Date.now();
    if (createdAt && now - createdAt.getTime() > ROTATE_AFTER_MS) {
      const newId = await this.createSession(reply, state.user.id, request.headers['user-agent']);
      await this.db
        .update(sessions)
        .set({ expiresAt: new Date(now + ROTATE_GRACE_MS) })
        .where(eq(sessions.id, state.sessionId));
      state.sessionId = newId;
    }
    if (now - state.user.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db
        .update(users)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(users.id, state.user.id));
      state.user.lastSeenAt = new Date(now);
      this.onSeen?.(state.user, request);
    }
    return state;
  }

  /** Nouvelle session pour un utilisateur (connexion) : l'ancienne session de la requête est supprimée. */
  async login(request: FastifyRequest, reply: FastifyReply, user: UserRow): Promise<void> {
    if (user.bannedAt) {
      throw new HttpError(403, 'banned', 'Ce compte est suspendu');
    }
    const old = this.tokenFrom(request);
    if (old) await this.db.delete(sessions).where(eq(sessions.id, sessionIdOf(old)));
    const sessionId = await this.createSession(reply, user.id, request.headers['user-agent']);
    this.setResolved(request, { user, sessionId });
    this.onSeen?.(user, request);
  }

  /** Supprime toutes les sessions d'un utilisateur (bannissement). */
  async revokeAll(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = this.tokenFrom(request);
    if (token) await this.db.delete(sessions).where(eq(sessions.id, sessionIdOf(token)));
    this.clearCookie(reply);
    this.setResolved(request, null);
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const [u] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return u ?? null;
  }

  /** Crée ou met à jour le super-admin (ADMIN_EMAIL / ADMIN_PASSWORD). */
  async ensureSuperAdmin(email: string, password: string): Promise<void> {
    const existing = await this.findByEmail(email);
    const passwordHash = await hashPassword(password);
    if (existing) {
      await this.db
        .update(users)
        .set({ passwordHash, role: 'superadmin', isGuest: false })
        .where(eq(users.id, existing.id));
    } else {
      await this.db.insert(users).values({
        email: email.toLowerCase(),
        passwordHash,
        displayName: 'Administrateur',
        role: 'superadmin',
        isGuest: false,
      });
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function checkRole(state: AuthState | null, required: Role): AuthState {
  if (!state) throw new HttpError(401, 'unauthorized', 'Connexion requise');
  if (!hasRole(state.user.role, required)) {
    throw new HttpError(403, 'forbidden', 'Droits insuffisants');
  }
  return state;
}
