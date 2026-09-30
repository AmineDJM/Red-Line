import type { World } from '@redline/engine';
import type { Balance } from '@redline/shared';
import type { Db } from '../db/client.js';
import type { Engine } from '../engine.js';
import type { GameData } from '../data/loader.js';
import { hashJson } from '../data/loader.js';
import { latestReleaseId, releaseSnapshot } from '../data/catalog-store.js';
import { HttpError } from '../auth/auth.js';

/**
 * Mondes (données statiques du moteur) construits une seule fois par couple
 * (release du catalogue, équilibrage) et partagés entre les parties qui les épinglent.
 */
export class WorldRegistry {
  private readonly cache = new Map<string, Promise<World>>();
  /** Release utilisée par les nouvelles parties. */
  currentReleaseId: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly engine: Engine | null,
    private readonly data: GameData,
  ) {}

  async init(): Promise<void> {
    this.currentReleaseId = await latestReleaseId(this.db);
  }

  /** Raison pour laquelle aucune partie ne peut tourner, ou null. */
  unavailableReason(): { code: string; message: string } | null {
    if (!this.engine) {
      return { code: 'engine_unavailable', message: 'Moteur de simulation indisponible' };
    }
    if (!this.data.map) {
      return { code: 'data_unavailable', message: this.data.mapError ?? 'Carte indisponible' };
    }
    if (!this.data.balance) {
      return {
        code: 'data_unavailable',
        message: this.data.balanceError ?? 'Équilibrage indisponible',
      };
    }
    return null;
  }

  assertAvailable(): { engine: Engine } {
    const r = this.unavailableReason();
    if (r) throw new HttpError(503, r.code, r.message);
    return { engine: this.engine! };
  }

  key(releaseId: number | null, balance: Balance): string {
    return `${releaseId ?? 0}:${hashJson(balance)}`;
  }

  get(releaseId: number | null, balance: Balance): Promise<World> {
    const { engine } = this.assertAvailable();
    const key = this.key(releaseId, balance);
    let p = this.cache.get(key);
    if (!p) {
      p = (async () => {
        const catalog =
          releaseId === null ? [] : ((await releaseSnapshot(this.db, releaseId)) ?? []);
        return engine.buildWorld(this.data.map!, catalog, balance);
      })();
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p;
  }

  async forNewGames(): Promise<{ world: World; releaseId: number | null; balance: Balance }> {
    this.assertAvailable();
    const balance = this.data.balance!;
    const releaseId = this.currentReleaseId;
    return { world: await this.get(releaseId, balance), releaseId, balance };
  }

  /** Nouvelle release : les nouvelles parties l'utiliseront ; le monde est construit tout de suite. */
  async setCurrentRelease(releaseId: number): Promise<void> {
    this.currentReleaseId = releaseId;
    if (!this.unavailableReason()) await this.get(releaseId, this.data.balance!);
  }

  /** Oublie les mondes qui ne sont plus utilisés. */
  prune(keep: Set<string>): void {
    if (this.data.balance) keep.add(this.key(this.currentReleaseId, this.data.balance));
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
  }
}
