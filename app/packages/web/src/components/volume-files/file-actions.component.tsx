import { Download, FilePenLine, FolderPlus, Pencil, Trash2, Upload, FolderUp } from 'lucide-react';
import type { VolumeEntryInfo } from '@hyveon/shared/volumeFiles';
import { MAX_TEXT_EDIT_BYTES } from '@hyveon/shared/volumeFiles';
import { Button } from '@/components/ui/button.component';

/** Props for {@link FileToolbar}. */
export interface FileToolbarProps {
  /** Why mutating actions are disabled (shown as their title), or `null` when they are enabled. */
  disabledReason: string | null;
  onNewFolder(): void;
  onUploadFiles(): void;
  onUploadFolder(): void;
}

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

/**
 * Per-entry actions. Download and Edit (view) stay available while the server runs; Rename and Delete follow
 * `disabledReason`. Edit appears only for files small enough for the in-app editor.
 */
export function RowActions({ entry, supportsArchive, disabledReason, onDownload, onEdit, onRename, onDelete }: RowActionsProps) {
  const disabled = disabledReason !== null;
  const title = disabledReason ?? undefined;
  return (
    <div className="flex justify-end gap-1">
      {(!entry.isDir || supportsArchive) && (
        <Button size="icon" variant="ghost" aria-label={`Download ${entry.name}`} onClick={() => onDownload(entry)}>
          <Download />
        </Button>
      )}
      {!entry.isDir && entry.size <= MAX_TEXT_EDIT_BYTES && (
        <Button size="icon" variant="ghost" aria-label={`Edit ${entry.name}`} onClick={() => onEdit(entry)}>
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
