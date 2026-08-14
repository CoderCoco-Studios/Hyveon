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
