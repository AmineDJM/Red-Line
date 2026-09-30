/**
 * Données statiques de data/ embarquées à la compilation, en morceaux chargés à la demande.
 * Chaque fichier est facultatif (les équipes données les produisent en parallèle) : absent = vide.
 */
import {
  BalanceSchema,
  ResearchFileSchema,
  type Balance,
  type ResearchNode,
} from '@redline/shared';

const researchFiles = import.meta.glob('../../../../data/research/*.json', { import: 'default' });
const balanceFiles = import.meta.glob('../../../../data/balance/*.json', { import: 'default' });
const photoFiles = import.meta.glob('../../../../data/art/photos.json', { import: 'default' });

/** Nœuds de recherche de data/research (validés ; fichiers invalides ignorés). */
export async function bundledResearch(): Promise<ResearchNode[]> {
  const out: ResearchNode[] = [];
  for (const load of Object.values(researchFiles)) {
    const parsed = ResearchFileSchema.safeParse(await load());
    if (parsed.success) out.push(...parsed.data.nodes);
  }
  return out;
}

let balance: Promise<Balance | null> | null = null;
/** Équilibrage (coûts des bâtiments, opérations de renseignement…), null si invalide. */
export function bundledBalance(): Promise<Balance | null> {
  balance ??= (async () => {
    let merged: Record<string, unknown> = {};
    for (const load of Object.values(balanceFiles)) {
      const v = await load();
      if (v && typeof v === 'object' && !Array.isArray(v))
        merged = { ...merged, ...(v as Record<string, unknown>) };
    }
    const parsed = BalanceSchema.safeParse(merged);
    return parsed.success ? parsed.data : null;
  })();
  return balance;
}

/** Manifeste des photos (data/art/photos.json) embarqué, ou null s'il n'existe pas encore. */
export async function bundledPhotoManifest(): Promise<unknown> {
  const load = Object.values(photoFiles)[0];
  return load ? load() : null;
}
