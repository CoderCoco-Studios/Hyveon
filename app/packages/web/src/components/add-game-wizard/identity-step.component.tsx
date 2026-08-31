import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import type { WizardDraft } from './wizard-form.utils.js';

/** Props for {@link IdentityStep}. */
export interface IdentityStepProps {
  /** The wizard's in-progress draft; only `name`/`image`/`connect_message` are read here. */
  draft: WizardDraft;
  /** Validation issues for the whole draft — filtered by `path` to find the message for each field. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator edits a field. */
  onChange: (patch: Partial<Pick<WizardDraft, 'name' | 'image' | 'connect_message'>>) => void;
  /**
   * Renders the Name field as read-only. `name` is the `game_servers` map
   * key — the add wizard lets the operator choose it, but the edit form
   * (#100) reuses this step to edit an already-declared game and must not
   * let the operator rename it in place (that's a delete+recreate, not an
   * update). Defaults to `false` so the add wizard's behaviour is unchanged.
   */
  nameDisabled?: boolean;
}

/**
 * First step of the add-game wizard (#99): the operator names the new
 * `game_servers` entry, points at the container image to run, and optionally
 * writes a `connect_message` shown to Discord users after `/server-start`.
 * Purely presentational — the parent wizard owns the draft state and passes
 * down validation issues computed via `validateIdentityStep` (see wizard-form.utils.ts).
 *
 * Also reused, flattened alongside the other step components, by the edit
 * form (#100) — see the `nameDisabled` prop.
 */
export function IdentityStep({ draft, issues, onChange, nameDisabled = false }: IdentityStepProps) {
  const errorFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  return (
    <div className="space-y-5">
      <FormField id="wizard-identity-name" label="Name" errors={errorFor('name')}>
        {(fieldProps) => (
          <Input
            {...fieldProps}
            value={draft.name}
            placeholder="minecraft"
            disabled={nameDisabled}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
      </FormField>
      <FormField id="wizard-identity-image" label="Image" errors={errorFor('image')}>
        {(fieldProps) => (
          <Input
            {...fieldProps}
            value={draft.image}
            placeholder="itzg/minecraft-server"
            onChange={(e) => onChange({ image: e.target.value })}
          />
        )}
      </FormField>
      <FormField id="wizard-identity-connect-message" label="Connect message" errors={errorFor('connect_message')}>
        {(fieldProps) => (
          <Input
            {...fieldProps}
            value={draft.connect_message}
            placeholder="Connect at {ip}:25565"
            onChange={(e) => onChange({ connect_message: e.target.value })}
          />
        )}
      </FormField>
    </div>
  );
}
