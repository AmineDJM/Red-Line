import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Vrai sur écran étroit (mobile) : carte plein écran, tiroirs depuis le bas. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
