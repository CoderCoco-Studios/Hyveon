import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SectionCard } from '@/components/section-card.component';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import type { WizardDraft } from './wizard-form.utils.js';

/** Props for {@link ReviewStep}. */
export interface ReviewStepProps {
  /** The fully-assembled wizard draft to summarize before submit. */
  draft: WizardDraft;
  /**
   * Every outstanding validation issue across the whole draft (i.e.
   * `validateStep('review', draft, existingGames)`), rendered so a disabled
   * Submit button has a visible reason instead of a silent dead-end — e.g. a
   * business rule (HTTPS port constraints, Fargate cpu/memory pairing) that
   * only became violated on an earlier step but wasn't caught there because
   * the draft was still structurally incomplete at the time.
   */
  issues?: GameServerValidationIssue[];
  /** Server-side error message from a failed submit attempt (e.g. a name collision), surfaced above the summary so the operator can fix and retry without losing the draft. Submit/navigation controls themselves live in the wizard shell's footer, not here. */
  submitError?: string | null;
}

/** One label/value pair in a summary section. */
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-[var(--color-muted-foreground)]">{label}</span>
      <span className="font-[var(--font-mono)] text-right text-[var(--color-foreground)] break-all">{value}</span>
    </div>
  );
}

/**
 * Final step of the add-game wizard (#99): renders a read-only summary of
 * every field entered across the Identity, Resources, Networking, Storage,
 * and Environment steps. Optional fields that were left blank — `connect_message`,
 * `file_seeds`, and `environment` — are omitted entirely rather than shown with a
 * placeholder, so the summary only surfaces what the operator actually
 * configured. Outstanding validation `issues` (every issue across the whole
 * draft, not just Review's own) are listed as an alert so a disabled Submit
 * button always has a visible reason — some business rules only become
 * violated once every step is filled in, so their first (and, on some
 * paths, only) visible surface is here. A `submitError` from a failed submit
 * attempt (surfaced by the wizard container after `POST /api/games` fails)
 * is rendered as a second alert below it so the draft isn't lost. This
 * component is purely presentational — Submit/navigation controls are owned
 * exclusively by the wizard shell's footer, not by this step.
 */
export function ReviewStep({ draft, issues = [], submitError = null }: ReviewStepProps) {
  const hasConnectMessage = draft.connect_message.trim().length > 0;
  const hasFileSeeds = draft.file_seeds.length > 0;
  const hasEnvironment = draft.environment.length > 0;

  return (
    <div className="space-y-4">
      <SectionCard title="Identity">
        <div className="space-y-1">
          <SummaryRow label="Name" value={draft.name || '—'} />
          <SummaryRow label="Image" value={draft.image || '—'} />
          {hasConnectMessage && <SummaryRow label="Connect message" value={draft.connect_message} />}
        </div>
      </SectionCard>

      <SectionCard title="Resources">
        <div className="space-y-1">
          <SummaryRow label="CPU" value={draft.cpu ?? '—'} />
          <SummaryRow label="Memory" value={draft.memory ?? '—'} />
        </div>
      </SectionCard>

      <SectionCard title="Networking">
        <div className="space-y-3">
          <SummaryRow label="HTTPS" value={draft.https ? 'Enabled' : 'Disabled'} />
          {draft.ports.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No ports configured.</p>
          ) : (
            <ul className="space-y-1">
              {draft.ports.map((port, index) => (
                <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-[var(--font-mono)]">{port.container ?? '—'}</span>
                    <span className="uppercase text-[var(--color-muted-foreground)]">{port.protocol}</span>
                  </span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {port.visibility === 'internal' ? 'VPC-only' : 'Public'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {draft.healthCheck.enabled ? (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
                Health check
              </h4>
              <SummaryRow
                label="Request"
                value={`${draft.healthCheck.method} ${draft.healthCheck.scheme}://…:${draft.healthCheck.port ?? '—'}${draft.healthCheck.path}`}
              />
              <SummaryRow
                label="Condition"
                value={`${draft.healthCheck.jsonPath} ${draft.healthCheck.operator}${draft.healthCheck.operator === 'exists' ? '' : ` ${draft.healthCheck.value}`}`}
              />
              <SummaryRow
                label="Credential"
                value={draft.healthCheck.secretSet || draft.healthCheck.secretArn.trim().length > 0 ? 'Set' : 'Not set'}
              />
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No health check — idle detection uses network traffic.
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Storage">
        <div className="space-y-3">
          {draft.volumes.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No volumes configured.</p>
          ) : (
            <ul className="space-y-1">
              {draft.volumes.map((volume, index) => (
                <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                  <span>{volume.name}</span>
                  <span className="font-[var(--font-mono)] text-[var(--color-muted-foreground)]">
                    {volume.container_path}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {hasFileSeeds && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
                File seeds
              </h4>
              <ul className="space-y-1">
                {draft.file_seeds.map((seed, index) => (
                  <li key={index} className="font-[var(--font-mono)] text-sm">
                    {seed.path}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasEnvironment && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
                Environment variables
              </h4>
              <ul className="space-y-1">
                {draft.environment.map((variable, index) => (
                  <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                    <span>{variable.name}</span>
                    <span className="font-[var(--font-mono)] text-[var(--color-muted-foreground)]">
                      {variable.value}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SectionCard>

      {issues.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">Fix the following before submitting:</p>
            <ul className="list-disc pl-4">
              {issues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {submitError}
        </div>
      )}
    </div>
  );
}
