import { useCallback, useState } from 'react';
import type { VolumeEntryInfo, VolumeFilesErrorCode, VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { joinVolumePath } from '@hyveon/shared/volumeFiles';
import { ConfirmDialog } from '../confirm-dialog.component.js';
import { InlineAlert } from '../inline-alert.component.js';
import { LoadingState } from '../loading-state.component.js';
import { FolderUploadProgressMeter } from '../folder-upload/folder-upload-progress-meter.component.js';
import { useFolderUploadProgress } from '../folder-upload/use-folder-upload-progress.hook.js';
import { DropZone } from './drop-zone.component.js';
import { FileTable } from './file-table.component.js';
import { FileToolbar } from './file-actions.component.js';
import { NameDialog } from './name-dialog.component.js';
import { SERVER_CHECKING_MESSAGE, SERVER_RUNNING_MESSAGE, SERVER_UNCONFIRMED_MESSAGE, ServerBanner } from './server-banner.component.js';
import { TextEditorDialog } from './text-editor-dialog.component.js';
import { TransferList } from './transfer-list.component.js';
import { useServerGuard } from './use-server-guard.hook.js';
import { useVolumeFiles } from './use-volume-files.hook.js';
import { VolumeBreadcrumb } from './volume-breadcrumb.component.js';
import { isSessionLostCode, volumeLabel } from './volume-files.utils.js';

/** Props for {@link VolumeBrowser}. */
export interface VolumeBrowserProps {
  game: string;
  /** Name of the mounted volume to browse. */
  volume: string;
  status: VolumeSessionStatus;
  /** True once the session has left `running`; only an open text editor stays, so unsaved text can be copied out. */
  ended: boolean;
  /** Called when an operation shows the session is gone (`unreachable` / `no-session`), so the page re-reads it. */
  onSessionLost(): void;
}

/** Shown in the editor when the session ended while it was open. */
export const SESSION_ENDED_MESSAGE = 'The file browser session ended. Copy your text out before closing; saving is unavailable.';

/** Why mutations are disabled, keyed by the guard's block (`none` when allowed). */
const BLOCK_REASONS = {
  none: null,
  running: SERVER_RUNNING_MESSAGE,
  unconfirmed: SERVER_UNCONFIRMED_MESSAGE,
  checking: SERVER_CHECKING_MESSAGE,
} as const;

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: VolumeEntryInfo }
  | { kind: 'delete'; entry: VolumeEntryInfo }
  | { kind: 'edit'; entry: VolumeEntryInfo };

/**
 * The browsing surface for one volume of a running session: toolbar, breadcrumb, listing, dialogs and transfers.
 *
 * @remarks
 * Mutations are disabled while the game server runs or its state is unconfirmed (see {@link useServerGuard}).
 * Folder uploads report on the folder-upload channel, so the listing refreshes when that run settles. When the session
 * ends ({@link VolumeBrowserProps.ended}) everything is hidden except an open text editor, which stays mounted with
 * Save disabled so unsaved text is not lost.
 *
 * @param props - See {@link VolumeBrowserProps}.
 */
