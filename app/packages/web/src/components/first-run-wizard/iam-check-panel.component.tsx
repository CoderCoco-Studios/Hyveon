import { CheckCircle2, AlertTriangle, Loader2, Copy } from 'lucide-react';
import { HYVEON_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';
import type { IamCheckResult } from '@hyveon/desktop-preload';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';

/** Props for {@link IamCheckPanel}. */
export interface IamCheckPanelProps {
  /** Latest IAM dry-run result, or `null` before the first check runs. */
  iamCheck: IamCheckResult | null;
  /** True while the IAM check is in flight. */
  checking: boolean;
  /** Set when the IAM check IPC call itself fails outright. */
  error: string | null;
  /** Runs (or re-runs) the IAM permission dry-run. */
  onRun: () => void;
}

/**
 * IAM permission dry-run panel: a run/re-run button plus one of four mutually exclusive result states — an
 * outright IPC-level `error`, `passed`, `missing` (with the required policy JSON and a clipboard-copy affordance),
 * or `warning` (the simulation itself couldn't run, so the full `HYVEON_DEPLOY_ALL_ACTIONS` checklist is rendered
 * instead).
 *
 * @remarks
 * Extracted out of {@link BootstrapStep} (`bootstrap-step.component.tsx`): this panel shares no state with the
 * resource-provisioning rows above it in that step, and the check never blocks wizard progression — only the
 * bootstrap resources reaching `created`/`exists` does.
 */
export function IamCheckPanel({ iamCheck, checking, error, onRun }: IamCheckPanelProps) {
  return (
    <div className="border-t border-[var(--color-border)] pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">IAM permission check</h3>
        <Button type="button" variant="outline" size="sm" onClick={onRun} disabled={checking}>
          {checking && <Loader2 className="animate-spin" />}
          {iamCheck ? 'Re-check permissions' : 'Check permissions'}
        </Button>
      </div>

      <InlineAlert message={error} />

      {iamCheck?.status === 'passed' && (
        <div className="flex items-center gap-2 text-sm text-[var(--color-green)]">
          <CheckCircle2 className="size-4" />
          All required permissions are present.
        </div>
      )}

      {iamCheck?.status === 'missing' && iamCheck.policyJson && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-[var(--color-amber)]">
            <AlertTriangle className="size-4" />
            Some permissions are missing. Paste the policy below into your IAM user&apos;s inline policy.
          </div>
          <div className="relative">
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 text-xs">
              {iamCheck.policyJson}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() =>
                void navigator.clipboard.writeText(iamCheck.policyJson!).catch(() => {
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

      {iamCheck?.status === 'warning' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-[var(--color-amber)]">
            <AlertTriangle className="size-4" />
            {iamCheck.message ?? 'Could not run the permission simulation.'}
          </div>
          <p className="text-xs text-muted-foreground">
            Ensure your IAM user/role has the following actions (see <code>docs/docs/setup.md</code>&apos;s{' '}
            <code>HyveonDeployAll</code> policy):
          </p>
          <ul className="max-h-48 overflow-auto text-xs font-[var(--font-mono)] text-muted-foreground space-y-0.5">
            {HYVEON_DEPLOY_ALL_ACTIONS.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
