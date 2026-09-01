import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../api.service.js';
import { ErrorBanner } from './error-banner.component.js';
import { Button } from './ui/button.component.js';

/**
 * Client-side state for the "Export diagnostics bundle" button.
 *
 *  - `'idle'`: nothing in flight, no prior result to show — the initial
 *    state, and also where a dialog-cancel returns to (silent no-op, per
 *    spec — no error, no lingering success/error copy either).
 *  - `'loading'`: the `diagnostics.exportBundle` IPC call is in flight.
 *  - `{ status: 'success', path }`: the bundle was written; `path` backs the
 *    "Show in folder" action.
 *  - `{ status: 'error', message }`: the export failed (write failure, or
 *    the IPC call itself rejecting) — shown as an inline error indication.
 */
type ExportBundleState = 'idle' | 'loading' | { status: 'success'; path: string } | { status: 'error'; message: string };

/**
 * "Export diagnostics bundle" button plus its two result banners (a success
 * banner with a "Show in folder" action, or an error banner) — owns the
 * `diagnostics.exportBundle`/`diagnostics.showInFolder` IPC calls and their
 * client-side state so callers only render the button and let it drive its
 * own result UI.
 */
export function ExportBundleButton() {
  const [exportState, setExportState] = useState<ExportBundleState>('idle');

  /**
   * Triggers the `diagnostics.exportBundle` IPC call. A dialog-cancel
   * resolves `{ status: 'cancelled' }` — routed back to `'idle'` with no
   * error shown, per spec. A write failure or a rejected IPC call both
   * surface as `{ status: 'error', message }`.
   */
  const handleExportBundle = useCallback(async () => {
    setExportState('loading');
    try {
      const result = await api.diagnosticsExportBundle();
      if (result.status === 'written') {
        setExportState({ status: 'success', path: result.path });
      } else if (result.status === 'cancelled') {
        setExportState('idle');
      } else {
        setExportState({ status: 'error', message: result.message });
      }
    } catch (err) {
      setExportState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to export diagnostics bundle' });
    }
  }, []);

  /** Reveals the last-exported bundle in the OS's file manager. A no-op unless {@link exportState} is a success. */
  const handleShowInFolder = useCallback(() => {
    if (typeof exportState === 'object' && exportState.status === 'success') {
      void api.diagnosticsShowInFolder(exportState.path);
    }
  }, [exportState]);

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleExportBundle()}
        disabled={exportState === 'loading'}
        className="self-end"
      >
        <Download className="h-3.5 w-3.5" />
        {exportState === 'loading' ? 'Exporting…' : 'Export diagnostics bundle'}
      </Button>

      {typeof exportState === 'object' && exportState.status === 'success' && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        >
          <span>
            Diagnostics bundle written to <span className="font-[var(--font-mono)]">{exportState.path}</span>
          </span>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={handleShowInFolder}>
            Show in folder
          </Button>
        </div>
      )}

      {typeof exportState === 'object' && exportState.status === 'error' && (
        <ErrorBanner>Failed to export diagnostics bundle: {exportState.message}</ErrorBanner>
      )}
    </div>
  );
}
