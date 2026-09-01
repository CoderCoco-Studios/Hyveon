import { Link } from 'react-router-dom';
import type { RunHistoryRecord } from '@hyveon/desktop-preload';
import { Badge } from './ui/badge.component.js';
import { TableCell, TableRow } from './ui/table.component.js';
import { RunStatusBadge } from './run-status-badge.component.js';
import { PartialApplyBadge } from './partial-apply-badge.component.js';
import { RollbackAction, type RollbackResult } from './rollback-action.component.js';
import { ChangeSummaryStatus } from './change-summary-status.component.js';
import { formatTimestamp } from '@/lib/utils.utils';

interface RunHistoryRowProps {
  /** The run-history record this row renders. */
  record: RunHistoryRecord;
  /** Forwarded to {@link RollbackAction} for apply rows that recorded a `configVersionId`. */
  onRolledBack: (result: RollbackResult) => void;
}

/**
 * One row in `/iac/history`'s run table: kind (with a "rollback" badge when the run itself was a
 * rollback), status (with a "partial" badge for a partial apply), the `ChangeSummaryStatus` cell,
 * started/completed timestamps, approver, and — for apply rows that recorded a `configVersionId` —
 * a {@link RollbackAction}.
 */
export function RunHistoryRow({ record, onRolledBack }: RunHistoryRowProps) {
  return (
    <TableRow>
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
          <RollbackAction applyRunId={record.runId} onRolledBack={onRolledBack} />
        )}
      </TableCell>
    </TableRow>
  );
}
