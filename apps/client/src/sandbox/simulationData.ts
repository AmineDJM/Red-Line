/**
 * Données nécessaires au moteur local (bac à sable) qui ne sont pas exposées par l'API REST :
 * grille H3, détroits, zones disputées et équilibrage. Lues dans data/ à la compilation, en
 * morceaux chargés à la demande (jamais dans le parcours de jeu normal).
 */
import {
  BalanceSchema,
  type Balance,
  type CellsFile,
  type DisputedArea,
  type Strait,
} from '@redline/shared';

const mapFiles = import.meta.glob(
  [
    '../../../../data/map/cells.json',
    '../../../../data/map/straits.json',
    '../../../../data/map/disputed.json',
  ],
  {
    import: 'default',
  },
);
const balanceFiles = import.meta.glob('../../../../data/balance/*.json', { import: 'default' });

export interface SimulationData {
  cells: CellsFile | null;
  straits: Strait[];
  disputed: DisputedArea[];
  balance: Balance | null;
  missing: string[];
}

function base(path: string) {
  return (
    path
      .split('/')
      .pop()
      ?.replace(/\.json$/, '') ?? path
  );
}

function asArray<T>(v: unknown, keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

export async function loadSimulationData(): Promise<SimulationData> {
  const missing: string[] = [];
  const byName = new Map<string, () => Promise<unknown>>(
    Object.entries(mapFiles).map(([p, load]) => [base(p), load]),
  );

  let cells: CellsFile | null = null;
  const cellsLoader = byName.get('cells');
  if (cellsLoader) cells = (await cellsLoader()) as CellsFile;
  else missing.push('data/map/cells.json');

  const straits = byName.get('straits')
    ? asArray<Strait>(await byName.get('straits')!(), ['straits'])
    : [];
  const disputed = byName.get('disputed')
    ? asArray<DisputedArea>(await byName.get('disputed')!(), ['disputed', 'areas'])
    : [];

  // L'équilibrage peut être découpé en plusieurs fichiers : on fusionne puis on valide.
  let merged: Record<string, unknown> = {};
  for (const load of Object.values(balanceFiles)) {
    const v = await load();
    if (v && typeof v === 'object' && !Array.isArray(v))
      merged = { ...merged, ...(v as Record<string, unknown>) };
  }
  const parsed = BalanceSchema.safeParse(merged);
  const balance = parsed.success ? parsed.data : null;
  if (!balance) missing.push('data/balance/*.json');
  return { cells, straits, disputed, balance, missing };
}
