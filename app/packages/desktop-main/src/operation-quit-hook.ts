import { logger } from './logger.js';
import type { PulumiService } from './services/PulumiService.js';

/** The slice of Electron's `app` the operation quit hook needs. */
export interface OperationQuitApp {
  on(event: 'before-quit', fn: () => void): void;
  exit(exitCode?: number): void;
}

/** How long an aborted engine call may keep the process alive before the app force-exits. */
export const OPERATION_QUIT_FORCE_EXIT_MS = 10_000;

// @spec IAC-ENGINE-LIFE-009
/**
 * Aborts any running infrastructure operation when the app begins to quit, so `SIGINT` reaches the engine instead of
 * orphaning it, and force-exits if a wedged engine call still keeps the process alive after `forceExitMs`.
 *
 * @remarks
 * Never prevents or delays the quit itself, so it composes with other `before-quit` hooks. The force-exit timer is
 * unref'd and is only armed when an operation was actually running.
 *
 * @param app - The Electron app (or a stand-in).
 * @param pulumi - Source of the abort action.
 * @param forceExitMs - Longest time to wait before forcing the process to exit.
 */
export function installOperationQuitHook(
  app: OperationQuitApp,
  pulumi: Pick<PulumiService, 'abortInFlightOperations'>,
  forceExitMs = OPERATION_QUIT_FORCE_EXIT_MS,
): void {
  app.on('before-quit', () => {
    if (!pulumi.abortInFlightOperations()) return;
    logger.warn('Quit: aborting the running infrastructure operation', { forceExitMs });
    setTimeout(() => app.exit(0), forceExitMs).unref();
  });
}
