import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errMessage } from '@hyveon/shared';
import type { VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { HelperSessionRegistry, NoSessionError } from './HelperSessionRegistry.js';
import { VolumeFileError } from './VolumeFileBackend.js';
import { describeFailure, isAbort, type OpNames } from './volumeFileErrors.js';

/** Fewest milliseconds between two `running` progress events of one transfer. */
const PROGRESS_INTERVAL_MS = 150;

/** Options for {@link streamToFile}. */
export interface StreamToFileOptions {
  /** Aborts the copy and removes the partial file. */
  signal: AbortSignal;
  /** Called with the size of each chunk written. */
  onBytes: (n: number) => void;
}

/**
 * Copies `source` to `target` through a `.part` file, so `target` only ever holds a complete download.
 *
 * @remarks
 * The part file has a name unique to this call and is created exclusively, so a file the operator already has next
 * to `target` is never truncated or deleted. It is renamed over `target` on success and removed on any failure or
 * abort, leaving an existing `target` untouched until the new bytes are complete.
 *
 * @param source - The bytes to save; destroyed when this settles.
 * @param target - Final local path.
 * @param options - Abort signal and byte counter.
 * @throws The stream or file-system error, or an `AbortError` when `options.signal` aborts.
 */
export async function streamToFile(source: Readable, target: string, options: StreamToFileOptions): Promise<void> {
  const part = `${target}.${randomBytes(6).toString('hex')}.part`;
  const out = createWriteStream(part, { flags: 'wx' });
  let created = false;
  out.once('open', () => {
    created = true;
  });
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      options.onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, out, { signal: options.signal });
    await rename(part, target);
  } catch (err) {
    source.destroy();
    out.destroy();
    if (!out.closed) await new Promise<void>((resolve) => out.once('close', resolve));
    if (created) await rm(part, { force: true });
    throw err;
  }
}

/** Error codes Node's file-system calls fail with. */
const LOCAL_FS_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EISDIR', 'EROFS', 'EBUSY', 'EEXIST', 'ENOTDIR']);

/** System calls only the local file system makes; `read` is excluded because sockets fail with it too. */
const LOCAL_FS_SYSCALLS = new Set(['open', 'write', 'rename', 'close', 'unlink', 'fsync', 'mkdir']);

/** The Node error behind `err`, when it carries a string code. */
const errnoOf = (err: unknown): NodeJS.ErrnoException | null =>
  err instanceof Error && !(err instanceof VolumeFileError) && !isAbort(err) && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? (err as NodeJS.ErrnoException)
    : null;

/** Whether `err` is a local file-system error rather than a connection one. */
const isLocalFsError = (err: unknown): boolean => {
  const errno = errnoOf(err);
  return !!errno && (LOCAL_FS_CODES.has(errno.code ?? '') || LOCAL_FS_SYSCALLS.has(errno.syscall ?? ''));
};

/**
 * The operator message for a transfer that failed: local file-system errors get `localFailure`, other coded Node and
 * undici errors (a dropped or reset connection mid-body) are reported as the file manager being unreachable, and
 * everything else gets the fixed file-manager wording.
 *
 * @param err - What the transfer threw.
 * @param names - What to call the entry in the message.
 * @param localFailure - Message for a failure reading or writing a local file.
 */
export function transferErrorMessage(err: unknown, names: OpNames, localFailure: string): string {
  if (isLocalFsError(err)) return localFailure;
  const dropped = errnoOf(err) ? new VolumeFileError('unreachable', 'transfer connection dropped') : err;
  return describeFailure(dropped, names).message;
}

/** What {@link TransferManager.start} needs to run one transfer. */
export interface TransferSpec {
  game: string;
  kind: VolumeTransferProgress['kind'];
  /** What the transfer is called in the UI. */
  name: string;
  /** `null` when unknown (a folder archive). */
  bytesTotal: number | null;
  /** Base name of the saved local file, reported with the final `done` event of a download. */
  savedAs?: string;
  /** Operator-facing message for a failure that is not a cancellation. */
  describeError: (err: unknown) => string;
  /** Optional message to attach to the `cancelled` event, e.g. cleanup that did not finish. */
  describeCancel?: () => string | undefined;
  /** Called once when the transfer ends, after its work and cleanup, and only for a transfer that {@link TransferManager.start} returned. */
  onSettled?: () => void;
  /** The work. Resolve when finished; honour `signal` and report bytes as they move. */
  run: (context: { signal: AbortSignal; onBytes: (n: number) => void }) => Promise<void>;
}

/** A transfer in flight. */
interface ActiveTransfer {
  game: string;
  controller: AbortController;
}

