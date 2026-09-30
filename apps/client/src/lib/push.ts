/**
 * Notifications navigateur :
 *  - Web Push (serveur) : si GET /api/push/key fournit une clé VAPID, abonnement via le service
 *    worker /sw.js puis POST /api/push/subscribe ;
 *  - notifications locales : alertes critiques quand l'onglet est en arrière-plan (sans serveur).
 */
import { useEffect } from 'react';
import { getApi } from '../api/index.js';
import { useGame } from '../store/game.js';
import { describeNotification } from '../shell/helpers.js';
import { t } from '../i18n/index.js';

const PREF_KEY = 'rl.notify';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationsEnabled(): boolean {
  try {
    return (
      notificationsSupported() &&
      Notification.permission === 'granted' &&
      localStorage.getItem(PREF_KEY) === '1'
    );
  } catch {
    return false;
  }
}

function b64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Active les notifications ; renvoie 'push' (Web Push), 'local', 'denied' ou 'unsupported'. */
export async function enableNotifications(): Promise<'push' | 'local' | 'denied' | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  try {
    localStorage.setItem(PREF_KEY, '1');
  } catch {
    /* stockage indisponible */
  }
  const api = await getApi();
  const key = await api.pushKey().catch(() => null);
  if (!key || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'local';
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key),
      }));
    await api.pushSubscribe(sub.toJSON());
    return 'push';
  } catch {
    return 'local';
  }
}

export async function disableNotifications(): Promise<void> {
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    /* stockage indisponible */
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      await (await getApi()).pushUnsubscribe();
    }
  } catch {
    /* rien à désabonner */
  }
}

/** Alertes critiques en notification système quand l'onglet est masqué. */
export function usePushNotifications(gameId: string) {
  useEffect(() => {
    let last = 0;
    return useGame.subscribe((s, prev) => {
      if (s.notifications === prev.notifications || !notificationsEnabled()) return;
      if (document.visibilityState === 'visible') return;
      for (const n of s.notifications) {
        if (n.id <= last) break;
        const d = describeNotification(n.item, s.view, s.me);
        if (!d.critical) continue;
        try {
          new Notification(t('app.name'), {
            body: d.text,
            tag: `${gameId}-${n.id}`,
            icon: '/icon-192.png',
          });
        } catch {
          /* notification refusée */
        }
      }
      last = s.notifications[0]?.id ?? last;
    });
  }, [gameId]);
}
