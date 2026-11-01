import { useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { validateDestination, type VolumeLike } from '@hyveon/shared/folderUpload';
import { Button } from '@/components/ui/button.component';
import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import { ErrorBanner } from '../error-banner.component.js';
import { formatBytes } from '../../lib/format.utils.js';
import { FolderIncludeTree } from './folder-include-tree.component.js';
import { summarizeSelection } from './folder-seed.utils.js';
import type { FolderSeedState } from './use-folder-seed.hook.js';

/** Props for {@link FolderSeedSection}. */
export interface FolderSeedSectionProps {
  /** Selection state from {@link useFolderSeed}; owned by the parent so it survives step changes. */
  seed: FolderSeedState;
  /** The game's volumes, used to validate the destination. */
  volumes: VolumeLike[];
  /** Prefix for element ids, so the section can appear twice on one page without clashing. */
  idPrefix?: string;
  /** Locks the controls, e.g. while an upload runs. */
  disabled?: boolean;
  /** Hides the section's own heading when a surrounding card already titles it. */
  hideHeading?: boolean;
}

// @spec HELPER-SELECT-001, HELPER-SELECT-002, HELPER-SELECT-005, HELPER-SAFE-001, HELPER-SAFE-005
/**
 * "Seed from folder" section shared by the add-game wizard's Storage step and the game page: folder picker, include
 * tree, destination field with validation against the game's volumes, and a summary.
 *
 * @remarks
 * Separate from the inline `file_seeds` rows, which it does not touch. Restores the persisted selection on mount.
 *
 * @param props - See {@link FolderSeedSectionProps}.
 */
export function FolderSeedSection({ seed, volumes, idPrefix = 'folder-seed', disabled, hideHeading }: FolderSeedSectionProps) {
  const { scan, include, destination, error, load, pick, setInclude, setDestination } = seed;

  useEffect(() => {
    void load();
  }, [load]);

  const validation = destination ? validateDestination(destination, volumes) : null;
  const destinationError = validation && !validation.ok ? validation.error : undefined;
  const summary = scan ? summarizeSelection(scan.tree, include) : null;

  return (
    <section className="space-y-3" aria-label="Seed from folder">
      <div>
        {!hideHeading && <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Seed from folder</h3>}
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Optional — copy a local folder into a volume after the game is deployed. Nothing is uploaded until you start it.
        </p>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => void pick()}>
          <FolderOpen />
          {scan ? 'Change folder' : 'Choose folder'}
        </Button>
        {scan && (
          <span className="font-[var(--font-mono)] text-xs text-[var(--color-muted-foreground)]">{scan.rootName}</span>
        )}
      </div>

      {scan && (
        <>
          <FolderIncludeTree tree={scan.tree} include={include} onChange={setInclude} disabled={disabled} />

          <FormField
            id={`${idPrefix}-destination`}
            label="Destination in container"
            errors={destinationError}
            hint={
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Must be inside a volume path, e.g. {volumes.map((v) => v.container_path).join(', ') || 'a declared volume'}.
              </p>
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={destination}
                disabled={disabled}
                placeholder="/data"
                onChange={(event) => setDestination(event.target.value)}
              />
            )}
          </FormField>

          {summary && (
            <p className="text-xs text-[var(--color-muted-foreground)]" data-testid={`${idPrefix}-summary`}>
              {summary.files} file{summary.files === 1 ? '' : 's'} selected, {formatBytes(summary.bytes)} of{' '}
              {scan.fileCount} file{scan.fileCount === 1 ? '' : 's'} ({formatBytes(scan.totalBytes)}) in the folder.
              {scan.skippedLinks > 0 &&
                ` ${scan.skippedLinks} symbolic link${scan.skippedLinks === 1 ? '' : 's'} will be skipped.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
