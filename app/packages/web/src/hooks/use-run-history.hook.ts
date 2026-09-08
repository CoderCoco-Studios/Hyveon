import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunHistoryRecord, RunHistoryStatus } from '@hyveon/desktop-preload';
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

/** Number of run records fetched per page (initial load and each "Load more"). */
const PAGE_SIZE = 25;

/** `status` filter options accepted by {@link useRunHistory}, `'all'` meaning no filter is applied (i.e. the unfiltered `hyveon.iac.runs.list` path). */
export type StatusFilter = RunHistoryStatus | 'all';

/** Live state and actions returned by {@link useRunHistory}. */
export interface UseRunHistoryResult {
  records: RunHistoryRecord[];
  loading: boolean;
  error: string | null;
  nextBefore: string | undefined;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Fetch orchestration for `/iac/history`'s run table: the initial page for the given
 * `statusFilter` — server-side via the `status-index` GSI — plus cursor-based "Load more"
 * pagination. Re-fetches the first page whenever `statusFilter` changes.
 */
export function useRunHistory(statusFilter: StatusFilter): UseRunHistoryResult {
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * The fetched page, tagged with the `statusFilter` it was fetched for.
   * Records, cursor and error all live together so a filter change discards
   * them as one unit at render time — the effect below no longer has to reset
   * them synchronously, which is what `react-hooks/set-state-in-effect`
   * flags. `loading` becomes "no page for the current filter yet".
   */
  const [page, setPage] = useState<{
    statusFilter: StatusFilter;
    records: RunHistoryRecord[];
    nextBefore: string | undefined;
    error: string | null;
  } | null>(null);

  const bridgeAvailable = Boolean(window.hyveon);
  const settled = page !== null && page.statusFilter === statusFilter;
  const records = settled ? page.records : [];
  const nextBefore = settled ? page.nextBefore : undefined;
  const error = settled ? page.error : bridgeAvailable ? null : BRIDGE_UNAVAILABLE;
  const loading = bridgeAvailable && !settled;

  /**
   * Monotonically-increasing request generation counter. `loadMore`'s fetch
   * isn't tied to the filter effect below, so without this a "Load more"
   * click followed by a filter change could resolve after the filter effect
   * has already reset `records` — appending a stale-filter page onto the
   * fresh list. Each in-flight request captures the counter's value at
   * dispatch time and only applies its result if it's still current.
   */
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!window.hyveon) return;
    const seq = ++requestSeqRef.current;
    window.hyveon.iac.runs
      .list({ limit: PAGE_SIZE, status: statusFilter === 'all' ? undefined : statusFilter })
      .then((fetched) => {
        if (requestSeqRef.current !== seq) return;
        setPage({
          statusFilter,
          records: fetched.records,
          nextBefore: fetched.nextBefore,
          error: null,
        });
      })
      .catch(() => {
        if (requestSeqRef.current !== seq) return;
        // Settle the page for this filter with an error so the view leaves
        // its loading state and shows the message instead of spinning.
        setPage({
          statusFilter,
          records: [],
          nextBefore: undefined,
          error: 'Could not load the run history.',
        });
      });
  }, [statusFilter]);

  const loadMore = useCallback(() => {
    if (!nextBefore || !window.hyveon) return;
    const seq = ++requestSeqRef.current;
    setLoadingMore(true);
    window.hyveon.iac.runs
      .list({ limit: PAGE_SIZE, before: nextBefore, status: statusFilter === 'all' ? undefined : statusFilter })
      .then((fetched) => {
        if (requestSeqRef.current !== seq) return;
        setPage((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                records: [...prev.records, ...fetched.records],
                nextBefore: fetched.nextBefore,
                error: null,
              },
        );
      })
      .catch(() => {
        if (requestSeqRef.current !== seq) return;
        setPage((prev) => (prev === null ? prev : { ...prev, error: 'Could not load more run history.' }));
      })
      .finally(() => {
        // Cleared unconditionally, unlike the result/error handlers above. A
        // filter change bumps `requestSeqRef` mid-flight, so gating this on
        // the seq guard left `loadingMore` stuck `true` forever — and once
        // the newly-filtered page settled with a cursor, "Load more"
        // rendered permanently disabled. Only one load-more can be in flight
        // at a time (the button is disabled while it runs), so whichever
        // request owns the flag is always the one entitled to clear it.
        setLoadingMore(false);
      });
  }, [nextBefore, statusFilter]);

  return { records, loading, error, nextBefore, loadingMore, loadMore };
}
