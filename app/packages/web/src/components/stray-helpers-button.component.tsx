import { useState } from 'react';
import { Eraser } from 'lucide-react';
import type { StrayHelperReport } from '@hyveon/shared/folderUpload';
import { api } from '../api.service.js';
import { ErrorBanner } from './error-banner.component.js';
import { Button } from './ui/button.component.js';

/** Client-side state of the cleanup action: idle, in flight, finished with a report, or failed. */
type CleanupState = 'idle' | 'loading' | { status: 'done'; report: StrayHelperReport } | { status: 'error'; message: string };

/**
 * "Clean up stray helpers" Diagnostics action: stops every file-manager helper task that no active upload owns and
 * lists what it stopped, so an app that exited mid-upload cannot leave a billable task running.
 */
export function StrayHelpersButton() {
  const [state, setState] = useState<CleanupState>('idle');

  async function handleCleanup() {
    setState('loading');
    try {
      setState({ status: 'done', report: await api.folderCleanupStrayHelpers() });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to clean up stray helpers' });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleCleanup()}
        disabled={state === 'loading'}
        className="self-end"
      >
        <Eraser className="h-3.5 w-3.5" />
        {state === 'loading' ? 'Cleaning up…' : 'Clean up stray helpers'}
      </Button>

      {typeof state === 'object' && state.status === 'done' && (
        <div
          role="status"
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        >
          {state.report.stopped.length === 0 ? (
            <p>No stray helpers found.</p>
          ) : (
            <>
              <p>
                Stopped {state.report.stopped.length} helper{state.report.stopped.length === 1 ? '' : 's'}:
              </p>
              <ul className="list-disc pl-5 text-xs">
                {state.report.stopped.map((helper) => (
                  <li key={helper.taskArn}>
                    {helper.game} ({helper.ageMinutes} min old)
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Skipped {state.report.skipped}, revoked {state.report.revokedRules} access rule
            {state.report.revokedRules === 1 ? '' : 's'}.
          </p>
          {state.report.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-[var(--color-red)]">
              {state.report.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {typeof state === 'object' && state.status === 'error' && <ErrorBanner>{state.message}</ErrorBanner>}
    </div>
  );
}
