/**
 * "Networking" step of the add-game wizard (#99) — a row editor for
 * {@link WizardDraftPort} entries (`container` port + `protocol`). Each row
 * exposes a container-port number input, a protocol select, and a
 * Public/VPC-only visibility select, plus a "Remove" button; a trailing
 * "Add port" button appends a blank row.
 *
 * The component itself holds no state — every edit (add/remove/edit) is
 * expressed as a brand-new `ports` array passed to `onChange`, mirroring the
 * rest of the wizard's "lift state up to the draft" pattern (see
 * `wizard-form.utils.ts`). Validation issues are supplied by the caller
 * (typically `validateNetworkingStep()`); a `ports[N]`-pathed issue
 * highlights only that row, via {@link stepForIssuePath}'s sibling
 * path-indexing scheme (`ports[0]`, `ports[1]`, ...).
 *
 * The step also renders the `https` toggle: enabling it terminates TLS for
 * this game via an in-task Caddy sidecar (see `replace-alb-with-caddy-sidecar`),
 * which is why it lives alongside the ports it constrains — rule 1 of the
 * four HTTPS port rules (`ports` must be non-empty) is pathed at `ports`
 * with no row to anchor to, so it's surfaced next to the toggle instead of
 * inside a port row.
 */

import { AlertTriangle } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { cn } from '@/lib/utils.utils';
import { messageFor, type WizardDraftHealthCheck, type WizardDraftPort } from './wizard-form.utils.js';

/** Protocol options offered in each row's dropdown; `game_servers[].ports[].protocol` is a plain string server-side, but only these two are meaningful for an ECS/Fargate task definition. */
const PROTOCOL_OPTIONS = ['tcp', 'udp'] as const;

/** Blank row appended by the "Add port" button. */
const EMPTY_PORT: WizardDraftPort = { container: null, protocol: 'tcp', visibility: 'public' };

/** `visibility` options offered in each row's dropdown. */
const VISIBILITY_OPTIONS = ['public', 'internal'] as const;

/** `healthCheck.scheme` options. */
const HEALTH_CHECK_SCHEME_OPTIONS = ['http', 'https'] as const;

/** `healthCheck.method` options. */
const HEALTH_CHECK_METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD'] as const;

/** `healthCheck.activeWhen.operator` options. */
const HEALTH_CHECK_OPERATOR_OPTIONS = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'exists'] as const;

/** Props for {@link NetworkingStep}. */
export interface NetworkingStepProps {
  /** Current draft port rows. */
  ports: WizardDraftPort[];
  /** Validation issues for this step (e.g. from `validateNetworkingStep()`), positioned via `ports[N]` / `ports[N].field` paths, or `ports` itself for the no-ports HTTPS rule. */
  issues: GameServerValidationIssue[];
  /** Called with the full replacement `ports` array on every add/remove/edit. */
  onChange: (ports: WizardDraftPort[]) => void;
  /** Current draft value of the `https` flag. */
  https: boolean;
  /** Called with the new value whenever the HTTPS toggle is flipped. */
  onHttpsChange: (https: boolean) => void;
  /** Current draft value of the optional `healthCheck` declaration. */
  healthCheck: WizardDraftHealthCheck;
  /** Called with a partial patch whenever a health-check field changes. */
  onHealthCheckChange: (patch: Partial<WizardDraftHealthCheck>) => void;
}

/**
 * Finds the first issue (if any) that belongs to this row — either a
 * row-level path (`ports[index]`) or a field-level path nested under it
 * (`ports[index].container`, `ports[index].protocol`, ...). Field-level
 * issues are how zod reports e.g. a blank container-port ("Expected number,
 * received null"), so both forms must be matched or the row highlights with
 * no visible message.
 */
