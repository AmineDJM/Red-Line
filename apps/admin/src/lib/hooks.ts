import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './errors';

/** Chargement asynchrone avec état d'erreur lisible et rechargement. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], requiredRole?: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(
    async (silent = false) => {
      const my = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const d = await load();
        if (my === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e, requiredRole));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
