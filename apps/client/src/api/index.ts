import { IS_MOCK } from '../config.js';
import { HttpApi } from './http.js';
import type { Api } from './types.js';

export * from './types.js';

let instance: Promise<Api> | null = null;

/** API courante : serveur réel, ou fixtures en mode ?mock=1 (chargées à la demande). */
export function getApi(): Promise<Api> {
  instance ??= IS_MOCK ? import('./mock.js').then((m) => new m.MockApi()) : Promise.resolve(new HttpApi());
  return instance;
}
