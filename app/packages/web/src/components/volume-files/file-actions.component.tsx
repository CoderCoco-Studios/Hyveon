import { Download, FilePenLine, FolderPlus, Pencil, Trash2, Upload, FolderUp } from 'lucide-react';
import type { VolumeEntryInfo } from '@hyveon/shared/volumeFiles';
import { isValidEntryName, MAX_TEXT_EDIT_BYTES } from '@hyveon/shared/volumeFiles';
import { Button } from '@/components/ui/button.component';

/** Props for {@link FileToolbar}. */
export interface FileToolbarProps {
  /** Why mutating actions are disabled (shown as their title), or `null` when they are enabled. */
  disabledReason: string | null;
  onNewFolder(): void;
  onUploadFiles(): void;
  onUploadFolder(): void;
}

// @spec HELPER-FB-034
/** Directory-level actions: new folder and the two upload routes. */
export function FileToolbar({ disabledReason, onNewFolder, onUploadFiles, onUploadFolder }: FileToolbarProps) {
  const disabled = disabledReason !== null;
  const title = disabledReason ?? undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={disabled} title={title} onClick={onNewFolder}>
        <FolderPlus />
        New folder
      </Button>
      <Button size="sm" variant="secondary" disabled={disabled} title={title} onClick={onUploadFiles}>
        <Upload />
        Upload files
      </Button>
      <Button size="sm" variant="secondary" disabled={disabled} title={title} onClick={onUploadFolder}>
        <FolderUp />
        Upload folder
      </Button>
    </div>
  );
}

/** Title of the actions disabled for an entry whose name can't be turned into a volume path. */
export const UNHANDLED_NAME_MESSAGE = "This name can't be handled here (it contains a separator or is not a valid file name).";

/** Props for {@link RowActions}. */
export interface RowActionsProps {
  entry: VolumeEntryInfo;
  /** False when the backend cannot stream a folder archive, which hides folder download. */
  supportsArchive: boolean;
  /** Why mutating actions are disabled, or `null`. */
  disabledReason: string | null;
  onDownload(entry: VolumeEntryInfo): void;
  onEdit(entry: VolumeEntryInfo): void;
  onRename(entry: VolumeEntryInfo): void;
  onDelete(entry: VolumeEntryInfo): void;
}

// @spec HELPER-FB-040, HELPER-EDIT-001
/**
 * Per-entry actions. Download and Edit (view) stay available while the server runs; Rename and Delete follow
 * `disabledReason`. Edit appears only for files small enough for the in-app editor. An entry whose name is not a valid
 * entry name (the backend can report one) has every action disabled, since none of them can build its path.
 */
export function RowActions({ entry, supportsArchive, disabledReason, onDownload, onEdit, onRename, onDelete }: RowActionsProps) {
  const invalidName = !isValidEntryName(entry.name);
  const disabled = invalidName || disabledReason !== null;
  const nameTitle = invalidName ? UNHANDLED_NAME_MESSAGE : undefined;
  const title = nameTitle ?? disabledReason ?? undefined;
  return (
    <div className="flex justify-end gap-1">
      {(!entry.isDir || supportsArchive) && (
        <Button size="icon" variant="ghost" aria-label={`Download ${entry.name}`} disabled={invalidName} title={nameTitle} onClick={() => onDownload(entry)}>
          <Download />
        </Button>
      )}
      {!entry.isDir && entry.size <= MAX_TEXT_EDIT_BYTES && (
        <Button size="icon" variant="ghost" aria-label={`Edit ${entry.name}`} disabled={invalidName} title={nameTitle} onClick={() => onEdit(entry)}>
          <FilePenLine />
        </Button>
      )}
      <Button size="icon" variant="ghost" aria-label={`Rename ${entry.name}`} disabled={disabled} title={title} onClick={() => onRename(entry)}>
        <Pencil />
      </Button>
      <Button size="icon" variant="ghost" aria-label={`Delete ${entry.name}`} disabled={disabled} title={title} onClick={() => onDelete(entry)}>
        <Trash2 />
      </Button>
    </div>
  );
}
