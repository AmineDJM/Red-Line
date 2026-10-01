import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LoginBodySchema, RegisterBodySchema } from '@redline/shared';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { HttpError, hashPassword, toPublicUser, verifyDummy, verifyPassword } from './auth.js';
import { parseBody } from '../http/util.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { auth, db } = ctx;
  const limit = {
    rateLimit: { max: ctx.options.authRateLimitPerMin, timeWindow: '1 minute' },
  };

  app.post('/api/auth/guest', { config: limit }, async (req, reply) => {
    const current = await auth.authenticate(req, reply);
    if (current) return { user: toPublicUser(current.user) };
    const [user] = await db
      .insert(users)
      .values({
        displayName: `Invité-${randomInt(1000, 10000)}`,
        isGuest: true,
        role: 'player',
      })
      .returning();
    await auth.login(req, reply, user!);
    return { user: toPublicUser(user!) };
  });

  app.post('/api/auth/register', { config: limit }, async (req, reply) => {
    const body = parseBody(RegisterBodySchema, req.body);
    const email = body.email.toLowerCase();
    if (await auth.findByEmail(email)) {
      throw new HttpError(409, 'email_taken', 'Cette adresse e-mail est déjà utilisée');
    }
    const passwordHash = await hashPassword(body.password);
    const current = await auth.authenticate(req, reply);
    let user;
    try {
      user = await saveAccount();
    } catch (err) {
      // Course entre deux inscriptions : l'index unique sur lower(email) tranche.
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'email_taken', 'Cette adresse e-mail est déjà utilisée');
      }
      throw err;
    }
    await auth.login(req, reply, user!);
    return { user: toPublicUser(user!) };

    async function saveAccount() {
      let user;
      if (current?.user.isGuest) {
        // Un invité qui crée un compte garde ses parties.
        [user] = await db
          .update(users)
          .set({ email, passwordHash, displayName: body.displayName, isGuest: false })
          .where(eq(users.id, current.user.id))
          .returning();
      } else {
        [user] = await db
          .insert(users)
          .values({ email, passwordHash, displayName: body.displayName, isGuest: false })
          .returning();
      }
      return user;
    }
  });

  app.post('/api/auth/login', { config: limit }, async (req, reply) => {
    const body = parseBody(LoginBodySchema, req.body);
    const user = await auth.findByEmail(body.email);
    const ok = user?.passwordHash
      ? await verifyPassword(user.passwordHash, body.password)
      : await verifyDummy(body.password);
    if (!user || !ok) {
      throw new HttpError(401, 'invalid_credentials', 'E-mail ou mot de passe incorrect');
    }
    await auth.login(req, reply, user);
    return { user: toPublicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.logout(req, reply);
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const state = await auth.authenticate(req, reply);
    if (!state) throw new HttpError(401, 'unauthorized', 'Non connecté');
    return {
      user: toPublicUser(state.user),
      legal: { needsAcceptance: await ctx.legal.needsAcceptance(state.user.id) },
      premiumBalance: state.user.premiumBalance,
      ...(state.user.unlimited ? { premiumUnlimited: true } : {}),
    };
  });
}
