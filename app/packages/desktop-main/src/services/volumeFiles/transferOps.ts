import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { errMessage } from '@hyveon/shared';
import { validateDestination, type FolderUploadStartResult } from '@hyveon/shared/folderUpload';
import { joinVolumePath, normalizeVolumePath, type VolumeRef, type VolumeResult, type VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { DeploymentConfigService } from '../DeploymentConfigService.js';
import { FolderScanService } from '../FolderScanService.js';
import { FolderUploadService } from '../FolderUploadService.js';
import { NativeDialogService } from '../NativeDialogService.js';
import { METADATA_OP_TIMEOUT_MS, type FileOps } from './fileOps.js';
import { toHelperPath } from './helperVolumeLayout.js';
import { HelperSessionRegistry } from './HelperSessionRegistry.js';
import { statLocalFiles } from './localFiles.js';
import { sanitizeLocalFileName } from './localNames.js';
import { VolumeFileError } from './VolumeFileBackend.js';
import { fail, logRefusal, ok, toVolumeResult, type OpNames } from './volumeFileErrors.js';
import { streamToFile, TransferManager, transferErrorMessage } from './transfers.js';

/** What a download's pre-dialog check learned about its entry. */
interface Probe {
  /** Normalized volume path. */
  clean: string;
  /** Byte size of a file; `null` for a folder archive. */
  size: number | null;
}

/** What an interrupted upload left on the volume: nothing, a file that was removed, or one that could not be. */
type PartialFile = 'none' | 'removed' | 'left';

/** An upload stopped between files because the server may now be running; carries the operator message. */
class UploadStoppedError extends Error {}

/** Operator message for a partial file that could not be removed. */
const partialUploadMessage = (name: string): string => `'${name}' was partially uploaded; delete it before retrying.`;

/**
 * The download and upload operations: the checks that run before any dialog opens, the dialogs, and the hand-off to
 * the background {@link TransferManager}.
 */
export class TransferOps {
  private readonly manager: TransferManager;

  constructor(
    private readonly registry: HelperSessionRegistry,
    private readonly ops: FileOps,
    private readonly dialogs: NativeDialogService,
    private readonly scans: FolderScanService,
    private readonly folderUploads: FolderUploadService,
    private readonly deploymentConfig: DeploymentConfigService,
  ) {
    this.manager = new TransferManager(registry);
  }

  /**
   * Subscribes to progress events of every transfer.
   *
   * @param listener - Called for each event.
   * @returns The unsubscribe function.
   */
  onTransfer(listener: (progress: VolumeTransferProgress) => void): () => void {
    return this.manager.onTransfer(listener);
  }

  /**
   * Cancels one transfer of `game`.
   *
   * @param game - Game the transfer belongs to.
   * @param transferId - Transfer to cancel.
   */
  cancel(game: string, transferId: string): { cancelled: boolean } {
    return this.manager.cancel(game, transferId);
  }

  /**
   * Cancels every transfer of `game`.
   *
   * @param game - Game whose session is stopping.
   */
  abortGame(game: string): void {
    this.manager.abortGame(game);
  }

  /**
   * Saves a file, or a folder as a zip archive, to a location the operator picks.
   *
   * @remarks
   * The entry is checked before the save dialog opens, so a missing file or unsupported archive never costs the
   * operator a dialog. The transfer then runs in the background and reports through {@link VolumeFilesService.onTransfer}.
   * Downloads read only, so they stay allowed while the server runs.
   *
   * @param ref - Game and volume.
   * @param path - File or folder to download.
   * @param isDir - Whether `path` is a folder.
   * @returns The transfer id, or `null` when the dialog was cancelled.
   */
  async download(ref: VolumeRef, path: string, isDir: boolean): Promise<VolumeResult<{ transferId: string } | null>> {
    const probe = await this.ops.run(
      ref,
      { mutates: false, path, validate: () => ({ path: normalizeVolumePath(path), names: undefined }) },
      async ({ backend, signal, helperPath }, { path: clean }): Promise<VolumeResult<Probe>> => {
        if (isDir) {
          return backend.supportsArchive ? ok({ clean, size: null }) : fail('failed', 'Folder download is not supported by this backend.');
        }
        const info = await backend.stat(helperPath(clean), signal);
        return info.isDir ? fail('invalid-path', `'${clean}' is a folder, not a file.`) : ok({ clean, size: info.size });
      },
    );
    if (!probe.ok) return probe;
    const { clean, size } = probe.value;
    const base = clean === '/' ? ref.volume || 'volume' : clean.slice(clean.lastIndexOf('/') + 1);
    const names = { missing: clean, existing: base };
    try {
      const target = await this.dialogs.pickSavePath(sanitizeLocalFileName(isDir ? `${base}.zip` : base, process.platform));
      if (!target) return ok(null);
      const transferId = await this.manager.start({
        game: ref.game,
        kind: 'download',
        name: base,
        bytesTotal: size,
        savedAs: basename(target),
        describeError: (err) => transferErrorMessage(err, names, "Couldn't write to that location."),
        run: async ({ signal, onBytes }) => {
          const source = await this.registry.withBackend(ref.game, (backend, layout) => {
            const helperPath = toHelperPath(layout, ref.volume, clean);
            if (!isDir) return backend.readStream(helperPath, signal);
            if (!backend.archiveStream) throw new VolumeFileError('failed', 'archive is not supported');
            return backend.archiveStream(helperPath, signal);
          });
          await streamToFile(source, target, { signal, onBytes });
        },
      });
      return ok({ transferId });
    } catch (err) {
      return toVolumeResult(err, ref, path, names);
    }
  }

  /**
   * Uploads local files into a directory of a volume, never overwriting.
   *
   * @remarks
   * Everything that can be refused is refused before any byte moves: path validity, a running server, a missing
   * session, local files that are not regular files, and target names that already exist (the whole upload is
   * refused). The transfer then runs in the background. It holds the session before it checks the server for the
   * last time, and checks again before every file, so a server that starts mid-upload (see `games.start`) stops the
   * transfer with a `failed` phase instead of letting writes continue under it.
   *
   * @param ref - Game and volume.
   * @param dir - Destination directory.
   * @param localPaths - Files dropped by the operator, resolved by the preload; omitted to open the file dialog.
   * @returns The transfer id, or `null` when nothing was chosen.
   */
  async uploadFiles(ref: VolumeRef, dir: string, localPaths?: string[]): Promise<VolumeResult<{ transferId: string } | null>> {
    const names: OpNames = { missing: dir, existing: dir };
    try {
      const cleanDir = normalizeVolumePath(dir);
      if (localPaths?.includes('')) return logRefusal(ref, dir, fail('invalid-path', "A dropped item couldn't be read. Use Upload files instead."));
      const refusal = await this.ops.assertWritable(ref.game);
      if (refusal) return logRefusal(ref, dir, refusal);
      await this.manager.requireRunning(ref.game);
      const picked = localPaths ?? (await this.dialogs.pickFiles());
      if (picked.length === 0) return ok(null);
      const local = await statLocalFiles(picked);
      if (!local.ok) return logRefusal(ref, dir, fail('invalid-path', local.message));
      const files = local.files.map((file) => ({ ...file, target: joinVolumePath(cleanDir, file.name) }));
      const duplicate = files.find((file, i) => files.findIndex((other) => other.target === file.target) !== i);
      if (duplicate) return logRefusal(ref, dir, fail('conflict', `'${duplicate.name}' was chosen more than once.`));

      const clear = await this.ops.run(
        ref,
        { mutates: true, path: dir, validate: () => ({ path: cleanDir, names: undefined }) },
        async ({ backend, signal, helperPath }) => {
          for (const file of files) {
            const exists = await backend.stat(helperPath(file.target), signal).then(
              () => true,
              (err: unknown) => {
                if (err instanceof VolumeFileError && err.code === 'not-found') return false;
                throw err;
              },
            );
            if (exists) return fail('conflict', `'${file.name}' already exists.`);
          }
          return ok(true as const);
        },
      );
      if (!clear.ok) return clear;

      let current = files[0]!.name;
      let partial: PartialFile = 'none';
      const transferId = await this.manager.start({
        game: ref.game,
        kind: 'upload',
        name: files.length === 1 ? current : `${files.length} files`,
        bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
        describeError: (err) => {
          if (err instanceof UploadStoppedError) return err.message;
          const message = transferErrorMessage(err, { missing: current, existing: current }, "Couldn't read a local file.");
          if (partial === 'removed') return `${message} The partial file was removed.`;
          return partial === 'left' ? `${message} ${partialUploadMessage(current)}` : message;
        },
        describeCancel: () => (partial === 'left' ? partialUploadMessage(current) : undefined),
        run: async ({ signal, onBytes }) => {
          for (const file of files) {
            current = file.name;
            const refusal = await this.ops.assertWritable(ref.game);
            if (refusal) throw new UploadStoppedError(`Upload stopped. ${refusal.message}`);
            signal.throwIfAborted();
            let counted = 0;
            try {
              await this.registry.withBackend(ref.game, (backend, layout) => {
                // A retry replays the file from its start.
                onBytes(-counted);
                counted = 0;
                return backend.writeStream(toHelperPath(layout, ref.volume, file.target), createReadStream(file.path), {
                  size: file.size,
                  overwrite: false,
                  signal,
                  onBytes: (n) => {
                    counted += n;
                    onBytes(n);
                  },
                });
              });
            } catch (err) {
              partial = await this.removePartial(ref, file.target, err);
              throw err;
            }
          }
        },
      });
      return ok({ transferId });
    } catch (err) {
      return toVolumeResult(err, ref, dir, names);
    }
  }

  /**
   * Uploads a local folder into a directory of a volume through the folder-upload flow, which asks before
   * overwriting and verifies the result.
   *
   * @remarks
   * The run does not touch the folder-upload card's saved selection or its last-run status.
   *
   * @param ref - Game and volume.
   * @param dir - Destination directory.
   * @returns The folder-upload start result (a refused start carries its reason for the page to show), or `null` when
   * the dialog was cancelled.
   */
  async uploadFolder(ref: VolumeRef, dir: string): Promise<VolumeResult<FolderUploadStartResult | null>> {
    try {
      const cleanDir = normalizeVolumePath(dir);
      const refusal = await this.ops.assertWritable(ref.game);
      if (refusal) return logRefusal(ref, dir, refusal);
      const server = (await this.deploymentConfig.getGameServers()).find((g) => g.name === ref.game);
      const volume = server?.volumes.find((v) => v.name === ref.volume);
      if (!server || !volume) return logRefusal(ref, dir, fail('unknown-volume', `'${ref.volume}' is not a volume of '${ref.game}'.`));
      const destination = volume.container_path.replace(/\/+$/, '') + (cleanDir === '/' ? '' : cleanDir) || '/';
      const owner = validateDestination(destination, server.volumes);
      if (!owner.ok || owner.volume.name !== ref.volume) {
        return logRefusal(ref, dir, fail('unknown-volume', `That folder belongs to another volume of '${ref.game}'.`));
      }
      const rootPath = await this.dialogs.pickDirectory();
      if (!rootPath) return ok(null);
      const scan = await this.scans.scan(rootPath).catch((err: unknown) => {
        logger.warn('VolumeFilesService: folder scan failed', { game: ref.game, error: errMessage(err) });
        return null;
      });
      if (!scan) return fail('failed', "Couldn't read that folder.");
      return ok(await this.folderUploads.startUpload({ game: ref.game, scanId: scan.scanId, include: [''], destination }, { persistSelection: false }));
    } catch (err) {
      return toVolumeResult(err, ref, dir, { missing: dir, existing: dir });
    }
  }

  /**
   * Best-effort removal of the file an upload was writing when it failed or was cancelled.
   *
   * @remarks
   * The pre-upload stat proved the target did not exist, so a file there is this upload's truncated body. A
   * `conflict` failure is skipped: the target appeared on its own, or a retried first attempt landed in full.
   *
   * @param ref - Game and volume.
   * @param target - Volume path the upload was writing.
   * @param cause - What the upload threw.
   * @returns Whether a partial file was removed, left behind, or never existed.
   */
  private async removePartial(ref: VolumeRef, target: string, cause: unknown): Promise<PartialFile> {
    if (cause instanceof VolumeFileError && cause.code === 'conflict') return 'none';
    try {
      await this.registry.withBackend(ref.game, (backend, layout) =>
        backend.remove(toHelperPath(layout, ref.volume, target), AbortSignal.timeout(METADATA_OP_TIMEOUT_MS)),
      );
      return 'removed';
    } catch (err) {
      if (err instanceof VolumeFileError && err.code === 'not-found') return 'none';
      logger.warn('VolumeFilesService: could not remove a partial upload', { game: ref.game, volume: ref.volume, path: target, error: errMessage(err) });
      return 'left';
    }
  }
}
