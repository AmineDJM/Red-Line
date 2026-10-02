import type { World } from '@redline/engine';
import type { Balance } from '@redline/shared';
import type { Db } from '../db/client.js';
import type { Engine } from '../engine.js';
import { hashJson } from '../data/loader.js';
import type { DataStore } from '../data/store.js';
import { latestReleaseId, releaseSnapshot } from '../data/catalog-store.js';
import { HttpError } from '../auth/auth.js';

/** Ce qu'une partie épingle pour reconstruire son monde à l'identique. */
export interface WorldPin {
  releaseId: number | null;
  balance: Balance;
  /** Révision des données d'administration (carte, recherche, ORBAT). */
  dataRev: number;
  /** Version de la carte (identifiants de province) : courante ou archivée (data/map/archive). */
  mapVersion: number;
}

/**
 * Mondes (données statiques du moteur) construits une seule fois par quadruplet
 * (release du catalogue, équilibrage, révision des données, version de la carte) et partagés entre les
 * parties qui les épinglent.
 */
export class WorldRegistry {
  private readonly cache = new Map<string, Promise<World>>();
  /** Release utilisée par les nouvelles parties. */
  currentReleaseId: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly engine: Engine | null,
    private readonly store: DataStore,
  ) {}

  async init(): Promise<void> {
    this.currentReleaseId = await latestReleaseId(this.db);
  }

  /** Raison pour laquelle aucune partie ne peut tourner, ou null. */
  unavailableReason(): { code: string; message: string } | null {
    if (!this.engine) {
      return { code: 'engine_unavailable', message: 'Moteur de simulation indisponible' };
    }
    const cur = this.store.current();
    if (!cur.map) {
      return {
        code: 'data_unavailable',
        message: this.store.repo.mapError ?? 'Carte indisponible',
      };
    }
    if (!cur.balance) {
      return {
        code: 'data_unavailable',
        message: this.store.repo.balanceError ?? 'Équilibrage indisponible',
      };
    }
    return null;
  }

  assertAvailable(): { engine: Engine } {
    const r = this.unavailableReason();
    if (r) throw new HttpError(503, r.code, r.message);
    return { engine: this.engine! };
  }

  key(pin: WorldPin): string {
    return `${pin.releaseId ?? 0}:${hashJson(pin.balance)}:${pin.dataRev}:m${pin.mapVersion}`;
  }

  get(pin: WorldPin): Promise<World> {
    const { engine } = this.assertAvailable();
    const key = this.key(pin);
    let p = this.cache.get(key);
    if (!p) {
      p = (async () => {
        const catalog =
          pin.releaseId === null ? [] : ((await releaseSnapshot(this.db, pin.releaseId)) ?? []);
        await this.store.ensureMap(pin.mapVersion);
        const data = this.store.effective(pin.dataRev, pin.mapVersion);
        if (!data.map) throw new HttpError(503, 'data_unavailable', 'Carte indisponible');
        return engine.buildWorld(data.map, catalog, pin.balance, {
          research: data.research,
          orbats: data.orbats,
        });
      })();
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p;
  }

  /** Épingle courante pour une nouvelle partie (équilibrage éventuellement surchargé par le scénario). */
  currentPin(balance?: Balance): WorldPin {
    this.assertAvailable();
    return {
      releaseId: this.currentReleaseId,
      balance: balance ?? this.store.current().balance!,
      dataRev: this.store.currentRev,
      mapVersion: this.store.mapVersion,
    };
  }

  async forNewGames(balance?: Balance): Promise<{ world: World; pin: WorldPin }> {
    const pin = this.currentPin(balance);
    return { world: await this.get(pin), pin };
  }

  /** Nouvelle release : les nouvelles parties l'utiliseront ; le monde est construit tout de suite. */
  async setCurrentRelease(releaseId: number): Promise<void> {
    this.currentReleaseId = releaseId;
    if (!this.unavailableReason()) await this.get(this.currentPin());
  }

  /** Oublie les mondes qui ne sont plus utilisés. */
  prune(keep: Set<string>): void {
    if (!this.unavailableReason()) keep.add(this.key(this.currentPin()));
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
  }
}
