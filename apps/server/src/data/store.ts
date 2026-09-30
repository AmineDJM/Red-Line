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
import { ScenarioFileSchema, type GameData } from './loader.js';

/**
 * Données de jeu effectives = fichiers du dépôt (data/) + modifications du back-office (table data_revisions).
 * Chaque modification est une révision numérotée ; une partie épingle la révision en vigueur à sa création
 * (games.data_rev), ce qui garantit une reprise identique après redémarrage. Retour arrière = nouvelle révision
 * qui reprend une valeur antérieure.
 */
export interface EffectiveData {
  rev: number;
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

const MAX_CACHED = 6;

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
  private cache = new Map<number, EffectiveData>();
  currentRev = 0;

  constructor(
    private readonly db: Db,
    readonly repo: GameData,
  ) {}

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

  /** Dernière valeur de chaque (type, clé) avec une révision <= rev. */
  private overrides(rev: number): Map<DataKind, Map<string, unknown>> {
    const out = new Map<DataKind, Map<string, unknown>>();
    for (const r of this.revs) {
      if (r.id > rev) break;
      let m = out.get(r.kind);
      if (!m) out.set(r.kind, (m = new Map()));
      m.set(r.key, r.data);
    }
    return out;
  }

  effective(rev: number): EffectiveData {
    const cached = this.cache.get(rev);
    if (cached) return cached;
    const repo = this.repo;
    const ov = this.overrides(rev);
    const get = <T>(k: DataKind) => (ov.get(k) ?? new Map()) as Map<string, T | null>;

    let map = repo.map;
    if (map) {
      const nations = replaceById<NationDef>(map.nations, get<NationDef>('nation'));
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
      map,
      nationsById: new Map((map?.nations ?? []).map((n) => [n.id, n])),
      balance: rules === undefined ? repo.balance : (rules ?? repo.balance),
      research: replaceById<ResearchNode>(repo.research, get<ResearchNode>('research')),
      orbats,
      scenarios: replaceById<ScenarioFile>(repo.scenarios, get<ScenarioFile>('scenario')),
    };
    if (this.cache.size >= MAX_CACHED) {
      const oldest = [...this.cache.keys()].find((k) => k !== this.currentRev);
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(rev, eff);
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
