import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { FolderUploadLastRun, FolderUploadPhase, FolderUploadProgress } from '@hyveon/shared/folderUpload';
import { Button } from '@/components/ui/button.component';
import { api } from '../../api.service.js';
import { ErrorBanner } from '../error-banner.component.js';
import { formatBytes, formatDuration, formatTimestamp } from '../../lib/format.utils.js';

/** Props for {@link FolderUploadProgressMeter}. */
export interface FolderUploadProgressMeterProps {
  /** Game whose upload to show; used to cancel. */
  game: string;
  /** Latest snapshot from {@link useFolderUploadProgress}, or `null` when no run exists in this session. */
  progress: FolderUploadProgress | null;
  /** Persisted outcome of the last run; shown (with Resume) when no run exists in this session, e.g. after a restart. */
  lastRun?: FolderUploadLastRun | null;
  /** Starts the upload again from the current selection; backs both Resume and Retry. */
  onRestart: () => void;
  /** Disables Resume/Retry, e.g. while the server is running or the game is not deployed. */
  restartDisabled?: boolean;
  /** Called once each time a run reaches done, failed or cancelled. */
  onSettled?: (phase: 'done' | 'failed' | 'cancelled') => void;
}

/** Operator-facing label for each phase. */
const PHASE_LABELS: Record<FolderUploadPhase, string> = {
  'starting-helper': 'Starting helper',
  uploading: 'Uploading',
  verifying: 'Verifying',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const VERIFICATION_PREFIX = 'Verification failed: ';

/** Splits a verification failure message into its path entries, or `null` for any other error. */
function verificationPaths(error: string): string[] | null {
  if (!error.startsWith(VERIFICATION_PREFIX)) return null;
  return error.slice(VERIFICATION_PREFIX.length).split(/, (?=\S)/);
}

/**
 * Determinate progress meter for a folder upload: phase, percent bar, bytes, files, current file, rate, ETA, Cancel,
 * Resume/Retry on failure, and the verification result.
 *
 * @remarks
 * Presentational over a snapshot supplied by {@link useFolderUploadProgress}, which restores the current run on mount
 * so a reopened page resumes mid-run. The bar never reads 100% before the run is verified and done.
 *
 * @param props - See {@link FolderUploadProgressMeterProps}.
 */
export function FolderUploadProgressMeter({ game, progress, lastRun, onRestart, restartDisabled, onSettled }: FolderUploadProgressMeterProps) {
  const [cancelling, setCancelling] = useState(false);
  const settledFor = useRef<object | null>(null);
  const phase = progress?.phase;

  useEffect(() => {
    if (progress && (phase === 'done' || phase === 'failed' || phase === 'cancelled') && settledFor.current === null) {
      settledFor.current = progress;
      setCancelling(false);
      onSettled?.(phase);
    }
    if (phase === 'starting-helper' || phase === 'uploading') settledFor.current = null;
  }, [progress, phase, onSettled]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await api.folderCancelUpload(game);
    } catch {
      setCancelling(false);
    }
  }

  if (!progress) {
    if (!lastRun) return null;
    return (
      <div className="space-y-2 text-sm" data-testid="folder-upload-last-run">
        <p>
          Last upload {lastRun.status === 'done' ? 'completed' : lastRun.status}{' '}
          {formatTimestamp(lastRun.completedAt)}: {lastRun.files} file{lastRun.files === 1 ? '' : 's'},{' '}
          {formatBytes(lastRun.bytes)}.
        </p>
        {lastRun.status !== 'done' && (
          <Button type="button" size="sm" disabled={restartDisabled} onClick={onRestart}>
            Resume upload
          </Button>
        )}
      </div>
    );
  }

  const active = progress.phase === 'starting-helper' || progress.phase === 'uploading' || progress.phase === 'verifying';
  const raw = progress.bytesTotal > 0 ? (progress.bytesDone / progress.bytesTotal) * 100 : 0;
  const percent = progress.phase === 'done' ? 100 : Math.min(99, Math.floor(raw));
  const paths = progress.error ? verificationPaths(progress.error) : null;

  return (
    <div className="space-y-3" data-testid="folder-upload-meter">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium">
          {active && <Loader2 className="h-4 w-4 animate-spin" />}
          {PHASE_LABELS[progress.phase]}
        </span>
        {progress.phase !== 'starting-helper' && <span>{percent}%</span>}
      </div>

      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.phase === 'starting-helper' ? undefined : percent}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
      >
        <div
          className={progress.phase === 'failed' ? 'h-full bg-[var(--color-red)]' : 'h-full bg-[var(--color-primary)]'}
          style={{ width: progress.phase === 'starting-helper' ? '0%' : `${percent}%` }}
        />
      </div>

      {progress.phase !== 'starting-helper' && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-4">
          <div>
            <dt>Bytes</dt>
            <dd className="text-[var(--color-foreground)]">
              {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
            </dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd className="text-[var(--color-foreground)]">
              {progress.filesDone} of {progress.filesTotal}
            </dd>
          </div>
          <div>
            <dt>Rate</dt>
            <dd className="text-[var(--color-foreground)]">
              {progress.phase === 'uploading' ? `${formatBytes(progress.bytesPerSecond)}/s` : '-'}
            </dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd className="text-[var(--color-foreground)]">
              {progress.phase === 'uploading' && progress.etaSeconds !== undefined ? formatDuration(progress.etaSeconds) : '-'}
            </dd>
          </div>
        </dl>
      )}

      {progress.phase === 'uploading' && progress.currentPath && (
        <p className="truncate font-[var(--font-mono)] text-xs text-[var(--color-muted-foreground)]" title={progress.currentPath}>
          {progress.currentPath}
        </p>
      )}

      {active && (
        <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void handleCancel()}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      )}

      {progress.phase === 'done' && (
        <p role="status" className="text-sm text-[var(--color-green)]">
          Upload verified: {progress.filesTotal} file{progress.filesTotal === 1 ? '' : 's'}, {formatBytes(progress.bytesTotal)}.
        </p>
      )}

      {progress.phase === 'cancelled' && (
        <div className="space-y-2">
          <p role="status" className="text-sm">Cancelled. Files already copied are kept; resume to upload the rest.</p>
          <Button type="button" size="sm" disabled={restartDisabled} onClick={onRestart}>
            Resume upload
          </Button>
        </div>
      )}

      {progress.phase === 'failed' && (
        <div className="space-y-2">
          <ErrorBanner>
            {paths ? (
              <>
                <p>Verification found files that did not land correctly:</p>
                <ul className="mt-1 list-disc pl-5 font-[var(--font-mono)] text-xs">
                  {paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </>
            ) : (
              (progress.error ?? 'Upload failed.')
            )}
          </ErrorBanner>
          <Button type="button" size="sm" disabled={restartDisabled} onClick={onRestart}>
            {paths ? 'Retry upload' : 'Resume upload'}
          </Button>
        </div>
      )}
    </div>
  );
}
