import type { ReactNode } from 'react';
import { CheckCircle2, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import type { IamCheckResult } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { Input } from '@/components/ui/input.component';
import { IamCheckPanel } from './iam-check-panel.component.js';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';

/**
 * Human-readable heading for each {@link BootstrapResourceKey} this step
 * renders an editable row for — every key on that type.
 */
const RESOURCE_LABELS: Record<BootstrapResourceKey, string> = {
  stateBucket: 'State bucket',
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
  /**
   * Latest known status of the run-history DynamoDB table (the bootstrap-
   * deadlock fix, `wizard.bootstrap.runsTable`) — rendered as a separate,
   * read-only row (no editable name field, unlike {@link names}'s two
   * entries): its name isn't operator-editable at this point in the wizard,
   * since no `DeploymentConfig` exists yet to hold a `runsTableName`
   * override.
   */
  runsTableStatus: BootstrapResourceState;
  /** Present when {@link runsTableStatus} is `'failed'`. */
  runsTableMessage?: string;
  /**
   * Latest known status of the initial `deployment-config.json` seed (the
   * fresh-install-bricking fix, `wizard.bootstrap.deploymentConfig`) —
   * rendered as a separate, read-only row like {@link runsTableStatus}: it
   * has no editable name field of its own (it's seeded into whichever
   * configuration bucket {@link names}`.configurationBucket` names).
   */
  deploymentConfigStatus: BootstrapResourceState;
  /** Present when {@link deploymentConfigStatus} is `'failed'`. */
  deploymentConfigMessage?: string;
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
  runsTableStatus,
  runsTableMessage,
  deploymentConfigStatus,
  deploymentConfigMessage,
  iamCheck,
  iamChecking,
  iamError,
  onRunIamCheck,
}: BootstrapStepProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Hyveon needs three AWS resources to manage its infrastructure state and run history, plus a permission
        check against your account. The two bucket names are editable — the defaults below are usually fine.
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
        <StatusRow label="Run-history table" status={runsTableStatus} message={runsTableMessage} />
        <StatusRow label="Initial configuration" status={deploymentConfigStatus} message={deploymentConfigMessage} />
      </div>

      <Button type="button" onClick={onRunBootstrap} disabled={bootstrapping}>
        {bootstrapping && <Loader2 className="animate-spin" />}
        {[...Object.values(statuses), runsTableStatus, deploymentConfigStatus].some(
          (s) => s === 'created' || s === 'exists',
        )
          ? 'Re-run bootstrap'
          : 'Bootstrap AWS resources'}
      </Button>

      <IamCheckPanel iamCheck={iamCheck} checking={iamChecking} error={iamError} onRun={onRunIamCheck} />
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
  const label = RESOURCE_LABELS[resource];
  return (
    <StatusRow label={label} status={status} message={message}>
      <Input
        value={name}
        onChange={(e) => onNameChange(resource, e.target.value)}
        disabled={disabled || succeeded}
        aria-label={`${label} name`}
      />
      {succeeded && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3 text-[var(--color-green)]" />
          Public access blocked
        </p>
      )}
    </StatusRow>
  );
}

/**
 * Renders one row's icon/label/{@link StatusBadge} header plus its `'failed'` message — shared by every bootstrap
 * status row in this step.
 *
 * @remarks
 * {@link ResourceRow} is the only row with anything beyond that: an editable name field and, once the resource
 * reaches `created`/`exists`, a public-access-block confirmation — passed here as `children`, rendered after the
 * header and before the (mutually exclusive) failure message. The run-history table and initial-configuration rows
 * have no such extra content — unlike the two S3 buckets, neither has an editable name field at this point in the
 * wizard (no `DeploymentConfig` exists yet to hold a `runsTableName` override, and the config seed has no name of
 * its own — it's seeded into whichever configuration bucket {@link ResourceRow} names) — so they call this directly
 * with no `children`.
 */
function StatusRow({
  label,
  status,
  message,
  children,
}: {
  label: string;
  status: BootstrapResourceState;
  message?: string;
  children?: ReactNode;
}) {
  const succeeded = status === 'created' || status === 'exists';
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {succeeded && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {status === 'creating' && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {status === 'failed' && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium">{label}</span>
        <StatusBadge status={status} />
      </div>
      {children}
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
