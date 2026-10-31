import type { Readable } from 'node:stream';
import type { HelperSessionRegistry } from '../volumeFiles/HelperSessionRegistry.js';
import {
  VolumeFileError,
  type VolumeEntry,
  type VolumeFileBackend,
  type VolumeStat,
  type WriteOptions,
} from '../volumeFiles/VolumeFileBackend.js';

/**
 * A {@link VolumeFileBackend} for one game's registry-owned helper session, so the upload engine can run unchanged.
 *
 * @remarks
 * Every call goes through {@link HelperSessionRegistry.withBackend} on its own, so an operator-IP recovery retries that
 * single operation rather than the whole run. The registry owns the session's connection, so `connect` and `close` do
 * nothing here.
 */
export class RegistryUploadBackend implements VolumeFileBackend {
  readonly supportsArchive = false;

  /**
   * @param registry - Owner of the helper session.
   * @param game - Game whose session every call is routed to.
   */
  constructor(
    private readonly registry: Pick<HelperSessionRegistry, 'withBackend'>,
    private readonly game: string,
  ) {}

  /** No-op: the registry connects the backend before `acquire` resolves. */
  async connect(): Promise<void> {}

  /** No-op: the registry closes the backend when the session ends. */
  async close(): Promise<void> {}

  /** Lists `dir` on the session's backend. */
  list(dir: string, signal?: AbortSignal): Promise<VolumeEntry[]> {
    return this.registry.withBackend(this.game, (b) => b.list(dir, signal));
  }

  /** Describes `path` on the session's backend. */
  stat(path: string, signal?: AbortSignal): Promise<VolumeStat> {
    return this.registry.withBackend(this.game, (b) => b.stat(path, signal));
  }

  /** Opens `path` for reading on the session's backend. */
  readStream(path: string, signal?: AbortSignal): Promise<Readable> {
    return this.registry.withBackend(this.game, (b) => b.readStream(path, signal));
  }

  /** Creates a directory on the session's backend. */
  mkdir(path: string, options?: { existOk?: boolean; signal?: AbortSignal }): Promise<void> {
    return this.registry.withBackend(this.game, (b) => b.mkdir(path, options));
  }

  /** Renames a path on the session's backend. */
  move(from: string, to: string, signal?: AbortSignal): Promise<void> {
    return this.registry.withBackend(this.game, (b) => b.move(from, to, signal));
  }

  /** Deletes a path on the session's backend. */
  remove(path: string, signal?: AbortSignal): Promise<void> {
    return this.registry.withBackend(this.game, (b) => b.remove(path, signal));
  }

  // @spec HELPER-UPLOAD-019
  /**
   * Writes `source` once; a registry retry after an operator-IP recovery cannot replay the consumed stream, so it fails
   * with `unreachable` and the caller reopens the source.
   */
  writeStream(path: string, source: Readable, options: WriteOptions): Promise<void> {
    let attempted = false;
    return this.registry.withBackend(this.game, async (b) => {
      if (attempted) throw new VolumeFileError('unreachable', 'The upload stream cannot be replayed after the connection was recovered.');
      attempted = true;
      await b.writeStream(path, source, options);
    });
  }
}
