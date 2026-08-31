/**
 * "Storage" step of the add-game wizard (#99): editable `volumes` rows
 * (`name` + `container_path`) plus fully-optional `file_seeds` rows (`path`
 * + `content` + `content_base64` + `mode`).
 *
 * The server requires at least one volume
 * (`gameServerSchema.volumes.min(1)`, see `gameServerValidator.ts`), so the
 * "Remove" button on the last remaining volume row is disabled — unlike
 * `file_seeds`, which are genuinely optional and can be removed down to
 * zero rows.
 *
 * Purely presentational, mirroring the rest of the wizard's "lift state up
 * to the draft" pattern: every add/remove/edit is expressed as a
 * `{ volumes }` or `{ file_seeds }` patch passed to `onChange`. Validation
 * issues are supplied by the caller (typically `validateStorageStep()`) and
 * matched back to the row/field they belong to by exact path —
 * `volumes[0].container_path`, `file_seeds[1].path`, or the array-level
 * `volumes` issue for the min-1 rule.
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import { Textarea } from '@/components/ui/textarea.component';
import { cn } from '@/lib/utils.utils';
import { messageFor, type WizardDraft, type WizardDraftFileSeed, type WizardDraftVolume } from './wizard-form.utils.js';

/** Blank row appended by the "Add volume" button. */
const EMPTY_VOLUME: WizardDraftVolume = { name: '', container_path: '' };

/** Blank row appended by the "Add file seed" button. */
const EMPTY_FILE_SEED: WizardDraftFileSeed = { path: '', content: '', content_base64: '', mode: '' };

/** Props for {@link StorageStep}. */
export interface StorageStepProps {
  /** The wizard's in-progress draft; only `volumes`/`file_seeds` are read here. */
  draft: WizardDraft;
  /** Validation issues for this step (e.g. from `validateStorageStep()`), positioned via `volumes`/`volumes[N].field`/`file_seeds[N].field` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator adds, removes, or edits a row. */
  onChange: (patch: Partial<Pick<WizardDraft, 'volumes' | 'file_seeds'>>) => void;
}

/**
 * Row editor for the wizard's "Storage" step: a `volumes` list (at least one
 * row required, enforced by disabling the last row's remove button) and an
 * optional `file_seeds` list.
 */
export function StorageStep({ draft, issues, onChange }: StorageStepProps) {
  const { volumes, file_seeds: fileSeeds } = draft;

  const volumesArrayError = messageFor(issues, 'volumes');

  function addVolume() {
    onChange({ volumes: [...volumes, { ...EMPTY_VOLUME }] });
  }

  function removeVolume(index: number) {
    if (volumes.length <= 1) return;
    onChange({ volumes: volumes.filter((_, i) => i !== index) });
  }

  function updateVolume(index: number, patch: Partial<WizardDraftVolume>) {
    onChange({ volumes: volumes.map((volume, i) => (i === index ? { ...volume, ...patch } : volume)) });
  }

  function addFileSeed() {
    onChange({ file_seeds: [...fileSeeds, { ...EMPTY_FILE_SEED }] });
  }

  function removeFileSeed(index: number) {
    onChange({ file_seeds: fileSeeds.filter((_, i) => i !== index) });
  }

  function updateFileSeed(index: number, patch: Partial<WizardDraftFileSeed>) {
    onChange({ file_seeds: fileSeeds.map((seed, i) => (i === index ? { ...seed, ...patch } : seed)) });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Volumes</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Every game server needs at least one EFS-backed volume for its save data.
          </p>
        </div>

        {volumesArrayError && (
          <p role="alert" className="text-xs text-[var(--color-red)]">
            {volumesArrayError}
          </p>
        )}

        <div className="space-y-3">
          {volumes.map((volume, index) => (
            <VolumeRow
              key={index}
              index={index}
              volume={volume}
              issues={issues}
              canRemove={volumes.length > 1}
              onUpdate={updateVolume}
              onRemove={removeVolume}
            />
          ))}
        </div>

        <Button type="button" variant="secondary" size="sm" onClick={addVolume}>
          Add volume
        </Button>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">File seeds</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Optional — files written into a volume the first time the server starts.
          </p>
        </div>

        {fileSeeds.length === 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">No file seeds configured.</p>
        )}

        <div className="space-y-3">
          {fileSeeds.map((seed, index) => (
            <FileSeedRow
              key={index}
              index={index}
              seed={seed}
              issues={issues}
              onUpdate={updateFileSeed}
              onRemove={removeFileSeed}
            />
          ))}
        </div>

        <Button type="button" variant="secondary" size="sm" onClick={addFileSeed}>
          Add file seed
        </Button>
      </section>
    </div>
  );
}

