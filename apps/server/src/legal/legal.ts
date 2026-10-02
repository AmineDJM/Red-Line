import { clientIp } from '../http/security.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LegalDoc, LegalDocRef } from '@redline/shared';
import type { Db } from '../db/client.js';
import { legalAcceptances } from '../db/schema.js';
import { HttpError, checkRole, type Auth } from '../auth/auth.js';
import { parseBody } from '../http/util.js';
import { fillTokens } from './settings.js';

export const LEGAL_IDS = ['cgu', 'cgv', 'privacy', 'withdrawal', 'mentions', 'cookies'] as const;
export type LegalId = (typeof LEGAL_IDS)[number];

/** Documents que tout utilisateur accepte ; CGV et rétractation sont exigées avant un achat. */
export const ALWAYS_REQUIRED: LegalId[] = ['cgu', 'privacy'];
export const PURCHASE_REQUIRED: LegalId[] = ['cgv', 'withdrawal'];
/** Documents d'information (mentions légales, cookies) : consultables, jamais soumis à acceptation. */
export const INFORMATIVE: LegalId[] = ['mentions', 'cookies'];

/** Lit un document Markdown avec en-tête (--- title / version / updatedAt ---). */
export function parseLegal(id: LegalId, raw: string): LegalDoc {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  const head: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const version = Number(head.version ?? 1);
  return {
    id,
    version: Number.isInteger(version) && version > 0 ? version : 1,
    title: head.title ?? id,
    markdown: (m ? m[2]! : raw).trim(),
    updatedAt: head.updatedAt ?? '',
  };
}

/**
 * Documents légaux versionnés (apps/site/content/fr/legal/*.md, la version française fait foi) et
 * acceptations enregistrées. Les traductions (apps/site/content/<langue>/legal/*.md) ne servent qu'à
 * l'affichage ; elles ne sont proposées que si leur version est celle du texte français.
 */
export class LegalService {
  readonly docs = new Map<LegalId, LegalDoc>();
  readonly translations = new Map<string, Map<LegalId, LegalDoc>>();

  constructor(
    private readonly db: Db,
    dir: string,
    log: FastifyBaseLogger,
    contentDir?: string,
  ) {
    for (const id of LEGAL_IDS) {
      const p = join(dir, `${id}.md`);
      if (!existsSync(p)) {
        log.warn(`document légal absent : ${p}`);
        continue;
      }
      this.docs.set(id, { ...parseLegal(id, readFileSync(p, 'utf8')), lang: 'fr' });
    }
    if (contentDir && existsSync(contentDir)) {
      for (const lang of readdirSync(contentDir)) {
        if (lang === 'fr' || !/^[a-z]{2,3}$/.test(lang)) continue;
        const map = new Map<LegalId, LegalDoc>();
        for (const id of LEGAL_IDS) {
          const p = join(contentDir, lang, 'legal', `${id}.md`);
          const ref = this.docs.get(id);
          if (!ref || !existsSync(p)) continue;
          const d = parseLegal(id, readFileSync(p, 'utf8'));
          if (d.version === ref.version) map.set(id, { ...d, lang });
          else
            log.warn(
              `traduction ${lang}/${id} en retard (v${d.version} ≠ v${ref.version}) : ignorée`,
            );
        }
        if (map.size) this.translations.set(lang, map);
      }
    }
  }

  /** Document dans la langue demandée si sa traduction est à jour, sinon la version française. */
  doc(id: LegalId, lang?: string): LegalDoc | undefined {
    const base = lang ? lang.toLowerCase().split('-')[0]! : 'fr';
    return this.translations.get(base)?.get(id) ?? this.docs.get(id);
  }

  current(id: LegalId): LegalDocRef | null {
    const d = this.docs.get(id);
    return d ? { id, version: d.version } : null;
  }