export function VolumeBrowser({ game, volume, status, ended, onSessionLost }: VolumeBrowserProps) {
  const guard = useServerGuard(game);
  const { noteFailure } = guard;
  const handleFailure = useCallback(
    (code: VolumeFilesErrorCode) => {
      noteFailure(code);
      if (isSessionLostCode(code)) onSessionLost();
    },
    [noteFailure, onSessionLost],
  );
  const files = useVolumeFiles(game, volume, !ended, handleFailure);
  const folderProgress = useFolderUploadProgress(game);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Where the folder upload shown in the meter was started from this page; a run started elsewhere has no origin.
  const [folderOrigin, setFolderOrigin] = useState<{ volume: string; dir: string } | null>(null);

  const disabledReason = ended ? SESSION_ENDED_MESSAGE : BLOCK_REASONS[guard.block ?? 'none'];
  const canResumeFolder = folderOrigin !== null && folderOrigin.volume === volume;
  const { refresh } = files;
  const handleFolderSettled = useCallback(() => void refresh(), [refresh]);

  function startFolderUpload() {
    setFolderOrigin({ volume, dir: files.path });
    void files.uploadFolder();
  }

  // The editor stays at the same tree position in both modes so ending the session does not remount it.
  return (
    <div className={ended ? 'hidden' : 'space-y-4'}>
      {!ended && (
        <>
          {(guard.block === 'running' || guard.block === 'unconfirmed') && <ServerBanner block={guard.block} onRetry={() => void guard.retry()} />}
          <InlineAlert message={files.error} />
          <FileToolbar
            disabledReason={disabledReason}
            onNewFolder={() => setDialog({ kind: 'mkdir' })}
            onUploadFiles={() => void files.uploadFiles()}
            onUploadFolder={startFolderUpload}
          />
          <VolumeBreadcrumb rootLabel={volumeLabel(volume)} path={files.path} onOpen={files.open} />
          <DropZone disabled={disabledReason !== null} onDropFiles={(dropped) => void files.uploadDropped(dropped)}>
            {files.listing === null ? (
              <LoadingState label="Loading files…" />
            ) : (
              <FileTable
                entries={files.listing}
                sort={files.sort}
                onSort={files.setSort}
                supportsArchive={status.supportsArchive}
                disabledReason={disabledReason}
                onOpenFolder={(name) => files.open(joinVolumePath(files.path, name))}
                onDownload={(entry) => void files.download(entry)}
                onEdit={(entry) => setDialog({ kind: 'edit', entry })}
                onRename={(entry) => setDialog({ kind: 'rename', entry })}
                onDelete={(entry) => setDialog({ kind: 'delete', entry })}
              />
            )}
          </DropZone>
          <TransferList game={game} transfers={files.transfers} />
          {folderProgress && (
            <FolderUploadProgressMeter
              game={game}
              progress={folderProgress}
              restartDisabled={disabledReason !== null || !canResumeFolder}
              onRestart={() => folderOrigin && canResumeFolder && void files.uploadFolder(folderOrigin.dir)}
              onSettled={handleFolderSettled}
            />
          )}
          <NameDialog
            open={dialog?.kind === 'mkdir'}
            onOpenChange={(open) => !open && setDialog(null)}
            title="New folder"
            label="Folder name"
            submitLabel="Create"
            submitDisabledReason={disabledReason}
            onSubmit={(name) => void files.mkdir(name)}
          />
          <NameDialog
            open={dialog?.kind === 'rename'}
            onOpenChange={(open) => !open && setDialog(null)}
            title="Rename"
            label="New name"
            submitLabel="Rename"
            submitDisabledReason={disabledReason}
            initialValue={dialog?.kind === 'rename' ? dialog.entry.name : ''}
            onSubmit={(name) => dialog?.kind === 'rename' && void files.rename(joinVolumePath(files.path, dialog.entry.name), name)}
          />
          <ConfirmDialog
            open={dialog?.kind === 'delete'}
            onOpenChange={(open) => !open && setDialog(null)}
            title={dialog?.kind === 'delete' ? (dialog.entry.isDir ? `Delete ${dialog.entry.name} and everything in it?` : `Delete ${dialog.entry.name}?`) : ''}
            description="This can't be undone."
            confirmLabel="Delete"
            confirmDisabledReason={disabledReason ?? undefined}
            onConfirm={() => dialog?.kind === 'delete' && void files.remove(joinVolumePath(files.path, dialog.entry.name))}
          />
        </>
      )}
      <TextEditorDialog
        entry={dialog?.kind === 'edit' ? dialog.entry : null}
        path={dialog?.kind === 'edit' ? joinVolumePath(files.path, dialog.entry.name) : null}
        saveDisabledReason={disabledReason}
        notice={ended ? SESSION_ENDED_MESSAGE : undefined}
        readText={files.readText}
        writeText={files.writeText}
        onDownload={(entry) => void files.download(entry)}
        onSaved={() => void refresh()}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
