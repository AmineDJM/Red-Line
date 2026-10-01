/** Textes localisables des notifications du moteur (clés du client, paramètres structurés). */
import { loc, type LocParam, type LocText, type ProvinceId } from '@redline/shared';

/**
 * Titre et texte localisables d'une notification : clés `engine.note.<id>.title` et
 * `engine.note.<id>.text` du client (variante `textKey` pour un second texte du même titre).
 */
export function noteLoc(
  id: string,
  params?: Record<string, LocParam>,
  textKey = 'text',
): { title: LocText; text: LocText } {
  return { title: loc(`engine.note.${id}.title`), text: loc(`engine.note.${id}.${textKey}`, params) };
}

/** Lieu localisable d'une province (nom traduit par le client), ou « en mer ». */
export function placeOf(pid: ProvinceId | null): LocParam {
  return pid ? { province: pid } : { key: 'engine.place.sea' };
}

/** Copie profonde à clés triées (même vue avant et après sérialisation de l'état). */
export function canonical<T>(x: T): T {
  if (Array.isArray(x)) return x.map(canonical) as T;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonical(o[k])]),
    ) as T;
  }
  return x;
}
