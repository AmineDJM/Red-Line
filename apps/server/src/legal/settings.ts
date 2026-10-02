import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  LEGAL_DEFAULTS,
  LEGAL_SETTING_KEYS,
  LegalSettingsSchema,
  type LegalSettings,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import { serverSettings } from '../db/schema.js';

const KEY = 'legal';
/** Relecture périodique (plusieurs instances : un réglage modifié ailleurs finit par être vu). */
const REFRESH_MS = 60_000;

/** Domaine (sans www.) d'une origine, pour l'adresse de contact par défaut. */
export function domainOf(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return 'localhost';
  }
}

/**
 * Mentions légales de l'éditeur (table server_settings, clé « legal ») : valeurs par défaut du contrat
 * partagé, surchargées par le back-office. `rev` change à chaque modification (caches des pages).
 */
export class LegalSettingsService {
  private saved: Partial<LegalSettings> = {};
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  rev = 0;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly envContactEmail: string | null,
  ) {}

  async init(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const [row] = await this.db
        .select({ value: serverSettings.value })
        .from(serverSettings)
        .where(eq(serverSettings.key, KEY));
      const parsed = LegalSettingsSchema.partial().safeParse(row?.value ?? {});
      const next = parsed.success ? parsed.data : {};
      if (JSON.stringify(next) !== JSON.stringify(this.saved)) {
        this.saved = next;
        this.rev++;
      }
    } catch (err) {
      this.log.warn({ err }, 'réglages légaux illisibles : valeurs par défaut');
    }
    this.loadedAt = Date.now();
  }

  /** Réglages effectifs (défauts + base). Déclenche une relecture en arrière-plan si besoin. */
  current(): LegalSettings {
    if (Date.now() - this.loadedAt > REFRESH_MS && !this.loading) {
      this.loading = this.reload().finally(() => (this.loading = null));
    }
    return { ...LEGAL_DEFAULTS, ...this.saved };
  }

  /** Valeurs enregistrées au back-office (sans les défauts). */
  stored(): Partial<LegalSettings> {
    return { ...this.saved };
  }

  async save(next: LegalSettings): Promise<LegalSettings> {
    const value = LegalSettingsSchema.parse(next);
    await this.db
      .insert(serverSettings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value } });
    this.saved = value;
    this.rev++;
    this.loadedAt = Date.now();
    return this.current();
  }

  contactEmail(origin: string): string {
    return this.current().contactEmail || this.envContactEmail || `contact@${domainOf(origin)}`;
  }

  /** Jetons {{legal.<champ>}} pour une origine donnée (e-mail de contact résolu). */
  tokens(origin: string): Record<string, string> {
    const s = this.current();
    const out: Record<string, string> = {};
    for (const k of LEGAL_SETTING_KEYS) out[`legal.${k}`] = s[k];
    out['legal.contactEmail'] = this.contactEmail(origin);
    return out;
  }
}

/** Remplace les jetons {{clé}} d'un texte (valeurs passées par `escape`, jetons inconnus vidés). */
export function fillTokens(
  text: string,
  values: Record<string, string>,
  escape: (s: string) => string = (s) => s,
): string {
  return text.replace(/\{\{([a-zA-Z][\w.]*)\}\}/g, (_m, k: string) => escape(values[k] ?? ''));
}
