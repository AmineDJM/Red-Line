import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LEGAL_DEFAULTS, LegalSettingsSchema } from '@redline/shared';
import type { AppContext } from '../context.js';
import { adminAudit } from '../db/schema.js';
import { checkRole } from '../auth/auth.js';
import { parseBody } from '../http/util.js';
import { publicOrigin } from '../http/origin.js';
import type { LegalSettingsService } from '../legal/settings.js';

/**
 * Réglages › Légal : identité de l'éditeur, hébergeur, contact, médiateur, mention de TVA.
 * Lecture : modérateurs ; écriture : super-admin (journalisée).
 */
export async function adminSettingsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  legal: LegalSettingsService,
): Promise<void> {
  const { auth, db } = ctx;
  const view = (req: FastifyRequest) => {
    const origin = publicOrigin(ctx.config, req);
    return {
      settings: legal.current(),
      stored: legal.stored(),
      defaults: LEGAL_DEFAULTS,
      effective: { contactEmail: legal.contactEmail(origin) },
      publicUrl: ctx.config.publicUrl,
      envContactEmail: ctx.config.legalContactEmail,
    };
  };

  app.get('/admin/api/settings/legal', async (req: FastifyRequest, reply: FastifyReply) => {
    checkRole(await auth.authenticate(req, reply), 'moderator');
    return view(req);
  });

  app.put('/admin/api/settings/legal', async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = checkRole(await auth.authenticate(req, reply), 'superadmin');
    const body = parseBody(LegalSettingsSchema, req.body);
    const before = legal.current();
    await legal.save(body);
    await db.insert(adminAudit).values({
      adminId: admin.user.id,
      action: 'settings.legal',
      target: 'settings:legal',
      before,
      after: body,
    });
    return view(req);
  });
}
