/**
 * "Networking" step of the add-game wizard — a row editor for
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
 * which is why it lives alongside the ports it constrains. When HTTPS is on, a
 * dedicated web-port field (the port the game's web server listens on, which
 * Caddy serves on 443) appears above the port list, and the list is relabeled
 * as optional additional ports; a `webPort`-pathed issue is anchored to that
 * field.
 */

import { AlertTriangle } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { NativeSelect } from '@/components/ui/native-select.component';
import { cn } from '@/lib/utils.utils';
import { HealthCheckFields } from './health-check-fields.component.js';
import { messageFor, type WizardDraftHealthCheck, type WizardDraftPort } from './wizard-form.utils.js';

/** Protocol options offered in each row's dropdown; `game_servers[].ports[].protocol` is a plain string server-side, but only these three are meaningful for an ECS/Fargate task definition (`icmp` opens an ICMP ingress rule rather than a TCP/UDP port). */
const PROTOCOL_OPTIONS = ['tcp', 'udp', 'icmp'] as const;

/** Default ICMP type prefilled when a blank row is switched to `icmp` — echo request (ping), the type an operator almost always wants. */
const DEFAULT_ICMP_TYPE = 8;

/** Blank row appended by the "Add port" button. */
const EMPTY_PORT: WizardDraftPort = { container: null, protocol: 'tcp', visibility: 'public' };

/** `visibility` options offered in each row's dropdown. */
const VISIBILITY_OPTIONS = ['public', 'internal'] as const;

/** Props for {@link NetworkingStep}. */
export interface NetworkingStepProps {
  /** Current draft port rows. */
  ports: WizardDraftPort[];
  /** Validation issues for this step (e.g. from `validateNetworkingStep()`), positioned via `ports[N]` / `ports[N].field` paths, or `webPort` for the web-port field. */
  issues: GameServerValidationIssue[];
  /** Called with the full replacement `ports` array on every add/remove/edit. */
  onChange: (ports: WizardDraftPort[]) => void;
  /** Current draft value of the `https` flag. */
  https: boolean;
  /** Called with the new value whenever the HTTPS toggle is flipped. */
  onHttpsChange: (https: boolean) => void;
  /** Current draft value of the web port the game's web server listens on; `null` until entered. Only rendered while `https` is on. */
  webPort: number | null;
  /** Called with the new web port (`null` when cleared) on every edit of the web-port field. */
  onWebPortChange: (webPort: number | null) => void;
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
  webPort,
  onWebPortChange,
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

  const webPortError = messageFor(issues, 'webPort');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Networking</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Declare the container ports the server listens on.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id="https-toggle"
            type="checkbox"
            checked={https}
            aria-describedby={https ? 'https-callout' : undefined}
            onChange={(event) => onHttpsChange(event.target.checked)}
            className="size-3.5 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
          />
          <Label htmlFor="https-toggle" className="cursor-pointer">
            Enable HTTPS (Caddy sidecar)
          </Label>
        </div>

        {https && (
          <div
            id="https-callout"
            className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Enabling HTTPS opens ports 443 and 80 to the internet for the whole stack, not only this game. The
              web port is not directly reachable from outside — reaching it goes through the sidecar on 443.
              Additional ports follow their own visibility. On first boot, the task performs a Let&apos;s Encrypt
              (ACME) issuance, which requires this game&apos;s hostname to resolve to the running task.
            </span>
          </div>
        )}

        {https && (
          <FormField
            id="web-port"
            label="Web port"
            errors={webPortError}
            hint={
              <p className="text-xs text-[var(--color-muted-foreground)]">
                The port your game&apos;s web server listens on (for example 30000). Caddy serves it publicly on 443
                and proxies to this port; 80 and 443 are reserved.
              </p>
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="number"
                value={webPort ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  onWebPortChange(raw === '' ? null : Number(raw));
                }}
              />
            )}
          </FormField>
        )}
      </div>

      {https && (
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-foreground)]">Additional ports (optional)</h4>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Extra ports that are reachable on their own, such as a UDP game or voice port. Each follows its
            visibility setting.
          </p>
        </div>
      )}

      {ports.length === 0 && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {https ? 'No additional ports.' : 'No ports configured yet.'}
        </p>
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
              <FormField
                id={`port-container-${index}`}
                label={port.protocol === 'icmp' ? 'ICMP type' : 'Container port'}
                hint={
                  port.protocol === 'icmp' ? (
                    <p className="text-xs text-[var(--color-muted-foreground)]">8 = echo request (ping)</p>
                  ) : undefined
                }
                className="flex-1"
              >
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    value={port.container ?? ''}
                    aria-invalid={Boolean(issue)}
                    aria-describedby={issue ? `port-error-${index}` : undefined}
                    onChange={(event) => {
                      const raw = event.target.value;
                      updateRow(index, { container: raw === '' ? null : Number(raw) });
                    }}
                  />
                )}
              </FormField>

              <FormField id={`port-protocol-${index}`} label="Protocol" className="flex-1">
                {(fieldProps) => (
                  <NativeSelect
                    {...fieldProps}
                    value={port.protocol}
                    onChange={(event) => {
                      const protocol = event.target.value;
                      // Prefill the ICMP type only for a still-blank row; leave a filled container untouched.
                      updateRow(
                        index,
                        protocol === 'icmp' && port.container === null
                          ? { protocol, container: DEFAULT_ICMP_TYPE }
                          : { protocol },
                      );
                    }}
                  >
                    {PROTOCOL_OPTIONS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {protocol.toUpperCase()}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>

              <FormField id={`port-visibility-${index}`} label="Visibility" className="flex-1">
                {(fieldProps) => (
                  <NativeSelect
                    {...fieldProps}
                    value={port.visibility}
                    onChange={(event) => updateRow(index, { visibility: event.target.value as WizardDraftPort['visibility'] })}
                  >
                    {VISIBILITY_OPTIONS.map((visibility) => (
                      <option key={visibility} value={visibility}>
                        {visibility === 'public' ? 'Public' : 'VPC-only'}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>

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
        {https ? 'Add additional port' : 'Add port'}
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
          <HealthCheckFields healthCheck={healthCheck} ports={ports} webPort={https ? webPort : null} issues={issues} onChange={onHealthCheckChange} />
        )}
      </div>
    </div>
  );
}
