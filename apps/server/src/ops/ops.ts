import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  RuntimeSettingsSchema,
  type Announcement,
  type AnnouncementBody,
  type RuntimeSettings,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import { announcements, serverSettings, users } from '../db/schema.js';
import type { RuntimeOptions } from '../context.js';
import type { Connection, GameHost } from '../host/game-host.js';

const RUNTIME_KEY = 'runtime_settings';
const MIN = 60_000;

/** Paramètres d'exploitation modifiables à chaud (quotas, délais d'abandon, veille des IA). */
export class RuntimeSettingsStore {
  constructor(
    private readonly db: Db,
    private readonly options: RuntimeOptions,
    private readonly host: GameHost,
    private readonly log: FastifyBaseLogger,
  ) {}

  current(): RuntimeSettings {
    const o = this.options;
    return {
      maxActiveSoloPerUser: o.maxActiveSoloPerUser,
      maxActiveMultiPerUser: o.maxActiveMultiPerUser,
      soloAbandonMin: o.soloAbandonMs / MIN,
      multiAbandonMin: o.multiAbandonMs / MIN,
      dormancyDelayMin: o.dormancyDelayMs / MIN,
      idleUnloadMin: o.idleUnloadMs / MIN,
    };
  }

  private apply(s: RuntimeSettings): void {
    const o = this.options;
    o.maxActiveSoloPerUser = s.maxActiveSoloPerUser;
    o.maxActiveMultiPerUser = s.maxActiveMultiPerUser;
    o.soloAbandonMs = s.soloAbandonMin * MIN;
    o.multiAbandonMs = s.multiAbandonMin * MIN;
    o.dormancyDelayMs = s.dormancyDelayMin * MIN;
    o.idleUnloadMs = s.idleUnloadMin * MIN;
    this.host.setOptions({
      soloAbandonMs: o.soloAbandonMs,
      multiAbandonMs: o.multiAbandonMs,
      dormancyDelayMs: o.dormancyDelayMs,
      idleUnloadMs: o.idleUnloadMs,
    });
  }

  /** Valeurs enregistrées en base (prioritaires sur les valeurs de démarrage). */
  async init(): Promise<void> {
    const [row] = await this.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.key, RUNTIME_KEY));
    if (!row) return;
    const r = RuntimeSettingsSchema.safeParse(row.value);
    if (r.success) this.apply(r.data);
    else this.log.warn('paramètres du serveur invalides en base : ignorés');
  }

  async save(value: unknown): Promise<RuntimeSettings> {
    const s = RuntimeSettingsSchema.parse(value);
    await this.db
      .insert(serverSettings)
      .values({ key: RUNTIME_KEY, value: s })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: s } });
    this.apply(s);
    return s;
  }
}

type Row = typeof announcements.$inferSelect;

/** Annonces globales : avis à tous les joueurs connectés, renvoyé à chaque connexion pendant sa validité. */
export class AnnouncementService {
  private active: Row[] = [];
  private loadedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly host: GameHost,
  ) {}

  private view(r: Row, author: string | null): Announcement {
    return {
      id: r.id,
      text: r.text,
      level: r.level,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      active: r.active,
      createdAt: r.createdAt.toISOString(),
      authorName: author,
    };
  }

  async list(): Promise<Announcement[]> {
    const rows = await this.db
      .select({ a: announcements, name: users.displayName })
      .from(announcements)
      .leftJoin(users, eq(users.id, announcements.createdBy))
      .orderBy(desc(announcements.id))
      .limit(200);
    return rows.map((r) => this.view(r.a, r.name));
  }

  async refresh(): Promise<void> {
    const now = new Date();
    this.active = await this.db
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.active, true),
          lte(announcements.startsAt, now),
          gt(announcements.endsAt, now),
        ),
      );
    this.loadedAt = Date.now();
  }

  /** Annonces en cours (publiques : page d'accueil, bannière du client). */
  async current(): Promise<Pick<Announcement, 'id' | 'text' | 'level' | 'endsAt'>[]> {
    if (Date.now() - this.loadedAt > 30_000) await this.refresh();
    const now = Date.now();
    return this.active
      .filter((a) => a.startsAt.getTime() <= now && a.endsAt.getTime() > now)
      .map((a) => ({ id: a.id, text: a.text, level: a.level, endsAt: a.endsAt.toISOString() }));
  }

  /** À l'arrivée d'un joueur dans une partie : annonces en cours. */
  async greet(conn: Connection): Promise<void> {
    for (const a of await this.current()) conn.send({ t: 'notice', level: a.level, text: a.text });
  }

  async create(
    body: AnnouncementBody,
    authorId: string,
  ): Promise<{ announcement: Announcement; sent: number }> {
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = new Date(body.endsAt);
    const [row] = await this.db
      .insert(announcements)
      .values({
        text: body.text,
        level: body.level,
        startsAt,
        endsAt,
        active: body.active,
        createdBy: authorId,
      })
      .returning();
    await this.refresh();
    const now = Date.now();
    const sent =
      body.broadcast && body.active && startsAt.getTime() <= now && endsAt.getTime() > now
        ? this.host.noticeAll(body.text, body.level)
        : 0;
    return { announcement: this.view(row!, null), sent };
  }

  async update(
    id: number,
    patch: { active?: boolean; endsAt?: string },
  ): Promise<Announcement | null> {
    const set: Partial<typeof announcements.$inferInsert> = {};
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.endsAt) set.endsAt = new Date(patch.endsAt);
    const [row] = await this.db
      .update(announcements)
      .set(set)
      .where(eq(announcements.id, id))
      .returning();
    await this.refresh();
    return row ? this.view(row, null) : null;
  }

  async remove(id: number): Promise<boolean> {
    const rows = await this.db.delete(announcements).where(eq(announcements.id, id)).returning();
    await this.refresh();
    return rows.length > 0;
  }
}