  private async accepted(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ docId: legalAcceptances.docId, version: legalAcceptances.version })
      .from(legalAcceptances)
      .where(eq(legalAcceptances.userId, userId));
    return new Set(rows.map((r) => `${r.docId}@${r.version}`));
  }

  /** Documents à (re)accepter : CGU et confidentialité toujours ; CGV et rétractation si une version antérieure a été acceptée. */
  async needsAcceptance(userId: string): Promise<LegalDocRef[]> {
    const acc = await this.accepted(userId);
    const everAccepted = (id: string) => [...acc].some((k) => k.startsWith(`${id}@`));
    const out: LegalDocRef[] = [];
    for (const id of LEGAL_IDS) {
      const ref = this.current(id);
      if (!ref || INFORMATIVE.includes(id) || acc.has(`${id}@${ref.version}`)) continue;
      if (ALWAYS_REQUIRED.includes(id) || everAccepted(id)) out.push(ref);
    }
    return out;
  }

  /** Documents manquants parmi `ids` (version en vigueur). */
  async missing(userId: string, ids: LegalId[]): Promise<LegalDocRef[]> {
    const acc = await this.accepted(userId);
    return ids
      .map((id) => this.current(id))
      .filter((r): r is LegalDocRef => !!r && !acc.has(`${r.id}@${r.version}`));
  }

  async accept(userId: string, refs: LegalDocRef[], ipHash: string | null): Promise<void> {
    for (const r of refs) {
      const cur = this.current(r.id);
      if (!cur) throw new HttpError(404, 'unknown_document', `Document inconnu : ${r.id}`);
      if (cur.version !== r.version) {
        throw new HttpError(
          409,
          'outdated_version',
          `Le document ${r.id} a été mis à jour (version ${cur.version})`,
        );
      }
    }
    for (const r of refs) {
      await this.db
        .insert(legalAcceptances)
        .values({ userId, docId: r.id, version: r.version, ipHash })
        .onConflictDoNothing();
    }
  }

  async hasAccepted(userId: string, id: LegalId, version: number): Promise<boolean> {
    const [r] = await this.db
      .select({ v: legalAcceptances.version })
      .from(legalAcceptances)
      .where(
        and(
          eq(legalAcceptances.userId, userId),
          eq(legalAcceptances.docId, id),
          eq(legalAcceptances.version, version),
        ),
      );
    return !!r;
  }
}

const AcceptBodySchema = z.object({
  docs: z
    .array(z.object({ id: z.enum(LEGAL_IDS), version: z.number().int().positive() }))
    .min(1)
    .max(LEGAL_IDS.length),
});

export async function legalRoutes(
  app: FastifyInstance,
  deps: {
    legal: LegalService;
    auth: Auth;
    hashIp: (ip: string) => string;
    /** Jetons {{origin}} et {{legal.*}} pour la requête (mentions réglées au back-office). */
    tokens?: (req: FastifyRequest) => Record<string, string>;
  },
): Promise<void> {
  const { legal, auth } = deps;

  app.get('/api/legal/:doc', async (req) => {
    const id = (req.params as { doc: string }).doc as LegalId;
    const lang = (req.query as { lang?: unknown }).lang;
    const doc = LEGAL_IDS.includes(id)
      ? legal.doc(id, typeof lang === 'string' ? lang : undefined)
      : undefined;
    if (!doc) throw new HttpError(404, 'not_found', 'Document introuvable');
    if (!deps.tokens) return { doc };
    return { doc: { ...doc, markdown: fillTokens(doc.markdown, deps.tokens(req)) } };
  });

  app.post('/api/legal/accept', async (req: FastifyRequest, reply: FastifyReply) => {
    const { user } = checkRole(await auth.authenticate(req, reply), 'player');
    const body = parseBody(AcceptBodySchema, req.body);
    await legal.accept(user.id, body.docs, deps.hashIp(clientIp(req)));
    return { ok: true, needsAcceptance: await legal.needsAcceptance(user.id) };
  });
}
