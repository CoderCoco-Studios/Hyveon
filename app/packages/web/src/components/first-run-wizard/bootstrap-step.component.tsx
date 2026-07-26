import { CheckCircle2, XCircle, AlertTriangle, Loader2, Copy } from 'lucide-react';
import { GAME_SERVER_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';
import type { IamCheckResult } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { Input } from '@/components/ui/input.component';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';

/** Human-readable heading for each {@link BootstrapResourceKey}. */
const RESOURCE_LABELS: Record<BootstrapResourceKey, string> = {
  stateBucket: 'Terraform state bucket',
  lockTable: 'Terraform lock table',
  tfvarsBucket: 'Tfvars bucket',
};

/** Props for {@link BootstrapStep}. */
export interface BootstrapStepProps {
  /** Editable resource name, keyed by resource. */
  names: Record<BootstrapResourceKey, string>;
  /** Latest known status per resource. */
  statuses: Record<BootstrapResourceKey, BootstrapResourceState>;
  /** Present when a resource's status is `'failed'`. */
  messages: Partial<Record<BootstrapResourceKey, string>>;
  /** Invoked as the operator edits a resource's name field. */
  onNameChange: (resource: BootstrapResourceKey, name: string) => void;
  /** Runs (or re-runs) all three bootstrap operations. */
  onRunBootstrap: () => void;
  /** True while any bootstrap call is in flight. */
  bootstrapping: boolean;
  /** Latest IAM dry-run result, or `null` before the first check runs. */
  iamCheck: IamCheckResult | null;
  /** True while the IAM check is in flight. */
  iamChecking: boolean;
  /** Set when the IAM check IPC call itself fails outright. */
  iamError: string | null;
  /** Runs (or re-runs) the IAM permission dry-run. */
  onRunIamCheck: () => void;
}

/**
 * Fourth step of the first-run wizard (#208, building on the SDK bootstrap
 * services from #200/#203/#205): provisions the Terraform backend resources
 * (state bucket, lock table, tfvars bucket) via granular per-resource IPC
 * calls, then runs a best-effort IAM permission dry-run against the
 * `GameServerDeployAll` action set. The IAM check never blocks progression —
 * only the three bootstrap resources reaching `created`/`exists` does.
 */
export function BootstrapStep({
  names,
  statuses,
  messages,
  onNameChange,
  onRunBootstrap,
  bootstrapping,
  iamCheck,
  iamChecking,
  iamError,
  onRunIamCheck,
}: BootstrapStepProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Hyveon needs three AWS resources to manage its Terraform state, plus a permission check against your
        account. Resource names are editable — the defaults below are usually fine.
      </p>

      <div className="space-y-4">
        {(Object.keys(RESOURCE_LABELS) as BootstrapResourceKey[]).map((resource) => (
          <ResourceRow
            key={resource}
            resource={resource}
            name={names[resource]}
            status={statuses[resource]}
            message={messages[resource]}
            onNameChange={onNameChange}
            disabled={bootstrapping}
          />
        ))}
      </div>

      <Button type="button" onClick={onRunBootstrap} disabled={bootstrapping}>
        {bootstrapping && <Loader2 className="animate-spin" />}
        {Object.values(statuses).some((s) => s === 'created' || s === 'exists') ? 'Re-run bootstrap' : 'Bootstrap AWS resources'}
      </Button>

      <div className="border-t border-[var(--color-border)] pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">IAM permission check</h3>
          <Button type="button" variant="outline" size="sm" onClick={onRunIamCheck} disabled={iamChecking}>
            {iamChecking && <Loader2 className="animate-spin" />}
            {iamCheck ? 'Re-check permissions' : 'Check permissions'}
          </Button>
        </div>

        {iamError && (
          <p role="alert" className="text-sm text-[var(--color-red)]">
            {iamError}
          </p>
        )}

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
              <code>GameServerDeployAll</code> policy):
            </p>
            <ul className="max-h-48 overflow-auto text-xs font-[var(--font-mono)] text-muted-foreground space-y-0.5">
              {GAME_SERVER_DEPLOY_ALL_ACTIONS.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders one resource's editable name field and status badge. */
function ResourceRow({
  resource,
  name,
  status,
  message,
  onNameChange,
  disabled,
}: {
  resource: BootstrapResourceKey;
  name: string;
  status: BootstrapResourceState;
  message?: string;
  onNameChange: (resource: BootstrapResourceKey, name: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {(status === 'created' || status === 'exists') && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {status === 'creating' && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {status === 'failed' && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium">{RESOURCE_LABELS[resource]}</span>
        <StatusBadge status={status} />
      </div>
      <Input
        value={name}
        onChange={(e) => onNameChange(resource, e.target.value)}
        disabled={disabled || status === 'created' || status === 'exists'}
        aria-label={`${RESOURCE_LABELS[resource]} name`}
      />
      {status === 'failed' && message && <p className="text-xs text-[var(--color-red)]">{message}</p>}
    </div>
  );
}

/** Status badge matching {@link BootstrapResourceState}. */
function StatusBadge({ status }: { status: BootstrapResourceState }) {
  switch (status) {
    case 'created':
      return <Badge variant="success">Created</Badge>;
    case 'exists':
      return <Badge variant="success">Already exists</Badge>;
    case 'creating':
      return <Badge variant="secondary">Creating…</Badge>;
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="outline">Pending</Badge>;
  }
}
