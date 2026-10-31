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

/** Every IPC request channel this controller handles, so the pattern and its log line cannot drift apart. */
const CH = {
  sessionStatus: 'volumeFiles.session.status',
  sessionStart: 'volumeFiles.session.start',
  sessionAttach: 'volumeFiles.session.attach',
  sessionDetach: 'volumeFiles.session.detach',
  sessionStop: 'volumeFiles.session.stop',
  sessionRestart: 'volumeFiles.session.restart',
  list: 'volumeFiles.list',
  mkdir: 'volumeFiles.mkdir',
  rename: 'volumeFiles.rename',
  remove: 'volumeFiles.delete',
  readText: 'volumeFiles.readText',
  writeText: 'volumeFiles.writeText',
  download: 'volumeFiles.download',
  cancelTransfer: 'volumeFiles.cancelTransfer',
  uploadFiles: 'volumeFiles.uploadFiles',
  uploadFolder: 'volumeFiles.uploadFolder',
} as const;

const asRecord = (payload: unknown): Raw | null => (typeof payload === 'object' && payload !== null ? (payload as Raw) : null);

/** The malformed-payload answer for channels returning a {@link VolumeResult}. */
const invalidRequest = () => fail('invalid-path', INVALID_REQUEST);

/** A request that names a game and a volume; the legacy unnamed volume is the empty string. */
function parseRef(raw: Raw | null): VolumeRef | null {
  return raw && isNonEmptyString(raw['game']) && typeof raw['volume'] === 'string' ? { game: raw['game'], volume: raw['volume'] } : null;
}

/** `raw[key]` for every key when all are non-empty strings, else `null`. */
function nonEmptyStrings<K extends string>(raw: Raw, keys: readonly K[]): Record<K, string> | null {
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = raw[key];
    if (!isNonEmptyString(value)) return null;
    out[key] = value;
  }
  return out;
}

// @spec HELPER-IPC-007
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

/** How a file channel reads its payload: the non-empty string fields it needs, plus any further shape check. */
interface FileSpec<K extends string> {
  /** Non-empty string fields beyond `game` and `volume`; these (and `volume`) are the only fields logged. */
  strings: readonly K[];
  /** Extra shape check for fields that are not non-empty strings. */
  check?: (raw: Raw) => boolean;
}

