import type { Readable } from 'node:stream';

/** One entry of a volume directory listing. */
export interface VolumeEntry {
  name: string;
  isDir: boolean;
  /** Byte length; `0` for directories. */
  size: number;
  /** Last modification time in milliseconds since the Unix epoch. */
  modifiedMs: number;
}

/** A {@link VolumeEntry} plus the absolute path it was resolved from. */
export interface VolumeStat extends VolumeEntry {
  path: string;
}

/** Why a volume operation failed; the only error vocabulary callers branch on. */
export type VolumeFileErrorCode = 'not-found' | 'conflict' | 'unreachable' | 'auth' | 'pin-mismatch' | 'failed';

/** A volume operation failed with a modeled {@link VolumeFileErrorCode}. */
export class VolumeFileError extends Error {
  /**
   * @param code - What kind of failure this is.
   * @param message - Operator-readable description; never carries credentials.
   * @param status - The HTTP status behind the failure, when there was one.
   * @param options - Standard error options, such as the underlying `cause`.
   */
  constructor(
    readonly code: VolumeFileErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VolumeFileError';
  }
}

/** Options for {@link VolumeFileBackend.writeStream}. */
export interface WriteOptions {
  /** Byte length the source stream will produce; announced to the server up front. */
  size: number;
  /** Replace an existing file; when `false`, an existing file fails with `conflict`. */
  overwrite: boolean;
  signal?: AbortSignal;
  /** Called with the byte count of each chunk as it is handed to the socket. */
  onBytes?: (n: number) => void;
}

// @spec HELPER-FB-039, HELPER-FB-040
/**
 * Reads and writes the files of one game server's data volume, whatever serves them.
 *
 * @remarks
 * Paths are absolute POSIX paths under the volume root. Failures reject with {@link VolumeFileError}.
 */
export interface VolumeFileBackend {
  /** Whether {@link VolumeFileBackend.archiveStream} is implemented. */
  readonly supportsArchive: boolean;

  /**
   * Establishes the session (authentication, trust check) before any other call.
   *
   * @param signal - Aborts the request.
   * @throws {@link VolumeFileError} with `auth` or `pin-mismatch`, or `unreachable`.
   */
  connect(signal?: AbortSignal): Promise<void>;

  /**
   * Lists the immediate children of a directory.
   *
   * @param dir - Absolute directory path.
   * @param signal - Aborts the request.
   * @returns The directory's entries.
   * @throws {@link VolumeFileError} with `not-found` when the directory is absent.
   */
  list(dir: string, signal?: AbortSignal): Promise<VolumeEntry[]>;

  /**
   * Describes one file or directory.
   *
   * @param path - Absolute path.
   * @param signal - Aborts the request.
   * @returns The entry's metadata.
   * @throws {@link VolumeFileError} with `not-found` when the path is absent.
   */
  stat(path: string, signal?: AbortSignal): Promise<VolumeStat>;

  /**
   * Opens a file's bytes for reading.
   *
   * @param path - Absolute file path.
   * @param signal - Aborts the request.
   * @returns A stream the caller must consume or destroy.
   * @throws {@link VolumeFileError} with `not-found` when the file is absent.
   */
  readStream(path: string, signal?: AbortSignal): Promise<Readable>;

  /**
   * Writes a file from a stream, creating missing parent directories.
   *
   * @param path - Absolute destination path.
   * @param source - The bytes to write; destroyed when the call settles.
   * @param options - Size, overwrite policy, abort signal and progress callback.
   * @throws {@link VolumeFileError} with `conflict` when the file exists and `overwrite` is `false`.
   */
  writeStream(path: string, source: Readable, options: WriteOptions): Promise<void>;

  /**
   * Creates a directory, including missing parents.
   *
   * @remarks
   * Backends whose server does not reject an existing directory check for it first, so `conflict` is reported
   * consistently; `existOk` skips that check.
   *
   * @param path - Absolute directory path.
   * @param options - `existOk` tolerates an existing directory; `signal` aborts the request.
   * @throws {@link VolumeFileError} with `conflict` when the directory exists and `existOk` is not set.
   */
  mkdir(path: string, options?: { existOk?: boolean; signal?: AbortSignal }): Promise<void>;

  /**
   * Renames or moves a file or directory.
   *
   * @param from - Absolute source path.
   * @param to - Absolute destination path.
   * @param signal - Aborts the request.
   * @throws {@link VolumeFileError} with `not-found` or `conflict`.
   */
  move(from: string, to: string, signal?: AbortSignal): Promise<void>;

  /**
   * Deletes a file or a directory with its contents.
   *
   * @param path - Absolute path.
   * @param signal - Aborts the request.
   * @throws {@link VolumeFileError} with `not-found` when the path is absent.
   */
  remove(path: string, signal?: AbortSignal): Promise<void>;

  /**
   * Streams a directory as a zip archive; present only when {@link VolumeFileBackend.supportsArchive} is `true`.
   *
   * @param dir - Absolute directory path.
   * @param signal - Aborts the request.
   * @returns A stream the caller must consume or destroy.
   * @throws {@link VolumeFileError} with `not-found` when the directory is absent.
   */
  archiveStream?(dir: string, signal?: AbortSignal): Promise<Readable>;

  /** Releases pooled connections. */
  close(): Promise<void>;
}
