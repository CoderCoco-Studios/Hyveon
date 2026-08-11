import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Copy, Loader2 } from 'lucide-react';
import { api, type CloudHealthCheckSummary, type CloudHealthFixResult } from '../api.service.js';
import { Button } from './ui/button.component.js';
import { Badge } from './ui/badge.component.js';

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

  /** Calls `api.cloudHealthFix` for this row and records the outcome, or defers to `onFixed` when it succeeds outright. */
  async function handleFix() {
    setFixing(true);
    setFixResult(null);
    try {
      const result = await api.cloudHealthFix(check.id);
      if (result.outcome === 'fixed') {
        onFixed();
      } else {
        setFixResult(result);
      }
    } finally {
      setFixing(false);
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
      {check.message && !fixResult && <p className="text-xs text-muted-foreground">{check.message}</p>}
      {fixResult?.outcome === 'failed' && <p className="text-xs text-[var(--color-red)]">{fixResult.message}</p>}
      {fixResult?.outcome === 'needsPolicyUpdate' && fixResult.policyJson && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-amber)]">
            Your Hyveon deploy policy needs updating. Apply the JSON below via your CloudFormation stack, then click
            Fix again.
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
 * `.then()`/`.finally()` continuations, never synchronously in the effect
 * body — mirroring `settings.page.tsx`'s `engineVersion` effect — so the
 * mount effect satisfies `react-hooks/set-state-in-effect`.
 *
 * @returns the Cloud Health checklist section.
 */
export function CloudHealthSection() {
  const [checks, setChecks] = useState<CloudHealthCheckSummary[] | null>(null);
  const [loading, setLoading] = useState(true);

  /** Fetches the checklist and updates state from the resolved/rejected promise, never synchronously. */
  const fetchChecks = useCallback(() => {
    return api
      .cloudHealthList()
      .then((result) => setChecks(result))
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
      {(checks ?? []).map((check) => (
        <HealthRow key={check.id} check={check} onFixed={refresh} />
      ))}
    </div>
  );
}
