import { useState } from 'react';
import type { VolumeSessionState, VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { AUTO_STOP_WARNING_MS } from '@hyveon/shared/volumeFiles';
import { Badge, type BadgeProps } from '@/components/ui/badge.component';
import { Button } from '@/components/ui/button.component';
import { ConfirmDialog } from '../confirm-dialog.component.js';
import { InlineAlert } from '../inline-alert.component.js';
import { useNowTick } from '../../hooks/use-now-tick.hook.js';
import { formatDuration } from '../../lib/format.utils.js';

/** Props for {@link SessionBar}. */
export interface SessionBarProps {
  status: VolumeSessionStatus;
  /** Message of the last failed session action, or `null`. */
  actionError: string | null;
  onStart(): void;
  onStop(): void;
  onRestart(): void;
}

const STATE_LABELS: Record<VolumeSessionState, string> = {
  not_deployed: 'Not deployed',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  orphaned: 'Orphaned',
  failed: 'Failed',
};

const STATE_VARIANTS: Record<VolumeSessionState, BadgeProps['variant']> = {
  not_deployed: 'secondary',
  stopped: 'secondary',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  orphaned: 'destructive',
  failed: 'destructive',
};

/** Seconds between two ISO timestamps' epoch values, clamped at zero. */
function secondsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / 1000);
}

/** Elapsed time and auto-stop countdown for a running session, with the warning once the countdown is short. */
function SessionClock({ status }: { status: VolumeSessionStatus }) {
  const now = useNowTick(1000);
  const startedAt = status.startedAt ? Date.parse(status.startedAt) : null;
  const autoStopAt = status.autoStopAt ? Date.parse(status.autoStopAt) : null;
  const remainingMs = autoStopAt === null ? null : Math.max(0, autoStopAt - now);
  return (
    <>
      {startedAt !== null && <span className="text-xs text-[var(--color-muted-foreground)]">Up {formatDuration(secondsBetween(startedAt, now))}</span>}
      {remainingMs !== null && (
        <span className="text-xs text-[var(--color-muted-foreground)]">Auto-stop in {formatDuration(remainingMs / 1000)}</span>
      )}
      {remainingMs !== null && remainingMs < AUTO_STOP_WARNING_MS && (
        <span role="status" className="text-xs text-[var(--color-amber)]">
          The session stops automatically soon.
        </span>
      )}
    </>
  );
}

/**
 * Header strip for a game's file-browser session: state badge, clock, the actions each state allows and the failure
 * reason.
 *
 * @remarks
 * Start is offered when stopped or failed, Stop while running (confirmed first when an upload or download holds the
 * session) and Restart only for an orphaned session.
 *
 * @param props - See {@link SessionBarProps}.
 */
export function SessionBar({ status, actionError, onStart, onStop, onRestart }: SessionBarProps) {
  const [confirmStop, setConfirmStop] = useState(false);
  const { state } = status;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={STATE_VARIANTS[state]}>{STATE_LABELS[state]}</Badge>
        {state === 'running' && <SessionClock status={status} />}
        <div className="ml-auto flex items-center gap-2">
          {(state === 'stopped' || state === 'failed') && (
            <Button size="sm" variant="start" onClick={onStart}>
              Start
            </Button>
          )}
          {state === 'running' && (
            <Button size="sm" variant="stop" onClick={() => (status.uploadHolders > 0 ? setConfirmStop(true) : onStop())}>
              Stop
            </Button>
          )}
          {state === 'orphaned' && (
            <Button size="sm" variant="outline" onClick={onRestart}>
              Restart
            </Button>
          )}
        </div>
      </div>
      {state === 'failed' && <InlineAlert message={status.error ?? 'The session failed.'} />}
      <InlineAlert message={actionError} />
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop the session?"
        description="This cancels the running upload."
        confirmLabel="Stop session"
        onConfirm={onStop}
      />
    </div>
  );
}
