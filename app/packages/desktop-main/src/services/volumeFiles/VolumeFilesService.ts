import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import {
  joinVolumePath,
  MAX_TEXT_EDIT_BYTES,
  normalizeVolumePath,
  parentOfVolumePath,
  VolumePathError,
  type VolumeEntryInfo,
  type VolumeFilesErrorCode,
  type VolumeListing,
  type VolumeRef,
  type VolumeResult,
  type VolumeSessionStatus,
  type VolumeTextFile,
} from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { ConfigService } from '../ConfigService.js';
import { EcsService } from '../EcsService.js';
import { isVolumeMounted, toHelperPath, type HelperVolumeLayout } from './helperVolumeLayout.js';
import { HelperSessionRegistry, NoSessionError, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import { VolumeFileError, type VolumeEntry, type VolumeFileBackend } from './VolumeFileBackend.js';

/** How long one metadata operation (list, stat, mkdir, move, remove, small text read or write) may take. */
export const METADATA_OP_TIMEOUT_MS = 30_000;

type VolumeFailure = Extract<VolumeResult<never>, { ok: false }>;

const ok = <T>(value: T): VolumeResult<T> => ({ ok: true, value });
const fail = (code: VolumeFilesErrorCode, message: string): VolumeFailure => ({ ok: false, code, message });

/** Fixed operator messages for session-level backend failures that name no path. */
const OPERATOR_MESSAGES: Record<Exclude<VolumeFileError['code'], 'not-found' | 'conflict' | 'failed'>, string> = {
  unreachable: "The file manager isn't reachable. Restart the session.",
  auth: 'The file manager rejected the session. Restart the session.',
  'pin-mismatch': "The file manager's identity couldn't be verified. Restart the session.",
};

/** Raised by validation when text to save exceeds the editor limit; mapped to `too-large`. */
class TextTooLargeError extends Error {}

/** What the operator called things in a request: used to word failures without echoing backend messages. */
interface OpNames {
  /** Volume path that may turn out to be missing. */
  missing: string;
  /** Entry name that may turn out to exist already. */
  existing: string;
}

/** The pieces of an open session a file operation works with. */
interface FileIo {
  backend: VolumeFileBackend;
  /** Aborts the operation after {@link METADATA_OP_TIMEOUT_MS}; created per attempt. */
  signal: AbortSignal;
  /** Maps a clean volume path to the helper's path for this request's volume. */
  helperPath: (volumePath: string) => string;
}

const entryInfo = ({ name, isDir, size, modifiedMs }: VolumeEntry): VolumeEntryInfo => ({ name, isDir, size, modifiedMs });

/** Whether `err` is an aborted or timed-out request. */
const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Whether `err` is an aborted request, raw or wrapped by the client as `unreachable` with the abort as its cause. */
const isAbortOrWrapped = (err: unknown): boolean =>
  isAbort(err) || (err instanceof VolumeFileError && err.code === 'unreachable' && isAbort(err.cause));

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

/** Reads `stream` fully unless it exceeds `limit` bytes; the stream is destroyed either way. */
async function readCapped(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > limit) return null;
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
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
  constructor(
    private readonly registry: HelperSessionRegistry,
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
  ) {}

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
      return { game, state: 'failed', error, browseHeld: false, uploadHolders: 0, supportsArchive: false, volumes: [] };
    }
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
    return this.runFileOp(
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
    return this.runFileOp(
      ref,
      { mutates: true, path: parent, validate: () => ({ path: joinVolumePath(parent, name), names: { missing: parent, existing: name } }) },
      async (io, { path }) => {
        await io.backend.mkdir(io.helperPath(path), { signal: io.signal });
        return ok(await this.entryAt(io, path, { name, isDir: true, size: 0, modifiedMs: 0 }));
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
    return this.runFileOp(
      ref,
      {
        mutates: true,
        path,
        validate: () => {
          const from = this.requireNotRoot(path, 'The volume root');
          return { path: from, to: joinVolumePath(parentOfVolumePath(from), newName), names: { missing: from, existing: newName } };
        },
      },
      async (io, { path: from, to }) => {
        const source = await io.backend.stat(io.helperPath(from), io.signal).catch(() => null);
        await io.backend.move(io.helperPath(from), io.helperPath(to), io.signal);
        return ok(await this.entryAt(io, to, { name: newName, isDir: source?.isDir ?? false, size: 0, modifiedMs: 0 }));
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
    return this.runFileOp(
      ref,
      { mutates: true, path, validate: () => ({ path: this.requireNotRoot(path, 'The volume root'), names: undefined }) },
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
    return this.runFileOp(
      ref,
      { mutates: false, path, validate: () => ({ path: normalizeVolumePath(path), names: undefined }) },
      async ({ backend, signal, helperPath }, { path: file }) => {
        const info = await backend.stat(helperPath(file), signal);
        if (info.isDir) return fail('invalid-path', `'${file}' is a folder, not a file.`);
        if (info.size > MAX_TEXT_EDIT_BYTES) return fail('too-large', 'That file is larger than 1 MiB and can\'t be edited here.');
        const bytes = await readCapped(await backend.readStream(helperPath(file), signal), MAX_TEXT_EDIT_BYTES);
        if (!bytes) return fail('too-large', 'That file is larger than 1 MiB and can\'t be edited here.');
        const content = bytes.includes(0) ? null : this.decodeUtf8(bytes);
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
    return this.runFileOp(
      ref,
      {
        mutates: true,
        path,
        validate: () => {
          const file = this.requireNotRoot(path, 'The volume root');
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

  /** Fires `acquire` for the browse holder; its outcome reaches the renderer through the registry's state pushes. */
  private acquireInBackground(game: string): void {
    void this.registry
      .acquire(game, 'browse')
      .then((result) => {
        if (!result.ok) logger.warn('VolumeFilesService: browse session did not start', { game, code: result.code });
      })
      .catch((err: unknown) => logger.error('VolumeFilesService: browse session start failed', { game, error: errMessage(err) }));
  }

  /**
   * The shared shape of every file operation: validate, check the server, run inside the session, map failures.
   *
   * @param ref - Game and volume.
   * @param spec - Whether it mutates, the raw path (for logs), and a validator that throws {@link VolumePathError}.
   * @param run - The work, given the session and the validated parameters; may return a modeled refusal.
   */
  private async runFileOp<P extends { names: OpNames | undefined }, T>(
    ref: VolumeRef,
    spec: { mutates: boolean; path: string; validate: () => P },
    run: (io: FileIo, params: P) => Promise<VolumeResult<T>>,
  ): Promise<VolumeResult<T>> {
    let names: OpNames = { missing: spec.path, existing: spec.path };
    try {
      const params = spec.validate();
      names = params.names ?? { missing: spec.path, existing: spec.path };
      if (spec.mutates) {
        const refusal = await this.assertWritable(ref.game);
        if (refusal) return refusal;
      }
      return await this.registry.withBackend(ref.game, async (backend, layout) => {
        const refusal = this.checkVolume(ref, layout, spec.mutates);
        if (refusal) return refusal;
        const io: FileIo = {
          backend,
          signal: AbortSignal.timeout(METADATA_OP_TIMEOUT_MS),
          helperPath: (volumePath) => toHelperPath(layout, ref.volume, volumePath),
        };
        return run(io, params);
      });
    } catch (err) {
      return this.toVolumeResult(err, ref, spec.path, names);
    }
  }

  /** Refuses a volume the session did not mount, and mutations of a legacy fallback layout. */
  private checkVolume(ref: VolumeRef, layout: HelperVolumeLayout, mutates: boolean): VolumeFailure | null {
    if (!isVolumeMounted(layout, ref.volume)) {
      const unapplied = layout.unmounted.some((u) => u.volume === ref.volume);
      return fail(
        'unknown-volume',
        unapplied ? `Apply the infrastructure to browse '${ref.volume}'.` : `'${ref.volume}' is not a volume of '${ref.game}'.`,
      );
    }
    if (mutates && layout.usedFallback) return fail('apply-needed', 'Apply the infrastructure to change files in this volume.');
    return null;
  }

  /**
   * Refuses a change while the game's server task exists or its state can't be confirmed (fail closed).
   *
   * @param game - Game whose server must be stopped.
   * @returns A refusal, or `null` when the server is confirmed stopped.
   */
  private async assertWritable(game: string): Promise<VolumeFailure | null> {
    try {
      const outputs = await this.config.getStackOutputs();
      if (!outputs) throw new Error('The infrastructure outputs are not available.');
      const task = await this.ecs.findRunningTaskOrThrow(outputs.ecsClusterName, game);
      return task ? fail('server-running', `'${game}' is running. Stop the server to change files.`) : null;
    } catch (err) {
      logger.warn('VolumeFilesService: server state unconfirmed, refusing change', { game, error: errMessage(err) });
      return fail('server-check-failed', "Couldn't confirm the server is stopped.");
    }
  }

  /** Normalizes `path` and rejects the volume root, which no operation may remove or rename. */
  private requireNotRoot(path: string, what: string): string {
    const clean = normalizeVolumePath(path);
    if (clean === '/') throw new VolumePathError(`${what} can't be changed.`);
    return clean;
  }

  /** Stats a path just written; `fallback` stands in (modification time 0 = unknown) when the stat fails. */
  private async entryAt(io: FileIo, volumePath: string, fallback: VolumeEntryInfo): Promise<VolumeEntryInfo> {
    try {
      const { isDir, size, modifiedMs } = await io.backend.stat(io.helperPath(volumePath), io.signal);
      return { name: fallback.name, isDir, size, modifiedMs };
    } catch {
      return fallback;
    }
  }

  /** Decodes strict UTF-8; `null` when the bytes are not valid. */
  private decodeUtf8(bytes: Buffer): string | null {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  /**
   * Maps a thrown error to a modeled failure and logs it with identifiers only.
   *
   * @remarks
   * Backend messages embed helper mount paths, so the operator message is built from `names` instead; the original
   * message is logged.
   */
  private toVolumeResult(err: unknown, ref: VolumeRef, path: string, names: OpNames): VolumeFailure {
    const failure = this.describe(err, names);
    const log = { game: ref.game, volume: ref.volume, path, code: failure.code, error: errMessage(err) };
    if (failure.code === 'failed') logger.error('VolumeFilesService: file operation failed', log);
    else logger.warn('VolumeFilesService: file operation refused', log);
    return failure;
  }

  /** The code and fixed operator message for `err`. */
  private describe(err: unknown, names: OpNames): VolumeFailure {
    if (err instanceof NoSessionError) return fail('no-session', 'No file manager session is running. Start one to browse files.');
    if (err instanceof TextTooLargeError) return fail('too-large', 'That text is larger than 1 MiB and can\'t be saved here.');
    if (err instanceof VolumePathError) return fail('invalid-path', err.message);
    if (isAbortOrWrapped(err)) return fail('unreachable', "The file manager didn't respond in time.");
    if (err instanceof VolumeFileError) {
      if (err.code === 'not-found') return fail('not-found', `'${names.missing}' no longer exists.`);
      if (err.code === 'conflict') return fail('conflict', `'${names.existing}' already exists.`);
      if (err.code !== 'failed') return fail(err.code, OPERATOR_MESSAGES[err.code]);
    }
    return fail('failed', 'The file operation failed.');
  }
}
