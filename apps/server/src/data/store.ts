import { asc, eq, sql } from 'drizzle-orm';
import {
  BalanceSchema,
  DisputedAreaSchema,
  NationDefSchema,
  OrbatSchema,
  ProvinceDefSchema,
  ResearchNodeSchema,
  type Balance,
  type ChangeScope,
  type DisputedArea,
  type MapData,
  type NationDef,
  type Orbat,
  type ProvinceDef,
  type ResearchNode,
  type ScenarioFile,
} from '@redline/shared';
import type { z } from 'zod';
import type { Db } from '../db/client.js';
import { dataRevisions, type DataKind } from '../db/schema.js';
import { loadArchivedMap, ScenarioFileSchema, type ArchivedMap, type GameData } from './loader.js';

/**
 * Données de jeu effectives = fichiers du dépôt (data/) + modifications du back-office (table data_revisions).
 * Chaque modification est une révision numérotée ; une partie épingle la révision en vigueur à sa création
 * (games.data_rev), ce qui garantit une reprise identique après redémarrage. Retour arrière = nouvelle révision
 * qui reprend une valeur antérieure.
 *
 * Versions de carte : une partie épingle aussi la version de la carte (games.map_version). La carte
 * courante vient de data/map, les précédentes de data/map/archive/<version>/ (chargées à la demande).
 * Les modifications de la carte (nations, provinces, zones disputées) sont propres à la version de
 * carte en vigueur quand elles ont été écrites (data_revisions.map_version) : une province d'une
 * autre version ne s'applique jamais ; une nation d'une autre version s'applique (nom, couleur…)
 * mais garde la capitale de la carte visée (identifiants de province différents).
 */
export interface EffectiveData {
  rev: number;
  mapVersion: number;
  map: MapData | null;
  nationsById: Map<string, NationDef>;
  balance: Balance | null;
  research: ResearchNode[];
  orbats: Record<string, Orbat[]>;
  scenarios: ScenarioFile[];
}

export type RevisionRow = typeof dataRevisions.$inferSelect;

/** Schéma de validation de chaque type de donnée administrable. */
export const DATA_SCHEMAS: Record<DataKind, z.ZodTypeAny> = {
  rules: BalanceSchema,
  research: ResearchNodeSchema,
  orbat: OrbatSchema,
  scenario: ScenarioFileSchema,
  nation: NationDefSchema,
  province: ProvinceDefSchema,
  disputed: DisputedAreaSchema,
};

/** Types dont la modification change le monde du moteur (et donc les parties épinglées). */
export const WORLD_KINDS: DataKind[] = ['research', 'orbat', 'nation', 'province', 'disputed'];

/** Types propres à une version de carte (identifiants de province). */
export const MAP_KINDS: DataKind[] = ['nation', 'province', 'disputed'];

const MAX_CACHED = 6;
/** Marque interne : nation écrite pour une autre version de carte. */
const FOREIGN = Symbol('foreignMap');

function replaceById<T extends { id: string }>(base: T[], over: Map<string, T | null>): T[] {
  if (over.size === 0) return base;
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of base) {
    seen.add(item.id);
    // null = retour à la valeur du dépôt.
    out.push(over.get(item.id) ?? item);
  }
  for (const [id, v] of over) if (!seen.has(id) && v) out.push(v);
  return out;
}

export class DataStore {
  private revs: RevisionRow[] = [];
  private cache = new Map<string, EffectiveData>();
  private archives = new Map<number, ArchivedMap>();
  private archiveLoads = new Map<number, Promise<void>>();
  currentRev = 0;

  constructor(
    private readonly db: Db,
    readonly repo: GameData,
  ) {}

  /** Version de la carte des nouvelles parties. */
  get mapVersion(): number {
    return this.repo.mapVersion;
  }

