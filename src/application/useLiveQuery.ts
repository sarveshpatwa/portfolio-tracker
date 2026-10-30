/**
 * React hook that runs an async database query and re-runs it whenever any
 * of the given stores change. Keeps screens in sync with the database without
 * a separate state library.
 */

import { useEffect, useRef, useState } from 'react';
import { getDb } from '../data/db/schema';

export type LiveQuery<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'ready'; data: T; error: undefined }
  | { status: 'error'; data: undefined; error: Error };

export function useLiveQuery<T>(query: () => Promise<T>, stores: readonly string[], deps: readonly unknown[] = []): LiveQuery<T> {
  const [state, setState] = useState<LiveQuery<T>>({ status: 'loading', data: undefined, error: undefined });
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const run = () =>
      queryRef.current().then(
        (data) => !cancelled && setState({ status: 'ready', data, error: undefined }),
        (err: unknown) =>
          !cancelled && setState({ status: 'error', data: undefined, error: err instanceof Error ? err : new Error(String(err)) }),
      );

    getDb().then(
      (db) => {
        if (cancelled) return;
        unsubscribe = db.subscribe((changed) => {
          if (stores.some((s) => changed.has(s))) void run();
        });
        void run();
      },
      (err: unknown) => !cancelled && setState({ status: 'error', data: undefined, error: err instanceof Error ? err : new Error(String(err)) }),
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Re-subscribe only when the store list or caller-supplied deps change.
  }, [stores.join('|'), ...deps]);

  return state;
}
