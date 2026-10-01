/**
 * Message unique à afficher à l'arrivée sur un écran (ex. « partie supprimée » après un retour forcé
 * à l'accueil). Conservé dans sessionStorage, lu une seule fois.
 */
const KEY = 'rl.flash';

export type FlashCode = 'game_deleted';

export function setFlash(code: FlashCode): void {
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    /* stockage indisponible : pas de message */
  }
}

export function takeFlash(): FlashCode | null {
  try {
    const v = sessionStorage.getItem(KEY) as FlashCode | null;
    if (v) sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