// @spec HELPER-IPC-001, HELPER-FB-008
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

  // @spec HELPER-IPC-008
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
  @MessagePattern(CH.sessionStatus)
  sessionStatus(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp(CH.sessionStatus, game, (g) => this.files.sessionStatus(g));
  }

  /** Starts (or joins) the browse session without waiting for readiness. */
  @MessagePattern(CH.sessionStart)
  sessionStart(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp(CH.sessionStart, game, (g) => this.files.sessionStart(g));
  }

  /** Re-holds the browse session when the page returns. */
  @MessagePattern(CH.sessionAttach)
  sessionAttach(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp(CH.sessionAttach, game, (g) => this.files.sessionAttach(g));
  }

  /** Releases the browse hold. */
  @MessagePattern(CH.sessionDetach)
  sessionDetach(@Payload() game: unknown): Promise<VolumeSessionStatus> {
    return this.sessionOp(CH.sessionDetach, game, (g) => this.files.sessionDetach(g));
  }

  /** Stops the session now. */
  @MessagePattern(CH.sessionStop)
  sessionStop(@Payload() game: unknown): Promise<VolumeResult<VolumeSessionStatus>> {
    return this.gameOp(CH.sessionStop, game, (g) => this.files.sessionStop(g), invalidRequest);
  }

  /** Stops the session, then starts a new browse session. */
  @MessagePattern(CH.sessionRestart)
  sessionRestart(@Payload() game: unknown): Promise<VolumeResult<VolumeSessionStatus>> {
    return this.gameOp(CH.sessionRestart, game, (g) => this.files.sessionRestart(g), invalidRequest);
  }

  /** Lists a directory of a volume. */
  @MessagePattern(CH.list)
  list(@Payload() payload: unknown): Promise<VolumeResult<VolumeListing>> {
    return this.fileOp(CH.list, payload, { strings: ['path'] }, (ref, { path }) => this.files.list(ref, path));
  }

  /** Creates a folder. */
  @MessagePattern(CH.mkdir)
  mkdir(@Payload() payload: unknown): Promise<VolumeResult<VolumeEntryInfo>> {
    return this.fileOp(CH.mkdir, payload, { strings: ['parent', 'name'] }, (ref, { parent, name }) =>
      this.files.mkdir(ref, parent, name),
    );
  }

  /** Renames an entry within its directory. */
  @MessagePattern(CH.rename)
  rename(@Payload() payload: unknown): Promise<VolumeResult<VolumeEntryInfo>> {
    return this.fileOp(CH.rename, payload, { strings: ['path', 'newName'] }, (ref, { path, newName }) =>
      this.files.rename(ref, path, newName),
    );
  }

  /** Deletes a file or a folder with its contents. */
  @MessagePattern(CH.remove)
  remove(@Payload() payload: unknown): Promise<VolumeResult<true>> {
    return this.fileOp(CH.remove, payload, { strings: ['path'] }, (ref, { path }) => this.files.remove(ref, path));
  }

  /** Reads a UTF-8 text file for the editor. */
  @MessagePattern(CH.readText)
  readText(@Payload() payload: unknown): Promise<VolumeResult<VolumeTextFile>> {
    return this.fileOp(CH.readText, payload, { strings: ['path'] }, (ref, { path }) => this.files.readText(ref, path));
  }

  /** Overwrites a text file if it is unchanged since it was read. */
  @MessagePattern(CH.writeText)
  writeText(@Payload() payload: unknown): Promise<VolumeResult<{ modifiedMs: number }>> {
    const spec = { strings: ['path'], check: (raw: Raw) => typeof raw['content'] === 'string' && Number.isFinite(raw['expectedModifiedMs']) } as const;
    return this.fileOp(CH.writeText, payload, spec, (ref, { path }, raw) =>
      this.files.writeText(ref, path, raw['content'] as string, raw['expectedModifiedMs'] as number),
    );
  }

  /** Saves a file, or a folder as a zip, to a location the operator picks; progress arrives on the push channel. */
  @MessagePattern(CH.download)
  download(@Payload() payload: unknown): Promise<VolumeResult<{ transferId: string } | null>> {
    const spec = { strings: ['path'], check: (raw: Raw) => typeof raw['isDir'] === 'boolean' } as const;
    return this.fileOp(CH.download, payload, spec, (ref, { path }, raw) => this.files.download(ref, path, raw['isDir'] as boolean));
  }

  /** Cancels a running download or upload. */
  @MessagePattern(CH.cancelTransfer)
  cancelTransfer(@Payload() payload: unknown): { cancelled: boolean } {
    logger.debug(`VolumeFilesController: ${CH.cancelTransfer} invoked`, safeFields(payload, ['transferId']));
    const raw = asRecord(payload);
    const ids = raw && nonEmptyStrings(raw, ['game', 'transferId']);
    return ids ? this.files.cancelTransfer(ids.game, ids.transferId) : { cancelled: false };
  }

  /** Uploads local files into a volume directory: the dropped `localPaths`, or a file dialog when they are omitted. */
  @MessagePattern(CH.uploadFiles)
  uploadFiles(@Payload() payload: unknown): Promise<VolumeResult<{ transferId: string } | null>> {
    const spec = {
      strings: ['dir'],
      check: (raw: Raw) => raw['localPaths'] === undefined || (Array.isArray(raw['localPaths']) && raw['localPaths'].every((p) => typeof p === 'string')),
    } as const;
    return this.fileOp(CH.uploadFiles, payload, spec, (ref, { dir }, raw) =>
      this.files.uploadFiles(ref, dir, raw['localPaths'] as string[] | undefined),
    );
  }

  /** Uploads a local folder through the folder-upload flow. */
  @MessagePattern(CH.uploadFolder)
  uploadFolder(@Payload() payload: unknown): Promise<VolumeResult<FolderUploadStartResult | null>> {
    return this.fileOp(CH.uploadFolder, payload, { strings: ['dir'] }, (ref, { dir }) => this.files.uploadFolder(ref, dir));
  }

  // @spec HELPER-IPC-006, HELPER-IPC-007
  /**
   * Logs the invocation (identifiers only), validates a file channel's payload, and runs `run` on a valid one.
   *
   * @param channel - Channel being served.
   * @param payload - Raw renderer payload.
   * @param spec - The string fields the channel requires and any further shape check.
   * @param run - Called with the volume reference, the required string fields and the raw payload.
   */
  private async fileOp<T, K extends string>(
    channel: string,
    payload: unknown,
    spec: FileSpec<K>,
    run: (ref: VolumeRef, strings: Record<K, string>, raw: Raw) => Promise<VolumeResult<T>>,
  ): Promise<VolumeResult<T>> {
    logger.debug(`VolumeFilesController: ${channel} invoked`, safeFields(payload, ['volume', ...spec.strings]));
    const raw = asRecord(payload);
    const ref = parseRef(raw);
    const strings = raw && nonEmptyStrings(raw, spec.strings);
    return raw && ref && strings && (spec.check?.(raw) ?? true) ? run(ref, strings, raw) : invalidRequest();
  }

  /** Runs a bare-game session channel, answering a bad `game` with a failed status. */
  private sessionOp(channel: string, game: unknown, run: (game: string) => Promise<VolumeSessionStatus>): Promise<VolumeSessionStatus> {
    return this.gameOp(channel, game, run, () => failedSessionStatus(typeof game === 'string' ? game : '', INVALID_REQUEST));
  }

  // @spec HELPER-IPC-006
  /** Logs a bare-game channel and runs `run` for a valid game, else answers with `invalid()`. */
  private async gameOp<T>(channel: string, game: unknown, run: (game: string) => Promise<T>, invalid: () => T): Promise<T> {
    logger.debug(`VolumeFilesController: ${channel} invoked`, safeFields({ game }, []));
    return isNonEmptyString(game) ? run(game) : invalid();
  }
}
