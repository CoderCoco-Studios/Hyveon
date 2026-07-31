import { CheckCircle2, XCircle, AlertTriangle, Loader2, Copy, ShieldCheck } from 'lucide-react';
import { HYVEON_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';
import type { IamCheckResult } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { Input } from '@/components/ui/input.component';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';

/**
 * Human-readable heading for each {@link BootstrapResourceKey} this step
 * renders an editable row for — today, every key on that type.
 *
 * @remarks
 * Until task 10.3, {@link BootstrapResourceKey} also carried a `lockTable`
 * member this step deliberately excluded from its rendered rows (nothing
 * has bootstrapped a DynamoDB lock table since task 5.1 removed
 * `BootstrapService.ensureLockTable` and its `wizard.bootstrap.lockTable`
 * IPC channel, so an editable name field for it would have had zero effect
 * on what gets created — only on a value the now-deleted `terraform-init`
 * step's `backendConfig` separately fed to the also-now-deleted
 * `terraform.init` call). Task 10.3 removed `lockTable` from
 * {@link BootstrapResourceKey} entirely, so this record now covers every key
 * on that type — no `Exclude<...>` narrowing needed any more.
 */
const RESOURCE_LABELS: Record<BootstrapResourceKey, string> = {
  stateBucket: 'Terraform state bucket',
  configurationBucket: 'Configuration bucket',
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
  /** Runs (or re-runs) both bootstrap operations. */
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
 * services from #200/#203/#205): provisions the two backend resources (state
 * bucket, configuration bucket) via granular per-resource IPC calls, then
 * runs a best-effort IAM permission dry-run against the `HyveonDeployAll`
 * action set. The IAM check never blocks progression — only the two
 * bootstrap resources reaching `created`/`exists` does. Both resources are
 * created/hardened independently of one another: a failure on one is
 * reported without affecting the other's outcome.
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
        Hyveon needs two AWS resources to manage its infrastructure state, plus a permission check against your
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
    </div>
  );
}

/**
 * Renders one resource's editable name field, status badge, and — once the
 * resource reaches `created`/`exists` — its public-access-block outcome.
 *
 * @remarks
 * There is no separate PAB status to render: `BootstrapService` applies all
 * four public-access-block settings unconditionally, in the same try/catch
 * as the resource's other configuration calls, so a `created`/`exists`
 * status already implies PAB succeeded, and a PAB failure surfaces exactly
 * like any other configuration failure — `status: 'failed'` with `message`
 * set to the underlying error (see `BootstrapResult`'s TSDoc). The "Public
 * access blocked" line below is therefore just the positive confirmation of
 * that same status, not a distinct piece of state.
 */
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
  const succeeded = status === 'created' || status === 'exists';
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {succeeded && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {status === 'creating' && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {status === 'failed' && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium">{RESOURCE_LABELS[resource]}</span>
        <StatusBadge status={status} />
      </div>
      <Input
        value={name}
        onChange={(e) => onNameChange(resource, e.target.value)}
        disabled={disabled || succeeded}
        aria-label={`${RESOURCE_LABELS[resource]} name`}
      />
      {status === 'failed' && message && <p className="text-xs text-[var(--color-red)]">{message}</p>}
      {succeeded && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3 text-[var(--color-green)]" />
          Public access blocked
        </p>
      )}
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
