/** Lifecycle phase of a folder-to-volume upload run. */
export type FolderUploadPhase = 'starting-helper' | 'uploading' | 'verifying' | 'done' | 'failed' | 'cancelled';

/** Progress snapshot streamed from desktop-main to the renderer roughly every 500 ms. */
export interface FolderUploadProgress {
  game: string;
  phase: FolderUploadPhase;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  /** Volume-relative path of the file currently in flight, when one is. */
  currentPath?: string;
  /** Smoothed transfer rate. */
  bytesPerSecond: number;
  /** Estimated seconds remaining; absent until the rate is stable. */
  etaSeconds?: number;
  /** Normalized failure message when `phase` is `failed`. */
  error?: string;
}

/** One node of a scanned local directory tree. `relPath` is POSIX-style and relative to the scan root. */
export interface FolderScanNode {
  name: string;
  kind: 'file' | 'dir';
  /** Bytes for a file; the sum of descendant file sizes for a dir. */
  size: number;
  relPath: string;
  children?: FolderScanNode[];
}

/** Result of scanning a picked local folder; the scan itself stays in main, addressed by `scanId`. */
export interface FolderScanResult {
  scanId: string;
  rootName: string;
  tree: FolderScanNode;
  fileCount: number;
  totalBytes: number;
  /** Symlinks encountered and skipped. */
  skippedLinks: number;
}

/** The operator's upload selection for one game. */
export interface FolderUploadSelection {
  game: string;
  localPath: string;
  /** Selected `relPath`s; a selected dir includes all of its descendants. */
  include: string[];
  /** Absolute container path under one of the game's volume `container_path`s. */
  destination: string;
}

/** Outcome of the most recent upload run, persisted per game. */
export interface FolderUploadLastRun {
  status: 'done' | 'failed' | 'cancelled';
  completedAt: string;
  files: number;
  bytes: number;
}

/** A file selected for upload. */
export interface PlannedFile {
  relPath: string;
  size: number;
}

/** Request to start (or persist the selection for) an upload; the renderer references the scan by id, never by path. */
export interface FolderUploadRequest {
  game: string;
  scanId: string;
  /** Selected `relPath`s; a selected dir includes all of its descendants. */
  include: string[];
  /** Absolute container path under one of the game's volume `container_path`s. */
  destination: string;
}

/** Per-game folder-upload state persisted in application-local storage. */
export interface FolderUploadStoredState {
  localPath: string;
  include: string[];
  destination: string;
  lastRun?: FolderUploadLastRun;
}

/** Result of asking main to start an upload; the run's progress then arrives on the progress event channel. */
export type FolderUploadStartResult = { started: true; runId: string } | { started: false; error: string };

/** One helper task stopped by the stray-helper sweep. */
export interface StrayHelperStopped {
  game: string;
  taskArn: string;
  ageMinutes: number;
}

/** What a stray-helper sweep did. */
export interface StrayHelperReport {
  stopped: StrayHelperStopped[];
  /** Helpers left alone because an active run owns them or they are younger than the age threshold. */
  skipped: number;
  /** App-created security-group rules revoked. */
  revokedRules: number;
  errors: string[];
}
