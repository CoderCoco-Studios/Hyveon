// @spec HELPER-EDIT-001, HELPER-EDIT-002
/** Largest text file the in-app editor will open or save, in bytes. */
export const MAX_TEXT_EDIT_BYTES = 1_048_576;

// @spec HELPER-FB-023
/** How long before an automatic stop the renderer warns the operator, in milliseconds. */
export const AUTO_STOP_WARNING_MS = 10 * 60 * 1000;

/** Lifecycle of one game's file-browser helper session. */
export type VolumeSessionState = 'not_deployed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'failed';

/** One declared game volume; `mounted` is false when the session's layout could not mount it (apply needed). */
export interface VolumeInfo {
  name: string;
  containerPath: string;
  mounted: boolean;
}

/** Renderer-visible state of a game's file-browser session. Carries no credential, token, IP or URL. */
export interface VolumeSessionStatus {
  game: string;
  state: VolumeSessionState;
  /** ISO 8601. */
  startedAt?: string;
  /** ISO 8601. */
  autoStopAt?: string;
  browseHeld: boolean;
  /** Holds by uploads (folder-upload runs and upload transfers); browse and download holds are not counted. */
  uploadHolders: number;
  supportsArchive: boolean;
  error?: string;
  volumes: VolumeInfo[];
}

/** Every file request names its volume; `path` is relative to that volume's root. */
export interface VolumeRef {
  game: string;
  volume: string;
}

/** One directory entry as shown in the browser. */
export interface VolumeEntryInfo {
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

/** A directory listing for a volume-relative path. */
export interface VolumeListing {
  path: string;
  entries: VolumeEntryInfo[];
}

/** A text file's content plus the modification time used for conflict detection on save. */
export interface VolumeTextFile {
  path: string;
  content: string;
  modifiedMs: number;
}

/** Why a file operation failed; `apply-needed` means the volume layout is a legacy fallback that must not be mutated. */
export type VolumeFilesErrorCode =
  | 'not-found'
  | 'conflict'
  | 'unreachable'
  | 'auth'
  | 'pin-mismatch'
  | 'invalid-path'
  | 'unknown-volume'
  | 'server-running'
  | 'server-check-failed'
  | 'no-session'
  | 'too-large'
  | 'binary'
  | 'apply-needed'
  | 'failed';

/** Outcome of a file operation: a value, or a coded failure with an operator-facing message. */
export type VolumeResult<T> = { ok: true; value: T } | { ok: false; code: VolumeFilesErrorCode; message: string };

/** Progress of one download or upload, pushed to the renderer on {@link VOLUME_FILES_TRANSFER_CHANNEL}. */
export interface VolumeTransferProgress {
  game: string;
  transferId: string;
  kind: 'download' | 'upload';
  name: string;
  bytesDone: number;
  /** `null` when the total is unknown (for example a folder archive). */
  bytesTotal: number | null;
  phase: 'running' | 'done' | 'failed' | 'cancelled';
  /** Base name of the local file a finished download was saved as. */
  savedAs?: string;
  error?: string;
}

// @spec HELPER-IPC-008
/** IPC push channel carrying {@link VolumeSessionStatus} updates. */
export const VOLUME_FILES_SESSION_CHANNEL = 'volumeFiles.session';

/** IPC push channel carrying {@link VolumeTransferProgress} updates. */
export const VOLUME_FILES_TRANSFER_CHANNEL = 'volumeFiles.transfer';
