/**
 * Request/result payload shapes for the `iac.settings.autoUpdate.get` /
 * `iac.settings.autoUpdate.update` IPC channels — reads and writes the
 * `enableAutoUpdate` electron-store flag that gates `desktop-main/src/updater.ts`'s
 * `electron-updater` integration. Deliberately separate from
 * `deploymentSettingsWrite.ts`'s types: `enableAutoUpdate` is a local
 * electron-store flag, not a field of `DeploymentConfig`, so it carries no
 * etag/optimistic-locking concerns and no validation beyond "is it a
 * boolean".
 */

/** Successful read of the current `enableAutoUpdate` flag. */
export interface AutoUpdateSettingGetSuccess {
  ok: true;
  enableAutoUpdate: boolean;
  /** The running app's `app.getVersion()`; `'unknown'` outside Electron. */
  appVersion: string;
}

/** Catch-all read failure — the store was unexpectedly unavailable. */
export interface AutoUpdateSettingGetFailure {
  ok: false;
  code: 'error';
  message: string;
}

/** Discriminated union returned by the `iac.settings.autoUpdate.get` handler. */
export type AutoUpdateSettingGetResult = AutoUpdateSettingGetSuccess | AutoUpdateSettingGetFailure;

/** Request payload for `iac.settings.autoUpdate.update`. */
export interface AutoUpdateSettingUpdatePayload {
  enableAutoUpdate: boolean;
}

/** Successful write of the `enableAutoUpdate` flag — echoes the value now in effect. */
export interface AutoUpdateSettingWriteSuccess {
  ok: true;
  enableAutoUpdate: boolean;
}

/** Catch-all write failure — e.g. the store was unexpectedly unavailable. */
export interface AutoUpdateSettingWriteFailure {
  ok: false;
  code: 'error';
  message: string;
}

/** Discriminated union returned by the `iac.settings.autoUpdate.update` handler. */
export type AutoUpdateSettingWriteResult = AutoUpdateSettingWriteSuccess | AutoUpdateSettingWriteFailure;

/**
 * Discriminated union returned by the `iac.settings.autoUpdate.check` handler —
 * the result of an on-demand update check, independent of the
 * `enableAutoUpdate` flag. Never implies a download or install occurred; those
 * only happen through the separate, explicitly user-initiated
 * `iac.settings.autoUpdate.download` / `iac.settings.autoUpdate.install` channels.
 */
export type ManualUpdateCheckResult =
  | { ok: true; updateAvailable: true; version: string }
  | { ok: true; updateAvailable: false }
  | { ok: false; message: string };

/**
 * One progress sample from a user-initiated update download, pushed over the
 * `iac.settings.autoUpdate.download` stream. Mirrors the fields of
 * `electron-updater`'s `ProgressInfo` the renderer needs.
 */
export interface UpdateDownloadProgress {
  /** Download completion, `0`–`100`. */
  percent: number;
  /** Bytes downloaded so far. */
  transferred: number;
  /** Total bytes to download. */
  total: number;
  /** Current transfer rate in bytes per second. */
  bytesPerSecond: number;
}

/**
 * Terminal outcome of a user-initiated update download. `ok: true` means the
 * update is fully downloaded and ready for {@link UpdateInstallResult}'s
 * install step; the app has NOT restarted yet.
 */
export type UpdateDownloadResult = { ok: true; version: string } | { ok: false; message: string };

/**
 * Result of the `iac.settings.autoUpdate.install` handler. `ok: true` means
 * `quitAndInstall` was invoked and the app is about to quit; `ok: false`
 * carries the reason it could not (e.g. outside the packaged app, or no
 * update has been downloaded).
 */
export type UpdateInstallResult = { ok: true } | { ok: false; message: string };
