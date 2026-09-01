import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunHistoryRecord, RunHistoryStatus, IacRunKind } from '@hyveon/desktop-preload';
import { Button } from '../components/ui/button.component.js';
import { Badge } from '../components/ui/badge.component.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.component.js';
import { RunStatusBadge } from '../components/run-status-badge.component.js';
import { PartialApplyBadge } from '../components/partial-apply-badge.component.js';
import { RollbackAction, type RollbackResult } from '../components/rollback-action.component.js';
import { InlineSpinner } from '../components/loading-state.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { formatTimestamp } from '../lib/utils.utils.js';
import { ChangeSummaryStatus } from '../components/change-summary-status.component.js';
import { SectionCard } from '../components/section-card.component.js';
import { AsyncContent } from '../components/async-content.component.js';

/** Number of run records fetched per page (initial load and each "Load more"). */
const PAGE_SIZE = 25;

/** Shown instead of the run table when the page is rendered outside Electron, where there is no IPC bridge to query. */
const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

/** `kind` filter options, `'all'` meaning no filter is applied. */
type KindFilter = IacRunKind | 'all';

/** `status` filter options, `'all'` meaning no filter is applied (i.e. the unfiltered `hyveon.iac.runs.list` path). */
type StatusFilter = RunHistoryStatus | 'all';

/**
 * Iac run-history route (`/iac/history`) — a newest-first table
 * of persisted plan/apply/destroy runs backed by
 * `hyveon.iac.runs.list` (issue #111). Supports `kind`/`status` filters
 * and cursor-based "Load more" pagination; clicking a row's kind opens the
 * read-only run-detail view at `/iac/history/:runId`. The "Changes"
 * column reuses `ChangeSummaryStatus` from the live Plan/Apply page (task
 * 9.5) so a row's resource-change summary renders with the same
 * unavailable/no-op/badges three-way distinction, and a row whose record
 * carries `partialApply: true` gets a read-only "partial" badge next to its
 * status.
 *
 * Per the design doc, `status` filtering is server-side (the `status-index`
 * GSI), while `kind` filtering is applied client-side to the fetched page —
 * run volume at this project's scale is tiny, so a kind-filtered page can
 * render fewer rows than {@link PAGE_SIZE} without needing a dedicated index.
 */
export function IacHistoryPage() {
  const navigate = useNavigate();
  const [loadingMore, setLoadingMore] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

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

  const visibleRecords = kindFilter === 'all' ? records : records.filter((r) => r.kind === kindFilter);

  /** Routes a confirmed rollback into the plan/apply run view — see `IacPage`'s `RollbackNavState`. */
  const handleRolledBack = useCallback(
    ({ versionId, rolledBackFrom }: RollbackResult) => {
      navigate('/iac', { state: { configVersionId: versionId, rolledBackFrom } });
    },
    [navigate],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="Run History" subtitle="Past plan, apply, and destroy runs.">
        <Link to="/iac" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          Back to Plan/Apply
        </Link>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          Kind
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-foreground)]"
          >
            <option value="all">All</option>
            <option value="plan">Plan</option>
            <option value="apply">Apply</option>
            <option value="destroy">Destroy</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-foreground)]"
          >
            <option value="all">All</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="aborted">Aborted</option>
          </select>
        </label>
      </div>

      <SectionCard title="Recent runs">
        <AsyncContent
          loading={loading}
          error={records.length === 0 ? error : null}
          isEmpty={visibleRecords.length === 0}
          emptyMessage="No runs match the current filters."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Changes</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Approver</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRecords.map((record) => (
                <TableRow key={record.sk}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/iac/history/${record.runId}`}
                        className="capitalize text-[var(--color-primary)] underline underline-offset-2"
                      >
                        {record.kind}
                      </Link>
                      {record.rolledBackFrom && (
                        <Badge variant="cyan" title={`Rollback of apply run ${record.rolledBackFrom}`}>
                          rollback
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <RunStatusBadge status={record.status} />
                      {record.partialApply === true && <PartialApplyBadge />}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ChangeSummaryStatus summary={record.changeSummary} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(record.startedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(record.completedAt)}</TableCell>
                  <TableCell className="text-xs">{record.approvedBy ?? '—'}</TableCell>
                  <TableCell>
                    {record.kind === 'apply' && record.configVersionId !== undefined && (
                      <RollbackAction applyRunId={record.runId} onRolledBack={handleRolledBack} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {error && <p className="mt-3 text-xs text-[var(--color-red)]">{error}</p>}

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
