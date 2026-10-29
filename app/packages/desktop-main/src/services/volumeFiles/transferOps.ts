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
import type { FileOps } from './fileOps.js';
import { toHelperPath } from './helperVolumeLayout.js';
import { HelperSessionRegistry } from './HelperSessionRegistry.js';
import { statLocalFiles } from './localFiles.js';
import { sanitizeLocalFileName } from './localNames.js';
import { VolumeFileError } from './VolumeFileBackend.js';
import { fail, ok, toVolumeResult, type OpNames } from './volumeFileErrors.js';
import { streamToFile, TransferManager, transferErrorMessage } from './transfers.js';

/** What a download's pre-dialog check learned about its entry. */
interface Probe {
  /** Normalized volume path. */
  clean: string;
  /** Byte size of a file; `null` for a folder archive. */
  size: number | null;
}

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
   * refused). The transfer then runs in the background.
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
      if (localPaths?.includes('')) return fail('invalid-path', "A dropped item couldn't be read. Use Upload files instead.");
      const refusal = await this.ops.assertWritable(ref.game);
      if (refusal) return refusal;
      await this.manager.requireRunning(ref.game);
      const picked = localPaths ?? (await this.dialogs.pickFiles());
      if (picked.length === 0) return ok(null);
      const local = await statLocalFiles(picked);
      if (!local.ok) return fail('invalid-path', local.message);
      const files = local.files.map((file) => ({ ...file, target: joinVolumePath(cleanDir, file.name) }));
      const duplicate = files.find((file, i) => files.findIndex((other) => other.target === file.target) !== i);
      if (duplicate) return fail('conflict', `'${duplicate.name}' was chosen more than once.`);

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
      const transferId = await this.manager.start({
        game: ref.game,
        kind: 'upload',
        name: files.length === 1 ? current : `${files.length} files`,
        bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
        describeError: (err) => transferErrorMessage(err, { missing: current, existing: current }, "Couldn't read a local file."),
        run: async ({ signal, onBytes }) => {
          for (const file of files) {
            current = file.name;
            let counted = 0;
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
      if (refusal) return refusal;
      const server = (await this.deploymentConfig.getGameServers()).find((g) => g.name === ref.game);
      const volume = server?.volumes.find((v) => v.name === ref.volume);
      if (!server || !volume) return fail('unknown-volume', `'${ref.volume}' is not a volume of '${ref.game}'.`);
      const destination = volume.container_path.replace(/\/+$/, '') + (cleanDir === '/' ? '' : cleanDir);
      const owner = validateDestination(destination, server.volumes);
      if (!owner.ok || owner.volume.name !== ref.volume) {
        return fail('unknown-volume', `That folder belongs to another volume of '${ref.game}'.`);
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
}