function rowError(issues: GameServerValidationIssue[], index: number): GameServerValidationIssue | undefined {
  const prefix = `ports[${index}]`;
  return issues.find((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
}

/**
 * Row editor for the wizard's "Networking" step. Renders one row per port
 * with a container-port input, protocol select, and remove button, plus an
 * "Add port" button that appends {@link EMPTY_PORT}.
 */
export function NetworkingStep({
  ports,
  issues,
  onChange,
  https,
  onHttpsChange,
  healthCheck,
  onHealthCheckChange,
}: NetworkingStepProps) {
  function addRow() {
    onChange([...ports, { ...EMPTY_PORT }]);
  }

  function removeRow(index: number) {
    onChange(ports.filter((_, i) => i !== index));
  }

  function updateRow(index: number, patch: Partial<WizardDraftPort>) {
    onChange(ports.map((port, i) => (i === index ? { ...port, ...patch } : port)));
  }

  // The "at least one port" HTTPS rule has no port row to anchor to, so it's
  // surfaced next to the toggle itself rather than via `rowError`.
  const noPortsIssue = issues.find((issue) => issue.path === 'ports');
  const describedBy =
    [https ? 'https-callout' : null, noPortsIssue ? 'https-error' : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Networking</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Declare every container port the server listens on.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id="https-toggle"
            type="checkbox"
            checked={https}
            aria-invalid={Boolean(noPortsIssue)}
            aria-describedby={describedBy}
            onChange={(event) => onHttpsChange(event.target.checked)}
            className="size-3.5 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
          />
          <Label htmlFor="https-toggle" className="cursor-pointer">
            Enable HTTPS (Caddy sidecar)
          </Label>
        </div>

        {noPortsIssue && (
          <p id="https-error" role="alert" className="text-xs text-[var(--color-red)]">
            {noPortsIssue.message}
          </p>
        )}

        {https && (
          <div
            id="https-callout"
            className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Enabling HTTPS opens ports 443 and 80 to the internet for the whole stack, not only this game. This
              game&apos;s raw container port loses its public ingress rule — reaching the game goes through the
              sidecar instead. On first boot, the task performs a Let&apos;s Encrypt (ACME) issuance, which requires
              this game&apos;s hostname to resolve to the running task.
            </span>
          </div>
        )}
      </div>

      {ports.length === 0 && (
        <p className="text-xs text-[var(--color-muted-foreground)]">No ports configured yet.</p>
      )}

      <div className="space-y-3">
        {ports.map((port, index) => {
          const issue = rowError(issues, index);
          return (
            <div
              key={index}
              data-testid={`port-row-${index}`}
              className={cn(
                'flex flex-wrap items-end gap-3 rounded-[var(--radius-sm)] border p-3',
                issue ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
              )}
            >
              <div className="flex-1">
                <Label htmlFor={`port-container-${index}`}>Container port</Label>
                <Input
                  id={`port-container-${index}`}
                  type="number"
                  value={port.container ?? ''}
                  aria-invalid={Boolean(issue)}
                  aria-describedby={issue ? `port-error-${index}` : undefined}
                  onChange={(event) => {
                    const raw = event.target.value;
                    updateRow(index, { container: raw === '' ? null : Number(raw) });
                  }}
                />
              </div>

              <div className="flex-1">
                <Label htmlFor={`port-protocol-${index}`}>Protocol</Label>
                <select
                  id={`port-protocol-${index}`}
                  value={port.protocol}
                  onChange={(event) => updateRow(index, { protocol: event.target.value })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {PROTOCOL_OPTIONS.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <Label htmlFor={`port-visibility-${index}`}>Visibility</Label>
                <select
                  id={`port-visibility-${index}`}
                  value={port.visibility}
                  onChange={(event) => updateRow(index, { visibility: event.target.value as WizardDraftPort['visibility'] })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {VISIBILITY_OPTIONS.map((visibility) => (
                    <option key={visibility} value={visibility}>
                      {visibility === 'public' ? 'Public' : 'VPC-only'}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove port ${index + 1}`}
                onClick={() => removeRow(index)}
              >
                Remove
              </Button>

              {issue && (
                <p id={`port-error-${index}`} role="alert" className="w-full text-xs text-[var(--color-red)]">
                  {issue.message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={addRow}>
        Add port
      </Button>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Health check</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Judge this server active/idle by an HTTP request instead of network traffic. Leave off to keep the
            default network-traffic heuristic.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="health-check-enabled"
            type="checkbox"
            checked={healthCheck.enabled}
            onChange={(event) => onHealthCheckChange({ enabled: event.target.checked })}
            className="size-3.5 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
          />
          <Label htmlFor="health-check-enabled" className="cursor-pointer">
            Enable authoritative health check
          </Label>
        </div>

        {healthCheck.enabled && (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3">
            <div className="flex flex-wrap gap-3">
              <div className="w-24">
                <Label htmlFor="health-check-scheme">Scheme</Label>
                <select
                  id="health-check-scheme"
                  value={healthCheck.scheme}
                  onChange={(event) => onHealthCheckChange({ scheme: event.target.value })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {HEALTH_CHECK_SCHEME_OPTIONS.map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {scheme}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <Label htmlFor="health-check-port">Port</Label>
                <select
                  id="health-check-port"
                  value={healthCheck.port ?? ''}
                  aria-invalid={Boolean(messageFor(issues, 'healthCheck.port'))}
                  aria-describedby={messageFor(issues, 'healthCheck.port') ? 'health-check-port-error' : undefined}
                  onChange={(event) => onHealthCheckChange({ port: event.target.value === '' ? null : Number(event.target.value) })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  <option value="">Select a declared port…</option>
                  {ports
                    .filter((port) => port.container !== null)
                    .map((port) => (
                      <option key={`${port.container}-${port.protocol}`} value={port.container ?? ''}>
                        {port.container}/{port.protocol}
                      </option>
                    ))}
                </select>
                {messageFor(issues, 'healthCheck.port') && (
                  <p id="health-check-port-error" role="alert" className="text-xs text-[var(--color-red)]">
                    {messageFor(issues, 'healthCheck.port')}
                  </p>
                )}
              </div>

              <div className="w-28">
                <Label htmlFor="health-check-method">Method</Label>
                <select
                  id="health-check-method"
                  value={healthCheck.method}
                  onChange={(event) => onHealthCheckChange({ method: event.target.value })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {HEALTH_CHECK_METHOD_OPTIONS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </div>

              <div className="w-32">
                <Label htmlFor="health-check-timeout">Timeout (ms)</Label>
                <Input
                  id="health-check-timeout"
                  type="number"
                  value={healthCheck.timeoutMs ?? ''}
                  aria-invalid={Boolean(messageFor(issues, 'healthCheck.timeoutMs'))}
                  onChange={(event) => {
                    const raw = event.target.value;
                    onHealthCheckChange({ timeoutMs: raw === '' ? null : Number(raw) });
                  }}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="health-check-path">Request path</Label>
              <Input
                id="health-check-path"
                value={healthCheck.path}
                aria-invalid={Boolean(messageFor(issues, 'healthCheck.path'))}
                aria-describedby={messageFor(issues, 'healthCheck.path') ? 'health-check-path-error' : undefined}
                placeholder="/status"
                onChange={(event) => onHealthCheckChange({ path: event.target.value })}
              />
              {messageFor(issues, 'healthCheck.path') && (
                <p id="health-check-path-error" role="alert" className="text-xs text-[var(--color-red)]">
                  {messageFor(issues, 'healthCheck.path')}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1">
                <Label htmlFor="health-check-json-path">Response JSON path</Label>
                <Input
                  id="health-check-json-path"
                  value={healthCheck.jsonPath}
                  placeholder="players.online"
                  onChange={(event) => onHealthCheckChange({ jsonPath: event.target.value })}
                />
              </div>

              <div className="w-40">
                <Label htmlFor="health-check-operator">Operator</Label>
                <select
                  id="health-check-operator"
                  value={healthCheck.operator}
                  onChange={(event) => onHealthCheckChange({ operator: event.target.value })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {HEALTH_CHECK_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </div>

              {healthCheck.operator !== 'exists' && (
                <div className="flex-1">
                  <Label htmlFor="health-check-value">Comparison value</Label>
                  <Input
                    id="health-check-value"
                    value={healthCheck.value}
                    aria-invalid={Boolean(messageFor(issues, 'healthCheck.activeWhen.value'))}
                    onChange={(event) => onHealthCheckChange({ value: event.target.value })}
                  />
                </div>
              )}
            </div>
            {messageFor(issues, 'healthCheck.activeWhen.value') && (
              <p role="alert" className="text-xs text-[var(--color-red)]">
                {messageFor(issues, 'healthCheck.activeWhen.value')}
              </p>
            )}

            <div>
              <Label htmlFor="health-check-secret">
                Credential (Secrets Manager ARN){healthCheck.secretSet ? ' — a credential is already set' : ''}
              </Label>
              <Input
                id="health-check-secret"
                value={healthCheck.secretArn}
                aria-invalid={Boolean(messageFor(issues, 'healthCheck.auth.secretArn'))}
                placeholder={
                  healthCheck.secretSet ? 'Leave blank to keep the existing credential' : 'arn:aws:secretsmanager:...'
                }
                onChange={(event) => onHealthCheckChange({ secretArn: event.target.value })}
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Injected as the request&apos;s <code>Authorization</code> header. The credential value itself never
                appears here — only whether one is configured.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
