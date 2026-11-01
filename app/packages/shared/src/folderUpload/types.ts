/** Lifecycle phase of a folder-to-volume upload run. */
export type FolderUploadPhase =
  | 'starting-helper'
  | 'awaiting-confirmation'
  | 'uploading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

// @spec HELPER-OVER-002
/** Most conflicting paths carried in an {@link OverwriteSummary}. */
export const MAX_OVERWRITE_SAMPLES = 20;

/** One planned file whose volume copy has a different size and would be overwritten. */
export interface OverwriteConflict {
  relPath: string;
  existingSize: number;
  newSize: number;
}

/** What the pre-upload check found on the volume; sent to the renderer while the run awaits confirmation. */
export interface OverwriteSummary {
  /** Planned files that exist on the volume with a different size and would be overwritten. */
  conflictCount: number;
  /** Planned files already on the volume at the expected size; resume skips them. */
  identicalCount: number;
  /** Planned files not on the volume yet. */
  newCount: number;
  /** Existing files in the touched directories that the plan does not include; context only, never overwritten. */
  otherExistingCount: number;
  /** Up to {@link MAX_OVERWRITE_SAMPLES} of the conflicts. */
  samples: OverwriteConflict[];
}

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
  /** Normalized failure message when `phase` is `failed`, or the reason a run was cancelled by the app. */
  error?: string;
  /** Present while `phase` is `awaiting-confirmation`: the files the upload would overwrite. */
  overwrite?: OverwriteSummary;
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

/** Operator's answer to the overwrite warning; `proceed: false` cancels the run. */
export interface FolderOverwriteDecision {
  game: string;
  proceed: boolean;
}

/** Whether a confirmation was waiting for the answer. */
export interface FolderOverwriteDecisionResult {
  resolved: boolean;
}
