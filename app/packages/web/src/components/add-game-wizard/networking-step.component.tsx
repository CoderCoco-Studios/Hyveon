/**
 * "Networking" step of the add-game wizard (#99) — a row editor for
 * {@link WizardDraftPort} entries (`container` port + `protocol`). Each row
 * exposes a container-port number input and a protocol select, plus a
 * "Remove" button; a trailing "Add port" button appends a blank row.
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
import type { WizardDraftPort } from './wizard-form.utils.js';

/** Protocol options offered in each row's dropdown; `game_servers[].ports[].protocol` is a plain string server-side, but only these two are meaningful for an ECS/Fargate task definition. */
const PROTOCOL_OPTIONS = ['tcp', 'udp'] as const;

/** Blank row appended by the "Add port" button. */
const EMPTY_PORT: WizardDraftPort = { container: null, protocol: 'tcp' };

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
export function NetworkingStep({ ports, issues, onChange, https, onHttpsChange }: NetworkingStepProps) {
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
                'space-y-2 rounded-[var(--radius-sm)] border p-3',
                issue ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
              )}
            >
              <div className="flex items-end gap-3">
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

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove port ${index + 1}`}
                  onClick={() => removeRow(index)}
                >
                  Remove
                </Button>
              </div>

              {issue && (
                <p id={`port-error-${index}`} role="alert" className="text-xs text-[var(--color-red)]">
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
    </div>
  );
}
