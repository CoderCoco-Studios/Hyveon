import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { RunHistoryRecord } from '@hyveon/desktop-preload';
import type { AnsiLogChunk } from '../components/ansi-log-viewer.component.js';
import { AnsiLogViewer } from '../components/ansi-log-viewer.component.js';
import { RunStatusBadge } from '../components/run-status-badge.component.js';
import { Badge } from '../components/ui/badge.component.js';
import { ChangeSummaryStatus, ErrorBanner } from './iac.page.js';

/**
 * Number of the most recent run records searched for a `runId` match on
 * this page's direct-navigation/refresh path (see {@link useHistoryRecord}).
 * Mirrors the history list page's own client-side-kind-filter trade-off:
 * run volume at this project's scale is expected to stay well under this
 * ceiling, so a single page covers it without a dedicated get-by-id API.
 */
const LOOKUP_PAGE_SIZE = 200;

/** Resolves the {@link RunHistoryRecord} for `runId` by searching the most recent page of `hyveon.iac.runs.list`. */
function useHistoryRecord(runId: string | undefined): {
  record: RunHistoryRecord | null | undefined;
  loading: boolean;
} {
  // The resolved record is tagged with the `runId` it belongs to, so both
  // "the route changed, discard the previous answer" and "are we still
  // loading?" are derived at render. The effect therefore only ever writes
  // state from its async callbacks, never synchronously
  // (`react-hooks/set-state-in-effect`).
  const [resolved, setResolved] = useState<{
    runId: string;
    record: RunHistoryRecord | null;
  } | null>(null);

  const canLookup = Boolean(runId) && Boolean(window.hyveon);
  const settled = resolved !== null && resolved.runId === runId;
  // `undefined` means "not answered yet", `null` means "looked and found
  // nothing" — the distinction the caller's log ladder branches on.
  const record = settled ? resolved.record : undefined;
  const loading = canLookup && !settled;

  useEffect(() => {
    if (!runId || !window.hyveon) return;
    let cancelled = false;
    window.hyveon.iac.runs
      .list({ limit: LOOKUP_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setResolved({ runId, record: page.records.find((r) => r.runId === runId) ?? null });
      })
      .catch(() => {
        if (!cancelled) setResolved({ runId, record: null });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return { record, loading };
}

/** Splits raw log text into `AnsiLogChunk`s (one per line) so persisted log text can render through the same `AnsiLogViewer` streamed chunks use. */
function textToChunks(text: string): AnsiLogChunk[] {
  return text.split('\n').map((line) => ({ stream: 'stdout' as const, line }));
}

/** Which source a run-detail page's log ultimately resolved from — see the log-source ladder in `useRunLogLadder`. */
type LogSource = 'stream' | 'inline' | 'url' | 'none';

/**
 * Resolves a finished run's captured log via the fallback ladder: replay via
 * `hyveon.iac.runs.streamLogs` when local run artifacts still exist,
 * otherwise the persisted record's `logInline` text, otherwise a presigned
 * URL fetched via `hyveon.iac.runs.logUrl(record.logS3Key)`.
 */
function useRunLogLadder(runId: string | undefined, record: RunHistoryRecord | null | undefined): {
  chunks: AnsiLogChunk[];
  source: LogSource;
  loading: boolean;
} {
  // Same tagging approach as useHistoryRecord above: the resolved log is
  // stamped with the `runId` it was fetched for, so navigating to a different
  // run discards it at render time instead of needing the effect to clear
  // `chunks`/`source` synchronously.
  const [resolved, setResolved] = useState<{
    runId: string;
    chunks: AnsiLogChunk[];
    source: LogSource;
  } | null>(null);

  const canLoad = Boolean(runId) && Boolean(window.hyveon);
  const settled = resolved !== null && resolved.runId === runId;
  const chunks = settled ? resolved.chunks : [];
  const source = settled ? resolved.source : 'none';
  // `record === undefined` means useHistoryRecord's own fetch is still in
  // flight; staying in the loading state through that window is what stops a
  // transient "no log" flash before the ladder has anything to go on.
  // `record === null` means there is no record to load a log from, which is a
  // settled answer, not a pending one.
  const loading = canLoad && record !== null && !settled;

  useEffect(() => {
    if (!runId || !window.hyveon) return;
    if (!record) return;
    let cancelled = false;

    /** Publish a ladder result, tagged with the run it belongs to. */
    const publish = (next: { chunks?: AnsiLogChunk[]; source: LogSource }) => {
      setResolved({ runId, chunks: next.chunks ?? [], source: next.source });
    };

    void (async () => {
      try {
        const streamed: AnsiLogChunk[] = [];
        for await (const chunk of window.hyveon!.iac.runs.streamLogs(runId)) {
          if (cancelled) return;
          streamed.push(chunk);
        }
        if (cancelled) return;
        if (streamed.length > 0) {
          publish({ chunks: streamed, source: 'stream' });
          return;
        }
      } catch {
        // Local run artifacts (<runsDir>/<runId>) are gone — fall through to
        // the persisted record's inline/offloaded log below.
      }
      if (cancelled) return;

      if (record.logInline) {
        publish({ chunks: textToChunks(record.logInline), source: 'inline' });
        return;
      }

      if (record.logS3Key) {
        try {
          const url = await window.hyveon!.iac.runs.logUrl(record.logS3Key);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`presigned log fetch failed: ${res.status}`);
          const text = await res.text();
          if (cancelled) return;
          publish({ chunks: textToChunks(text), source: 'url' });
        } catch {
          if (!cancelled) publish({ source: 'none' });
        }
        return;
      }

      publish({ source: 'none' });
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, record]);

  return { chunks, source, loading };
}

/** Format an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Read-only run-detail route (`/iac/history/:runId`) — shows a single
 * persisted `terraform` run's status and captured log, reusing the live
 * Plan/Apply page's `AnsiLogViewer`/`ErrorBanner`/`ChangeSummaryStatus`
 * components. Never offers Approve/Apply controls: every record in history
 * describes a finished (terminal) run — a `RunRecord` is only ever
 * persisted once its subcommand has closed. A record with
 * `partialApply: true` gets a read-only "partial" badge next to its status —
 * unlike the live page's `PartialApplyBanner`, there is no "start over"
 * action on a historical run.
 */
export function IacRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { record, loading: recordLoading } = useHistoryRecord(runId);
  const { chunks, source, loading: logLoading } = useRunLogLadder(runId, record);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Run detail</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">{runId}</p>
        </div>
        <Link to="/iac/history" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          Back to history
        </Link>
      </div>

      {recordLoading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : !record ? (
        <ErrorBanner message={`No run history record was found for "${runId}".`} />
      ) : (
        <section className="flex flex-col gap-3" aria-label="Run detail">
          <div className="flex flex-wrap items-center gap-3">
            <span className="capitalize text-sm font-medium text-[var(--color-foreground)]">{record.kind}</span>
            <RunStatusBadge status={record.status} />
            {record.partialApply === true && (
              <Badge
                variant="warning"
                title="Apply stopped partway through — some resources were already changed before this run failed or was aborted."
              >
                partial
              </Badge>
            )}
            <span className="text-xs text-[var(--color-muted-foreground)]">
              Started {formatTimestamp(record.startedAt)} — completed {formatTimestamp(record.completedAt)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-foreground)]">Changes</span>
            <ChangeSummaryStatus summary={record.changeSummary} />
          </div>

          {record.rolledBackFrom && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Rollback of{' '}
              <Link
                to={`/iac/history/${record.rolledBackFrom}`}
                className="text-[var(--color-primary)] underline underline-offset-2"
              >
                apply run {record.rolledBackFrom}
              </Link>
            </p>
          )}

          {record.approvedBy && (
            <p className="text-sm text-[var(--color-foreground)]">
              Approved by <strong>{record.approvedBy}</strong>
              {record.approvedAt && <> at {formatTimestamp(record.approvedAt)}</>}
            </p>
          )}

          {logLoading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading log…
            </div>
          ) : (
            <>
              <AnsiLogViewer chunks={chunks} emptyMessage="No log is available for this run." />
              {source === 'none' && chunks.length === 0 && (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  This run has no replayable, inline, or offloaded log.
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