  /** Version servie (courante ou archivée) ; false pour une version inconnue. */
  hasMap(version: number): boolean {
    return version === this.repo.mapVersion || this.repo.archivedMapVersions.includes(version);
  }

  /** Charge une carte archivée (sans effet pour la carte courante). Erreur si elle n'existe pas. */
  ensureMap(version: number): Promise<void> {
    if (version === this.repo.mapVersion || this.archives.has(version)) return Promise.resolve();
    if (!this.repo.archivedMapVersions.includes(version))
      return Promise.reject(new Error(`carte version ${version} absente (data/map/archive)`));
    let p = this.archiveLoads.get(version);
    if (!p) {
      p = loadArchivedMap(this.repo.dataDir, version).then((a) => {
        this.archives.set(version, a);
      });
      p.catch(() => this.archiveLoads.delete(version));
      this.archiveLoads.set(version, p);
    }
    return p;
  }

  /** Carte archivée déjà chargée (ensureMap), ou null. */
  archived(version: number): ArchivedMap | null {
    return this.archives.get(version) ?? null;
  }

  async init(): Promise<void> {
    this.revs = await this.db.select().from(dataRevisions).orderBy(asc(dataRevisions.id));
    this.currentRev = this.revs.at(-1)?.id ?? 0;
    this.cache.clear();
  }

  /** Recharge depuis la base (révision écrite par une autre instance). */
  async refreshIfStale(): Promise<void> {
    const [r] = await this.db
      .select({ id: sql<number>`coalesce(max(${dataRevisions.id}), 0)::int` })
      .from(dataRevisions);
    if ((r?.id ?? 0) !== this.currentRev) await this.init();
  }

  current(): EffectiveData {
    return this.effective(this.currentRev);
  }

  /**
   * Dernière valeur de chaque (type, clé) avec une révision <= rev. Les provinces et zones disputées
   * d'une autre version de carte sont ignorées ; une nation d'une autre version garde la capitale
   * de la carte visée.
   */
  private overrides(rev: number, mapVersion: number): Map<DataKind, Map<string, unknown>> {
    const out = new Map<DataKind, Map<string, unknown>>();
    for (const r of this.revs) {
      if (r.id > rev) break;
      const foreign = MAP_KINDS.includes(r.kind) && r.mapVersion !== mapVersion;
      if (foreign && r.kind !== 'nation') continue;
      let m = out.get(r.kind);
      if (!m) out.set(r.kind, (m = new Map()));
      m.set(r.key, foreign && r.data ? { ...(r.data as object), [FOREIGN]: true } : r.data);
    }
    return out;
  }

