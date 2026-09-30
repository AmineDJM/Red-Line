/**
 * Édition d'une donnée versionnée (règles, nœud de recherche, ORBAT, scénario, nation, province,
 * territoire disputé) : brouillon, validation zod, différences, enregistrement avec portée,
 * historique, restauration d'une révision et retour au dépôt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeScope } from '@redline/shared';
import type { DataRevision, SaveMeta, Versioned, WriteResult } from '../api/types';
import { useToast } from '../components/overlay';
import { T, fmt } from '../i18n';
import { diffObjects } from './diff';
import { errorMessage } from './errors';
import { clone, setIn, type Path } from './paths';
import { issueMap, validateWith, type ReadableIssue } from './validation';

type Schema<T> = Parameters<typeof validateWith<T>>[0];

export interface VersionedOps<T> {
  /** Clé de rechargement (change → recharge). null : pas encore de sélection. */
  key: string | null;
  load: () => Promise<Versioned<T>>;
  save: (data: T, meta: SaveMeta) => Promise<WriteResult<T>>;
  revert: (revisionId: number, meta: SaveMeta) => Promise<WriteResult<T>>;
  reset?: (meta: SaveMeta) => Promise<WriteResult<T>>;
  schema: Schema<T>;
  labelFor?: (path: string) => string;
  /** Appelé après toute écriture réussie (invalidation des caches). */
  onWritten?: (data: T | null) => void;
  /** Donnée neuve (création) quand le chargement renvoie 404. */
  blank?: () => T;
  role?: string;
}

export function useVersioned<T>(ops: VersionedOps<T>) {
  const toast = useToast();
  const [state, setState] = useState<{
    original: T | null;
    revisions: DataRevision<T>[];
    source: 'admin' | 'repo';
    isNew: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const o = opsRef.current;
    if (o.key === null) {
      setState(null);
      setDraft(null);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await o.load();
      if (my !== seq.current) return;
      setState({ original: r.data, revisions: r.revisions, source: r.source, isNew: false });
      setDraft(clone(r.data));
    } catch (e) {
      if (my !== seq.current) return;
      const status = (e as { status?: number }).status;
      if (status === 404 && o.blank) {
        const b = o.blank();
        setState({ original: null, revisions: [], source: 'repo', isNew: true });
        setDraft(b);
      } else {
        setState(null);
        setDraft(null);
        setError(errorMessage(e, o.role));
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [ops.key, load]);

  const validation = useMemo(
    () => (draft === null ? null : validateWith<T>(ops.schema, draft, ops.labelFor)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft],
  );
  const errors = useMemo(() => issueMap(validation?.issues ?? []), [validation]);
  const changes = useMemo(
    () => (draft === null ? [] : diffObjects(state?.original ?? {}, draft)),
    [draft, state],
  );
  const changed = useMemo(
    () => new Set(state?.isNew ? [] : changes.map((c) => c.path)),
    [changes, state],
  );
  const dirty = !!state && (state.isNew || changes.length > 0);

  const set = useCallback(
    (path: Path, value: unknown) => setDraft((d) => (d === null ? d : setIn(d, path, value))),
    [],
  );

  const after = async (r: WriteResult<T>, msg: string) => {
    toast(
      r.runningGames
        ? fmt(T.commit.savedRunning, { n: r.revision.id, g: r.runningGames })
        : fmt(msg, { n: r.revision.id }),
    );
    opsRef.current.onWritten?.(r.revision.data);
    await load();
  };

  const run = async (fn: () => Promise<WriteResult<T>>, msg: string) => {
    setBusy(true);
    try {
      await after(await fn(), msg);
      return true;
    } catch (e) {
      toast(errorMessage(e, opsRef.current.role), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (meta: { message: string; scope: ChangeScope; playerMessage: string }) =>
    validation?.ok
      ? run(() => opsRef.current.save(validation.value, meta), T.commit.saved)
      : Promise.resolve(false);
  const restore = (rev: DataRevision<T>, scope: ChangeScope = 'new_games') =>
    rev.data === null && opsRef.current.reset
      ? run(() => opsRef.current.reset!({ scope }), T.revisions.resetDone)
      : run(() => opsRef.current.revert(rev.id, { scope }), T.revisions.restored);
  const reset = (scope: ChangeScope = 'new_games') =>
    opsRef.current.reset
      ? run(() => opsRef.current.reset!({ scope }), T.revisions.resetDone)
      : Promise.resolve(false);
  const discard = () =>
    setDraft(
      state?.original !== undefined && state?.original !== null ? clone(state.original) : draft,
    );

  return {
    draft,
    setDraft,
    set,
    original: state?.original ?? null,
    revisions: state?.revisions ?? [],
    source: state?.source ?? 'repo',
    isNew: state?.isNew ?? false,
    validation,
    issues: (validation?.issues ?? []) as ReadableIssue[],
    errors,
    changes,
    changed,
    dirty,
    loading,
    busy,
    error,
    reload: load,
    save,
    restore,
    reset,
    discard,
  };
}

export type VersionedState<T> = ReturnType<typeof useVersioned<T>>;
