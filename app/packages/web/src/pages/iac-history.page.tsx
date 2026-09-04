import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { IacRunKind } from '@hyveon/desktop-preload';
import { Button } from '../components/ui/button.component.js';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table.component.js';
import { RunHistoryRow } from '../components/run-history-row.component.js';
import { type RollbackResult } from '../components/rollback-action.component.js';
import { InlineSpinner } from '../components/loading-state.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { SectionCard } from '../components/section-card.component.js';
import { AsyncContent } from '../components/async-content.component.js';
import { useRunHistory, type StatusFilter } from '../hooks/use-run-history.hook.js';

/** `kind` filter options, `'all'` meaning no filter is applied. */
type KindFilter = IacRunKind | 'all';

/**
 * Iac run-history route (`/iac/history`) — a newest-first table
 * of persisted plan/apply/destroy runs backed by
 * `hyveon.iac.runs.list`. Supports `kind`/`status` filters
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
 * render fewer rows than a full page without needing a dedicated index.
 * Fetch orchestration (pagination, the status-filter effect, "Load more")
 * lives in {@link useRunHistory}.
 */
export function IacHistoryPage() {
  const navigate = useNavigate();
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { records, loading, error, nextBefore, loadingMore, loadMore } = useRunHistory(statusFilter);

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
                <RunHistoryRow key={record.sk} record={record} onRolledBack={handleRolledBack} />
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
