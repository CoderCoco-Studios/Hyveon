import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Copy, ExternalLink, Download, Loader2 } from 'lucide-react';
import { api, type CloudHealthCheckSummary, type CloudHealthFixResult } from '../api.service.js';
import { Button } from './ui/button.component.js';
import { Badge } from './ui/badge.component.js';
import { Input } from './ui/input.component.js';

/**
 * Status badge for a single Cloud Health row.
 *
 * @param status - the check's current status.
 * @returns a colored {@link Badge} describing the status.
 */
function HealthBadge({ status }: { status: CloudHealthCheckSummary['status'] }) {
  switch (status) {
    case 'ok':
      return <Badge variant="success">OK</Badge>;
    case 'missing':
      return <Badge variant="destructive">Missing</Badge>;
    case 'error':
      return <Badge variant="destructive">Error</Badge>;
  }
}

/**
 * One row of the Cloud Health checklist, with its own Fix state.
 *
 * @param check - the check summary to render.
 * @param onFixed - called after a successful (`outcome: 'fixed'`) fix, so the parent can refresh the list.
 */
function HealthRow({ check, onFixed }: { check: CloudHealthCheckSummary; onFixed: () => void }) {
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<CloudHealthFixResult | null>(null);
  // Distinct from `fixResult`: set only when `api.cloudHealthFix` itself
  // rejects (an IPC-bridge-level failure), as opposed to the modeled
  // CloudHealthFixResult the controller returns for AWS-level failures.
  const [fixError, setFixError] = useState<string | null>(null);

  const [openingConsole, setOpeningConsole] = useState(false);
  const [consoleOpened, setConsoleOpened] = useState(false);
  // Fallback URL to display as plain text when the browser couldn't be
  // opened automatically — mirrors `guided-iam-step.component.tsx`'s
  // `consoleUrl` fallback pattern for the same `OpenConsoleResult` shape.
  const [consoleFallbackUrl, setConsoleFallbackUrl] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Calls `api.cloudHealthFix` for this row and records the outcome, or defers to `onFixed` when it succeeds outright. */
  async function handleFix() {
    setFixing(true);
    setFixResult(null);
    setFixError(null);
    try {
      const result = await api.cloudHealthFix(check.id);
      if (result.outcome === 'fixed') {
        onFixed();
      } else {
        setFixResult(result);
      }
    } catch (err) {
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixing(false);
    }
  }

  /** Opens `fixResult.policyConsoleUrl` in the operator's default browser, falling back to displaying the URL as text. */
  async function handleOpenConsole(url: string) {
    setOpeningConsole(true);
    setConsoleError(null);
    try {
      const result = await api.cloudHealthOpenPolicyConsole(url);
      setConsoleOpened(result.opened);
      setConsoleFallbackUrl(result.opened ? null : result.url);
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningConsole(false);
    }
  }

  /** Writes `fixResult.policyJson` to disk and records the path it was saved to. */
  async function handleDownload(policyJson: string) {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { path } = await api.cloudHealthDownloadPolicy(policyJson);
      setDownloadedPath(path);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  const broken = check.status !== 'ok';

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {check.status === 'ok' && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {check.status === 'missing' && <AlertTriangle className="size-4 text-[var(--color-amber)]" />}
        {check.status === 'error' && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium flex-1">{check.label}</span>
        <HealthBadge status={check.status} />
        {broken && (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleFix()} disabled={fixing}>
            {fixing ? <Loader2 className="size-3 animate-spin" /> : 'Fix'}
          </Button>
        )}
      </div>
      {check.message && !fixResult && !fixError && <p className="text-xs text-muted-foreground">{check.message}</p>}
      {fixError && <p className="text-xs text-[var(--color-red)]">Unable to reach the app: {fixError}</p>}
      {fixResult?.outcome === 'failed' && <p className="text-xs text-[var(--color-red)]">{fixResult.message}</p>}
      {fixResult?.outcome === 'needsPolicyUpdate' && fixResult.policyJson && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-amber)]">
            Your <code>HyveonDeployAll</code> policy needs updating. Open it in the IAM console and paste in the
            JSON below (Edit policy → JSON), or download it for use with the AWS CLI — then click Fix again.
          </p>
          <div className="relative">
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 text-xs">
              {fixResult.policyJson}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() =>
                void navigator.clipboard.writeText(fixResult.policyJson!).catch(() => {
                  /* clipboard denial is non-critical; the policy JSON is still visible above */
                })
              }
              aria-label="Copy required IAM JSON"
            >
              <Copy className="size-3" />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {fixResult.policyConsoleUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleOpenConsole(fixResult.policyConsoleUrl!)}
                disabled={openingConsole}
              >
                {openingConsole ? <Loader2 className="size-3 animate-spin" /> : <ExternalLink className="size-3" />}
                Open in AWS Console
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleDownload(fixResult.policyJson!)}
              disabled={downloading}
            >
              {downloading ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
              Download JSON
            </Button>
          </div>

          {consoleError && <p className="text-xs text-[var(--color-red)]">Unable to open the console: {consoleError}</p>}
          {consoleOpened && (
            <p className="flex items-center gap-1 text-xs text-[var(--color-green)]">
              <CheckCircle2 className="size-3" />
              Opened in your default browser.
            </p>
          )}
          {consoleFallbackUrl && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Could not open a browser automatically — open this URL manually:
              </p>
              <Input value={consoleFallbackUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}

          {downloadError && <p className="text-xs text-[var(--color-red)]">Unable to save the file: {downloadError}</p>}
          {downloadedPath && (
            <p className="flex items-center gap-1 text-xs text-[var(--color-green)]">
              <CheckCircle2 className="size-3" />
              Saved to {downloadedPath}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Always-visible AWS account-prerequisite checklist for the Settings page.
 *
 * @remarks
 * Runs on mount and on manual Refresh — no automatic polling. `loading`
 * starts `true` (rather than the mount effect calling `setLoading(true)`
 * synchronously) and `fetchChecks` only ever sets state inside its
 * `.then()`/`.catch()`/`.finally()` continuations, never synchronously in
 * the effect body — mirroring `settings.page.tsx`'s `engineVersion` effect —
 * so the mount effect satisfies `react-hooks/set-state-in-effect`.
 *
 * `listError` is distinct from a check's own `status: 'error'`: it's set
 * only when `api.cloudHealthList()` itself rejects (an IPC-bridge-level
 * failure), as opposed to the modeled `CloudHealthCheckResult` the
 * controller always returns for AWS-level failures.
 *
 * @returns the Cloud Health checklist section.
 */
export function CloudHealthSection() {
  const [checks, setChecks] = useState<CloudHealthCheckSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  /** Fetches the checklist and updates state from the resolved/rejected promise, never synchronously. */
  const fetchChecks = useCallback(() => {
    return api
      .cloudHealthList()
      .then((result) => {
        setChecks(result);
        setListError(null);
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  /** Manual Refresh handler: flips the spinner on immediately, then re-fetches. */
  const refresh = useCallback(() => {
    setLoading(true);
    void fetchChecks();
  }, [fetchChecks]);

  useEffect(() => {
    void fetchChecks();
  }, [fetchChecks]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : 'Refresh'}
        </Button>
      </div>
      {listError && (
        <p className="text-xs text-[var(--color-red)]">Unable to load Cloud Health checks: {listError}</p>
      )}
      {(checks ?? []).map((check) => (
        <HealthRow key={check.id} check={check} onFixed={refresh} />
      ))}
    </div>
  );
}
