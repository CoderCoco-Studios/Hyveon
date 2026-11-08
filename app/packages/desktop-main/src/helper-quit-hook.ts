import { logger } from './logger.js';
import type { HelperSessionRegistry } from './services/volumeFiles/HelperSessionRegistry.js';

// @spec HELPER-FB-018, HELPER-QUIT-001, HELPER-QUIT-002
/**
 * Builds the helper shutdown step the app's quit coordinator runs: stops every owned helper, and does nothing when
 * none is owned. The coordinator owns the quit prevention and the time bound.
 *
 * @param registry - Source of the owned games and the stop-all action.
 * @returns A stopper that settles once the helpers are stopped.
 */
export function createHelperQuitStopper(registry: Pick<HelperSessionRegistry, 'ownedGames' | 'stopAll'>): () => Promise<void> {
  return async () => {
    const owned = registry.ownedGames();
    if (owned.size === 0) return;
    await registry.stopAll();
    logger.info('Quit: file manager helpers stopped', { games: owned.size });
  };
}
