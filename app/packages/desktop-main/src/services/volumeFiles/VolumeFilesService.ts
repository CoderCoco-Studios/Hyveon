import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import type { FolderUploadStartResult } from '@hyveon/shared/folderUpload';
import {
  joinVolumePath,
  MAX_TEXT_EDIT_BYTES,
  normalizeVolumePath,
  parentOfVolumePath,
  type VolumeEntryInfo,
  type VolumeListing,
  type VolumeRef,
  type VolumeResult,
  type VolumeSessionStatus,
  type VolumeTextFile,
  type VolumeTransferProgress,
} from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { ConfigService } from '../ConfigService.js';
import { DeploymentConfigService } from '../DeploymentConfigService.js';
import { EcsService } from '../EcsService.js';
import { FolderScanService } from '../FolderScanService.js';
import { FolderUploadService } from '../FolderUploadService.js';
import { NativeDialogService } from '../NativeDialogService.js';
import { entryAt, FileOps, requireNotRoot } from './fileOps.js';
import { HelperSessionRegistry, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import type { VolumeEntry } from './VolumeFileBackend.js';
import { decodeUtf8, readCapped } from './textFiles.js';
import { TransferOps } from './transferOps.js';
import { fail, ok, TextTooLargeError } from './volumeFileErrors.js';

export { METADATA_OP_TIMEOUT_MS } from './fileOps.js';

const entryInfo = ({ name, isDir, size, modifiedMs }: VolumeEntry): VolumeEntryInfo => ({ name, isDir, size, modifiedMs });

/** Maps a registry snapshot (epoch milliseconds) to the renderer-visible status (ISO strings), field by field. */
function toSessionStatus(s: HelperSessionSnapshot): VolumeSessionStatus {
  return {
    game: s.game,
    state: s.state,
    ...(s.startedAt !== undefined && { startedAt: new Date(s.startedAt).toISOString() }),
    ...(s.autoStopAt !== undefined && { autoStopAt: new Date(s.autoStopAt).toISOString() }),
    browseHeld: s.browseHeld,
    uploadHolders: s.uploadHolders,
    supportsArchive: s.supportsArchive,
    ...(s.error !== undefined && { error: s.error }),
    volumes: s.volumes.map(({ name, containerPath, mounted }) => ({ name, containerPath, mounted })),
  };
}

/**
 * A `failed` session status with no volumes, for lookups that could not produce a real snapshot.
 *
 * @param game - Game the status describes.
 * @param error - Operator-safe reason.
 */
export function failedSessionStatus(game: string, error: string): VolumeSessionStatus {
  return { game, state: 'failed', error, browseHeld: false, uploadHolders: 0, supportsArchive: false, volumes: [] };
}

/**
 * The operator-facing file and session operations behind the `volumeFiles.*` IPC channels.
 *
 * @remarks
 * Every file operation validates its paths and names first, refuses mutations while the game's server may be running
 * or on a legacy fallback layout, and then runs against the shared helper session through
 * {@link HelperSessionRegistry.withBackend}. Failures come back as a {@link VolumeResult} with a fixed operator
 * message; backend messages embed helper mount paths and are only logged. The registry retries an operation once
 * after an operator-IP change, so a mutation whose first attempt landed can then report `conflict` or `not-found`.
 */
@Injectable()
export class VolumeFilesService {
  private readonly ops: FileOps;
  private readonly transfers: TransferOps;

  constructor(
    private readonly registry: HelperSessionRegistry,
    config: ConfigService,
    ecs: EcsService,
    dialogs: NativeDialogService,
    scans: FolderScanService,
    folderUploads: FolderUploadService,
    deploymentConfig: DeploymentConfigService,
  ) {
    this.ops = new FileOps(registry, config, ecs);
    this.transfers = new TransferOps(registry, this.ops, dialogs, scans, folderUploads, deploymentConfig);
    this.registry.onBeforeStop((game) => this.transfers.abortGame(game));
  }

  /**
   * Reads a game's session state; a failed lookup is reported as a `failed` status rather than thrown.
   *
   * @param game - Game whose session to describe.
   */
  async sessionStatus(game: string): Promise<VolumeSessionStatus> {
    try {
      return toSessionStatus(await this.registry.status(game));
    } catch (err) {
      const error = errMessage(err);
      logger.warn('VolumeFilesService: session status unavailable', { game, error });
      return failedSessionStatus(game, error);
    }
  }

  /**
   * Subscribes to session state changes, mapped to the renderer-visible status.
   *
   * @param listener - Called for every state change of every game's session.
   * @returns The unsubscribe function.
   */
  onSession(listener: (status: VolumeSessionStatus) => void): () => void {
    return this.registry.onState((snapshot) => listener(toSessionStatus(snapshot)));
  }

  /**
   * Starts (or joins) the browse session without waiting for the helper to become ready; progress arrives as pushes.
   *
   * @param game - Game to browse.
   * @returns The status right after the request, normally `starting`.
   */
  async sessionStart(game: string): Promise<VolumeSessionStatus> {
    this.acquireInBackground(game);
    return this.sessionStatus(game);
  }

  /**
   * Re-holds the browse session after the page returns, cancelling a pending grace stop.
   *
   * @param game - Game whose session to re-hold.
   */
  async sessionAttach(game: string): Promise<VolumeSessionStatus> {
    this.registry.attach(game);
    return this.sessionStatus(game);
  }

  /**
   * Releases the browse hold; the session stops after the registry's grace period unless something else holds it.
   *
   * @param game - Game whose browse hold to release.
   */
  async sessionDetach(game: string): Promise<VolumeSessionStatus> {
    this.registry.release(game, 'browse');
    return this.sessionStatus(game);
  }

  /**
   * Stops the session now, cancelling anything running on it.
   *
   * @param game - Game whose session to stop.
   */
  async sessionStop(game: string): Promise<VolumeResult<VolumeSessionStatus>> {
    const stopped = await this.registry.stop(game);
    if (!stopped.success) return fail('failed', stopped.message);
    return ok(await this.sessionStatus(game));
  }

  /**
   * Stops the session, then starts a new browse session without waiting for it to become ready.
   *
   * @param game - Game whose session to restart.
   */
  async sessionRestart(game: string): Promise<VolumeResult<VolumeSessionStatus>> {
    const stopped = await this.registry.stop(game);
    if (!stopped.success) return fail('failed', stopped.message);
    this.acquireInBackground(game);
    return ok(await this.sessionStatus(game));
  }

  /**
   * Lists a directory of a volume.
   *
   * @param ref - Game and volume.
   * @param path - Directory path inside the volume.
   */
  list(ref: VolumeRef, path: string): Promise<VolumeResult<VolumeListing>> {
    return this.ops.run(
      ref,
      { mutates: false, path, validate: () => ({ path: normalizeVolumePath(path), names: undefined }) },
      async ({ backend, signal, helperPath }, { path: dir }) => {
        const entries = await backend.list(helperPath(dir), signal);
        return ok({ path: dir, entries: entries.map(entryInfo) });
      },
    );
  }

  /**
   * Creates a folder.
   *
   * @param ref - Game and volume.
   * @param parent - Directory the folder goes in.
   * @param name - New folder name; a single valid path segment.
   * @returns The created entry; `modifiedMs` is 0 when it could not be read back.
   */
  mkdir(ref: VolumeRef, parent: string, name: string): Promise<VolumeResult<VolumeEntryInfo>> {
    return this.ops.run(
      ref,
      { mutates: true, path: parent, validate: () => ({ path: joinVolumePath(parent, name), names: { missing: parent, existing: name } }) },
      async (io, { path }) => {
        await io.backend.mkdir(io.helperPath(path), { signal: io.signal });
        return ok(await entryAt(io, path, { name, isDir: true, size: 0, modifiedMs: 0 }));
      },
    );
  }

  /**
   * Renames an entry within its directory.
   *
   * @param ref - Game and volume.
   * @param path - Entry to rename; not the volume root.
   * @param newName - New entry name; a single valid path segment.
   * @returns The renamed entry; `modifiedMs` is 0 when it could not be read back.
   */
  rename(ref: VolumeRef, path: string, newName: string): Promise<VolumeResult<VolumeEntryInfo>> {
    return this.ops.run(
      ref,
      {
        mutates: true,
        path,
        validate: () => {
          const from = requireNotRoot(path, 'The volume root');
          return { path: from, to: joinVolumePath(parentOfVolumePath(from), newName), names: { missing: from, existing: newName } };
        },
      },
      async (io, { path: from, to }) => {
        const source = await io.backend.stat(io.helperPath(from), io.signal).catch(() => null);
        await io.backend.move(io.helperPath(from), io.helperPath(to), io.signal);
        return ok(await entryAt(io, to, { name: newName, isDir: source?.isDir ?? false, size: 0, modifiedMs: 0 }));
      },
    );
  }

  /**
   * Deletes a file or a folder with its contents.
   *
   * @param ref - Game and volume.
   * @param path - Entry to delete; not the volume root.
   */
  remove(ref: VolumeRef, path: string): Promise<VolumeResult<true>> {
    return this.ops.run(
      ref,
      { mutates: true, path, validate: () => ({ path: requireNotRoot(path, 'The volume root'), names: undefined }) },
      async (io, { path: target }) => {
        await io.backend.remove(io.helperPath(target), io.signal);
        return ok(true as const);
      },
    );
  }

  /**
   * Reads a UTF-8 text file of at most {@link MAX_TEXT_EDIT_BYTES}.
   *
   * @param ref - Game and volume.
   * @param path - File to read.
   * @returns The text and its modification time (0 when unknown), or `too-large` / `binary`.
   */
  readText(ref: VolumeRef, path: string): Promise<VolumeResult<VolumeTextFile>> {
    return this.ops.run(
      ref,
      { mutates: false, path, validate: () => ({ path: normalizeVolumePath(path), names: undefined }) },
      async ({ backend, signal, helperPath }, { path: file }) => {
        const info = await backend.stat(helperPath(file), signal);
        if (info.isDir) return fail('invalid-path', `'${file}' is a folder, not a file.`);
        if (info.size > MAX_TEXT_EDIT_BYTES) return fail('too-large', 'That file is larger than 1 MiB and can\'t be edited here.');
        const bytes = await readCapped(await backend.readStream(helperPath(file), signal), MAX_TEXT_EDIT_BYTES);
        if (!bytes) return fail('too-large', 'That file is larger than 1 MiB and can\'t be edited here.');
        const content = bytes.includes(0) ? null : decodeUtf8(bytes);
        if (content === null) return fail('binary', "That file isn't UTF-8 text and can't be edited here.");
        return ok({ path: file, content, modifiedMs: info.modifiedMs });
      },
    );
  }

  /**
   * Overwrites a text file, but only if it is unchanged since it was read.
   *
   * @param ref - Game and volume.
   * @param path - File to overwrite.
   * @param content - New text; at most {@link MAX_TEXT_EDIT_BYTES} as UTF-8.
   * @param expectedModifiedMs - The modification time the editor read; 0 (unknown) is refused as a conflict.
   * @returns The file's new modification time (0 when it could not be read back).
   */
  writeText(ref: VolumeRef, path: string, content: string, expectedModifiedMs: number): Promise<VolumeResult<{ modifiedMs: number }>> {
    return this.ops.run(
      ref,
      {
        mutates: true,
        path,
        validate: () => {
          const file = requireNotRoot(path, 'The volume root');
          if (Buffer.byteLength(content) > MAX_TEXT_EDIT_BYTES) throw new TextTooLargeError();
          return { path: file, names: undefined };
        },
      },
      async (io, { path: file }) => {
        const info = await io.backend.stat(io.helperPath(file), io.signal);
        if (info.isDir) return fail('invalid-path', `'${file}' is a folder, not a file.`);
        if (info.modifiedMs === 0 || expectedModifiedMs === 0) {
          return fail('conflict', "Couldn't verify the file is unchanged since you opened it.");
        }
        if (info.modifiedMs !== expectedModifiedMs) return fail('conflict', 'The file changed on the volume since you opened it.');
        const bytes = Buffer.from(content, 'utf8');
        await io.backend.writeStream(io.helperPath(file), Readable.from([bytes]), { size: bytes.length, overwrite: true, signal: io.signal });
        const after = await io.backend.stat(io.helperPath(file), io.signal).catch(() => null);
        return ok({ modifiedMs: after?.modifiedMs ?? 0 });
      },
    );
  }

  /**
   * Subscribes to download and upload progress.
   *
   * @param listener - Called for every event of every transfer.
   * @returns The unsubscribe function.
   */
  onTransfer(listener: (progress: VolumeTransferProgress) => void): () => void {
    return this.transfers.onTransfer(listener);
  }

  /**
   * Cancels a running download or upload; the partial local file is removed.
   *
   * @param game - Game the transfer belongs to.
   * @param transferId - Transfer to cancel.
   */
  cancelTransfer(game: string, transferId: string): { cancelled: boolean } {
    return this.transfers.cancel(game, transferId);
  }

  /**
   * Saves a file, or a folder as a zip archive, to a location the operator picks; see {@link TransferOps.download}.
   *
   * @param ref - Game and volume.
   * @param path - File or folder to download.
   * @param isDir - Whether `path` is a folder.
   * @returns The transfer id, or `null` when the dialog was cancelled.
   */
  download(ref: VolumeRef, path: string, isDir: boolean): Promise<VolumeResult<{ transferId: string } | null>> {
    return this.transfers.download(ref, path, isDir);
  }

  /**
   * Uploads local files into a directory of a volume, never overwriting; see {@link TransferOps.uploadFiles}.
   *
   * @param ref - Game and volume.
   * @param dir - Destination directory.
   * @param localPaths - Files dropped by the operator, resolved by the preload; omitted to open the file dialog.
   * @returns The transfer id, or `null` when nothing was chosen.
   */
  uploadFiles(ref: VolumeRef, dir: string, localPaths?: string[]): Promise<VolumeResult<{ transferId: string } | null>> {
    return this.transfers.uploadFiles(ref, dir, localPaths);
  }

  /**
   * Uploads a local folder through the folder-upload flow; see {@link TransferOps.uploadFolder}.
   *
   * @param ref - Game and volume.
   * @param dir - Destination directory.
   * @returns The folder-upload start result, or `null` when the dialog was cancelled.
   */
  uploadFolder(ref: VolumeRef, dir: string): Promise<VolumeResult<FolderUploadStartResult | null>> {
    return this.transfers.uploadFolder(ref, dir);
  }

  /** Fires `acquire` for the browse holder; its outcome reaches the renderer through the registry's state pushes. */
  private acquireInBackground(game: string): void {
    void this.registry
      .acquire(game, 'browse')
      .then((result) => {
        if (!result.ok) logger.warn('VolumeFilesService: browse session did not start', { game, code: result.code });
      })
      .catch((err: unknown) => logger.error('VolumeFilesService: browse session start failed', { game, error: errMessage(err) }));
  }
}
