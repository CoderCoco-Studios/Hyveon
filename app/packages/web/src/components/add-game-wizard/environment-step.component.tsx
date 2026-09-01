/**
 * "Environment" step of the add-game wizard: editable `environment` rows
 * (`name` + `value`), positioned between Storage and Review.
 *
 * A fully optional list — unlike `volumes` (min 1), there is no minimum row
 * count and every row's Remove button is always enabled. Purely
 * presentational, mirroring the rest of the wizard's "lift state up to the
 * draft" pattern: every add/remove/edit is expressed as an
 * `{ environment }` patch passed to `onChange`. Validation issues are
 * supplied by the caller (typically `validateEnvironmentStep()`) and
 * matched back to the row/field they belong to by exact path —
 * `environment[0].name`.
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import { messageFor, type WizardDraft, type WizardDraftEnvironmentVariable } from './wizard-form.utils.js';

/** Blank row appended by the "Add variable" button. */
const EMPTY_ENVIRONMENT_VARIABLE: WizardDraftEnvironmentVariable = { name: '', value: '' };

/** Props for {@link EnvironmentStep}. */
export interface EnvironmentStepProps {
  /** The wizard's in-progress draft; only `environment` is read here. */
  draft: WizardDraft;
  /** Validation issues for this step (e.g. from `validateEnvironmentStep()`), positioned via `environment[N].name` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator adds, removes, or edits a row. */
  onChange: (patch: Partial<Pick<WizardDraft, 'environment'>>) => void;
}

/**
 * Row editor for the wizard's "Environment" step: an optional `environment`
 * list, no minimum row count.
 */
export function EnvironmentStep({ draft, issues, onChange }: EnvironmentStepProps) {
  const { environment } = draft;

  function addVariable() {
    onChange({ environment: [...environment, { ...EMPTY_ENVIRONMENT_VARIABLE }] });
  }

  function removeVariable(index: number) {
    onChange({ environment: environment.filter((_, i) => i !== index) });
  }

  function updateVariable(index: number, patch: Partial<WizardDraftEnvironmentVariable>) {
    onChange({
      environment: environment.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)),
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Environment variables</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Optional — environment variables injected into the container (e.g. <code>EULA=TRUE</code>).
        </p>
      </div>

      {environment.length === 0 && (
        <p className="text-xs text-[var(--color-muted-foreground)]">No environment variables configured.</p>
      )}

      <div className="space-y-3">
        {environment.map((variable, index) => {
          const nameError = messageFor(issues, `environment[${index}].name`);

          return (
            <div
              key={index}
              data-testid={`env-row-${index}`}
              className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3"
            >
              <div className="flex items-end gap-3">
                <FormField id={`env-name-${index}`} label="Variable name" errors={nameError} className="flex-1">
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={variable.name}
                      placeholder="EULA"
                      onChange={(event) => updateVariable(index, { name: event.target.value })}
                    />
                  )}
                </FormField>

                <FormField id={`env-value-${index}`} label="Value" className="flex-1">
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={variable.value}
                      placeholder="TRUE"
                      onChange={(event) => updateVariable(index, { value: event.target.value })}
                    />
                  )}
                </FormField>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove environment variable ${index + 1}`}
                  onClick={() => removeVariable(index)}
                >
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={addVariable}>
        Add variable
      </Button>
    </div>
  );
}