/** Props for {@link VolumeRow}. */
interface VolumeRowProps {
  /** Position in the `volumes` array; used for `data-testid`, field ids, and error-path matching. */
  index: number;
  /** This row's current draft value. */
  volume: WizardDraftVolume;
  /** Validation issues for the whole Storage step; filtered here to this row's `volumes[index].*` paths. */
  issues: GameServerValidationIssue[];
  /** Whether the "Remove" button is enabled — `false` when this is the only remaining volume row. */
  canRemove: boolean;
  /** Called with this row's index and a patch whenever a field changes. */
  onUpdate: (index: number, patch: Partial<WizardDraftVolume>) => void;
  /** Called with this row's index when "Remove" is clicked. */
  onRemove: (index: number) => void;
}

/** One `volumes` row: name + container path, with a "Remove" button disabled when it's the only row. */
function VolumeRow({ index, volume, issues, canRemove, onUpdate, onRemove }: VolumeRowProps) {
  const nameError = messageFor(issues, `volumes[${index}].name`);
  const pathError = messageFor(issues, `volumes[${index}].container_path`);

  return (
    <div
      data-testid={`volume-row-${index}`}
      className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3"
    >
      <div className="flex items-end gap-3">
        <FormField id={`volume-name-${index}`} label="Volume name" errors={nameError} className="flex-1">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={volume.name}
              placeholder="data"
              onChange={(event) => onUpdate(index, { name: event.target.value })}
            />
          )}
        </FormField>

        <FormField id={`volume-path-${index}`} label="Container path" errors={pathError} className="flex-1">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={volume.container_path}
              placeholder="/data"
              onChange={(event) => onUpdate(index, { container_path: event.target.value })}
            />
          )}
        </FormField>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canRemove}
          aria-label={canRemove ? `Remove volume ${index + 1}` : `Remove volume ${index + 1} (at least one volume is required)`}
          onClick={() => onRemove(index)}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

/** Props for {@link FileSeedRow}. */
interface FileSeedRowProps {
  /** Position in the `file_seeds` array; used for `data-testid`, field ids, and error-path matching. */
  index: number;
  /** This row's current draft value. */
  seed: WizardDraftFileSeed;
  /** Validation issues for the whole Storage step; filtered here to this row's `file_seeds[index].*` paths. */
  issues: GameServerValidationIssue[];
  /** Called with this row's index and a patch whenever a field changes. */
  onUpdate: (index: number, patch: Partial<WizardDraftFileSeed>) => void;
  /** Called with this row's index when "Remove" is clicked. */
  onRemove: (index: number) => void;
}

/** One `file_seeds` row: path, plain-text content, base64 content, and file mode. */
function FileSeedRow({ index, seed, issues, onUpdate, onRemove }: FileSeedRowProps) {
  const pathError = messageFor(issues, `file_seeds[${index}].path`);
  const contentError = messageFor(issues, `file_seeds[${index}].content`);
  const base64Error = messageFor(issues, `file_seeds[${index}].content_base64`);
  const modeError = messageFor(issues, `file_seeds[${index}].mode`);

  return (
    <div
      data-testid={`file-seed-row-${index}`}
      className={cn(
        'space-y-3 rounded-[var(--radius-sm)] border p-3',
        pathError ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
      )}
    >
      <div className="flex items-end gap-3">
        <FormField id={`file-seed-path-${index}`} label="Path" errors={pathError} className="flex-1">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={seed.path}
              placeholder="/data/config.yml"
              onChange={(event) => onUpdate(index, { path: event.target.value })}
            />
          )}
        </FormField>

        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Remove file seed ${index + 1}`}
          onClick={() => onRemove(index)}
        >
          Remove
        </Button>
      </div>

      <FormField id={`file-seed-content-${index}`} label="Content" errors={contentError}>
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            value={seed.content}
            placeholder="Plain-text file contents"
            rows={3}
            onChange={(event) => onUpdate(index, { content: event.target.value })}
          />
        )}
      </FormField>

      <div className="flex gap-3">
        <FormField id={`file-seed-base64-${index}`} label="Content (base64)" errors={base64Error} className="flex-1">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={seed.content_base64}
              placeholder="Base64-encoded binary contents"
              onChange={(event) => onUpdate(index, { content_base64: event.target.value })}
            />
          )}
        </FormField>

        <FormField id={`file-seed-mode-${index}`} label="Mode" errors={modeError} className="w-28">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={seed.mode}
              placeholder="0644"
              onChange={(event) => onUpdate(index, { mode: event.target.value })}
            />
          )}
        </FormField>
      </div>
    </div>
  );
}
