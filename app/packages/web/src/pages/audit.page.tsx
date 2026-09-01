import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuditEntry } from '../api.service.js';
import { Button } from '@/components/ui/button.component';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.component';
import { AuditEntryRow } from '../components/audit-entry-row.component.js';
import { InlineSpinner } from '../components/loading-state.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { SectionCard } from '../components/section-card.component.js';
import { AsyncContent } from '../components/async-content.component.js';

/** Number of audit entries fetched per page (initial load and each "Load more"). */
const PAGE_SIZE = 25;

/**
 * Audit log route (`/audit`). Fetches the newest {@link PAGE_SIZE} entries on
 * mount, renders them as expandable rows (see {@link AuditEntryRow}) showing
 * the before/after game-server config diff for each mutation, and paginates
 * older entries via a "Load more" button that passes the previous page's
 * `nextBefore` cursor back to `api.audit()`.
 */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shared unmount guard: set on unmount and checked by both the mount effect
  // below and `loadMore`, so a "Load more" request that resolves after the
  // operator has navigated away doesn't set state on an unmounted page.
  const cancelledRef = useRef(false);

  // Mount-only effect: `loading` already initialises to `true` and `error` to
  // `null`, so the old `setLoading(true)` / `setError(null)` preamble only
  // ever re-set the values they already held. Dropping it removes the
  // `react-hooks/set-state-in-effect` violation with no behaviour change.
  useEffect(() => {
    cancelledRef.current = false;
    api
      .audit({ limit: PAGE_SIZE })
      .then((page) => {
        if (cancelledRef.current) return;
        setEntries(page.entries);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        if (!cancelledRef.current) setError('Could not load the audit log.');
      })
      .finally(() => {
        if (!cancelledRef.current) setLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const loadMore = useCallback(() => {
    if (!nextBefore) return;
    setLoadingMore(true);
    setError(null);
    api
      .audit({ limit: PAGE_SIZE, before: nextBefore })
      .then((page) => {
        if (cancelledRef.current) return;
        setEntries((prev) => [...prev, ...page.entries]);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        if (!cancelledRef.current) setError('Could not load more audit entries.');
      })
      .finally(() => {
        if (!cancelledRef.current) setLoadingMore(false);
      });
  }, [nextBefore]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Audit Log" subtitle="Who changed which game's configuration, and what changed.">
        <PollingIndicator />
      </PageHeader>

      <SectionCard title="Recent changes">
        <AsyncContent
          loading={loading}
          error={error}
          isEmpty={entries.length === 0}
          emptyMessage="No audit entries yet."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Timestamp</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Game</TableHead>
                <TableHead>Version</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <AuditEntryRow key={entry.sk} entry={entry} />
              ))}
            </TableBody>
          </Table>

          {error && (
            <p className="mt-3 text-xs text-[var(--color-red)]">{error}</p>
          )}

          {nextBefore && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? (
                  <>
                    <InlineSpinner />
                    Loading…
                  </>
                ) : (
                  'Load more'
                )}
              </Button>
            </div>
          )}
        </AsyncContent>
      </SectionCard>
    </div>
  );
}
