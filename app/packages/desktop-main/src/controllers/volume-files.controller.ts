import { Controller, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { FolderUploadStartResult } from '@hyveon/shared/folderUpload';
import {
  VOLUME_FILES_SESSION_CHANNEL,
  VOLUME_FILES_TRANSFER_CHANNEL,
  type VolumeEntryInfo,
  type VolumeListing,
  type VolumeRef,
  type VolumeResult,
  type VolumeSessionStatus,
  type VolumeTextFile,
} from '@hyveon/shared/volumeFiles';
import { forwardToWindows } from '../ipc-broadcast.js';
import { logger } from '../logger.js';
import { failedSessionStatus, VolumeFilesService } from '../services/volumeFiles/VolumeFilesService.js';
import { fail } from '../services/volumeFiles/volumeFileErrors.js';
import { isNonEmptyString } from './validation.js';

type Raw = Record<string, unknown>;

/** Operator-facing text for every payload that fails shape validation. */
const INVALID_REQUEST = 'Invalid request.';

const asRecord = (payload: unknown): Raw | null => (typeof payload === 'object' && payload !== null ? (payload as Raw) : null);

/** The malformed-payload answer for channels returning a {@link VolumeResult}. */
const invalidRequest = () => fail('invalid-path', INVALID_REQUEST);

/** A request that names a game and a volume; the legacy unnamed volume is the empty string. */
function parseRef(payload: unknown): { ref: VolumeRef; raw: Raw } | null {
  const raw = asRecord(payload);
  if (!raw || !isNonEmptyString(raw['game']) || typeof raw['volume'] !== 'string') return null;
  return { ref: { game: raw['game'], volume: raw['volume'] }, raw };
}

/** The string fields of `payload` named in `keys`; anything else (including content and local paths) is left out. */
function safeFields(payload: unknown, keys: readonly string[]): Raw {
  const raw = asRecord(payload);
  if (!raw) return {};
  const fields: Raw = {};
  for (const key of ['game', ...keys]) {
    if (typeof raw[key] === 'string') fields[key] = raw[key];
  }
  return fields;
}

/**
 * IPC-only controller behind the operator's volume file browser. The helper credential, address and certificate pin
 * never cross this boundary; the renderer sees volume-relative paths and fixed operator messages only.
 *
 * @remarks
 * Payloads arrive from the renderer unchecked, so each handler validates its own shape and answers a malformed one
 * with an `invalid-path` failure (or a failed status) instead of throwing.
 */
@Controller()
export class VolumeFilesController implements OnModuleInit, OnModuleDestroy {
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly files: VolumeFilesService) {}

  /**
   * Forwards session and transfer events to every open window over {@link VOLUME_FILES_SESSION_CHANNEL} and
   * {@link VOLUME_FILES_TRANSFER_CHANNEL}; a no-op outside Electron.
   */
  async onModuleInit(): Promise<void> {
    const subscriptions = await Promise.all([
      forwardToWindows((listener) => this.files.onSession(listener), VOLUME_FILES_SESSION_CHANNEL),
      forwardToWindows((listener) => this.files.onTransfer(listener), VOLUME_FILES_TRANSFER_CHANNEL),
    ]);
    this.unsubscribes = subscriptions.filter((unsubscribe) => unsubscribe !== null);
  }

  /** Stops forwarding events. */
  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
  }

  /** Reads a game's session state. */
  @MessagePattern('volumeFiles.session.status')
  sessionStatus(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp('volumeFiles.session.status', game, (g) => this.files.sessionStatus(g));
  }

  /** Starts (or joins) the browse session without waiting for readiness. */
  @MessagePattern('volumeFiles.session.start')
  sessionStart(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp('volumeFiles.session.start', game, (g) => this.files.sessionStart(g));
  }

  /** Re-holds the browse session when the page returns. */
  @MessagePattern('volumeFiles.session.attach')
  sessionAttach(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp('volumeFiles.session.attach', game, (g) => this.files.sessionAttach(g));
  }

  /** Releases the browse hold. */
  @MessagePattern('volumeFiles.session.detach')
  sessionDetach(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp('volumeFiles.session.detach', game, (g) => this.files.sessionDetach(g));
  }

  /** Stops the session now. */
  @MessagePattern('volumeFiles.session.stop')
  async sessionStop(@Payload() game: unknown): Promise<VolumeResult<VolumeSessionStatus>> {
    logger.debug('VolumeFilesController: volumeFiles.session.stop invoked', safeFields({ game }, []));
    return isNonEmptyString(game) ? this.files.sessionStop(game) : invalidRequest();
  }

  /** Stops the session, then starts a new browse session. */
  @MessagePattern('volumeFiles.session.restart')
  async sessionRestart(@Payload() game: unknown): Promise<VolumeResult<VolumeSessionStatus>> {
    logger.debug('VolumeFilesController: volumeFiles.session.restart invoked', safeFields({ game }, []));
    return isNonEmptyString(game) ? this.files.sessionRestart(game) : invalidRequest();
  }

  /** Lists a directory of a volume. */
  @MessagePattern('volumeFiles.list')
  async list(@Payload() payload: unknown): Promise<VolumeResult<VolumeListing>> {
    logger.debug('VolumeFilesController: volumeFiles.list invoked', safeFields(payload, ['volume', 'path']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    return req && isNonEmptyString(path) ? this.files.list(req.ref, path) : invalidRequest();
  }

  /** Creates a folder. */
  @MessagePattern('volumeFiles.mkdir')
  async mkdir(@Payload() payload: unknown): Promise<VolumeResult<VolumeEntryInfo>> {
    logger.debug('VolumeFilesController: volumeFiles.mkdir invoked', safeFields(payload, ['volume', 'parent', 'name']));
    const req = parseRef(payload);
    const parent = req?.raw['parent'];
    const name = req?.raw['name'];
    return req && isNonEmptyString(parent) && isNonEmptyString(name) ? this.files.mkdir(req.ref, parent, name) : invalidRequest();
  }

  /** Renames an entry within its directory. */
  @MessagePattern('volumeFiles.rename')
  async rename(@Payload() payload: unknown): Promise<VolumeResult<VolumeEntryInfo>> {
    logger.debug('VolumeFilesController: volumeFiles.rename invoked', safeFields(payload, ['volume', 'path', 'newName']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    const newName = req?.raw['newName'];
    return req && isNonEmptyString(path) && isNonEmptyString(newName) ? this.files.rename(req.ref, path, newName) : invalidRequest();
  }

  /** Deletes a file or a folder with its contents. */
  @MessagePattern('volumeFiles.delete')
  async remove(@Payload() payload: unknown): Promise<VolumeResult<true>> {
    logger.debug('VolumeFilesController: volumeFiles.delete invoked', safeFields(payload, ['volume', 'path']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    return req && isNonEmptyString(path) ? this.files.remove(req.ref, path) : invalidRequest();
  }

  /** Reads a UTF-8 text file for the editor. */
  @MessagePattern('volumeFiles.readText')
  async readText(@Payload() payload: unknown): Promise<VolumeResult<VolumeTextFile>> {
    logger.debug('VolumeFilesController: volumeFiles.readText invoked', safeFields(payload, ['volume', 'path']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    return req && isNonEmptyString(path) ? this.files.readText(req.ref, path) : invalidRequest();
  }

  /** Overwrites a text file if it is unchanged since it was read. */
  @MessagePattern('volumeFiles.writeText')
  async writeText(@Payload() payload: unknown): Promise<VolumeResult<{ modifiedMs: number }>> {
    logger.debug('VolumeFilesController: volumeFiles.writeText invoked', safeFields(payload, ['volume', 'path']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    const content = req?.raw['content'];
    const expectedModifiedMs = req?.raw['expectedModifiedMs'];
    return req && isNonEmptyString(path) && typeof content === 'string' && Number.isFinite(expectedModifiedMs)
      ? this.files.writeText(req.ref, path, content, expectedModifiedMs as number)
      : invalidRequest();
  }

  /** Saves a file, or a folder as a zip, to a location the operator picks; progress arrives on the push channel. */
  @MessagePattern('volumeFiles.download')
  async download(@Payload() payload: unknown): Promise<VolumeResult<{ transferId: string } | null>> {
    logger.debug('VolumeFilesController: volumeFiles.download invoked', safeFields(payload, ['volume', 'path']));
    const req = parseRef(payload);
    const path = req?.raw['path'];
    const isDir = req?.raw['isDir'];
    return req && isNonEmptyString(path) && typeof isDir === 'boolean' ? this.files.download(req.ref, path, isDir) : invalidRequest();
  }

  /** Cancels a running download or upload. */
  @MessagePattern('volumeFiles.cancelTransfer')
  cancelTransfer(@Payload() payload: unknown): { cancelled: boolean } {
    logger.debug('VolumeFilesController: volumeFiles.cancelTransfer invoked', safeFields(payload, ['transferId']));
    const raw = asRecord(payload);
    const game = raw?.['game'];
    const transferId = raw?.['transferId'];
    return isNonEmptyString(game) && isNonEmptyString(transferId) ? this.files.cancelTransfer(game, transferId) : { cancelled: false };
  }

  /** Uploads local files into a volume directory: the dropped `localPaths`, or a file dialog when they are omitted. */
  @MessagePattern('volumeFiles.uploadFiles')
  async uploadFiles(@Payload() payload: unknown): Promise<VolumeResult<{ transferId: string } | null>> {
    logger.debug('VolumeFilesController: volumeFiles.uploadFiles invoked', safeFields(payload, ['volume', 'dir']));
    const req = parseRef(payload);
    const dir = req?.raw['dir'];
    const localPaths = req?.raw['localPaths'];
    const validPaths = localPaths === undefined || (Array.isArray(localPaths) && localPaths.every((p) => typeof p === 'string'));
    return req && isNonEmptyString(dir) && validPaths ? this.files.uploadFiles(req.ref, dir, localPaths as string[] | undefined) : invalidRequest();
  }

  /** Uploads a local folder through the folder-upload flow. */
  @MessagePattern('volumeFiles.uploadFolder')
  async uploadFolder(@Payload() payload: unknown): Promise<VolumeResult<FolderUploadStartResult | null>> {
    logger.debug('VolumeFilesController: volumeFiles.uploadFolder invoked', safeFields(payload, ['volume', 'dir']));
    const req = parseRef(payload);
    const dir = req?.raw['dir'];
    return req && isNonEmptyString(dir) ? this.files.uploadFolder(req.ref, dir) : invalidRequest();
  }

  /** Runs a bare-game session channel, answering a bad `game` with a failed status. */
  private async sessionOp(
    channel: string,
    game: unknown,
    run: (game: string) => Promise<VolumeSessionStatus>,
  ): Promise<VolumeSessionStatus> {
    logger.debug(`VolumeFilesController: ${channel} invoked`, safeFields({ game }, []));
    return isNonEmptyString(game) ? run(game) : failedSessionStatus(typeof game === 'string' ? game : '', INVALID_REQUEST);
  }
}
