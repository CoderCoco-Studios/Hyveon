import path from 'node:path';

// @spec APP-DIAG-LOG-008
/**
 * Resolves the directory the app writes (`createLogger`) and reads (`DIAGNOSTICS_LOG_DIR`) its log files from, so the
 * writer and the diagnostics reader share one derivation.
 *
 * @param userDataPath - Electron's `app.getPath('userData')`.
 * @returns The absolute log directory under the user-data path.
 */
export function resolveLogDir(userDataPath: string): string {
  return path.join(userDataPath, 'logs');
}