  effective(rev: number, mapVersion: number = this.repo.mapVersion): EffectiveData {
    const ck = `${rev}:${mapVersion}`;
    const cached = this.cache.get(ck);
    if (cached) return cached;
    const repo = this.repo;
    const ov = this.overrides(rev, mapVersion);
    const get = <T>(k: DataKind) => (ov.get(k) ?? new Map()) as Map<string, T | null>;

    let map: MapData | null;
    if (mapVersion === repo.mapVersion) map = repo.map;
    else {
      const a = this.archives.get(mapVersion);
      if (!a) throw new Error(`carte version ${mapVersion} non chargée (ensureMap)`);
      map = a.map;
    }
    if (map) {
      // Nation écrite pour une autre carte : sa capitale est celle de la carte visée.
      const base = new Map(map.nations.map((n) => [n.id, n]));
      const nationOv = new Map<string, NationDef | null>();
      for (const [id, v] of get<NationDef & { [FOREIGN]?: true }>('nation')) {
        if (!v || !v[FOREIGN]) {
          nationOv.set(id, v);
          continue;
        }
        const { [FOREIGN]: _foreign, ...def } = v;
        const own = base.get(id);
        if (own) nationOv.set(id, { ...def, capitalProvinceId: own.capitalProvinceId });
      }
      const nations = replaceById<NationDef>(map.nations, nationOv);
      const provinces = replaceById<ProvinceDef>(map.provinces, get<ProvinceDef>('province'));
      const disputed = replaceById<DisputedArea>(map.disputed, get<DisputedArea>('disputed'));
      if (nations !== map.nations || provinces !== map.provinces || disputed !== map.disputed) {
        map = { ...map, nations, provinces, disputed };
      }
    }
    const rules = get<Balance>('rules').get('default');
    const orbats: Record<string, Orbat[]> = {};
    const orbatOv = get<Orbat>('orbat');
    const sets = new Set([
      ...Object.keys(repo.orbats),
      ...[...orbatOv.keys()].map((k) => k.split('/')[0]!),
    ]);
    for (const set of sets) {
      const base = repo.orbats[set] ?? [];
      const over = new Map<string, Orbat | null>();
      for (const [k, v] of orbatOv) {
        const [s, nation] = k.split('/');
        if (s === set && nation) over.set(nation, v);
      }
      const byNation = new Map(base.map((o) => [o.nationId, o] as const));
      for (const [n, v] of over) {
        // null = retour à la valeur du dépôt (déjà dans byNation, ou absente du dépôt).
        if (v) byNation.set(n, v);
      }
      orbats[set] = [...byNation.values()].sort((a, b) => (a.nationId < b.nationId ? -1 : 1));
    }
    const eff: EffectiveData = {
      rev,
      mapVersion,
      map,
      nationsById: new Map((map?.nations ?? []).map((n) => [n.id, n])),
      balance: rules === undefined ? repo.balance : (rules ?? repo.balance),
      research: replaceById<ResearchNode>(repo.research, get<ResearchNode>('research')),
      orbats,
      scenarios: replaceById<ScenarioFile>(repo.scenarios, get<ScenarioFile>('scenario')),
    };
    if (this.cache.size >= MAX_CACHED) {
      const cur = `${this.currentRev}:${this.repo.mapVersion}`;
      const oldest = [...this.cache.keys()].find((k) => k !== cur);
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(ck, eff);
    return eff;
  }

  /** Écrit une révision (data validée par l'appelant ; null = retour à la valeur du dépôt). */
  async write(
    kind: DataKind,
    key: string,
    data: unknown,
    meta: { message: string; scope: ChangeScope; authorId: string | null },
  ): Promise<RevisionRow> {
    const [row] = await this.db
      .insert(dataRevisions)
      .values({
        kind,
        key,
        data: data as object | null,
        message: meta.message,
        scope: meta.scope,
        authorId: meta.authorId,
        mapVersion: this.repo.mapVersion,
      })
      .returning();
    // Une autre instance a pu écrire entre-temps : on relit tout pour rester ordonné.
    await this.init();
    return row!;
  }

  history(kind: DataKind, key: string): RevisionRow[] {
    return this.revs.filter((r) => r.kind === kind && r.key === key).reverse();
  }

  async revision(id: number): Promise<RevisionRow | null> {
    const [r] = await this.db.select().from(dataRevisions).where(eq(dataRevisions.id, id));
    return r ?? null;
  }

  /** Valeur du dépôt (avant toute modification). */
  repoValue(kind: DataKind, key: string): unknown {
    const r = this.repo;
    switch (kind) {
      case 'rules':
        return r.balance;
      case 'research':
        return r.research.find((n) => n.id === key) ?? null;
      case 'orbat': {
        const [set, nation] = key.split('/');
        return r.orbats[set!]?.find((o) => o.nationId === nation) ?? null;
      }
      case 'scenario':
        return r.scenarios.find((s) => s.id === key) ?? null;
      case 'nation':
        return r.map?.nations.find((n) => n.id === key) ?? null;
      case 'province':
        return r.map?.provinces.find((p) => p.id === key) ?? null;
      case 'disputed':
        return r.map?.disputed.find((d) => d.id === key) ?? null;
    }
  }
}
