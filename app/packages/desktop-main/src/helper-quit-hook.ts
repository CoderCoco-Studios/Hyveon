import { errMessage } from '@hyveon/shared';
import { logger } from './logger.js';
import type { HelperSessionRegistry } from './services/volumeFiles/HelperSessionRegistry.js';

/** The slice of Electron's `app` the quit hook needs. */
export interface QuitApp {
  on(event: 'before-quit', fn: (e: { preventDefault(): void }) => void): void;
  quit(): void;
}

/** How long quitting waits for helpers to stop before giving up. */
const DEFAULT_QUIT_TIMEOUT_MS = 5000;

// @spec HELPER-FB-018, HELPER-QUIT-001, HELPER-QUIT-002
/**
 * Stops the file manager helpers this app session owns before the app quits, so no helper is left billing and its
 * operator-IP rule is revoked.
 *
 * @remarks
 * With no owned sessions it does nothing, so quitting is never delayed. Otherwise the first `before-quit` is
 * prevented, helpers are stopped for at most `timeoutMs`, and `quit()` is called again; that second `before-quit`
 * passes through. Whatever outlives the timeout is left to the next launch's stray-helper sweep.
 *
 * @param app - The Electron app (or a stand-in).
 * @param registry - Source of the owned games and the stop-all action.
 * @param timeoutMs - Longest time to wait for helpers to stop.
 */
export function installHelperQuitHook(
  app: QuitApp,
  registry: Pick<HelperSessionRegistry, 'ownedGames' | 'stopAll'>,
  timeoutMs = DEFAULT_QUIT_TIMEOUT_MS,
): void {
  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping) return;
    const owned = registry.ownedGames();
    if (owned.size === 0) return;
    stopping = true;
    event.preventDefault();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    void Promise.race([registry.stopAll().then(() => 'stopped' as const), timeout])
      .then((outcome) => {
        if (outcome === 'stopped') logger.info('Quit: file manager helpers stopped', { games: owned.size });
        else logger.warn('Quit: stopping file manager helpers timed out', { games: owned.size, timeoutMs });
      })
      .catch((err: unknown) => {
        logger.warn('Quit: stopping file manager helpers failed', { error: errMessage(err) });
      })
      .finally(() => {
        clearTimeout(timer);
        app.quit();
      });
  });
}
