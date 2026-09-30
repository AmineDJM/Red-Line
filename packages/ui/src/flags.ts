import codes from './flag-codes.json';

/**
 * Drapeaux des nations (flag-icons, licence MIT, copiés dans apps/client/public/flags).
 * Nations sans drapeau disponible (Somaliland, Chypre du Nord…) : null → afficher la couleur de la nation.
 */
const FLAG_CODES = codes as Record<string, string>;

export function flagIso2(nationId: string): string | null {
  return FLAG_CODES[nationId] ?? null;
}

/** URL du drapeau 4:3 (SVG), servi par le client sous /flags. */
export function flagUrl(nationId: string, base = ''): string | null {
  const c = flagIso2(nationId);
  return c ? `${base}/flags/${c}.svg` : null;
}
