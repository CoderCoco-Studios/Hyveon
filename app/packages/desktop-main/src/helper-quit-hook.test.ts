import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createHelperQuitStopper } from './helper-quit-hook.js';
import { logger } from './logger.js';

describe('createHelperQuitStopper', () => {
  // @spec HELPER-QUIT-001
  it('should do nothing, and so never delay quit, when no helper is owned', async () => {
    const stopAll = vi.fn(async () => undefined);

    await createHelperQuitStopper({ ownedGames: () => new Set<string>(), stopAll })();

    expect(stopAll).not.toHaveBeenCalled();
  });

  // @spec HELPER-QUIT-002, HELPER-FB-018
  it('should stop every owned helper and log it', async () => {
    const stopAll = vi.fn(async () => undefined);

    await createHelperQuitStopper({ ownedGames: () => new Set(['mc']), stopAll })();

    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });
});