/**
 * Runs downloads and uploads in the background: keeps the game's file-manager session open for their duration,
 * reports progress, and cancels them on request or when the session is stopping.
 *
 * @remarks
 * A transfer only joins a session that is already running; it never launches a helper. Its hold is released on
 * every exit path before the final event is emitted.
 */
export class TransferManager {
  private readonly active = new Map<string, ActiveTransfer>();
  private readonly listeners = new Set<(progress: VolumeTransferProgress) => void>();

  constructor(private readonly registry: HelperSessionRegistry) {}

  /**
   * Subscribes to progress events.
   *
   * @param listener - Called for every event of every transfer.
   * @returns The unsubscribe function.
   */
  onTransfer(listener: (progress: VolumeTransferProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Checks that `game` has a running session to join, without joining it.
   *
   * @param game - Game whose session to check.
   * @throws {@link NoSessionError} when the session is not running.
   */
  async requireRunning(game: string): Promise<void> {
    const status = await this.registry.status(game).catch(() => null);
    if (status?.state !== 'running') throw new NoSessionError(game);
  }

  /**
   * Holds the game's running session and starts `spec.run` in the background.
   *
   * @param spec - The transfer to run.
   * @returns The transfer id, once the transfer has started.
   * @throws {@link NoSessionError} when the game has no running session to join.
   */
  async start(spec: TransferSpec): Promise<string> {
    await this.requireRunning(spec.game);
    const transferId = randomUUID();
    const holder = `upload:xfer-${transferId}` as const;
    const acquired = await this.registry.acquire(spec.game, holder);
    if (!acquired.ok) throw new NoSessionError(spec.game);
    const controller = new AbortController();
    this.active.set(transferId, { game: spec.game, controller });
    logger.info('VolumeFilesService: transfer started', { game: spec.game, transferId, kind: spec.kind });
    // Deferred so the invoke reply carrying `transferId` is queued before the first progress push.
    setImmediate(() => void this.execute(spec, transferId, holder, controller));
    return transferId;
  }

  /**
   * Cancels one transfer of `game`.
   *
   * @param game - Game the transfer belongs to.
   * @param transferId - Transfer to cancel.
   */
  cancel(game: string, transferId: string): { cancelled: boolean } {
    const transfer = this.active.get(transferId);
    if (transfer?.game !== game) return { cancelled: false };
    transfer.controller.abort();
    return { cancelled: true };
  }

  /**
   * Cancels every transfer of `game`.
   *
   * @param game - Game whose session is stopping.
   */
  abortGame(game: string): void {
    for (const transfer of this.active.values()) {
      if (transfer.game === game) transfer.controller.abort();
    }
  }

  private emit(progress: VolumeTransferProgress): void {
    for (const listener of this.listeners) {
      try {
        listener(progress);
      } catch (err) {
        logger.warn('VolumeFilesService: transfer listener threw', { game: progress.game, transferId: progress.transferId, error: errMessage(err) });
      }
    }
  }

  private async execute(spec: TransferSpec, transferId: string, holder: `upload:${string}`, controller: AbortController): Promise<void> {
    const { signal } = controller;
    let bytesDone = 0;
    let lastEmit = 0;
    const event = (phase: VolumeTransferProgress['phase'], extra: Partial<VolumeTransferProgress> = {}): VolumeTransferProgress => ({
      game: spec.game,
      transferId,
      kind: spec.kind,
      name: spec.name,
      bytesDone,
      bytesTotal: spec.bytesTotal,
      phase,
      ...extra,
    });
    this.emit(event('running'));
    let final: VolumeTransferProgress;
    try {
      // A cancel can land in the gap before this starts.
      signal.throwIfAborted();
      await spec.run({
        signal,
        onBytes: (n) => {
          bytesDone += n;
          const now = Date.now();
          if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
          lastEmit = now;
          this.emit(event('running'));
        },
      });
      final = event('done', spec.savedAs === undefined ? {} : { savedAs: spec.savedAs });
    } catch (err) {
      if (signal.aborted) {
        const note = spec.describeCancel?.();
        final = event('cancelled', note === undefined ? {} : { error: note });
      } else {
        logger.warn('VolumeFilesService: transfer failed', { game: spec.game, transferId, kind: spec.kind, error: errMessage(err) });
        final = event('failed', { error: spec.describeError(err) });
      }
    } finally {
      try {
        this.registry.release(spec.game, holder);
        this.active.delete(transferId);
      } finally {
        spec.onSettled?.();
      }
    }
    logger.info('VolumeFilesService: transfer finished', { game: spec.game, transferId, phase: final.phase });
    this.emit(final);
  }
}
