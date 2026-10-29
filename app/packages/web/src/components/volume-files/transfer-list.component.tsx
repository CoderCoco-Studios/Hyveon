import type { VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { Button } from '@/components/ui/button.component';
import { api } from '../../api.service.js';
import { formatBytes } from '../../lib/format.utils.js';

/** Props for {@link TransferList}. */
export interface TransferListProps {
  game: string;
  transfers: VolumeTransferProgress[];
}

/** Progress text for one transfer: bytes so far, with the total when known. */
function describeProgress(transfer: VolumeTransferProgress): string {
  const done = formatBytes(transfer.bytesDone);
  return transfer.bytesTotal === null ? done : `${done} of ${formatBytes(transfer.bytesTotal)}`;
}

/** One transfer row: name, progress bar, outcome and Cancel while it runs. */
function TransferRow({ game, transfer }: { game: string; transfer: VolumeTransferProgress }) {
  const percent = transfer.bytesTotal ? Math.min(100, Math.floor((transfer.bytesDone / transfer.bytesTotal) * 100)) : undefined;
  return (
    <li className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">
          {transfer.kind === 'upload' ? 'Upload' : 'Download'}: {transfer.name}
        </span>
        {transfer.phase === 'running' && (
          <Button size="sm" variant="outline" aria-label={`Cancel ${transfer.name}`} onClick={() => void api.volumeCancelTransfer(game, transfer.transferId).catch(() => undefined)}>
            Cancel
          </Button>
        )}
      </div>
      {transfer.phase === 'running' && (
        <div
          role="progressbar"
          aria-label={`${transfer.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        >
          <div className="h-full bg-[var(--color-primary)]" style={{ width: `${percent ?? 100}%` }} />
        </div>
      )}
      <p className="text-xs text-[var(--color-muted-foreground)]">
        {transfer.phase === 'running' && describeProgress(transfer)}
        {transfer.phase === 'done' && (transfer.savedAs ? `Done. Saved as ${transfer.savedAs}` : 'Done.')}
        {transfer.phase === 'cancelled' && 'Cancelled.'}
        {transfer.phase === 'failed' && 'Failed.'}
      </p>
      {transfer.error && <p className="text-xs text-[var(--color-red)]">{transfer.error}</p>}
    </li>
  );
}

/** Uploads and downloads seen on this page, newest last; renders nothing when there are none. */
export function TransferList({ game, transfers }: TransferListProps) {
  if (transfers.length === 0) return null;
  return (
    <ul aria-label="Transfers" className="space-y-3">
      {transfers.map((transfer) => (
        <TransferRow key={transfer.transferId} game={game} transfer={transfer} />
      ))}
    </ul>
  );
}
